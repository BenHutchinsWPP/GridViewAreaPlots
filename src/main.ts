// src/main.ts
//
// The whole app: one frozen Query object, one render path.
//
// There is no framework and no store (D12). Every interaction builds a new
// frozen Query and calls render(), which recomputes from the cubes and
// pushes the result into the rail and the four panes. That is viable
// because the arithmetic is cheap: re-filtering measures 0.055 ms and the
// 10-case duration curve 14 ms, against 100 ms and 250 ms gates.
//
// Buffers are allocated once per case and reused. Sorting is the only real
// cost in an interaction (footgun 14), and allocating a scratch array inside
// a render path is how that cost gets multiplied for no reason.

import './styles.css';
import {
  buildCalendar,
  buildMask,
  DAY_NAMES,
  getDayOfWeek,
  getHourOfDay,
  getMonth,
  getSeason,
  HOURS_PER_YEAR,
  MONTH_NAMES,
  SEASON_NAMES,
} from './calendar';
import {
  ALL_AREAS,
  allAreas,
  exportGroupings,
  groupingNames,
  isOffAxis,
  setAxis,
  setGroupings,
  type GroupingSummary,
} from './groupings';
import {
  applyMask,
  buildSeries,
  createScratch,
  hasData,
  isAllZero,
  pooledWeightedMean,
  quantiles,
  stats,
  type Quantiles,
} from './kernels';
import { ruleFor } from './rules';
import {
  hasSimd,
  ingest,
  NO_SIMD_MESSAGE,
  discoverAreas,
  readCasePlan,
  unionAreas,
  unionOf,
  type CasePlan,
} from './ingest/pool';
import {
  downloadBundle,
  isAbort,
  isBundleFile,
  loadBundle,
  readBundleFile,
  saveBundle,
  warmStorage,
} from './storage';
import type { BoxDim, CaseData, Filters, Query, Selection } from './types';
import { createCharts, type BoxGroup, type CaseSeries } from './ui/charts';
import { showGroupEditor } from './ui/groups';
import { showPicker } from './ui/picker';
import { areasFor, CASE_COLORS, createShell } from './ui/shell';

// ---------------------------------------------------------------- state

interface CaseBuffers {
  /** The built series, 8,760 values, NaN where there is no data. */
  series: Float32Array;
  /** The same series with filtered-out hours blanked, for the time axis. */
  display: Float32Array;
  mask: Uint8Array;
  /** Kept values, gathered then sorted in place. */
  gathered: Float32Array;
  /** Per-hour weight sum, for WEIGHTED_MEAN columns. */
  weights: Float32Array;
}

const cases: CaseData[] = [];
const buffers = new Map<string, CaseBuffers>();
/** Reused by every box-plot partition; one box is consumed before the next,
 * so two buffers cover the whole pane no matter how many boxes it draws. */
const boxScratch = createScratch();
const boxSeriesScratch = createScratch();
const boxWeightsScratch = createScratch();
let notes: string[] = [];
let busy: string | null = null;

