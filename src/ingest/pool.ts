// src/ingest/pool.ts
//
// Worker pool, file dispatch, cube assembly.
//
// The pool's unit of work is a BYTE RANGE, not a case (D10). One dropped
// file therefore uses every core, which is the common interaction, and ten
// dropped files queue into the same pool rather than a second one. Workers
// are pre-warmed at page load because startup is ~40 ms each.
//
// Two things in here are load-bearing for correctness rather than speed:
//
//   * The cube is pre-filled with NaN. "Never written" then looks exactly
//     like "this case never exported that column" -- both NaN, both refused
//     by the presence bitmap. Leaving the allocator's zeros in place would
//     turn a truncated file into 8,760 hours of plausible zeros.
//   * Rows must be ordered by (date, hour) with an hour's areas together. The
//     blit below relies on it, the parser checks it, and a file that breaks it
//     is refused rather than blitted wrong.

import { HOURS_PER_YEAR } from '../calendar';
import { derivedFor, requiredInputs, ruleFor } from '../rules';
import type { CaseData } from '../types';
import {
  areaHashes,
  buildColumnPlan,
  parseHeaderLine,
  unionSchema,
  type ColumnPlan,
  type HeaderInfo,
} from './header';
import type { BlockPayload } from './block';
import type {
  AxisMessage,
  BlockMessage,
  BlockResult,
  InitMessage,
  ScanMessage,
  ScanResult,
  WorkerResponse,
} from './worker';

/** D10: >= 8 MiB. 1 MiB blocks measure *worse* than plain streaming. */
export const BLOCK_TARGET_BYTES = 8 * 1024 * 1024;

/** Initial probe for the header and first data row. */
const HEAD_PROBE_BYTES = 256 * 1024;
const MAX_HEAD_PROBE_BYTES = 16 * 1024 * 1024;

/** The whole file is read through the pool; this is only the header probe. */
const decoder = new TextDecoder();

export interface CasePlan {
  file: File;
  header: HeaderInfo;
  /** Byte offset of the first data row -- block 0 starts here, not at 0. */
  dataStart: number;
  year: number;
  /** This case's area axis. Empty until discoverAreas() reads it from the
   * file's Name column; never guessed from the header probe. */
  areas: string[];
  /** Rows in each of this file's byte ranges, counted by the same scan. Bounds
   * the parser's per-block output exactly instead of by estimate. */
  rowsPerBlock: number[];
}

export interface IngestResult {
  cases: CaseData[];
  /** User-facing notes: dropped Feb 29, missing weights, partial coverage. */
  warnings: string[];
}

// ---------------------------------------------------------------- feature gate

/** The wasm-feature-detect SIMD128 probe: a module whose only instruction
 * needing the proposal is `i8x16.splat`, so validation fails without it.
 * The byte sequence is load-bearing -- an earlier hand-written variant
 * declared a v128 result and then dropped it, which is a type error, so it
 * validated false everywhere and would have refused every browser. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, // magic + version
  1, 4, 1, 96, 0, 0, // type: () -> ()
  3, 2, 1, 0, // one function of that type
  10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11, // i32.const 0; i8x16.splat; drop; end
]);

/** There is no scalar JS fallback (D12): feature-detect and refuse instead. */
export function hasSimd(): boolean {
  return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
}

export const NO_SIMD_MESSAGE =
  'This tool needs WebAssembly SIMD, which has shipped in Chrome and Edge since ' +
  'version 91 (May 2021). Please open it in an up-to-date Chrome or Edge.';

// ---------------------------------------------------------------- header probe

