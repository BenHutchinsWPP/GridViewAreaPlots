// test_calendar.mjs
//
// Plain node, assert-based, no test framework (CLAUDE.md hard rule 6).
// Exercises the real src/*.ts modules directly -- not a reimplementation --
// via Node's built-in TypeScript stripping (Node >=22.6, no flag needed on
// Node 24). test_loader.mjs supplies the two things Node does not: the
// extensionless-import hook, and the area axis and grouping mapping that
// groupings.ts no longer ships with the build.
//
// Run: node test_calendar.mjs

import assert from 'node:assert/strict';

import rulesData from './data/aggregation-rules.json' with { type: 'json' };

import './test_loader.mjs';

const { buildCalendar, buildMask, getMonth, getDayOfMonth, getDayOfWeek, HOURS_PER_YEAR } = await import(
  './src/calendar.ts'
);
const { areasIn } = await import('./src/groupings.ts');
const {
  ruleFor,
  groupOf,
  metricGroups,
  requiredInputs,
  defaultSelection,
  scaleOf,
  scalesOf,
  DEFAULT_METRICS,
  CALCULATED_GROUP,
} = await import('./src/rules.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

// --- 1. 8,760 entries, non-leap month histogram -----------------------

check('calendar has exactly 8,760 entries', () => {
  const calendar = buildCalendar(2035);
  assert.equal(calendar.length, HOURS_PER_YEAR);
  assert.equal(calendar.length, 8760);
});

check('month histogram matches non-leap month lengths x 24', () => {
  const calendar = buildCalendar(2035);
  const histogram = new Array(13).fill(0); // 1-indexed, [0] unused
  for (let h = 0; h < calendar.length; h++) {
    histogram[getMonth(calendar[h])]++;
  }
  const expected = [744, 672, 744, 720, 744, 720, 744, 744, 720, 744, 720, 744];
  assert.deepEqual(histogram.slice(1), expected);
});

// --- 2. Day-of-week for known dates ------------------------------------
//
// Anchors independently verified against Python's datetime module (a
// different implementation from anything in this repo, per footgun 3's
// warning not to trust a single oracle):
//   >>> datetime.date(2035, 1, 1).strftime('%A')  -> 'Monday'
//   >>> datetime.date(2034, 7, 4).strftime('%A')  -> 'Tuesday'
// calendar.ts's dayOfWeek() uses 0=Monday .. 6=Sunday.

function dayOfWeekOf(calendar, month, day) {
  for (let h = 0; h < calendar.length; h++) {
    const entry = calendar[h];
    if (getMonth(entry) === month && getDayOfMonth(entry) === day) return getDayOfWeek(entry);
  }
  throw new Error(`month ${month} day ${day} not found`);
}

check('2035-01-01 is a Monday', () => {
  assert.equal(dayOfWeekOf(buildCalendar(2035), 1, 1), 0);
});

check('2034-07-04 is a Tuesday', () => {
  assert.equal(dayOfWeekOf(buildCalendar(2034), 7, 4), 1);
});

// --- 3. Mask count, computed by hand -------------------------------------
//
// "August only, weekdays only, hours 7-22" for calendar year 2035.
// August 2035 has 31 days; August 1, 2035 is a Wednesday (independently
// confirmed via Python's datetime, not by re-running calendar.ts).
// Walking Wed(1) Thu(2) Fri(3) Sat(4) Sun(5) Mon(6) Tue(7) ... for 31 days
// and counting Mon-Fri by hand gives 23 weekdays. Hours 7 through 22
// inclusive is 22 - 7 + 1 = 16 hours per day.
//   expected = 23 weekdays * 16 hours/day = 368

check('mask for August, weekdays, HE 7-22 has a hand-computed count', () => {
  const calendar = buildCalendar(2035);
  const filters = {
    months: new Set([8]),
    hoursOfDay: new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]),
    daysOfWeek: new Set([0, 1, 2, 3, 4]), // Monday..Friday
    seasons: null,
    tou: null,
  };
  const touBitmap = new Uint8Array(HOURS_PER_YEAR); // unused: filters.tou is null
  const mask = buildMask(filters, calendar, touBitmap);
  assert.equal(mask.length, HOURS_PER_YEAR);
  let kept = 0;
  for (let h = 0; h < mask.length; h++) kept += mask[h];
  const weekdaysInAugust2035 = 23; // hand count, see comment above
  const hoursPerDay = 22 - 7 + 1;
  const expected = weekdaysInAugust2035 * hoursPerDay;
  assert.equal(expected, 368);
  assert.equal(kept, expected);
});