function sameAxis(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function reindexCase(data: CaseData, axis: readonly string[]): CaseData {
  if (sameAxis(data.areas, axis)) return data;

  const numMetrics = data.metrics.length;
  const cube = new Float32Array(axis.length * numMetrics * HOURS_PER_YEAR);
  cube.fill(NaN);
  const presence = new Uint8Array(axis.length * numMetrics);
  const destByArea = new Map<string, number>();
  axis.forEach((area, index) => destByArea.set(area, index));

  for (let oldArea = 0; oldArea < data.areas.length; oldArea++) {
    const nextArea = destByArea.get(data.areas[oldArea]);
    if (nextArea === undefined) continue;
    for (let metric = 0; metric < numMetrics; metric++) {
      const oldPlane = (oldArea * numMetrics + metric) * HOURS_PER_YEAR;
      const nextPlane = (nextArea * numMetrics + metric) * HOURS_PER_YEAR;
      cube.set(data.cube.subarray(oldPlane, oldPlane + HOURS_PER_YEAR), nextPlane);
      presence[nextArea * numMetrics + metric] = data.presence[oldArea * numMetrics + metric];
    }
  }

  return { ...data, areas: axis.slice(), cube, presence };
}

function adoptAxis(axis: string[]): void {
  const current = allAreas();
  if (sameAxis(current, axis)) return;
  for (let i = 0; i < cases.length; i++) cases[i] = reindexCase(cases[i], axis);
  buffers.clear();
  setAxis(axis);
}

let query: Query = Object.freeze({
  cases: [] as readonly string[],
  // Empty until a file says what columns exist; render() adopts the first
  // available metric. Naming one here would be this app asserting what a
  // utility's export contains.
  metrics: [] as readonly string[],
  selections: [
    Object.freeze({ kind: 'grouping' as const, name: groupingNames()[0] ?? ALL_AREAS }),
  ] as readonly Selection[],
  filters: Object.freeze({
    months: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  }) as Filters,
  boxDim: 'case' as BoxDim,
});

function setQuery(patch: Partial<Query>): void {
  query = Object.freeze({ ...query, ...patch });
  render();
}

function setFilters(patch: Partial<Filters>): void {
  setQuery({ filters: Object.freeze({ ...query.filters, ...patch }) });
}

/** Buffers are per drawn line, not per case: two metrics of the same case are
 * two series and each needs its own display and sorted arrays to survive
 * until the panes read them. ~175 KB each, ten lines maximum. */
function buffersFor(key: SeriesKey): CaseBuffers {
  const id = `${key.data.name}\u0000${key.selection.kind}:${key.selection.name}\u0000${key.metric}`;
  let existing = buffers.get(id);
  if (!existing) {
    existing = {
      series: createScratch(),
      display: createScratch(),
      mask: new Uint8Array(HOURS_PER_YEAR),
      gathered: createScratch(),
      weights: createScratch(),
    };
    buffers.set(id, existing);
  }
  return existing;
}

/** The metric axis offered in the rail: every column any loaded case kept. */
function availableMetrics(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const data of cases) {
    for (const metric of data.metrics) {
      if (seen.has(metric)) continue;
      seen.add(metric);
      out.push(metric);
    }
  }
  return out;
}

// ---------------------------------------------------------------- render

/**
 * The calendar dimensions a box plot can partition by: the category list to
 * draw, and the accessor that puts an hour in one of them. Kept as one table
 * rather than two switches -- the label list and the accessor have to agree
 * about what "key" means (1-based for month and hour-ending, 0-based for day
 * and season), and two switches are two places for that to drift.
 *
 * 'case' and 'area' are absent on purpose: they partition by something that
 * is not in the calendar, and computeBoxes handles each before it gets here.
 */
const BOX_DIMS: Partial<
  Record<BoxDim, { keys: { key: number; label: string }[]; of: (entry: number) => number }>
> = {
  month: { keys: MONTH_NAMES.map((label, i) => ({ key: i + 1, label })), of: getMonth },
  hourOfDay: {
    keys: Array.from({ length: 24 }, (_, i) => ({ key: i + 1, label: String(i + 1) })),
    of: getHourOfDay,
  },
  dayOfWeek: { keys: DAY_NAMES.map((label, i) => ({ key: i, label })), of: getDayOfWeek },
  season: { keys: SEASON_NAMES.map((label, i) => ({ key: i, label })), of: getSeason },
};

/**
 * Boxes partition a series rather than duplicating it, so K boxes cost
 * sum(n_i log n_i) <= N log N -- strictly less than the duration curve's
 * single sort of the same points. No dimension needs a precompute (D8).
 */