/** Read one file's header and enough of its first row to size blocks. */
export async function readCasePlan(file: File): Promise<CasePlan> {
  for (let probeBytes = HEAD_PROBE_BYTES; ; probeBytes *= 2) {
    const probe = new Uint8Array(await file.slice(0, probeBytes).arrayBuffer());
    const headerEnd = probe.indexOf(10);
    if (headerEnd < 0) {
      if (probeBytes < MAX_HEAD_PROBE_BYTES && probe.length === probeBytes) continue;
      throw new Error(`${file.name}: no line ending in the first ${probeBytes} B.`);
    }
    const header = parseHeaderLine(decoder.decode(probe.subarray(0, headerEnd)));
    const dataStart = headerEnd + 1;

    const rowEnd = probe.indexOf(10, dataStart);
    if (rowEnd < 0) {
      if (probeBytes < MAX_HEAD_PROBE_BYTES && probe.length === probeBytes) continue;
      throw new Error(`${file.name}: header but no complete data row in the first ${probeBytes} B.`);
    }
    const firstRow = decoder.decode(probe.subarray(dataStart, rowEnd));

    // Date is `M/D/YYYY`, parsed as three integers -- never a Date object
    // (footgun 3: one `new Date(str)` shifts rows by a day in half the world).
    const year = Number(firstRow.split(',', 1)[0].split('/')[2]);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new Error(`${file.name}: could not read a year from the first Date field.`);
    }

    // `areas` is filled by discoverAreas(), which reads the Name column of
    // every row. It is not guessed from this probe.
    return { file, header, dataStart, year, areas: [], rowsPerBlock: [] };
  }
}

export function unionOf(plans: CasePlan[]): string[] {
  const columns = unionSchema(plans.map((p) => p.header));
  // Calculated columns are in no file's header, so they are appended here or
  // the picker never offers them.
  return [...columns, ...derivedFor(columns)];
}

// ---------------------------------------------------------------- the pool

let poolPromise: Promise<Worker[]> | null = null;
/** The axis the workers' hash tables currently hold, joined. */
let poolAxis = '';

function poolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(1, Math.min(cores, 8));
}

async function createPool(): Promise<Worker[]> {
  if (!hasSimd()) throw new Error(NO_SIMD_MESSAGE);

  // Compiled once on the main thread and cloned to every worker: a
  // WebAssembly.Module is structured-cloneable, so N workers cost one fetch
  // and one compile rather than N of each.
  const module = await WebAssembly.compileStreaming(fetch('./block.wasm'));

  const workers: Worker[] = [];
  for (let i = 0; i < poolSize(); i++) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const init: InitMessage = { kind: 'init', module };
    await ready(worker, init);
    workers.push(worker);
  }
  poolAxis = '';
  return workers;
}

function ready(worker: Worker, message: InitMessage | AxisMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<WorkerResponse>) => {
      worker.removeEventListener('message', handler);
      if (event.data.kind === 'ready') resolve();
      else reject(new Error(`worker ${message.kind} failed: ${JSON.stringify(event.data)}`));
    };
    worker.addEventListener('message', handler);
    worker.postMessage(message);
  });
}

/**
 * The pool. It is built once and outlives any particular area axis: the axis
 * is discovered from the data, so the workers have to run before it is known.
 */
function pool(): Promise<Worker[]> {
  if (!poolPromise) poolPromise = createPool();
  return poolPromise;
}

/**
 * Load an axis into every worker's hash table. A file whose axis differs
 * routes its rows into the wrong cube planes unless this runs, so it is
 * checked against what the workers hold rather than assumed.
 */
async function useAxis(workers: Worker[], areas: string[]): Promise<void> {
  const key = areas.join(',');
  if (poolAxis === key) return;
  const hashes = areaHashes(areas);
  await Promise.all(workers.map((worker) => ready(worker, { kind: 'axis', areaHashes: hashes })));
  poolAxis = key;
}

function runJob<T extends BlockResult | ScanResult>(
  worker: Worker,
  job: BlockMessage | ScanMessage,
  want: T['kind'],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<WorkerResponse>) => {
      worker.removeEventListener('message', handler);
      const message = event.data;
      if (message.kind === want) resolve(message as T);
      else if (message.kind === 'error') reject(new Error(message.message));
      else reject(new Error(`unexpected worker message: ${message.kind}`));
    };
    worker.addEventListener('message', handler);
    worker.postMessage(job);
  });
}

/** Hand `jobs` to `workers`, one in flight per worker, in whatever order they
 * finish. Used by both passes. */
async function dispatch<T extends BlockResult | ScanResult>(
  workers: Worker[],
  jobs: (BlockMessage | ScanMessage)[],
  want: T['kind'],
  onResult: (result: T) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  await Promise.all(
    // One job in flight per worker: a worker handles a single message at a
    // time, so two concurrent jobs on one worker would race their handlers.
    workers.map(async (worker) => {
      for (;;) {
        const index = next++;
        if (index >= jobs.length) return;
        onResult(await runJob<T>(worker, jobs[index], want));
        onProgress?.(++done, jobs.length);
      }
    }),
  );
}

