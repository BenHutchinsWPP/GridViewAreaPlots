// src/types.ts
//
// Core model types. `Query` is the single source of truth the whole UI
// renders from (plan.md's "Architecture recap": "The whole UI is
// render(query) against one frozen query object.") -- construct it once per
// interaction and Object.freeze it; treat every field as immutable.

/**
 * Context filters over the 8,760-hour calendar. `null` means "no
 * constraint" for that dimension -- cheaper than a full Set, and it makes
 * "unfiltered" a fast path in calendar.ts's buildMask (skip the test
 * entirely rather than probing membership in a full set every hour).
 */
export interface Filters {
  readonly months: Set<number> | null; // 1-12
  readonly hoursOfDay: Set<number> | null; // 1-24, hour-ending (HE)
  readonly daysOfWeek: Set<number> | null; // 0-6, 0 = Monday .. 6 = Sunday
  readonly seasons: Set<string> | null; // 'Winter' | 'Spring' | 'Summer' | 'Fall'
  readonly tou: Set<string> | null; // e.g. 'OnPeak' | 'OffPeak' -- read from file data, never derived (footgun 17)
}

export type BoxDim = 'case' | 'month' | 'hourOfDay' | 'dayOfWeek' | 'season' | 'area';

/** 'grid' shows the 2x2 layout; 1-4 focuses a single pane (plan.md GUI
 * decision 1: keys `1`-`4` focus a pane, `Esc` returns to the grid).
 *
 * Deliberately NOT part of Query: focus is pure layout, it changes nothing
 * the kernels compute, and shell.ts owns it. Panes resize through the
 * ResizeObserver in charts.ts, so routing it through the query only bought a
 * full four-pane recompute per keystroke. */
export type PaneView = 'grid' | 1 | 2 | 3 | 4;

/**
 * The single query object render(query) is a pure function of. Build a new
 * object and Object.freeze it rather than mutating fields in place.
 */
export type Selection = Readonly<{ kind: 'area' | 'grouping'; name: string }>;

export interface Query {
  readonly cases: readonly string[];
  /** One or more metrics. Every drawn series is one (case, selection, metric)
   * of the cross product, so this multiplies with `selections`. */
  readonly metrics: readonly string[];
  readonly selections: readonly Selection[];
  readonly filters: Filters;
  readonly boxDim: BoxDim;
}

/** Column classification, mirrors data/aggregation-rules.json exactly --
 * see that file's `contract` string for the resolution rule this type
 * supports. Never re-derive it; branch on `series`/`temporal`/`weight`. */
export type ColumnClass = 'EXTENSIVE' | 'INTENSIVE' | 'CAPACITY';
export type SeriesRule = 'SUM' | 'WEIGHTED_MEAN' | 'MEAN';

/** One entry of data/aggregation-rules.json's `columns` array. */
export interface ColumnRule {
  readonly header: string;
  readonly canonical: string;
  readonly unit: string;
  readonly class: ColumnClass;
  /** How to build the per-hour series when combining areas into a grouping. */
  readonly series: SeriesRule;
  /** How to combine hours into a period total/average. SUM means a period
   * total is meaningful (e.g. MWh); MEAN means it is not (MW summed over
   * hours is not MWh). */
  readonly temporal: SeriesRule;
  /** Weight column for WEIGHTED_MEAN, e.g. 'Load (MWh)'. */
  readonly weight?: string;
  /** Tried when sum(weight) === 0 over the filtered hours. */
  readonly fallbackWeight?: string;
  /** True for columns that are themselves a weight another column depends on. */
  readonly isWeight?: boolean;
  /**
   * A CALCULATED column: no source column carries it. Its cube plane is filled
   * at ingest from the two named operands per area, and it is present only
   * when both are. `minuend`/`subtrahend` are the left and right operand of
   * whichever `op` applies.
   *
   * `sub` (the default) is only sound because both operands are same-unit
   * EXTENSIVE, so `Σ_a(x-y) == Σ_a x - Σ_a y` and it does not matter whether
   * the subtraction happens before or after the area collapse.
   *
   * `div` does NOT commute with the collapse -- `Σ(a/b) != Σa/Σb` -- so a
   * per-area ratio is only ever a per-area answer, and the column MUST carry
   * `series: 'WEIGHTED_MEAN'` with `weight` set to the DENOMINATOR. That is
   * what puts the ratio of sums back: `Σ((a/b)·b)/Σb == Σa/Σb`. A `div` rule
   * with any other series (or weight) is a plausible wrong number, so
   * test_kernels.mjs asserts the pairing rather than trusting the table.
   */
  readonly derived?: {
    readonly minuend: string;
    readonly subtrahend: string;
    readonly op?: 'sub' | 'div';
  };
  /**
   * The rule for this column was inferred from its name and units rather than
   * confirmed against GridView's own definition. Nothing branches on it: it
   * marks the rows to re-check against a real export, and which 12 rows carry
   * it is not currently self-consistent (`Avg LMP Weighted by Load` has it,
   * `by Gen` does not; five of the six A.S. prices have it).
   */
  readonly provisional?: boolean;
  /** All-zero in every hour of every case seen so far -- valid data, not a load error. */
  readonly degenerate?: boolean;
  /** Mostly zero/absent. */
  readonly sparse?: boolean;
  /** Summing this across areas double-counts (e.g. a flow shared by both sides of a tie). */
  readonly intraGroupHazard?: boolean;
}

/**
 * One case's fully-ingested data. `cube` is a single flat Float32Array
 * indexed as:
 *
 *   cube[(area * numMetrics + metric) * 8760 + hour]
 *
 * where `area` and `metric` are indices into `areas`/`metrics` -- Date,
 * Hour and Name are index arithmetic, never stored as strings in the cube.
 */
export interface CaseData {
  name: string;
  cube: Float32Array;
  areas: string[];
  metrics: string[];
  /** Presence bitmap, one byte per (area, metric) pair at index
   * `area * numMetrics + metric`: 1 = that plane has real data in `cube`,
   * 0 = it is NaN-filled because the source file lacked the column for
   * that area. Every kernel must consult this before reading the cube --
   * NaN poisons Welford, min/max, and duration-curve sort silently
   * (footgun 21). */
  presence: Uint8Array;
  /** Per-hour TOU code, length 8760, indexes into calendar.ts's
   * TOU_LABELS. Read from the file's TOU column at ingest -- never
   * recomputed (footgun 17). */
  tou: Uint8Array;
  /** Full column list present in the source CSV, independent of what was
   * retained -- lets Save/Load and the picker distinguish "never existed
   * in this study" from "existed but wasn't kept". */
  sourceColumns: string[];
  /** Calendar year this case's 8,760 hours belong to -- selects which
   * buildCalendar(year) to use. Feb 29 is dropped at ingest regardless of
   * year (D4), so every case is exactly 8,760 hours. */
  year: number;
}
