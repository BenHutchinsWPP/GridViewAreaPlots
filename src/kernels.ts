// src/kernels.ts
//
// Pure functions over typed arrays. No DOM, no allocation per interaction.
//
// Three rules run through every function in here:
//
//   1. **f32 is storage, f64 is arithmetic.** Values are read from a
//      Float32Array and accumulated in plain JS numbers. Naive f32 stddev
//      measures 58% wrong at one case and 878% wrong at ten (footgun 11).
//   2. **The presence bitmap is consulted before the cube, always.** A
//      metric a case never exported is NaN in memory, and NaN does not
//      announce itself: it poisons Welford, makes every min/max comparison
//      false, and sorts to one end of a duration curve as a cliff of
//      apparent extremes (footgun 21). Absent pairs are refused up front.
//   3. **The series is built before it is filtered.** A grouping is
//      collapsed to one 8,760-point series first, so every sort is over
//      <= 8,760 points rather than 376,680 (D5).
//
// Sorting, not filtering, is the interaction cost (footgun 14), so gathers
// and sorts go through a caller-owned scratch buffer that is allocated once
// and reused.

import { HOURS_PER_YEAR } from './calendar';
import { ruleFor } from './rules';
import type { CaseData, ColumnRule } from './types';

/** One 8,760-point buffer, allocated once per case by the UI and reused for
 * every interaction. Never allocate one inside a render path. */
export function createScratch(): Float32Array {
  return new Float32Array(HOURS_PER_YEAR);
}

export interface SeriesResult {
  /** The per-hour series, or null when the request was refused. */
  values: Float32Array | null;
  rule: ColumnRule | null;
  /** Set when values is null: what to show in the pane instead of a chart.
   * Panes render this inline rather than as a toast (GUI decision 7). */
  refusal?: string;
  /** For WEIGHTED_MEAN: the weight column actually used, and its per-hour
   * sum over the selected areas. The stats table needs the weights to
   * recompute a pooled average -- the mean of a weighted-mean series is not
   * the weighted mean (footgun 15). */
  weightColumn?: string;
  weights?: Float32Array;
  /** Non-fatal notes for the pane header. */
  warnings: string[];
}

function refuse(reason: string, rule: ColumnRule | null = null): SeriesResult {
  return { values: null, rule, refusal: reason, warnings: [] };
}

/** 1 = this case has real data for the pair; 0 = the plane is NaN. */
export function hasData(data: CaseData, areaIndex: number, metricIndex: number): boolean {
  return data.presence[areaIndex * data.metrics.length + metricIndex] === 1;
}

/** Area indices that both exist in this case and carry the metric. */
function resolveAreas(data: CaseData, areas: string[], metricIndex: number): number[] {
  const out: number[] = [];
  for (const name of areas) {
    const index = data.areas.indexOf(name);
    if (index >= 0 && hasData(data, index, metricIndex)) out.push(index);
  }
  return out;
}

function planeStart(data: CaseData, areaIndex: number, metricIndex: number): number {
  return (areaIndex * data.metrics.length + metricIndex) * HOURS_PER_YEAR;
}

/**
 * Build one 8,760-point series for `areas` x `metric`, dispatching on the
 * rule table's `series` enum. `data/aggregation-rules.json` is imported, not
 * re-derived -- summing a $/MWh column across areas is physically
 * meaningless and the chart would still render (footgun 7).
 */