// ---------------------------------------------------------------- cube assembly

export interface CaseAccumulator {
  plan: ColumnPlan;
  areaCount: number;
  cube: Float32Array;
  /** Per-hour TOU code, 0xFF until a row covers the hour. */
  tou: Uint8Array;
  areaSeen: Uint8Array;
  hourSeen: Uint8Array;
  /** One bit per (area, hour). Rows scatter into the cube, so a second row for
   * a cell would overwrite the first with nothing thrown -- two exports
   * concatenated into one file do exactly that. 47 KB for a 43-area case,
   * because duplicates are per ROW, not per cell. */
  covered: Uint8Array;
}

export function createAccumulator(plan: ColumnPlan, areaCount: number): CaseAccumulator {
  const cube = new Float32Array(areaCount * plan.metrics.length * HOURS_PER_YEAR);
  // See the header comment: NaN, not zero, is the correct "no data here".
  cube.fill(NaN);
  return {
    plan,
    areaCount,
    cube,
    tou: new Uint8Array(HOURS_PER_YEAR).fill(0xff),
    areaSeen: new Uint8Array(areaCount),
    hourSeen: new Uint8Array(HOURS_PER_YEAR),
    covered: new Uint8Array(Math.ceil((areaCount * HOURS_PER_YEAR) / 8)),
  };
}

/**
 * Scatter one block's rows into the cube. Correct in any arrival order, and --
 * unlike the hour-windowed blit this replaced -- correct for any row order
 * inside the block too. A value-sorted export lands exactly like a
 * date-ordered one.
 *
 * Rows are bucketed by area first. That is not cosmetic: an area's planes
 * occupy one contiguous ~1.7 MB region of the cube, so bucketing keeps the
 * writes inside it instead of walking the whole 72 MB. Measured on a full
 * year, 43 areas x 50 metrics: 96 ms unsorted, 40 ms bucketed, against 10 ms
 * for the old contiguous memcpy that only worked on ordered files.
 */
export function blitBlock(accumulator: CaseAccumulator, block: BlockPayload): void {
  const { plan, cube, areaCount, covered } = accumulator;
  const { rows, planes, values, rowArea, rowHour } = block;

  for (let hour = 0; hour < block.tou.length; hour++) {
    const code = block.tou[hour];
    if (code === 0xff) continue;
    accumulator.tou[hour] = code;
    accumulator.hourSeen[hour] = 1;
  }
  for (let area = 0; area < areaCount; area++) {
    if (block.areaSeen[area]) accumulator.areaSeen[area] = 1;
  }
  if (rows === 0 || planes === 0) return;

  // Output plane -> cube metric, then pre-multiplied into a cube offset so the
  // inner loop is an add and a load.
  const numMetrics = plan.metrics.length;
  const offsets = new Int32Array(planes);
  for (let p = 0; p < planes; p++) {
    offsets[p] = plan.slabPlan[plan.activePlanes[p]] * HOURS_PER_YEAR;
  }

  // Counting sort by area. O(rows), one pass to count and one to place.
  const counts = new Int32Array(areaCount + 1);
  for (let r = 0; r < rows; r++) counts[rowArea[r] + 1]++;
  for (let a = 0; a < areaCount; a++) counts[a + 1] += counts[a];
  const order = new Int32Array(rows);
  for (let r = 0; r < rows; r++) order[counts[rowArea[r]]++] = r;

  // When the retained planes land on consecutive cube metrics -- "keep
  // everything", and any contiguous run of columns -- the per-plane cube
  // offset is an arithmetic step, so the inner loop is an add rather than a
  // table lookup. Measured on a full year: 62 ms with the lookup, 41 ms with
  // the step. It is the whole difference between this blit and the contiguous
  // memcpy it replaced.
  let step = 0;
  let stepped = planes > 0;
  for (let p = 1; p < planes && stepped; p++) {
    const delta = offsets[p] - offsets[p - 1];
    if (p === 1) step = delta;
    else if (delta !== step) stepped = false;
  }

  for (let i = 0; i < rows; i++) {
    const r = order[i];
    const area = rowArea[r];
    const hour = rowHour[r];

    // A cell written twice is two rows claiming the same (area, hour). The
    // scatter would silently keep whichever worker finished last.
    const bit = area * HOURS_PER_YEAR + hour;
    const byte = bit >> 3;
    const mask = 1 << (bit & 7);
    if (covered[byte] & mask) {
      throw new Error(
        `Two rows both describe area index ${area} at hour ${hour}. One case cannot hold the ` +
          `same area-hour twice; two exports concatenated into one file look like this. Load ` +
          `them as separate files.`,
      );
    }
    covered[byte] |= mask;

    const src = r * planes;
    let out = area * numMetrics * HOURS_PER_YEAR + hour;
    if (stepped) {
      out += offsets[0];
      for (let p = 0; p < planes; p++) {
        cube[out] = values[src + p];
        out += step;
      }
    } else {
      for (let p = 0; p < planes; p++) cube[out + offsets[p]] = values[src + p];
    }
  }
}

