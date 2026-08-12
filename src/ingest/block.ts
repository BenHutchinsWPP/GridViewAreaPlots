// src/ingest/block.ts
//
// The WASM parser's JS side: instantiate the module, tell it this block's
// shape, hand it a block of whole rows, lift the row list back out.
//
// This lives apart from worker.ts on purpose. It is the riskiest index
// arithmetic in the build -- source column -> output plane -- so
// test_ingest.mjs (T4) drives *this* code directly in node rather than a
// reimplementation of it. worker.ts is then only plumbing: read bytes, call
// this, transfer the result.
//
// There is ONE parse path, and it assumes nothing about the file beyond the
// four key columns. An earlier version gated the module on a hardcoded
// 43-area / 50-metric shape and sent everything else to a JS fallback that
// measured 51 MiB/s against the module's 241 MiB/s; a later one required rows
// ordered by (Date, Hour) and refused a value-sorted export. Neither
// restriction is left.

/** block.c's ABI_VERSION. block.wasm is committed, so a stale binary against
 * updated TypeScript has to fail loudly at instantiate. */
export const PARSER_ABI = 5;

export const NEWLINE = 10;

export interface ParserExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  inbuf_ptr(): number;
  inbuf_size(): number;
  arena_bytes(): number;
  configure(
    numAreas: number,
    numPlanes: number,
    maxRows: number,
    sourceMetrics: number,
  ): number;
  plane_of_ptr(): number;
  values_ptr(): number;
  row_area_ptr(): number;
  row_hour_ptr(): number;
  tou_ptr(): number;
  area_seen_ptr(): number;
  last_rows(): number;
  last_emitted(): number;
  last_unknown_area(): number;
  last_dropped_date(): number;
  last_overflow(): number;
  area_table_reset(): void;
  area_table_put(hash: number, idx: number): number;
  parse_block(len: number): number;
  scan_axis(len: number): number;
  axis_names(): number;
  axis_off_ptr(): number;
  axis_len_ptr(): number;
  axis_rows(): number;
  axis_overflow(): number;
}

/**
 * What one block's Name-column pass found.
 *
 * There is deliberately no ordering information here. An earlier version
 * carried an inversion count and the block's hour range, which the
 * hour-windowed slab needed to check that blocks tiled the year. Row order
 * carries no meaning now, so reporting it would only invite a check that
 * refuses a file the parser handles correctly.
 */
export interface AxisScan {
  /** Distinct trimmed area names in this block, in first-seen order. */
  names: string[];
  /** Non-blank rows in this block -- the exact `maxRows` bound for a parse
   * over these same bytes. */
  rows: number;
}

/** Hours in a case. Mirrors calendar.ts HOURS_PER_YEAR and block.c's
 * HOURS_PER_YEAR; kept here so this module stays importable on its own. */
export const HOURS_PER_YEAR = 8760;

/**
 * One parsed block: a ROW LIST, not a slab.
 *
 * Every row carries its own placement, so nothing here depends on the order
 * rows appeared in the file. An earlier version returned an hour-windowed
 * slab, which required a block to be a contiguous run of hours and refused a
 * value-sorted export outright.
 */
export interface BlockPayload {
  /** Rows with a usable (area, hour). Feb 29 and unplaceable rows are not here. */
  rows: number;
  /** Non-blank rows the block contained, whether or not they were placed. */
  scanned: number;
  planes: number;
  /** values[row * planes + p] for active plane p. */
  values: Float32Array;
  rowArea: Uint16Array;
  rowHour: Uint16Array;
  /** Per-hour TOU code straight from the file's TOU column; 0xFF = uncovered. */
  tou: Uint8Array;
  /** 1 = this area had at least one row in the block. */
  areaSeen: Uint8Array;
}

/** A block that contributed nothing. Freshly allocated every time: the
 * buffers are transferred out of the worker, and a transferred buffer is
 * detached, so a shared constant would break the second empty block. */
