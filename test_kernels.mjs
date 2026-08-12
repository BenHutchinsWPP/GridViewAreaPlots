// test_kernels.mjs — T5, the aggregation and statistics kernels.
//
// Plain node, assert-based, no test framework (CLAUDE.md hard rule 6).
// Exits non-zero on any failure.
//
// The cases here are chosen to fail loudly on the footguns that otherwise
// produce plausible numbers:
//
//   * Welford in f64 against a hand-computed dataset, and against one whose
//     mean is large relative to its spread — the shape where naive f32
//     `sum(x^2)` measures 58–878% wrong (footgun 11).
//   * A weighted mean worked out by hand over 3 areas x 2 hours, because
//     `sum(x*w)/sum(w)` is not any kind of average of the per-area values
//     (footgun 7).
//   * `sum(w) == 0` must yield no-data, NOT zero and NOT a plain mean.
//     The plain mean is precisely the wrong answer (footgun 20).
//   * A NaN in the input must not silently poison the result (footgun 21).
//   * Quantiles against a hand-sorted 9-element array.
//
// Run: node test_kernels.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  buildSeries,
  applyMask,
  stats,
  quantiles,
  sortAsc,
  pooledWeightedMean,
  createScratch,
  isAllZero,
} = await import('./src/kernels.ts');
const { HOURS_PER_YEAR } = await import('./src/calendar.ts');
const { allAreas } = await import('./src/groupings.ts');
const { ruleFor } = await import('./src/rules.ts');

const HOURS = HOURS_PER_YEAR;
const areas = allAreas();

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

function close(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  );
}

/**
 * A CaseData over the first `areaCount` areas and the given metrics.
 * `fill(areaIndex, metricIndex, hour)` returns the value; return NaN to
 * simulate a hole. `absent` lists (area, metric) pairs whose presence bit is
 * 0 — the cube is NaN there, exactly as ingest leaves it.
 */
function makeCase(metrics, areaCount, fill, absent = []) {
  const cube = new Float32Array(areas.length * metrics.length * HOURS).fill(NaN);
  const presence = new Uint8Array(areas.length * metrics.length);
  const absentSet = new Set(absent.map(([a, m]) => `${a}:${m}`));

  for (let area = 0; area < areaCount; area++) {
    for (let metric = 0; metric < metrics.length; metric++) {
      if (absentSet.has(`${area}:${metric}`)) continue;
      presence[area * metrics.length + metric] = 1;
      const base = (area * metrics.length + metric) * HOURS;
      for (let hour = 0; hour < HOURS; hour++) cube[base + hour] = fill(area, metric, hour);
    }
  }
  return {
    name: 'synthetic',
    cube,
    areas,
    metrics,
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: metrics,
    year: 2035,
  };
}

/** A mask that keeps only `hours`. */
function maskOf(hours) {
  const mask = new Uint8Array(HOURS);
  for (const hour of hours) mask[hour] = 1;
  return mask;
}

// ---------------------------------------------------------------- Welford

{
  // Textbook set: mean 5, sum of squared deviations 32, sample sd sqrt(32/7).
  const values = Float32Array.from([2, 4, 4, 4, 5, 5, 7, 9]);
  const result = stats(values, values.length);
  assert.equal(result.n, 8);
  close(result.mean, 5, 1e-12, 'mean');
  close(result.sd, Math.sqrt(32 / 7), 1e-12, 'sample sd');
  assert.equal(result.min, 2);
  assert.equal(result.max, 9);
  ok('Welford matches a hand-computed mean, sample sd, min and max');
}