// --- 4. Groupings ---------------------------------------------------------

check("areasIn('Zone 1') returns exactly its two member areas", () => {
  assert.deepEqual(areasIn('Zone 1'), ['AREA01', 'AREA02']);
});

// --- 5. Rules ---------------------------------------------------------------

check('Avg LMP Weighted by Load rule is WEIGHTED_MEAN by Load (MWh)', () => {
  const rule = ruleFor('Avg LMP Weighted by Load ($/MWh)');
  assert.ok(rule, 'rule not found');
  assert.equal(rule.series, 'WEIGHTED_MEAN');
  assert.equal(rule.weight, 'Load (MWh)');
});

check("'Gen - Load' is filed under Calculations, not Load", () => {
  assert.equal(groupOf('Gen - Load'), CALCULATED_GROUP);
  assert.equal(groupOf('Load (MWh)'), 'Load');
  // The folder has to exist as its own group, or the picker cannot mark it.
  const titles = metricGroups(['Load (MWh)', 'Generation (MWh)', 'Gen - Load']).map((g) => g.title);
  assert.ok(titles.includes(CALCULATED_GROUP), titles.join(', '));
});

// MW and MWh are the same number for a single hour, so they share one chart
// axis. The scale merge must not leak past the axis: MW stays a rate
// everywhere else, and a unit that is genuinely a different quantity must
// still get its own axis or the chart compares nothing.
check('MW and MWh share one y scale, labelled with both, and nothing else merges', () => {
  assert.equal(scaleOf('MW'), scaleOf('MWh'), 'a rate held for one hour IS that much energy');
  assert.notEqual(scaleOf('$/MWh'), scaleOf('MWh'), 'a price is not an energy');
  assert.notEqual(scaleOf('ratio'), scaleOf('MWh'), 'a dimensionless ratio is not an energy');

  const merged = scalesOf([{ unit: 'MWh' }, { unit: 'MW' }, { unit: 'MWh' }]);
  assert.equal(merged.length, 1, 'one axis, not two');
  assert.equal(merged[0].label, 'MWh · MW', 'the axis must still name both units');

  // Three units, two scales: the pane refuses at three, so this has to draw.
  assert.equal(scalesOf([{ unit: 'MWh' }, { unit: 'MW' }, { unit: '$/MWh' }]).length, 2);

  // The rule table is untouched by any of this -- MW is still CAPACITY, which
  // is what forbids summing it over hours.
  assert.equal(ruleFor('Net Load (MW)').class, 'CAPACITY');
  assert.equal(ruleFor('Net Load (MW)').temporal, 'MEAN');
});

// The default selection has to be able to draw its own charts. Nothing is
// auto-added at load (footgun 20), so a default that names a weighted-mean or
// calculated column without its inputs ships a set whose panes refuse.
check('the default column selection is closed under its own dependencies', () => {
  const everything = rulesData.columns.map((c) => c.canonical.trim());
  const unknown = DEFAULT_METRICS.filter((name) => !everything.includes(name));
  assert.deepEqual(unknown, [], 'every default must be a real canonical name');

  const picked = defaultSelection(everything);
  assert.deepEqual(requiredInputs(picked), [], 'a default must not need a column it leaves out');
  assert.ok(picked.length > 0 && picked.length < everything.length, `${picked.length} of ${everything.length}`);
});

check('an unrecognised schema falls back to keeping everything', () => {
  // A picker that opens with nothing ticked reads as a failed load.
  assert.deepEqual(defaultSelection(['Some Future Column', 'Another']), [
    'Some Future Column',
    'Another',
  ]);
});

console.log(`\n${passed} checks passed`);
