// src/rules.ts
//
// Loads data/aggregation-rules.json and indexes it by trimmed canonical
// column name. Never re-derive the rules -- branch on `series` (see the
// JSON's own `contract` string) and `weight`/`fallbackWeight`.

import rulesData from '../data/aggregation-rules.json' with { type: 'json' };
import type { ColumnRule } from './types';

const byCanonical = new Map<string, ColumnRule>();
for (const column of rulesData.columns as ColumnRule[]) {
  byCanonical.set(column.canonical.trim(), column);
}

/**
 * Column groups, in the order an analyst reaches for them: what was served,
 * what produced it, what it cost per MWh, what moved between areas, what it
 * cost in total, then the long tail. `match` runs in this order and the first
 * hit wins, so more specific tests (A.S., emissions) come before the broad
 * unit tests they would otherwise fall into.
 *
 * A column no test claims lands in "Other" -- including any column with no
 * aggregation rule at all, which is exactly the case a new export shape
 * produces and the one that must not be hidden.
 */
interface Group {
  title: string;
  match: (name: string, unit: string) => boolean;
  /** Headline columns first, in this order, before everything else. */
  first?: string[];
}

/** The group calculated columns live in. Exported because the picker styles
 * this one folder differently and matches it by title. */
export const CALCULATED_GROUP = 'Calculations';

const has = (name: string, ...needles: string[]) =>
  needles.some((needle) => name.toLowerCase().includes(needle.toLowerCase()));

const GROUPS: Group[] = [
  {
    title: 'Load',
    first: ['Load (MWh)', 'Served Load Including Losses (MWh)', 'Net Load (MW)'],
    match: (name) => has(name, 'load') && !has(name, 'payment', 'cost', 'lmp weighted'),
  },
  {
    title: 'Generation',
    first: ['Generation (MWh)', 'Available Capacity (MW)', 'Installed Capacity (MW)'],
    match: (name) => has(name, 'generation', 'capacity', 'spillage') && !has(name, 'revenue', 'cost'),
  },
  {
    title: 'Prices',
    first: ['Avg LMP Weighted by Load ($/MWh)', 'Avg LMP Weighted by Gen ($/MWh)'],
    match: (name, unit) => has(name, 'lmp', 'price') || unit === '$/MWh',
  },
  {
    title: 'Interchange & losses',
    first: ['Import Flow(MWh)', 'Export Flow (MWh)'],
    match: (name) => has(name, 'flow', 'losses', 'import', 'export', 'interface', 'wheel'),
  },
  {
    title: 'Costs & revenue',
    match: (name, unit) => unit === 'k$' || has(name, 'cost', 'revenue', 'payment'),
  },
  {
    title: 'Ancillary services',
    match: (name) => has(name, 'a. s.', 'a.s.', 'reserve', 'regulation'),
  },
  {
    title: 'Emissions',
    match: (name) => has(name, 'so2', 'nox', 'co2', 'emission'),
  },
  {
    // Not in any export's header -- computed at ingest from columns that are.
    // Its own group, and highlighted in the picker, so a calculated column is
    // never mistaken for one the simulation reported.
    title: CALCULATED_GROUP,
    match: (name) => ruleFor(name)?.derived !== undefined,
  },
];

/**
 * Match order, which is NOT display order. Calculations, ancillary and
 * emissions are tested before the broad unit tests -- an "A. S. Price" is an
 * ancillary column first and a price second, and `Gen - Load` would otherwise
 * fall into "Load" -- but they read better further down the picker, so GROUPS
 * keeps the reading order and this keeps the matching one.
 */
const MATCH_ORDER = [
  ...GROUPS.filter(
    (g) =>
      g.title === CALCULATED_GROUP ||
      g.title === 'Ancillary services' ||
      g.title === 'Emissions',
  ),
  ...GROUPS,
];

export function groupOf(name: string): string {
  const unit = ruleFor(name)?.unit ?? '';
  for (const group of MATCH_ORDER) if (group.match(name, unit)) return group.title;
  return 'Other';
}

/** Sort key within a group: headline columns first, then columns that carry
 * real variation, then the constants. No badges -- the order IS the hint. */
function rank(group: Group | undefined, name: string): number {
  const headline = group?.first?.indexOf(name) ?? -1;
  if (headline >= 0) return headline;
  const rule = ruleFor(name);
  if (!rule) return 500;
  if (rule.degenerate) return 300;
  if (rule.sparse) return 200;
  return 100;
}

/** Columns bucketed and ranked for display: group order as above with
 * "Other" last, empty groups dropped. Used by the import picker and by the
 * rail's metric list, which have to agree or the same column appears under
 * two different headings. */
export function metricGroups(names: string[]): { title: string; names: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const name of names) {
    const title = groupOf(name);
    const bucket = buckets.get(title);
    if (bucket) bucket.push(name);
    else buckets.set(title, [name]);
  }
  return [...GROUPS.map((g) => g.title), 'Other']
    .filter((title) => buckets.has(title))
    .map((title) => {
      const group = GROUPS.find((g) => g.title === title);
      const inGroup = (buckets.get(title) as string[]).sort(
        (a, b) => rank(group, a) - rank(group, b) || a.localeCompare(b),
      );
      return { title, names: inGroup };
    });
}

export function ruleFor(canonical: string): ColumnRule | undefined {
  return byCanonical.get(canonical.trim());
}

