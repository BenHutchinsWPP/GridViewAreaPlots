// src/ingest/header.ts
//
// Header parse, canonical names, column plan.
//
// The one rule this file exists to enforce: **columns are mapped by trimmed
// canonical header name, never by position** (footgun 18). Numeric index 35
// is `RD A. S. Served Amount` in a 47-column export and `FR A. S.
// Requirement` in the 50-column one -- the first is a weight column, the
// second is identically zero. A positional parser swaps them, the weighted
// mean divides by a sum of zeros, and the chart still renders. Nothing
// throws. That is the worst failure available in this project, so the plan
// built here is the only thing standing between the cube and plausible
// wrong numbers.
//
// This module is deliberately free of DOM, Worker and Vite specifics so
// test_ingest.mjs can import it straight into node.

/** block.c treats source col >= 4 as metric (col - 4). Area count and metric
 * count are read from the file; these four key columns are the only fixed part
 * of the layout. */
export const KEY_COLS = 4;

export interface HeaderInfo {
  /** Fields exactly as they appear in the file (CR stripped), for display. */
  raw: string[];
  /** `raw` trimmed -- the key everything else matches on. */
  canonical: string[];
  dateCol: number;
  hourCol: number;
  touCol: number;
  nameCol: number;
  /** Canonical names of the metric columns, in source order. */
  metricNames: string[];
}

export interface ColumnPlan {
  /** The cube's metric axis: the retained list, in cube-metric-index order. */
  metrics: string[];
  /**
   * Indexed by SOURCE column index; value is the cube metric index this
   * column feeds, or -1 to skip. Key columns are always -1.
   */
  plan: Int32Array;
  /**
   * The same mapping indexed by block.c slab plane (`slab plane m` ==
   * `source column m + KEY_COLS`), length `sourceMetricCount`. This is what
   * the worker and the blit both index by, because parsers write metrics
   * positionally into the slab and the plan is applied on the way out.
   */
  slabPlan: Int32Array;
  /** Slab planes with a destination, ascending -- the transfer order. */
  activePlanes: Int32Array;
  /** Per-metric presence: 1 = this case's header carries it, 0 = absent. */
  presence: Uint8Array;
  /** Source metric slots in this file, independent of what was retained. */
  sourceMetricCount: number;
}

/** Strip a trailing CR (footgun 16: exports are CRLF, header included). */
function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Parse a header line into raw + canonical names and locate the four key
 * columns **by name**. The real export's header carries stray spaces
 * (` Hour`, ` TOU`, ` Name`, ` Total Generation Revenue (k$)`) and one
 * missing space (`Import Flow(MWh)`), so the raw string is kept for display
 * and the trimmed string is the key.
 */
export function parseHeaderLine(line: string): HeaderInfo {
  const raw = stripCR(line).split(',');
  const canonical = raw.map((s) => s.trim());

  const at = (name: string): number => {
    const i = canonical.indexOf(name);
    if (i < 0) {
      throw new Error(
        `CSV header is missing the required key column "${name}". Found: ${canonical
          .slice(0, KEY_COLS)
          .map((c) => JSON.stringify(c))
          .join(', ')}`,
      );
    }
    return i;
  };

  const dateCol = at('Date');
  const hourCol = at('Hour');
  const touCol = at('TOU');
  const nameCol = at('Name');

  // parser/block.c hardcodes col 0 = Date, col 1 = Hour, col 3 = Name and
  // treats every col >= 4 as metric (col - 4). We refuse rather than parse
  // a layout the wasm module would silently misread -- the whole point of
  // this file is that silent misreads are the failure mode here.
  if (dateCol !== 0 || hourCol !== 1 || nameCol !== 3 || touCol >= KEY_COLS) {
    throw new Error(
      `Unsupported column layout: parser/block.c requires the key columns in the ` +
        `canonical order Date,Hour,TOU,Name at indices 0-3, but this export has ` +
        `Date@${dateCol}, Hour@${hourCol}, TOU@${touCol}, Name@${nameCol}.`,
    );
  }

  const metricNames = canonical.slice(KEY_COLS);
  return { raw, canonical, dateCol, hourCol, touCol, nameCol, metricNames };
}