function emptyPayload(areaCount: number, planes: number): BlockPayload {
  return {
    rows: 0,
    scanned: 0,
    planes,
    values: new Float32Array(0),
    rowArea: new Uint16Array(0),
    rowHour: new Uint16Array(0),
    tou: new Uint8Array(0),
    areaSeen: new Uint8Array(areaCount),
  };
}

/**
 * Instantiate the parser and fill its area hash table. Every worker needs
 * its own instance: linear memory cannot be shared without SharedArrayBuffer,
 * which D2 forbids on GitHub Pages.
 *
 * The hash table is static in block.c and filled once here, because the axis
 * is fixed for the pool's lifetime -- pool.ts tears the pool down and rebuilds
 * it when the axis changes. Nothing later may move or re-mask it.
 */
export async function instantiateParser(
  module: WebAssembly.Module,
  hashes?: Uint32Array,
): Promise<ParserExports> {
  const instance = await WebAssembly.instantiate(module, {});
  const parser = instance.exports as unknown as ParserExports;
  if (parser.abi_version?.() !== PARSER_ABI) {
    throw new Error(
      `block.wasm reports ABI ${parser.abi_version?.()} but this module expects ` +
        `${PARSER_ABI}. Rebuild parser/block.wasm with parser/build.sh and commit it.`,
    );
  }
  parser.area_table_reset();
  if (hashes) loadAreaAxis(parser, hashes);
  return parser;
}

/** Fill the module's area hash table. The axis is not known until the scan
 * pass has run, so this is separate from instantiate. */
export function loadAreaAxis(parser: ParserExports, hashes: Uint32Array): void {
  parser.area_table_reset();
  for (let i = 0; i < hashes.length; i++) {
    if (!parser.area_table_put(hashes[i], i)) {
      throw new Error(
        `block.wasm's area table is full at ${hashes.length} areas. Raise AREA_TABLE in ` +
          `parser/block.c and rebuild.`,
      );
    }
  }
}

/** Copy a block into the module's input window, terminating a final row that
 * has no newline of its own. Returns the length the module should read. */
function loadInbuf(parser: ParserExports, bytes: Uint8Array, from: number, to: number): number {
  const inbufPtr = parser.inbuf_ptr();
  const inbufSize = parser.inbuf_size();
  const length = to - from;
  if (length + 1 > inbufSize) {
    throw new Error(`Block of ${length} B exceeds the ${inbufSize} B WASM input window.`);
  }
  const memory = new Uint8Array(parser.memory.buffer);
  memory.set(bytes.subarray(from, to), inbufPtr);
  let padded = length;
  // The module only emits a row once it sees the terminator, so a file that
  // does not end in a newline would otherwise lose its final row.
  if (memory[inbufPtr + padded - 1] !== NEWLINE) memory[inbufPtr + padded++] = NEWLINE;
  return padded;
}

/**
 * Read one block's Name column only: every distinct area name, and how many
 * non-blank rows the block holds.
 *
 * This exists because the area axis is data and used to be guessed. The old
 * rule -- read Name from the first rows until one repeats -- assumes the first
 * hour lists every area exactly once, and returns a short axis with no
 * complaint when it does not. Reading every row costs about a quarter of a full
 * parse, because the metric fields are skipped whole rather than split.
 */
export function scanAxis(
  parser: ParserExports,
  bytes: Uint8Array,
  from: number,
  to: number,
): AxisScan {
  if (to - from <= 0) return { names: [], rows: 0 };

  const padded = loadInbuf(parser, bytes, from, to);
  const rows = parser.scan_axis(padded);

  const overflow = parser.axis_overflow();
  if (overflow > 0) {
    throw new Error(
      `This export carries more distinct area names than the parser can hold. The area axis is ` +
        `read from the Name column, so a file whose Name column is not an area code produces ` +
        `one "area" per row.`,
    );
  }

  const count = parser.axis_names();
  const inbufPtr = parser.inbuf_ptr();
  const offsets = new Uint32Array(parser.memory.buffer, parser.axis_off_ptr(), count);
  const lengths = new Uint32Array(parser.memory.buffer, parser.axis_len_ptr(), count);
  const memory = new Uint8Array(parser.memory.buffer);
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = inbufPtr + offsets[i];
    names.push(decoder.decode(memory.subarray(at, at + lengths[i])));
  }

  return { names, rows };
}