function computeBoxes(series: CaseSeries[]): BoxGroup[] {
  const dim = query.boxDim;
  const drawable = series.filter((entry) => entry.values !== null);

  if (dim === 'case') {
    return drawable.map((entry) => ({
      label: entry.name,
      boxes: [
        { color: entry.color, name: entry.name, unit: entry.unit, quantiles: entry.quantiles },
      ],
    }));
  }

  if (dim === 'area') {
    // One group per area of the union, each holding a box per drawn line that
    // covers that area.
    const areas = Array.from(new Set(query.selections.flatMap((s) => areasFor(s))));
    const keys = seriesKeys(cases.filter((data) => query.cases.includes(data.name)));
    return areas.map((area) => ({
      label: area,
      boxes: keys.flatMap((key, index) => {
        const entry = series[index];
        if (!entry || entry.values === null) return [];
        const built = buildSeries(
          key.data,
          key.metric,
          [area],
          boxSeriesScratch,
          boxWeightsScratch,
        );
        if (built.values === null) return [];
        const buffer = buffersFor(key);
        const n = applyMask(built.values, buffer.mask, boxScratch);
        return [
          {
            color: entry.color,
            name: entry.name,
            unit: entry.unit,
            quantiles: quantiles(boxScratch, n),
          },
        ];
      }),
    }));
  }

  // 'case' and 'area' returned above, so anything left is a calendar dimension.
  const partition = BOX_DIMS[dim];
  if (!partition) return [];

  const calendars = new Map<number, Uint32Array>();
  const keys = seriesKeys(cases.filter((data) => query.cases.includes(data.name)));
  const groups: BoxGroup[] = [];
  for (const category of partition.keys) {
    const boxes: { color: string; name: string; unit: string; quantiles: Quantiles }[] = [];
    keys.forEach((key, index) => {
      const entry = series[index];
      if (!entry || entry.values === null) return;
      const buffer = buffersFor(key);
      let calendar = calendars.get(key.data.year);
      if (!calendar) {
        calendar = buildCalendar(key.data.year);
        calendars.set(key.data.year, calendar);
      }
      let n = 0;
      for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
        if (buffer.mask[hour] === 0) continue;
        if (partition.of(calendar[hour]) !== category.key) continue;
        const value = buffer.series[hour];
        if (Number.isNaN(value)) continue;
        boxScratch[n++] = value;
      }
      boxes.push({
        color: entry.color,
        name: entry.name,
        unit: entry.unit,
        quantiles: quantiles(boxScratch, n),
      });
    });
    groups.push({ label: category.label, boxes });
  }
  return groups;
}

/** One drawn line: a (case, selection, metric) triple. */
interface SeriesKey {
  data: CaseData;
  selection: Selection;
  metric: string;
}

/** The cross product, in a stable order: case outermost so a case's lines stay
 * together in the legend, then selection, then metric. */
function seriesKeys(active: CaseData[]): SeriesKey[] {
  const keys: SeriesKey[] = [];
  for (const data of active) {
    for (const selection of query.selections) {
      for (const metric of query.metrics) keys.push({ data, selection, metric });
    }
  }
  return keys;
}

/**
 * Label for one line. The case is always named; the other two axes are named
 * only when more than one of them is drawn, because "Case1 · AREA01 · Load
 * (MWh)" on a chart that has exactly one area and one metric is three words
 * of noise on every row of the legend.
 */
function seriesLabel(key: SeriesKey): string {
  const parts = [key.data.name];
  if (query.selections.length > 1) parts.push(key.selection.name);
  if (query.metrics.length > 1) parts.push(key.metric);
  return parts.join(' · ');
}