export function buildSeries(
  data: CaseData,
  metric: string,
  areas: string[],
  out: Float32Array,
  /** Caller-owned buffer for the per-hour weight sum. Required for
   * WEIGHTED_MEAN columns; allocating one here would put a 35 KB allocation
   * in the render path, per case, on every interaction. */
  weightsOut?: Float32Array,
): SeriesResult {
  const rule = ruleFor(metric);
  if (!rule) {
    return refuse(`No aggregation rule for "${metric}". Refusing rather than guessing one.`);
  }

  const metricIndex = data.metrics.indexOf(metric);
  if (metricIndex < 0) {
    const everExported = data.sourceColumns.some((c) => c.trim() === metric);
    return refuse(
      everExported
        ? `"${metric}" is in ${data.name} but was not retained at load. Re-ingest to plot it.`
        : `"${metric}" is not in ${data.name}.`,
      rule,
    );
  }

  const areaIndices = resolveAreas(data, areas, metricIndex);
  if (areaIndices.length === 0) {
    return refuse(`${data.name} has no data for "${metric}" in the selected area(s).`, rule);
  }

  const warnings: string[] = [];

  // A single area needs no aggregation at all: the stored plane IS the
  // series. Worth special-casing because the weighted-mean path would
  // otherwise turn a perfectly good value into NaN in every hour where the
  // weight happens to be zero.
  if (areaIndices.length === 1) {
    const start = planeStart(data, areaIndices[0], metricIndex);
    out.set(data.cube.subarray(start, start + HOURS_PER_YEAR));
    return { values: out, rule, warnings };
  }

  if (rule.intraGroupHazard) {
    warnings.push(
      `"${metric}" double-counts when summed across areas that trade with each other; ` +
        `read the grouping total with that in mind.`,
    );
  }

  if (rule.series === 'SUM' || rule.series === 'MEAN') {
    combineAreas(data, areaIndices, metricIndex, out, rule.series === 'MEAN');
    return { values: out, rule, warnings };
  }

  // WEIGHTED_MEAN. The weight column is a hard dependency: without it the
  // only available fallback is a plain mean, which is exactly the wrong
  // answer, so the pane refuses instead (footgun 20).
  const candidates = [rule.weight, rule.fallbackWeight].filter(
    (name): name is string => typeof name === 'string',
  );
  for (const weightName of candidates) {
    const weightIndex = data.metrics.indexOf(weightName);
    if (weightIndex < 0) continue;
    const weightAreas = resolveAreas(data, areas, weightIndex);
    if (weightAreas.length === 0) continue;

    const weights = weightsOut ?? new Float32Array(HOURS_PER_YEAR);
    const zeroHours = weightedMeanAreas(data, areaIndices, metricIndex, weightIndex, out, weights);
    if (zeroHours === HOURS_PER_YEAR) continue; // weight is identically zero; try the fallback
    if (zeroHours > 0) {
      warnings.push(
        `${zeroHours.toLocaleString()} hour(s) have a total "${weightName}" of zero and read ` +
          `as no-data rather than as a plain mean.`,
      );
    }
    return { values: out, rule, weightColumn: weightName, weights, warnings };
  }

  const named = candidates.length > 0 ? candidates.join('" or "') : '(none declared)';
  return refuse(
    `"${metric}" is a weighted mean across areas and needs its weight column "${named}", ` +
      `which ${data.name} does not carry. Re-ingest with that column retained.`,
    rule,
  );
}

/**
 * SUM and MEAN across areas: the same accumulation, differing only in whether
 * the hour's total is divided by the areas that contributed. `divide` is
 * loop-invariant, so this is one predictable branch per hour rather than the
 * two near-identical kernels this replaced.
 *
 * No contributing area is NaN, never 0 -- an hour no area reported is absent,
 * not zero, and every kernel downstream refuses NaN rather than averaging it
 * in (footgun 21).
 */
function combineAreas(
  data: CaseData,
  areaIndices: number[],
  metricIndex: number,
  out: Float32Array,
  divide: boolean,
): void {
  const { cube } = data;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    let total = 0;
    let seen = 0;
    for (let a = 0; a < areaIndices.length; a++) {
      const value = cube[planeStart(data, areaIndices[a], metricIndex) + hour];
      if (Number.isNaN(value)) continue;
      total += value;
      seen++;
    }
    out[hour] = seen === 0 ? NaN : divide ? total / seen : total;
  }
}

/** Returns the number of hours whose weight sum was zero (written as NaN). */
function weightedMeanAreas(
  data: CaseData,
  areaIndices: number[],
  metricIndex: number,
  weightIndex: number,
  out: Float32Array,
  weightsOut: Float32Array,
): number {
  const { cube } = data;
  let zeroHours = 0;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    let weighted = 0;
    let weight = 0;
    for (let a = 0; a < areaIndices.length; a++) {
      const area = areaIndices[a];
      const value = cube[planeStart(data, area, metricIndex) + hour];
      const w = cube[planeStart(data, area, weightIndex) + hour];
      if (Number.isNaN(value) || Number.isNaN(w)) continue;
      weighted += value * w;
      weight += w;
    }
    weightsOut[hour] = weight;
    // Zero total weight is genuinely undefined, not zero. Falling back to a
    // plain mean here is the exact mistake footgun 20 warns about.
    if (weight === 0) {
      out[hour] = NaN;
      zeroHours++;
    } else {
      out[hour] = weighted / weight;
    }
  }
  return zeroHours;
}