/**
 * Parse `bytes[from, to)` -- which must start at a row boundary and end just
 * after a `\n` -- into a row list of the retained planes.
 *
 * `maxRows` bounds the output and comes from the axis scan over this same byte
 * range, so it is exact rather than a guess. The module reports an overflow if
 * it ever needs more, which is refused rather than truncated.
 *
 * Position-independent twice over: a row's placement comes from its own
 * fields, so any block can be parsed by any worker in any order (D10), and the
 * rows inside a block may be in any order at all.
 */
export function parseBytes(
  parser: ParserExports,
  bytes: Uint8Array,
  from: number,
  to: number,
  activePlanes: Int32Array,
  areaCount: number,
  sourceMetricCount: number,
  maxRows: number,
): BlockPayload {
  const planes = activePlanes.length;
  if (to - from <= 0 || maxRows === 0) return emptyPayload(areaCount, planes);

  // The arena is laid out for THIS block. Anything that reads WASM memory must
  // do so after this call, never across it.
  if (!parser.configure(areaCount, planes, maxRows, sourceMetricCount)) {
    throw new Error(
      `A block of ${maxRows.toLocaleString()} rows x ${planes} retained column(s) does not fit ` +
        `the ${parser.arena_bytes()} B parser arena. Retain fewer columns, or lower ` +
        `BLOCK_TARGET_BYTES so blocks hold fewer rows.`,
    );
  }

  // Source metric -> output plane, rebuilt on every block. It is NOT a function
  // of the shape: two cases can carry the same area and column counts in a
  // different column order (schema drift is real in both membership and
  // order), and one pool interleaves blocks from every case. Caching this by
  // shape would feed one case's block another case's column mapping, which is
  // footgun 18 with no error attached.
  const planeOf = new Int32Array(parser.memory.buffer, parser.plane_of_ptr(), sourceMetricCount);
  planeOf.fill(-1);
  for (let p = 0; p < planes; p++) planeOf[activePlanes[p]] = p;

  const scanned = parser.parse_block(loadInbuf(parser, bytes, from, to));

  const overflow = parser.last_overflow();
  if (overflow > 0) {
    throw new Error(
      `${overflow} row(s) past the ${maxRows.toLocaleString()} the axis scan counted for this ` +
        `block. Both passes must see the same bytes.`,
    );
  }
  const unknown = parser.last_unknown_area();
  if (unknown > 0) {
    throw new Error(
      `${unknown} row(s) carry an area name that is not on the area axis. The axis is read from ` +
        `the Name column of every row, so this should be unreachable; the load is refused ` +
        `rather than dropping them.`,
    );
  }

  const rows = parser.last_emitted();
  if (rows === 0) return emptyPayload(areaCount, planes);

  return {
    rows,
    scanned,
    planes,
    values: new Float32Array(parser.memory.buffer, parser.values_ptr(), rows * planes).slice(),
    rowArea: new Uint16Array(parser.memory.buffer, parser.row_area_ptr(), rows).slice(),
    rowHour: new Uint16Array(parser.memory.buffer, parser.row_hour_ptr(), rows).slice(),
    tou: new Uint8Array(parser.memory.buffer, parser.tou_ptr(), HOURS_PER_YEAR).slice(),
    areaSeen: new Uint8Array(parser.memory.buffer, parser.area_seen_ptr(), areaCount).slice(),
  };
}

/** Index just past the first `\n` at or after `from`, or -1. */
export function afterNextNewline(bytes: Uint8Array, from: number): number {
  const at = bytes.indexOf(NEWLINE, Math.max(0, from));
  return at < 0 ? -1 : at + 1;
}