function render(): void {
  const metrics = availableMetrics();
  // Metrics that no loaded case carries would draw nothing and say nothing.
  // An empty set adopts the first column the data turned out to have, which
  // is also how the very first load picks a metric at all.
  if (metrics.length > 0) {
    const kept = query.metrics.filter((metric) => metrics.includes(metric));
    if (kept.length === 0) query = Object.freeze({ ...query, metrics: [metrics[0]] });
    else if (kept.length !== query.metrics.length) query = Object.freeze({ ...query, metrics: kept });
  }

  const enabled = new Set(query.cases);
  const active = cases.filter((data) => enabled.has(data.name));
  const keys = seriesKeys(active);

  const series: CaseSeries[] = [];
  let keptHours = 0;

  // Ten colours, ten lines (GUI decision 5: the mapping has to be learnable).
  // The cross product blows past that quickly -- 3 cases x 2 areas x 2 metrics
  // is already 12 -- so it is capped here rather than drawn illegibly.
  const overflow = keys.length > CASE_COLORS.length;

  keys.forEach((key, index) => {
    if (overflow) return;
    const { data, selection, metric } = key;
    const color = CASE_COLORS[index % CASE_COLORS.length];
    const buffer = buffersFor(key);
    const rule = ruleFor(metric);

    buildMask(query.filters, buildCalendar(data.year), data.tou, buffer.mask);

    const built = buildSeries(data, metric, areasFor(selection), buffer.series, buffer.weights);
    if (built.values === null) {
      series.push({
        name: seriesLabel(key),
        color,
        unit: rule?.unit ?? '',
        metric,
        values: null,
        refusal: built.refusal,
        warnings: built.warnings,
        sorted: buffer.gathered,
        n: 0,
        stats: { n: 0, mean: NaN, min: NaN, max: NaN, sd: NaN },
        quantiles: quantiles(buffer.gathered, 0),
        pooled: null,
        allZero: false,
      });
      return;
    }

    // The time axis wants gaps where the filter excluded an hour, so the
    // series is blanked rather than compacted for that pane.
    for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
      buffer.display[hour] = buffer.mask[hour] === 1 ? built.values[hour] : NaN;
    }

    const n = applyMask(built.values, buffer.mask, buffer.gathered);
    // The status sentence counts hours that actually CONTRIBUTED, not hours
    // the filter kept. For a complete case the two are identical; for a
    // partial export they are not, and reporting the filter count there
    // would overstate the sample the numbers came from.
    keptHours = Math.max(keptHours, n);
    const summary = stats(buffer.gathered, n);
    const allZero = isAllZero(buffer.gathered, n);
    // quantiles() sorts the gathered buffer in place, and the duration curve
    // reads that same sorted array -- one sort serves both panes.
    const spread = quantiles(buffer.gathered, n);

    series.push({
      name: seriesLabel(key),
      color,
      unit: rule?.unit ?? '',
      metric,
      values: buffer.display,
      warnings: built.warnings,
      weightColumn: built.weightColumn,
      sorted: buffer.gathered,
      n,
      stats: summary,
      quantiles: spread,
      pooled:
        built.weights !== undefined
          ? pooledWeightedMean(built.values, built.weights, buffer.mask)
          : null,
      allZero,
    });
  });

  const paneNotes = [...notes, ...series.flatMap((entry) => entry.warnings)];
  if (overflow) {
    paneNotes.unshift(
      `${keys.length} series selected (${active.length} case(s) x ${query.selections.length} ` +
        `area(s) x ${query.metrics.length} metric(s)). ${CASE_COLORS.length} is the most that ` +
        'can be told apart by colour — narrow one of the three.',
    );
  }

  charts.render({
    query,
    weighted: series.some((entry) => entry.weightColumn !== undefined),
    series,
    boxes: computeBoxes(series),
    notes: paneNotes,
    refusal: overflow ? paneNotes[0] : undefined,
  });

  shell.render(query, {
    cases,
    enabled,
    metrics,
    legend: series.map((entry) => ({ label: entry.name, color: entry.color })),
    keptHours: active.length === 0 ? HOURS_PER_YEAR : keptHours,
    bytes: cases.reduce((total, data) => total + data.cube.byteLength, 0),
    busy,
  });
}

// ---------------------------------------------------------------- ingest

const fileInput = document.createElement('input');
fileInput.id = 'file-input';
fileInput.type = 'file';
fileInput.accept = '.csv,text/csv,.gvap';
fileInput.multiple = true;
fileInput.style.display = 'none';
document.body.appendChild(fileInput);
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = '';
  if (files.length > 0) void loadFiles(files);
});

// The Load button. A .gvap goes through the same routing a dropped file does,
// so restoring is one code path however the file arrives.
const bundleInput = document.createElement('input');
bundleInput.type = 'file';
bundleInput.accept = '.gvap';
bundleInput.style.display = 'none';
document.body.appendChild(bundleInput);
bundleInput.addEventListener('change', () => {
  const files = Array.from(bundleInput.files ?? []);
  bundleInput.value = '';
  if (files.length > 0) void loadFiles(files);
});

function setBusy(message: string | null): void {
  busy = message;
  render();
}

/** Group membership is many-to-many and may name areas this build does not
 * have, so what a mapping actually covers is worth stating rather than
 * leaving to be discovered as an empty chart. */
function groupingNotes(summary: GroupingSummary, lead: string): string[] {
  const messages = [
    `${lead}: ${summary.groups} groups covering ${summary.mapped} of ${allAreas().length} areas.`,
  ];
  if (summary.offAxis.length > 0) {
    messages.push(
      `${summary.offAxis.length} name(s) in the mapping are not areas in this build and ` +
        `cannot be plotted: ${summary.offAxis.join(', ')}.`,
    );
  }
  if (summary.unmapped.length > 0) {
    messages.push(`In no group: ${summary.unmapped.join(', ')}.`);
  }
  return messages;
}

/** Axis areas that carry data in at least one loaded case, for the editor's
 * "listed but not in the data" flag. */
function presentAreas(): Set<string> {
  const present = new Set<string>();
  for (const data of cases) {
    data.areas.forEach((area, areaIndex) => {
      if (present.has(area)) return;
      for (let metric = 0; metric < data.metrics.length; metric++) {
        if (hasData(data, areaIndex, metric)) {
          present.add(area);
          return;
        }
      }
    });
  }
  return present;
}