/**
 * Fill every CALCULATED column's plane from its operands, after the last block
 * has blitted. NaN propagates on its own -- an hour either operand never
 * covered stays absent rather than becoming a plausible zero.
 *
 * Per-area subtraction is sound only because both operands are same-unit
 * EXTENSIVE (see ColumnRule.derived). A per-area RATIO (`op: 'div'`) is only a
 * per-area answer; what makes it right for a grouping is the WEIGHTED_MEAN
 * rule weighted by its denominator, applied after the collapse in kernels.ts.
 * Presence follows the operands either way: a calculated column whose inputs
 * were not retained has no plane to build and stays absent, which is what the
 * pane then refuses on.
 *
 * Returns warnings about operand SIGN (the one thing about a subtraction the
 * schema cannot establish) and about zero denominators.
 */
export function applyDerived(accumulator: CaseAccumulator): string[] {
  const { plan, cube } = accumulator;
  const numMetrics = plan.metrics.length;
  const warnings: string[] = [];

  for (let metric = 0; metric < numMetrics; metric++) {
    const derived = ruleFor(plan.metrics[metric])?.derived;
    if (!derived) continue;
    const left = plan.metrics.indexOf(derived.minuend);
    const right = plan.metrics.indexOf(derived.subtrahend);
    if (left < 0 || right < 0 || !plan.presence[left] || !plan.presence[right]) continue;

    // A subtraction only means what the column's NAME claims if both operands
    // are unsigned magnitudes. `Net Interchange` = Import - Export is net
    // imports only while Export is stored positive; if an export ever ships
    // its flows as negatives, the same subtraction silently becomes a sum of
    // magnitudes. The sign is data, so it is checked rather than assumed.
    let negativeLeft = 0;
    let negativeRight = 0;
    let zeroDenominator = 0;
    let live = 0;
    const divide = derived.op === 'div';

    for (let area = 0; area < accumulator.areaCount; area++) {
      const out = (area * numMetrics + metric) * HOURS_PER_YEAR;
      const a = (area * numMetrics + left) * HOURS_PER_YEAR;
      const b = (area * numMetrics + right) * HOURS_PER_YEAR;
      for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
        const x = cube[a + hour];
        const y = cube[b + hour];
        // A zero denominator is undefined, not infinite: x/0 would put
        // Infinity in the cube, which every downstream kernel treats as a
        // number and no NaN guard catches (footgun 21). Absent is the honest
        // read -- an area with no installed capacity has no capacity factor.
        cube[out + hour] = divide ? (y === 0 ? NaN : x / y) : x - y;
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        live++;
        if (x < 0) negativeLeft++;
        if (y < 0) negativeRight++;
        if (y === 0) zeroDenominator++;
      }
    }
    plan.presence[metric] = 1;

    if (divide) {
      if (zeroDenominator > 0) {
        warnings.push(
          `"${plan.metrics[metric]}" has ${zeroDenominator.toLocaleString()} area-hour(s) where ` +
            `${derived.subtrahend} is zero; those read as no-data rather than as a ratio.`,
        );
      }
      // The sign guard below is about what a SUBTRACTION means. A ratio's
      // equivalent question is answered by the weight pairing, which
      // test_kernels.mjs asserts against the rule table.
      continue;
    }

    // A tenth, not one cell: a few negatives are ordinary (solver noise, a
    // genuinely negative net position), a systematically signed column is not.
    const threshold = live / 10;
    const signed = [
      negativeLeft > threshold ? derived.minuend : null,
      negativeRight > threshold ? derived.subtrahend : null,
    ].filter((name): name is string => name !== null);
    if (signed.length > 0) {
      warnings.push(
        `"${plan.metrics[metric]}" subtracts ${derived.subtrahend} from ${derived.minuend}, ` +
          `but ${signed.join(' and ')} ${signed.length === 1 ? 'carries' : 'carry'} negative ` +
          `values in this export — so the result is not the net figure the name implies. ` +
          `Check the export's sign convention before reading it.`,
      );
    }
  }
  return warnings;
}

