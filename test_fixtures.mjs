// test_fixtures.mjs
//
// Synthetic test data, generated in memory. NOTHING data-shaped is tracked in
// this repo: the real export and the real area -> grouping rollup are
// gitignored local files, and the tests never read them.
//
// The synthetic export is not decorative. It has to reproduce every property
// the ingest tests actually gate on, because a fixture that quietly loses one
// turns a real parser bug into a passing run:
//
//   * CRLF throughout, so the last-column trailing-\r trap is exercised
//     (footgun 16). The last numeric column is populated in every row, or the
//     check that covers that trap compares nothing and passes vacuously.
//   * Exactly the legacy WASM fast-path area count, every one present in every
//     hour. Separate ingest tests cover variable area counts and row order.
//   * Exponent notation, which is in the real exports and parsed to NaN for a
//     whole build before the parity test caught it (footgun 24).
//   * Both TOU labels, since TOU is read from the file and never recomputed
//     (footgun 17).
//   * A leap year, so the D4 Feb 29 statement has something to fire on.
//   * Stray spaces in the header (` Hour`, ` TOU`, ` Name`), which the real
//     export has and which is why columns map by TRIMMED name (footgun 18).
//   * Enough bytes to split into several blocks at the sizes the tests use.
//
// Column NAMES come from data/aggregation-rules.json — they are the GridView
// product's schema, not any utility's data. Area names and every value here
// are invented.

import { readFileSync } from 'node:fs';

const rules = JSON.parse(
  readFileSync(new URL('./data/aggregation-rules.json', import.meta.url), 'utf8'),
);

/** Generic area axis. Distinctness matters: block.c routes rows by FNV-1a of
 * the name, and a collision would file one area's rows into another's plane
 * with no error at all. test_ingest asserts that via areaHashes(). */
export const AREAS = Array.from({ length: 43 }, (_, i) => `AREA${String(i + 1).padStart(2, '0')}`);

/** Five groups over the 43 areas, the same shape as a real rollup: uneven
 * sizes, every area in exactly one group. */
export const GROUPS = [
  ['Zone 1', AREAS.slice(0, 2)],
  ['Zone 2', AREAS.slice(2, 11)],
  ['Zone 3', AREAS.slice(11, 23)],
  ['Zone 4', AREAS.slice(23, 34)],
  ['Zone 5', AREAS.slice(34)],
];

/** A Groupings.csv: one row per (area, group), header included. */
export function groupingsCsv() {
  const lines = ['Name,Grouping'];
  for (const [group, members] of GROUPS) for (const area of members) lines.push(`${area},${group}`);
  return lines.join('\n') + '\n';
}

/** Deterministic; a fixture that changes between runs cannot be compared
 * against anything. Mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Non-leap month lengths. Feb 29 is never emitted even in a leap year --
 * ingest drops it (D4), so a fixture that contained it would be testing a row
 * the app is defined to throw away. */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function headerLine(metrics) {
  // The real header carries stray leading spaces on three key columns and on
  // some metrics. Columns map by trimmed name precisely so this is harmless --
  // keep it, or the test stops proving that.
  return ['Date', ' Hour', ' TOU', ' Name', ...metrics.map((n, i) => (i % 7 === 3 ? ` ${n}` : n))].join(',');
}

/**
 * Emit the export row by row. `days` calendar days from Jan 1, `hours` of
 * hour-ending 1..24 within each -- block.c rejects an Hour outside that range,
 * so a longer file has to advance the DATE, not the hour.
 */
function* rows({ year, days, hours, seed }) {
  // Calculated columns (`derived`) are computed at ingest from other planes and
  // are in NO real export's header. Emitting one here would misrepresent the
  // format and stop this fixture from exercising the WASM fast path.
  const metrics = rules.columns
    .filter((column) => column.derived === undefined)
    .map((column) => column.canonical.trim());
  const next = rng(seed);
  yield headerLine(metrics);

  let month = 1;
  let day = 1;
  for (let d = 0; d < days; d++) {
    for (let hour = 1; hour <= hours; hour++) {
      const tou = hour % 2 === 0 ? 'OnPeak' : 'OffPeak';
      for (const area of AREAS) {
        const fields = [`${month}/${day}/${year}`, String(hour), tou, area];
        for (let m = 0; m < metrics.length; m++) fields.push(value(next, m));
        yield fields.join(',');
      }
    }
    if (++day > MONTH_LENGTHS[month - 1]) {
      day = 1;
      month++;
    }
  }
}

/** One synthetic export as raw bytes. Small by default — the ingest tests want
 * a couple of hours, not a year. Use `writeExportCsv` for anything large. */
export function exportCsv({ year = 2036, days = 1, hours = 2, seed = 12345 } = {}) {
  // CRLF throughout, including a terminator on the final row.
  return new TextEncoder().encode([...rows({ year, days, hours, seed })].join('\r\n') + '\r\n');
}

/**
 * Stream a full-size export to `path`. A year of 43 areas x 50 metrics is
 * ~190 MB — joining that as one string is how a fixture generator turns into
 * an out-of-memory crash, so this writes incrementally.
 */
export async function writeExportCsv(path, { year = 2036, days = 365, hours = 24, seed = 12345 } = {}) {
  const { createWriteStream } = await import('node:fs');
  const { once } = await import('node:events');
  const out = createWriteStream(path);
  let chunk = '';
  for (const row of rows({ year, days, hours, seed })) {
    chunk += row + '\r\n';
    if (chunk.length > 1 << 20) {
      if (!out.write(chunk)) await once(out, 'drain');
      chunk = '';
    }
  }
  if (chunk) out.write(chunk);
  out.end();
  await once(out, 'finish');
  return path;
}

/** One field. The shapes are chosen to cover what block.c's number parser has
 * to survive, not to look like plausible power-system output. */
function value(next, index) {
  const r = next();
  if (index % 17 === 5) return '0';
  // Exponent notation -- real exports carry `7E-05` and it parsed to NaN for a
  // whole build (footgun 24).
  if (index % 23 === 7) return `${(r * 9 + 1).toFixed(0)}E-05`;
  if (index % 11 === 2) return (-r * 1000).toFixed(6);
  // Eight significant digits: the shape that makes block.c's two-step rounding
  // differ from strtod by under one ulp on a handful of cells.
  if (index % 13 === 4) return (r * 100000).toFixed(8);
  return (r * 500).toFixed(6);
}