/** Groupings.csv is `Name,Grouping`; a GridView export is not. Sniffing the
 * header keeps one drop target for everything instead of asking the user
 * which kind of file they are holding. */
async function isGroupingsCsv(file: File): Promise<boolean> {
  const head = await file.slice(0, 200).text();
  return /^\s*name\s*,\s*grouping\s*(\r|\n|$)/i.test(head);
}

function applyGroupings(csv: string): void {
  const summary = setGroupings(csv);
  notes = groupingNotes(summary, 'Groupings updated');

  // Selections the new mapping does not contain would silently plot nothing,
  // so they are dropped, and an empty result falls back to everything.
  const names = groupingNames();
  const kept = query.selections.filter((selection) =>
    selection.kind === 'grouping' ? names.includes(selection.name) : !isOffAxis(selection.name),
  );
  if (kept.length !== query.selections.length) {
    setQuery({ selections: kept.length > 0 ? kept : [{ kind: 'grouping', name: ALL_AREAS }] });
  } else {
    render();
  }
}

async function loadFiles(files: File[]): Promise<void> {
  // A dropped file is one of three things, told apart by its first bytes: a
  // saved bundle, a groupings mapping, or a GridView CSV export.
  const exports: File[] = [];
  for (const file of files) {
    if (await isBundleFile(file)) {
      await restoreBundleFile(file);
    } else if (await isGroupingsCsv(file)) {
      try {
        applyGroupings(await file.text());
      } catch (error) {
        notes = [`${file.name}: ${error instanceof Error ? error.message : String(error)}`];
        render();
      }
    } else {
      exports.push(file);
    }
  }
  if (exports.length === 0) return;
  files = exports;

  if (!hasSimd()) {
    notes = [NO_SIMD_MESSAGE];
    render();
    return;
  }
  try {
    setBusy(`Reading ${files.length} header${files.length === 1 ? '' : 's'}…`);
    const plans: CasePlan[] = [];
    for (const file of files) plans.push(await readCasePlan(file));

    // The area axis is READ from the Name column of every row, not guessed
    // from the first few. This pass also gives the ordering verdict for the
    // whole file, so a file that cannot be blitted is refused here rather
    // than partway through the expensive pass.
    setBusy('Reading the area axis…');
    await discoverAreas(plans, (done, total) => {
      setBusy(`Reading the area axis: block ${done} of ${total}…`);
    });

    // The axis grows as files introduce names. Rows route by area name, so
    // file order is irrelevant.
    const axis = unionAreas(plans, allAreas());

    const union = unionOf(plans);
    // The picker is shown on the first drop only, and is skippable (D6).
    // Later drops reuse the metric axis already in memory, because a cube
    // with a different width could not be overlaid with the existing ones.
    const retained =
      cases.length === 0 ? await showPicker(union, plans.length, axis.length) : cases[0].metrics;

    setBusy('Parsing…');
    const result = await ingest(plans, retained, axis, (done, total) => {
      setBusy(`Parsing block ${done} of ${total}…`);
    });

    adoptAxis(axis);
    for (const data of result.cases) {
      const existing = cases.findIndex((entry) => entry.name === data.name);
      if (existing >= 0) cases[existing] = data;
      else cases.push(data);
    }
    notes = result.warnings;
    setQueryCases();
  } catch (error) {
    notes = [error instanceof Error ? error.message : String(error)];
  } finally {
    setBusy(null);
  }
}

function setQueryCases(): void {
  setQuery({ cases: cases.map((data) => data.name) });
}