export function finalizeCase(
  accumulator: CaseAccumulator,
  name: string,
  sourceColumns: string[],
  year: number,
  areas: string[],
): { data: CaseData; warnings: string[] } {
  const { plan, cube } = accumulator;
  const numMetrics = plan.metrics.length;
  const presence = new Uint8Array(accumulator.areaCount * numMetrics);
  for (let area = 0; area < accumulator.areaCount; area++) {
    if (!accumulator.areaSeen[area]) continue;
    for (let metric = 0; metric < numMetrics; metric++) {
      presence[area * numMetrics + metric] = plan.presence[metric];
    }
  }

  const warnings: string[] = [];
  const absentMetrics = plan.metrics.filter((_, i) => !plan.presence[i]);
  if (absentMetrics.length > 0) {
    warnings.push(
      `${name}: ${absentMetrics.length} retained column(s) are not in this export ` +
        `(${absentMetrics.slice(0, 3).join(', ')}${absentMetrics.length > 3 ? ', …' : ''}).`,
    );
  }
  const missingAreas = areas.filter((_, i) => !accumulator.areaSeen[i]);
  if (missingAreas.length > 0) {
    warnings.push(`${name}: no rows for ${missingAreas.length} area(s): ${missingAreas.join(', ')}.`);
  }
  let covered = 0;
  for (let h = 0; h < HOURS_PER_YEAR; h++) covered += accumulator.hourSeen[h];
  if (covered < HOURS_PER_YEAR) {
    warnings.push(
      `${name}: covers ${covered.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} hours; ` +
        `the rest read as no-data.`,
    );
  }
  // D4, and it must be stated rather than silent.
  if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) {
    warnings.push(`${name}: ${year} is a leap year — Feb 29 was dropped at ingest (D4).`);
  }

  return {
    data: {
      name,
      cube,
      areas,
      metrics: plan.metrics,
      presence,
      tou: accumulator.tou,
      sourceColumns,
      year,
    },
    warnings,
  };
}

// ---------------------------------------------------------------- ingest

/** The byte ranges one file is cut into. Both passes use the same cut, so a
 * scan block and a parse block cover exactly the same rows. */
function rangesFor(plan: CasePlan): { start: number; end: number; skipPartialFirstRow: boolean }[] {
  // One flat size. The parser allocates its slab for the hours a block
  // actually spans, so a block no longer has to be capped to fit a fixed
  // window; it refuses a shape too large for its arena instead.
  const out = [];
  for (let start = plan.dataStart; start < plan.file.size; start += BLOCK_TARGET_BYTES) {
    out.push({
      start,
      end: Math.min(start + BLOCK_TARGET_BYTES, plan.file.size),
      skipPartialFirstRow: start !== plan.dataStart,
    });
  }
  return out;
}

function blocksFor(
  plan: CasePlan,
  caseIndex: number,
  activePlanes: Int32Array,
  areaCount: number,
  nextId: () => number,
): BlockMessage[] {
  const ranges = rangesFor(plan);
  if (plan.rowsPerBlock.length !== ranges.length) {
    throw new Error(
      `${plan.file.name}: discoverAreas() must run before ingest -- the parser is bounded by the ` +
        `row counts it produces.`,
    );
  }
  return ranges.map((range, i) => ({
    kind: 'block',
    blockId: nextId(),
    caseIndex,
    file: plan.file,
    ...range,
    activePlanes,
    areaCount,
    sourceMetricCount: plan.header.metricNames.length,
    maxRows: plan.rowsPerBlock[i],
  }));
}