{
  // The footgun-11 shape: a large mean with a tiny spread. Values are
  // 100000 + 0..99, whose exact sample variance is n(n+1)/12 = 841.6667.
  const n = 100;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = 100000 + i;
  const result = stats(values, n);
  const expectedSd = Math.sqrt((n * (n + 1)) / 12);
  close(result.mean, 100049.5, 1e-9, 'mean of a large-mean series');
  assert.ok(
    Math.abs(result.sd - expectedSd) / expectedSd < 1e-9,
    `sd relative error ${Math.abs(result.sd - expectedSd) / expectedSd} must stay under 1e-9`,
  );

  // What the rejected approach would have produced, computed here in f32 so
  // the number in footgun 11 is reproducible rather than asserted on faith.
  let sum = Math.fround(0);
  let sumSquares = Math.fround(0);
  for (let i = 0; i < n; i++) {
    sum = Math.fround(sum + values[i]);
    sumSquares = Math.fround(sumSquares + Math.fround(values[i] * values[i]));
  }
  const naiveVariance = Math.fround(
    (sumSquares - Math.fround(Math.fround(sum * sum) / n)) / (n - 1),
  );
  const naiveError = Math.abs(Math.sqrt(Math.abs(naiveVariance)) - expectedSd) / expectedSd;
  assert.ok(
    naiveError > 0.01,
    `naive f32 sum(x^2) should be visibly wrong here, but was off by only ${naiveError}`,
  );
  ok(
    `Welford sd is exact to <1e-9 relative where naive f32 sum(x^2) is off by ` +
      `${(naiveError * 100).toFixed(0)}%`,
  );
}

{
  const empty = stats(new Float32Array(0), 0);
  assert.equal(empty.n, 0);
  assert.ok(Number.isNaN(empty.mean) && Number.isNaN(empty.sd));
  const single = stats(Float32Array.from([42]), 1);
  assert.equal(single.mean, 42);
  assert.ok(Number.isNaN(single.sd), 'sample sd of one point is undefined, not 0');
  ok('stats on 0 and 1 points returns NaN rather than a fabricated 0');
}

// ---------------------------------------------------------------- SUM series

{
  const metrics = ['Load (MWh)'];
  assert.equal(ruleFor('Load (MWh)').series, 'SUM');
  // area a, hour h -> 100*(a+1) + h
  const data = makeCase(metrics, 3, (area, _metric, hour) => 100 * (area + 1) + hour);
  const out = createScratch();
  const series = buildSeries(data, 'Load (MWh)', areas.slice(0, 3), out);
  assert.equal(series.refusal, undefined);
  // hour 0: 100 + 200 + 300; hour 5: 105 + 205 + 305
  assert.equal(series.values[0], 600);
  assert.equal(series.values[5], 615);
  ok('SUM adds the member areas hour by hour');
}

{
  // One area is present but has a hole. The sum must skip the hole rather
  // than return NaN for the whole hour, and an hour with nothing at all must
  // be NaN rather than 0.
  const metrics = ['Load (MWh)'];
  const data = makeCase(metrics, 2, (area, _metric, hour) => {
    if (hour === 0) return NaN; // both areas missing
    if (hour === 1 && area === 1) return NaN; // one area missing
    return 10 * (area + 1);
  });
  const series = buildSeries(data, 'Load (MWh)', areas.slice(0, 2), createScratch());
  assert.ok(Number.isNaN(series.values[0]), 'an hour with no data at all must be NaN, not 0');
  assert.equal(series.values[1], 10, 'a partial hour sums what is there');
  assert.equal(series.values[2], 30);
  ok('a NaN in the input neither poisons the hour nor turns no-data into 0');
}

// ---------------------------------------------------------------- MEAN series

{
  const metric = 'Simple Average LMP($/MWh)';
  assert.equal(ruleFor(metric).series, 'MEAN', 'this column is unweighted by definition');
  const data = makeCase([metric], 3, (area) => [10, 20, 60][area]);
  const series = buildSeries(data, metric, areas.slice(0, 3), createScratch());
  assert.equal(series.values[0], 30, '(10 + 20 + 60) / 3');
  ok('MEAN is the plain unweighted mean of the member areas');
}

// ---------------------------------------------------------------- WEIGHTED_MEAN