async function saveAll(): Promise<void> {
  if (cases.length === 0) {
    notes = ['Nothing to save yet — drop a CSV export first.'];
    render();
    return;
  }
  try {
    setBusy('Saving…');
    // Two destinations, one button: the .gvap file is what the user keeps and
    // shares, origin-private storage is what makes Load instant on this
    // machine. The file is written first, because it is the one that can be
    // cancelled at the dialog.
    const filename = await downloadBundle(cases, (done, total) =>
      setBusy(`Writing case ${done} of ${total}…`),
    );
    await saveBundle(cases, (done, total) => setBusy(`Saving case ${done} of ${total}…`));
    notes = [
      `Saved ${cases.length} case(s) to ${filename}, and to this browser's origin-private ` +
        `storage for the Load button. Drop the .gvap file back in to restore it anywhere.`,
    ];
  } catch (error) {
    notes = isAbort(error)
      ? ['Save cancelled.']
      : [`Save failed: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setBusy(null);
  }
}

/**
 * Take on the grouping mapping a bundle was saved under. Restoring a study
 * under a different mapping than it was built with plots correct numbers
 * against the wrong group names, so the bundle's mapping wins -- and says so,
 * because it also changes what the Area/Group list offers.
 */
function adoptGroupings(csv: string | null, source: string): string[] {
  if (csv === null) {
    return [`${source} predates saved groupings — the mapping now loaded was left alone.`];
  }
  if (csv === exportGroupings()) return [];
  try {
    return groupingNotes(setGroupings(csv), `Groupings came from ${source}`);
  } catch (error) {
    return [`${source}: ${error instanceof Error ? error.message : String(error)}`];
  }
}

async function restoreBundleFile(file: File): Promise<void> {
  try {
    setBusy(`Restoring ${file.name}…`);
    const loaded = await readBundleFile(file);
    cases.length = 0;
    buffers.clear();
    cases.push(...loaded.cases);
    if (loaded.cases[0]) setAxis(loaded.cases[0].areas);
    notes = [
      `Restored ${loaded.cases.length} case(s) from ${file.name}.`,
      ...adoptGroupings(loaded.groupings, file.name),
    ];
    setQueryCases();
  } catch (error) {
    notes = [`${file.name}: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setBusy(null);
  }
}

/**
 * Restore this browser's origin-private cache -- what Save wrote alongside the
 * .gvap file, and what makes Load instant on the machine the study was built
 * on. Rejects when there is no cache to read, which is the normal state on any
 * other machine; the caller falls back to opening a file.
 */
async function loadAll(): Promise<void> {
  try {
    setBusy('Loading…');
    const loaded = await loadBundle();
    cases.length = 0;
    buffers.clear();
    cases.push(...loaded.cases);
    if (loaded.cases[0]) setAxis(loaded.cases[0].areas);
    notes = [
      `Loaded ${loaded.cases.length} case(s) from origin-private storage.`,
      ...adoptGroupings(loaded.groupings, 'the saved bundle'),
    ];
    setQueryCases();
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------- wiring

const shell = createShell({
  onQueryChange: setQuery,
  onFiltersChange: setFilters,
  onToggleCase(name) {
    const next = new Set(query.cases);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setQuery({ cases: cases.map((d) => d.name).filter((n) => next.has(n)) });
  },
  onRemoveCase(name) {
    const index = cases.findIndex((data) => data.name === name);
    if (index >= 0) cases.splice(index, 1);
    // Buffer keys are `case\0selection\0metric`, so the case name alone is
    // never a key -- deleting it left every removed case's ~875 KB of scratch
    // in the map for the life of the page.
    const prefix = `${name}\u0000`;
    for (const id of buffers.keys()) if (id.startsWith(prefix)) buffers.delete(id);
    setQuery({ cases: query.cases.filter((entry) => entry !== name) });
  },
  onFiles(files) {
    void loadFiles(files);
  },
  onAddCases() {
    fileInput.click();
  },
  onSave: saveAll,
  onLoad() {
    // Save writes BOTH a .gvap file and the origin-private cache, and tells the
    // user the cache is "for the Load button" -- so try it first. Anything else
    // (no cache on this machine, a cache from an older build) falls through to
    // opening a file, which is the only option on a machine that never saved.
    void loadAll().catch(() => {
      bundleInput.click();
    });
  },
  onGroupings() {
    void showGroupEditor({ present: presentAreas() }).then((csv) => {
      if (csv === null) return;
      try {
        applyGroupings(csv);
      } catch (error) {
        notes = [error instanceof Error ? error.message : String(error)];
        render();
      }
    });
  },
});

const charts = createCharts((dim) => setQuery({ boxDim: dim }));

// D9/D12: feature-detect SIMD and refuse with a clear message rather than
// carry a second parser that would also have to be verified bit-exact.
if (!hasSimd()) {
  notes = [NO_SIMD_MESSAGE];
} else {
  // The storage worker is the only one that can warm at page load. The parse
  // pool cannot: its workers hash the area axis, and the axis is not known
  // until a file has been read.
  warmStorage();
}

render();