/**
 * Read the area axis out of the data, and count each block's rows.
 *
 * The axis used to be guessed from the header probe: read Name until one
 * repeats, on the assumption that an export's first hour lists every area
 * exactly once. It returned 10 areas of 43 on a shuffled export and said
 * nothing, and it is wrong for any file whose first hour is incomplete.
 *
 * So every row's Name is read instead. The pass touches only the four key
 * columns and skips each row's metric fields whole -- 31 ms at 4.3 GiB/s on a
 * real 133 MB export, against ~560 ms for the full parse. The row counts it
 * returns bound the parser's per-block output exactly, so nothing downstream
 * has to estimate how many rows a byte range holds.
 *
 * Row ORDER is not checked, because nothing downstream depends on it.
 */
export async function discoverAreas(
  plans: CasePlan[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (plans.length === 0) return;

  let id = 0;
  const jobs: ScanMessage[] = [];
  const slotOf = new Map<number, { caseIndex: number; slot: number }>();
  plans.forEach((plan, caseIndex) => {
    rangesFor(plan).forEach((range, slot) => {
      slotOf.set(id, { caseIndex, slot });
      jobs.push({ kind: 'scan', blockId: id++, caseIndex, file: plan.file, ...range });
    });
  });

  const names = plans.map(() => new Set<string>());
  plans.forEach((plan) => {
    plan.rowsPerBlock = new Array(rangesFor(plan).length).fill(0);
  });

  const workers = await pool();
  await dispatch<ScanResult>(
    workers,
    jobs,
    'scanned',
    (result) => {
      const at = slotOf.get(result.blockId)!;
      for (const name of result.names) names[at.caseIndex].add(name);
      plans[at.caseIndex].rowsPerBlock[at.slot] = result.rows;
    },
    onProgress,
  );

  plans.forEach((plan, at) => {
    if (names[at].size === 0) {
      throw new Error(`${plan.file.name}: no area names in the Name column.`);
    }
    plan.areas = [...names[at]];
  });
}

export function unionAreas(plans: CasePlan[], base: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const area of base) {
    const name = area.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  for (const plan of plans) {
    for (const area of plan.areas) {
      const name = area.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Parse every plan into its own cube. `retained` defines the cube's metric
 * axis; the caller gets it from the picker, or passes the union schema for
 * "everything".
 */
export async function ingest(
  plans: CasePlan[],
  retained: string[],
  areas: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<IngestResult> {
  if (plans.length === 0) return { cases: [], warnings: [] };

  const areaSet = new Set(areas);
  for (const plan of plans) {
    for (const area of plan.areas) {
      if (!areaSet.has(area)) {
        throw new Error(`${plan.file.name}: area "${area}" is not on the shared area axis.`);
      }
    }
  }

  // Exactly the columns that were picked. A weight the selection needs but
  // does not include is reported, not smuggled in: the multi-area series that
  // depends on it refuses to draw later (footgun 20), which is the honest
  // outcome of the choice rather than a silent 35 MB per case per column.
  const metrics = retained.map((name) => name.trim());
  const warnings: string[] = [];
  const kept = new Set(metrics);
  for (const name of requiredInputs(metrics)) {
    if (kept.has(name)) continue;
    warnings.push(
      `"${name}" was not retained. Columns weighted by it can only be plotted for a single ` +
        `area, and calculated columns that subtract it cannot be built at all. Re-ingest ` +
        `with it kept.`,
    );
  }

  const columnPlans = plans.map((plan) => buildColumnPlan(plan.header, metrics));
  const accumulators = columnPlans.map((plan) => createAccumulator(plan, areas.length));

  let id = 0;
  const jobs: BlockMessage[] = [];
  plans.forEach((plan, index) => {
    jobs.push(...blocksFor(plan, index, columnPlans[index].activePlanes, areas.length, () => id++));
  });

  const workers = await pool();
  await useAxis(workers, areas);
  await dispatch<BlockResult>(
    workers,
    jobs,
    'done',
    (result) => blitBlock(accumulators[result.caseIndex], result),
    onProgress,
  );

  const cases: CaseData[] = [];
  accumulators.forEach((accumulator, index) => {
    const plan = plans[index];
    // After every block, before presence is read: a calculated column's plane
    // needs its operands complete across the whole year, and finalizeCase is
    // what turns plan.presence into the per-(area, metric) bitmap.
    warnings.push(...applyDerived(accumulator));
    const finalized = finalizeCase(
      accumulator,
      plan.file.name,
      plan.header.metricNames,
      plan.year,
      areas,
    );
    cases.push(finalized.data);
    warnings.push(...finalized.warnings);
  });

  return { cases, warnings };
}