{
  const price = 'Avg LMP Weighted by Load ($/MWh)';
  const weight = 'Load (MWh)';
  const rule = ruleFor(price);
  assert.equal(rule.series, 'WEIGHTED_MEAN');
  assert.equal(rule.weight, weight);

  // 3 areas x 2 hours, by hand:
  //   hour 0  values 10, 20, 30   weights 1, 2, 3
  //           (10*1 + 20*2 + 30*3) / 6 = 140 / 6 = 23.333...
  //   hour 1  values 10, 20, 30   weights 0, 0, 0  -> no data
  const values = [10, 20, 30];
  const weights = [1, 2, 3];
  const metrics = [price, weight];
  const data = makeCase(metrics, 3, (area, metric, hour) => {
    if (metric === 0) return values[area];
    return hour === 0 ? weights[area] : 0;
  });

  const series = buildSeries(data, price, areas.slice(0, 3), createScratch());
  assert.equal(series.refusal, undefined);
  assert.equal(series.weightColumn, weight);
  close(series.values[0], 140 / 6, 1e-5, 'weighted mean');

  // The plain mean would be 20 — close enough to look right, which is the
  // whole problem.
  assert.notEqual(Math.fround(series.values[0]), 20);

  assert.ok(
    Number.isNaN(series.values[1]),
    'sum(weight) == 0 must be no-data, not 0 and not the plain mean',
  );
  assert.ok(
    series.warnings.some((w) => w.includes('zero')),
    'zero-weight hours must be reported, not silently dropped',
  );
  ok('WEIGHTED_MEAN matches the hand calculation, and sum(w)==0 yields no-data');
}

{
  // The weight column was not retained. There is no honest fallback, so the
  // pane must refuse and name the column to re-ingest (footgun 20).
  const price = 'Avg LMP Weighted by Load ($/MWh)';
  const data = makeCase([price], 3, () => 25);
  const series = buildSeries(data, price, areas.slice(0, 3), createScratch());
  assert.equal(series.values, null, 'must refuse rather than plain-mean');
  assert.ok(series.refusal.includes('Load (MWh)'), 'the refusal must name the missing weight');
  ok('a weighted-mean column with no weight column refuses and names what to re-ingest');
}

{
  // Fallback weight: the primary weight is identically zero, so the rule's
  // declared fallback is used instead.
  const price = 'RD A. S. Price';
  const rule = ruleFor(price);
  assert.equal(rule.weight, 'RD A. S. Served Amount');
  assert.equal(rule.fallbackWeight, 'RD A. S. Requirement');
  const metrics = [price, rule.weight, rule.fallbackWeight];
  const data = makeCase(metrics, 2, (area, metric) => {
    if (metric === 0) return [4, 8][area]; // price
    if (metric === 1) return 0; // primary weight: identically zero
    return [1, 3][area]; // fallback weight
  });
  const series = buildSeries(data, price, areas.slice(0, 2), createScratch());
  assert.equal(series.weightColumn, rule.fallbackWeight);
  close(series.values[0], (4 * 1 + 8 * 3) / 4, 1e-5, 'fallback-weighted mean');
  ok('an identically-zero primary weight falls through to the declared fallback weight');
}

{
  // A single area needs no aggregation, and must not be turned into NaN by a
  // zero weight that is irrelevant when there is nothing to combine.
  const price = 'Avg LMP Weighted by Load ($/MWh)';
  const metrics = [price, 'Load (MWh)'];
  const data = makeCase(metrics, 1, (_area, metric) => (metric === 0 ? 33 : 0));
  const series = buildSeries(data, price, [areas[0]], createScratch());
  assert.equal(series.values[0], 33, 'one area is its own series');
  ok('a single-area selection returns the stored plane, zero weight or not');
}

{
  // Absent (case, metric): presence 0, cube NaN. Must be refused up front
  // rather than producing a NaN series that charts as a gap (footgun 21).
  const metrics = ['Load (MWh)'];
  const data = makeCase(metrics, 2, () => 5, [
    [0, 0],
    [1, 0],
  ]);
  const series = buildSeries(data, 'Load (MWh)', areas.slice(0, 2), createScratch());
  assert.equal(series.values, null);
  assert.ok(series.refusal.includes('no data'));
  ok('an absent (case, metric) pair is refused via the presence bitmap, not read as NaN');
}

{
  // A retained-but-dropped column must say so differently from one the study
  // never had — that distinction is the point of carrying sourceColumns.
  const data = makeCase(['Load (MWh)'], 1, () => 1);
  data.sourceColumns = ['Load (MWh)', 'CO2 Amt'];
  const dropped = buildSeries(data, 'CO2 Amt', [areas[0]], createScratch());
  assert.ok(dropped.refusal.includes('not retained'), dropped.refusal);
  const never = buildSeries(data, 'SO2 Amt', [areas[0]], createScratch());
  assert.ok(!never.refusal.includes('not retained'), never.refusal);
  ok('"dropped at load" and "never in this study" produce different refusals');
}

