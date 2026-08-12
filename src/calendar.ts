// src/calendar.ts
//
// The global 8,760-hour calendar: one packed Uint32Array built once per
// year and memoized. Every field is index arithmetic, never a Date object:
// `new Date(str)` shifts rows by a day in half the world's timezones. Hours
// are the fixed 24 hours of a non-leap year; Feb 29 is dropped at ingest.
//
// Bit layout of one packed entry (LSB first):
//   month      bits  0- 3  (4 bits)  1-12
//   dayOfMonth bits  4- 8  (5 bits)  1-31
//   dayOfWeek  bits  9-11  (3 bits)  0-6, 0 = Monday .. 6 = Sunday
//   hourOfDay  bits 12-16  (5 bits)  1-24 (hour-ending, HE)
//   season     bits 17-18  (2 bits)  0=Winter 1=Spring 2=Summer 3=Fall

import type { Filters } from './types';

export const HOURS_PER_YEAR = 8760;

// Non-leap month lengths. Feb is always 28 here -- Feb 29 is dropped at
// ingest (D4), so this table never varies by year.
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTH_SHIFT = 0;
const MONTH_BITS = 4;
const MONTH_MASK = (1 << MONTH_BITS) - 1;

const DAY_SHIFT = MONTH_SHIFT + MONTH_BITS;
const DAY_BITS = 5;
const DAY_MASK = (1 << DAY_BITS) - 1;

const DOW_SHIFT = DAY_SHIFT + DAY_BITS;
const DOW_BITS = 3;
const DOW_MASK = (1 << DOW_BITS) - 1;

const HOUR_SHIFT = DOW_SHIFT + DOW_BITS;
const HOUR_BITS = 5;
const HOUR_MASK = (1 << HOUR_BITS) - 1;

const SEASON_SHIFT = HOUR_SHIFT + HOUR_BITS;
const SEASON_BITS = 2;
const SEASON_MASK = (1 << SEASON_BITS) - 1;

export const SEASON_NAMES = ['Winter', 'Spring', 'Summer', 'Fall'] as const;

/** Display names for the calendar's own axes, next to SEASON_NAMES and
 * TOU_LABELS. The rail, the box-plot categories and the chart axis all label
 * the same twelve months and the same seven days -- three private copies is
 * three chances for them to disagree. `DAY_NAMES` is indexed by this file's
 * dayOfWeek convention: 0 = Monday .. 6 = Sunday. */
export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * TOU categories, indexed by the code stored in CaseData.tou. TOU is read
 * from the file and never recomputed; utilities vary the OnPeak window but the
 * file only distinguishes OnPeak/OffPeak.
 */
export const TOU_LABELS = ['OffPeak', 'OnPeak'] as const;

export function getMonth(entry: number): number {
  return (entry >>> MONTH_SHIFT) & MONTH_MASK;
}

export function getDayOfMonth(entry: number): number {
  return (entry >>> DAY_SHIFT) & DAY_MASK;
}

export function getDayOfWeek(entry: number): number {
  return (entry >>> DOW_SHIFT) & DOW_MASK;
}

export function getHourOfDay(entry: number): number {
  return (entry >>> HOUR_SHIFT) & HOUR_MASK;
}

export function getSeason(entry: number): number {
  return (entry >>> SEASON_SHIFT) & SEASON_MASK;
}

function seasonOf(month: number): number {
  if (month === 12 || month <= 2) return 0; // Winter: Dec/Jan/Feb
  if (month <= 5) return 1; // Spring: Mar/Apr/May
  if (month <= 8) return 2; // Summer: Jun/Jul/Aug
  return 3; // Fall: Sep/Oct/Nov
}

/**
 * Day of week via Sakamoto's algorithm -- pure integer arithmetic, no Date
 * object anywhere (footgun 3). Returns 0=Monday .. 6=Sunday.
 */
function dayOfWeek(year: number, month: number, day: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let y = year;
  if (month < 3) y -= 1;
  const sundayZero =
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[month - 1] + day) % 7;
  return (sundayZero + 6) % 7; // remap 0=Sunday..6=Saturday -> 0=Monday..6=Sunday
}

const cache = new Map<number, Uint32Array>();

/** Build (or return the memoized) packed calendar for `year`. Year-independent
 * except for day-of-week, so cases with different years (2034/2035/2044)
 * each get their own array, built once. */
export function buildCalendar(year: number): Uint32Array {
  const cached = cache.get(year);
  if (cached) return cached;

  const calendar = new Uint32Array(HOURS_PER_YEAR);
  let h = 0;
  for (let month = 1; month <= 12; month++) {
    const season = seasonOf(month);
    const length = MONTH_LENGTHS[month - 1];
    for (let day = 1; day <= length; day++) {
      const dow = dayOfWeek(year, month, day);
      for (let hourOfDay = 1; hourOfDay <= 24; hourOfDay++) {
        calendar[h++] =
          (month << MONTH_SHIFT) |
          (day << DAY_SHIFT) |
          (dow << DOW_SHIFT) |
          (hourOfDay << HOUR_SHIFT) |
          (season << SEASON_SHIFT);
      }
    }
  }
  cache.set(year, calendar);
  return calendar;
}

/**
 * Build a keep-mask over the calendar: length 8,760, 1 = keep. `null` in
 * any Filters field means "no constraint" on that dimension. Bitmask tests
 * only -- no Date, no allocation beyond the returned array (pass `out` to
 * reuse a buffer across calls so the UI never allocates per interaction).
 * TOU is read from `touBitmap` (per-case file data), never derived here
 * (footgun 17).
 */
export function buildMask(
  filters: Filters,
  calendar: Uint32Array,
  touBitmap: Uint8Array,
  out?: Uint8Array
): Uint8Array {
  const mask = out ?? new Uint8Array(calendar.length);
  const { months, hoursOfDay, daysOfWeek: daysOfWeekFilter, seasons, tou } = filters;

  for (let h = 0; h < calendar.length; h++) {
    const entry = calendar[h];
    let keep = 1;
    if (months !== null && !months.has(getMonth(entry))) keep = 0;
    else if (daysOfWeekFilter !== null && !daysOfWeekFilter.has(getDayOfWeek(entry))) keep = 0;
    else if (hoursOfDay !== null && !hoursOfDay.has(getHourOfDay(entry))) keep = 0;
    else if (seasons !== null && !seasons.has(SEASON_NAMES[getSeason(entry)])) keep = 0;
    else if (tou !== null && !tou.has(TOU_LABELS[touBitmap[h]])) keep = 0;
    mask[h] = keep;
  }
  return mask;
}