/**
 * The y scale a unit is drawn on. Two units share a scale only when they are
 * the same NUMBER, which MW and MWh are here: every value in the cube is one
 * hour, and 1 MW held for an hour is 1 MWh. Splitting `Load (MWh)` and `Net
 * Load (MW)` across a left and a right axis draws two identical quantities at
 * two different zoom levels, which reads as a difference that is not there.
 *
 * This is a property of the HOUR, not of the units, and it stops at the chart.
 * A period total of MW is still not MWh -- CAPACITY columns are never summed
 * over time -- so nothing here touches `class`,
 * `temporal` or the stats table, all of which keep treating MW as a rate.
 */
export function scaleOf(unit: string): string {
  return unit === 'MW' ? 'MWh' : unit;
}

/**
 * Distinct y scales among the drawn lines, in first-seen order, each labelled
 * with every unit sharing it -- so a merged axis reads "MWh · MW" rather than
 * silently renaming one of them.
 */
export function scalesOf(series: { unit: string }[]): { scale: string; label: string }[] {
  const byScale = new Map<string, string[]>();
  for (const { unit } of series) {
    const scale = scaleOf(unit);
    const seen = byScale.get(scale) ?? [];
    if (!seen.includes(unit)) seen.push(unit);
    byScale.set(scale, seen);
  }
  return [...byScale].map(([scale, units]) => ({ scale, label: units.join(' · ') }));
}

/**
 * What the picker ticks before the user touches it: the columns that answer
 * the questions this tool gets opened for -- what was served, what produced
 * it, what it cost, what moved between areas, and where the system fell short
 * -- at roughly 40% of the memory of keeping everything.
 *
 * The list is deliberately closed under its own dependencies: every weight and
 * every calculated column's operands are named here explicitly. Nothing is
 * auto-added at selection time, so a default that needed a
 * column it did not list would ship a set that cannot draw its own charts.
 *
 * Left OFF, and why: the six A.S. triads (18 columns; the Requirements are
 * identically zero and the prices are unprocured most hours), `Simple Average
 * LMP` (an unweighted mean of area averages),
 * SO2/NOx (their Cost columns are identically zero), the two `Total` columns
 * (spatial rule unconfirmed), and `Committed Capacity (MW)`.
 */
export const DEFAULT_METRICS: readonly string[] = [
  // What was served, and its shape.
  'Load (MWh)',
  'Served Load Including Losses (MWh)',
  'Net Load (MW)',
  // What produced it, what was available to, and how hard it was worked.
  'Generation (MWh)',
  'Available Capacity (MW)',
  'Installed Capacity (MW)',
  'Generation / Installed Capacity',
  'Gen - Load',
  'Spillage (MWh)',
  // What it cost per MWh, decomposed.
  'Avg LMP Weighted by Load ($/MWh)',
  'Avg LMP Weighted by Gen ($/MWh)',
  'LMP - Energy ($/MWh)',
  'LMP Loss Component ($/MWh)',
  'LMP Congestion Component ($/MWh)',
  // What moved between areas. The gross pair is here because Net Interchange
  // is built from it, and is exact per area even where the sum is not.
  'Import Flow(MWh)',
  'Export Flow (MWh)',
  'Net Interchange (MWh)',
  'Estimated Losses (MWh)',
  // What it cost in total.
  'Generation Cost (k$)',
  'Generation Revenue (k$)',
  'Load Payment (k$)',
  // Where the system fell short, and what it emitted.
  'Unserved Load (MWh)',
  'Unserved Load Cost (k$)',
  'CO2 Amt',
];

/**
 * The default ticks for a given export's union schema. Falls back to the whole
 * union when the intersection is empty, which is what a schema this build has
 * never seen produces -- a picker that opens with nothing ticked reads as a
 * failed load.
 */
export function defaultSelection(union: string[]): string[] {
  const wanted = new Set(DEFAULT_METRICS);
  const picked = union.filter((name) => wanted.has(name.trim()));
  return picked.length > 0 ? picked : [...union];
}

export function isDegenerate(canonical: string): boolean {
  return ruleFor(canonical)?.degenerate === true;
}

/**
 * Columns `retained` depends on but does not contain. Two kinds, reported the
 * same way because dropping either has the same consequence -- a column that
 * is offered and then cannot be built:
 *
 *   * WEIGHT columns, primary and fallback. Picking a price without its weight
 *     destroys the ability to build any grouping series for it, and the
 *     tempting fallback -- a plain mean -- is exactly the wrong answer
 *     (footgun 20).
 *   * OPERANDS of a calculated column. `Gen - Load` without `Generation (MWh)`
 *     has nothing to subtract, so its plane stays absent.
 *
 * Reported, never auto-added: the picker's MB readout has to price the cube
 * that gets allocated, and ingest warns about what it was not given.
 */
export function requiredInputs(retained: string[]): string[] {
  const retainedSet = new Set(retained.map((name) => name.trim()));
  const needed = new Set<string>();
  const want = (name: string | undefined) => {
    if (name && !retainedSet.has(name)) needed.add(name);
  };
  for (const name of retainedSet) {
    const rule = ruleFor(name);
    if (!rule) continue;
    want(rule.weight);
    want(rule.fallbackWeight);
    want(rule.derived?.minuend);
    want(rule.derived?.subtrahend);
  }
  return Array.from(needed);
}

/** Calculated columns whose operands all appear in `available`. They are not in
 * any file's header, so this is the only way they reach the picker. */
export function derivedFor(available: string[]): string[] {
  const have = new Set(available.map((name) => name.trim()));
  return (rulesData.columns as ColumnRule[])
    .filter((column) => {
      const d = column.derived;
      return d !== undefined && have.has(d.minuend) && have.has(d.subtrahend);
    })
    .map((column) => column.canonical.trim());
}