// ---------------------------------------------------------------- derived ratios
//
// A per-area ratio does not survive a sum: Sum(a/b) != Sum(a)/Sum(b). What
// makes `Generation / Installed Capacity` right for a grouping is that it is a
// WEIGHTED_MEAN weighted by its own DENOMINATOR, which reconstitutes the ratio
// of sums. Both halves of that are checked: the rule table's pairing, and the
// number the kernel actually produces.
{
  const rules = (await import('./data/aggregation-rules.json', { with: { type: 'json' } })).default;
  const divided = rules.columns.filter((column) => column.derived?.op === 'div');
  assert.ok(divided.length > 0, 'expected at least one div-derived column to check');
  for (const column of divided) {
    assert.equal(
      column.series,
      'WEIGHTED_MEAN',
      `${column.canonical}: a per-area ratio summed or plain-averaged across areas is wrong`,
    );
    assert.equal(
      column.weight,
      column.derived.subtrahend,
      `${column.canonical}: the weight must be the denominator, or the collapse is not a ratio of sums`,
    );
  }
  ok(`${divided.length} div-derived column(s) are weighted by their own denominator`);

  // Two areas, deliberately unequal: area 0 is a small plant running flat out,
  // area 1 a large one barely running. The capacity-weighted answer is
  // 900/1100, nowhere near the plain mean of 0.9 and 0.05.
  const RATIO = 'Generation / Installed Capacity';
  const metrics = [RATIO, 'Installed Capacity (MW)', 'Generation (MWh)'];
  const capacity = [100, 1000];
  const generation = [90, 50];
  const data = makeCase(metrics, 2, (area, metric) =>
    metric === 0 ? generation[area] / capacity[area] : metric === 1 ? capacity[area] : generation[area],
  );

  const built = buildSeries(data, RATIO, areas.slice(0, 2), createScratch(), createScratch());
  assert.equal(built.weightColumn, 'Installed Capacity (MW)');
  close(built.values[0], 140 / 1100, 1e-6, 'grouping ratio must be Sum(gen)/Sum(capacity)');
  assert.ok(
    Math.abs(built.values[0] - (0.9 + 0.05) / 2) > 0.1,
    'and must not be the plain mean of the per-area ratios',
  );
  ok('a derived ratio collapses to Sum(numerator)/Sum(denominator), not the mean of ratios');
}

{
  const hazard = ruleFor('Import Flow(MWh)');
  assert.equal(hazard.intraGroupHazard, true);
  const data = makeCase(['Import Flow(MWh)'], 2, () => 7);
  const series = buildSeries(data, 'Import Flow(MWh)', areas.slice(0, 2), createScratch());
  assert.ok(
    series.warnings.some((w) => w.includes('double-counts')),
    'summing a tie flow across both sides double-counts and must say so',
  );
  ok('an intra-group hazard column warns when summed across a grouping');
}

// ---------------------------------------------------------------- mask + gather

{
  const metrics = ['Load (MWh)'];
  const data = makeCase(metrics, 1, (_area, _metric, hour) => (hour === 3 ? NaN : hour));
  const series = buildSeries(data, 'Load (MWh)', [areas[0]], createScratch());
  const scratch = createScratch();
  const n = applyMask(series.values, maskOf([1, 3, 5, 7]), scratch);
  assert.equal(n, 3, 'the NaN hour must be dropped, not gathered');
  assert.deepEqual(Array.from(scratch.subarray(0, n)), [1, 5, 7]);
  ok('applyMask gathers only kept hours and drops NaN on the way through');
}

// ---------------------------------------------------------------- quantiles