/**
 * Gather the hours the mask keeps into `out`, dropping NaN on the way so no
 * kernel downstream ever has to think about it. Returns the count written.
 */
export function applyMask(series: Float32Array, mask: Uint8Array, out: Float32Array): number {
  let n = 0;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    if (mask[hour] === 0) continue;
    const value = series[hour];
    if (Number.isNaN(value)) continue;
    out[n++] = value;
  }
  return n;
}

export interface Stats {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation (n-1), NaN for n < 2. */
  sd: number;
}

/**
 * Welford in f64. Never `sum(x^2)`: it catastrophically cancels when the
 * mean is large relative to the spread, which is exactly the shape of the MW
 * and k$ columns (footgun 11).
 */
export function stats(values: Float32Array, n: number): Stats {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue; // belt and braces; applyMask already drops these
    count++;
    const delta = value - mean;
    mean += delta / count;
    m2 += delta * (value - mean);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (count === 0) return { n: 0, mean: NaN, min: NaN, max: NaN, sd: NaN };
  return {
    n: count,
    mean,
    min,
    max,
    sd: count < 2 ? NaN : Math.sqrt(m2 / (count - 1)),
  };
}

/**
 * The single sort call site in the app. Sorts `buffer[0, n)` ascending, in
 * place. D12 deferred the LSD radix sort behind this one function: the
 * builtin lands the 10-case duration curve at 56-126 ms against a 250 ms
 * gate, so radix comes back only against a real failing browser measurement,
 * and swapping it is a one-function change.
 */
export function sortAsc(buffer: Float32Array, n: number): Float32Array {
  const view = buffer.subarray(0, n);
  view.sort();
  return view;
}

export interface Quantiles {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /** Tukey fences: the furthest values still within 1.5 x IQR. */
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number;
  /** True when p25 = median = p75 -- the shape the all-zero and the mostly-zero
   * columns collapse to. Correct, useless, and looks broken (footgun 19). */
  degenerate: boolean;
}

function percentile(sorted: Float32Array, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const position = q * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * Sorts once and reads every quantile off the same sorted array. One sort
 * serves both the duration curve and the box plot -- they are the same
 * ordering of the same points.
 */
export function quantiles(buffer: Float32Array, n: number): Quantiles {
  const sorted = sortAsc(buffer, n);
  if (n === 0) {
    return {
      n: 0,
      min: NaN,
      p25: NaN,
      median: NaN,
      p75: NaN,
      max: NaN,
      lowerWhisker: NaN,
      upperWhisker: NaN,
      outliers: 0,
      degenerate: false,
    };
  }

  const p25 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const p75 = percentile(sorted, 0.75);
  const fence = 1.5 * (p75 - p25);

  // Walk in from both ends: the array is sorted, so the whiskers are the
  // first values inside the fences and everything past them is an outlier.
  let low = 0;
  while (low < n && sorted[low] < p25 - fence) low++;
  let high = n - 1;
  while (high >= 0 && sorted[high] > p75 + fence) high--;

  return {
    n,
    min: sorted[0],
    p25,
    median,
    p75,
    max: sorted[n - 1],
    lowerWhisker: low < n ? sorted[low] : sorted[0],
    upperWhisker: high >= 0 ? sorted[high] : sorted[n - 1],
    outliers: low + (n - 1 - high),
    degenerate: p25 === median && median === p75,
  };
}

/**
 * The pooled weighted average over the selected cells:
 * `sum(value x weight) / sum(weight)`.
 *
 * This is NOT the mean of the plotted per-hour weighted-mean series, and the
 * two disagree visibly because high-price hours are high-load hours. Both
 * are correct; the stats table must label which is which next to the number
 * itself (footgun 15, and the "Average paradox").
 */
export function pooledWeightedMean(
  series: Float32Array,
  weights: Float32Array,
  mask: Uint8Array,
): number {
  let weighted = 0;
  let total = 0;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    if (mask[hour] === 0) continue;
    const value = series[hour];
    const weight = weights[hour];
    if (Number.isNaN(value) || Number.isNaN(weight)) continue;
    weighted += value * weight;
    total += weight;
  }
  return total === 0 ? NaN : weighted / total;
}

/** True when every kept hour is exactly zero. Eight columns in the real
 * export are identically zero; they are valid data, but a flat line at zero
 * looks like a load failure, so the pane says so itself (footgun 19). */
export function isAllZero(values: Float32Array, n: number): boolean {
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (values[i] !== 0) return false;
  }
  return true;
}