/**
 * Union schema across cases: every metric canonical name seen in any
 * header, in first-seen order. Schema drift is real in both membership
 * *and* order, so the cube's metric axis is this union plus a per-case
 * presence bitmap -- never one file's column order.
 */
export function unionSchema(headers: HeaderInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of headers) {
    for (const name of h.metricNames) {
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Build the source-column -> cube-metric plan for one file against the
 * retained metric list. `retained` defines the cube's metric axis and its
 * index order; this file's own column order is irrelevant beyond locating
 * the bytes.
 */
export function buildColumnPlan(header: HeaderInfo, retained: string[]): ColumnPlan {
  const metrics = retained.map((n) => n.trim());
  const wanted = new Map<string, number>();
  for (let i = 0; i < metrics.length; i++) {
    if (!wanted.has(metrics[i])) wanted.set(metrics[i], i);
  }

  const plan = new Int32Array(header.canonical.length).fill(-1);
  const presence = new Uint8Array(metrics.length);

  for (let col = KEY_COLS; col < header.canonical.length; col++) {
    const dest = wanted.get(header.canonical[col]);
    if (dest === undefined) continue;
    // A duplicated header name would otherwise double-write one plane;
    // first occurrence wins.
    if (presence[dest]) continue;
    plan[col] = dest;
    presence[dest] = 1;
  }

  const sourceMetricCount = header.metricNames.length;
  const slabPlan = new Int32Array(sourceMetricCount).fill(-1);
  const active: number[] = [];
  for (let m = 0; m < sourceMetricCount; m++) {
    const col = m + KEY_COLS;
    const dest = col < plan.length ? plan[col] : -1;
    slabPlan[m] = dest;
    if (dest >= 0) active.push(m);
  }

  return {
    metrics,
    plan,
    slabPlan,
    activePlanes: Int32Array.from(active),
    presence,
    sourceMetricCount,
  };
}

/**
 * FNV-1a over the name bytes, byte-for-byte identical to block.c's `fnv1a`.
 * block.c strips a trailing CR and then trims spaces and tabs off the Name
 * field before hashing, because the area axis itself is built from trimmed
 * names (pool.ts `readAreaAxis`). Callers must pass an already-trimmed name so
 * both sides hash the same bytes; a padded Name field otherwise reads as an
 * area that is not on the axis and refuses a file that is merely spaced.
 */
export function fnv1a(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0x7f) {
      throw new Error(
        `Area name "${name}" contains a non-ASCII character; block.c hashes raw ` +
          `bytes, so the JS-side hash would not match.`,
      );
    }
    h ^= c;
    // FNV prime 0x01000193, kept in uint32 via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Hash every area name for block.c's open-addressed table, and prove the
 * hashes are distinct. A collision would route one area's rows into
 * another area's cube plane with no error at all.
 */
export function areaHashes(areas: string[]): Uint32Array {
  const out = new Uint32Array(areas.length);
  const seen = new Map<number, string>();
  for (let i = 0; i < areas.length; i++) {
    // Trimmed on both sides, always: block.c trims the Name field before
    // hashing, and a mismatch here routes rows to no area at all.
    const h = fnv1a(areas[i].trim());
    const clash = seen.get(h);
    if (clash !== undefined) {
      throw new Error(`FNV-1a collision between area names "${clash}" and "${areas[i]}".`);
    }
    seen.set(h, areas[i]);
    out[i] = h;
  }
  return out;
}

/**
 * Cumulative days before each month, non-leap -- the same table block.c
 * uses. Feb 29 is dropped at ingest (D4) so leap years share it.
 */
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** Day-of-year (0-based) for a 1-based month/day, or -1 for Feb 29 / invalid. */
export function dayOfYear(month: number, day: number): number {
  if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
  if (month === 2 && day === 29) return -1; // D4: Feb 29 dropped
  return CUM[month - 1] + day - 1;
}