{
  // Hand-sorted: 1..9. n = 9, so p25 sits at index 2 exactly, median at 4,
  // p75 at 6 — no interpolation needed, which is what makes it checkable.
  const buffer = createScratch();
  const source = [7, 2, 9, 4, 1, 8, 3, 6, 5];
  source.forEach((value, index) => (buffer[index] = value));
  const q = quantiles(buffer, source.length);
  assert.equal(q.n, 9);
  assert.equal(q.min, 1);
  assert.equal(q.p25, 3);
  assert.equal(q.median, 5);
  assert.equal(q.p75, 7);
  assert.equal(q.max, 9);
  assert.equal(q.outliers, 0);
  assert.equal(q.degenerate, false);
  assert.deepEqual(Array.from(buffer.subarray(0, 9)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  ok('quantiles on a hand-sorted 9-element array, and one sort leaves it sorted in place');
}

{
  // Interpolated case: 1..4, p25 = 1.75, median = 2.5, p75 = 3.25.
  const buffer = createScratch();
  [4, 1, 3, 2].forEach((value, index) => (buffer[index] = value));
  const q = quantiles(buffer, 4);
  close(q.p25, 1.75, 1e-12, 'p25');
  close(q.median, 2.5, 1e-12, 'median');
  close(q.p75, 3.25, 1e-12, 'p75');
  ok('quantiles interpolate between order statistics when the position is fractional');
}

{
  // The all-zero / sparse column shape: p25 = median = p75 = 0 and every
  // real event flagged an outlier. Correct, useless, and looks broken, so it
  // has to be detectable (footgun 19).
  const buffer = createScratch();
  for (let i = 0; i < 100; i++) buffer[i] = 0;
  buffer[99] = 500;
  const q = quantiles(buffer, 100);
  assert.equal(q.p25, 0);
  assert.equal(q.median, 0);
  assert.equal(q.p75, 0);
  assert.equal(q.degenerate, true);
  assert.equal(q.outliers, 1);
  assert.equal(q.upperWhisker, 0);
  assert.equal(q.max, 500);
  ok('a sparse column reports degenerate quartiles and its one event as an outlier');
}

{
  const buffer = createScratch();
  for (let i = 0; i < 8; i++) buffer[i] = 0;
  assert.equal(isAllZero(buffer, 8), true);
  buffer[3] = -0.000001; // real solver noise, per docs/data-format.md
  assert.equal(isAllZero(buffer, 8), false, 'tiny negative noise is data, not zero');
  assert.equal(isAllZero(buffer, 0), false, 'no data is not "all zero"');
  ok('isAllZero distinguishes an identically-zero column from one with solver noise');
}

{
  const buffer = createScratch();
  [3, 1, 2].forEach((value, index) => (buffer[index] = value));
  const view = sortAsc(buffer, 3);
  assert.equal(view.length, 3, 'sortAsc returns a view of exactly n elements');
  assert.deepEqual(Array.from(view), [1, 2, 3]);
  ok('sortAsc sorts in place through the one call site the radix swap would replace');
}

// ---------------------------------------------------------------- the paradox

{
  // The pooled weighted average is systematically higher than the mean of the
  // per-hour weighted-mean series, because the high-price hours are the
  // high-load hours. Both are correct; they must be labelled, not reconciled.
  const price = 'Avg LMP Weighted by Load ($/MWh)';
  const weight = 'Load (MWh)';
  const metrics = [price, weight];
  //   hour 0: price 10, load 1     hour 1: price 100, load 99
  const data = makeCase(metrics, 2, (area, metric, hour) => {
    if (metric === 0) return hour === 0 ? 10 : 100;
    return hour === 0 ? 1 : 99;
  });
  const series = buildSeries(data, price, areas.slice(0, 2), createScratch());
  const mask = maskOf([0, 1]);

  const gathered = createScratch();
  const n = applyMask(series.values, mask, gathered);
  const plain = stats(gathered, n).mean;
  const pooled = pooledWeightedMean(series.values, series.weights, mask);

  close(plain, 55, 1e-4, 'mean of the plotted series');
  close(pooled, (10 * 2 + 100 * 198) / 200, 1e-3, 'pooled weighted average');
  assert.ok(pooled > plain, 'the pooled average is the higher of the two, and both are correct');
  ok(
    `the Average paradox reproduces: plotted-series mean ${plain.toFixed(1)} vs pooled ` +
      `weighted average ${pooled.toFixed(1)}`,
  );
}

{
  const mask = maskOf([0]);
  const zeroWeights = new Float32Array(HOURS);
  const series = new Float32Array(HOURS).fill(5);
  assert.ok(
    Number.isNaN(pooledWeightedMean(series, zeroWeights, mask)),
    'a pooled average over zero total weight is undefined, not 0',
  );
  ok('pooledWeightedMean over zero total weight is NaN, not 0');
}

console.log(`\n${checks} checks passed`);
