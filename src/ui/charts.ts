// src/ui/charts.ts
//
// The four panes: two uPlot instances, one hand-drawn canvas box plot, one
// DOM stats table.
//
// uPlot instances are created ONCE and updated with setData(). Recreating
// one per data change or per resize throws away the reason uPlot was chosen.
// The box plot and the stats table are hand-drawn because uPlot ships
// neither and needs to ship neither.
//
// This module is a renderer: everything it draws is computed by main.ts and
// handed over. It owns no kernels and no query state.

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { HOURS_PER_YEAR, MONTH_NAMES } from '../calendar';
import type { Quantiles, Stats } from '../kernels';
import { scaleOf, scalesOf } from '../rules';
import type { BoxDim, Query } from '../types';

/** Points on the duration curve's shared x axis. The x axis is % of
 * interval, which is what makes cases with different filtered-hour counts
 * overlayable at all; 1,000 points is >2 per pixel at any pane width this
 * layout produces. */
const DURATION_POINTS = 1000;

export interface CaseSeries {
  /** "Case · Area · Metric", trimmed to the axes that actually vary. */
  name: string;
  color: string;
  /** Unit of this line's metric. Lines of different units get different y
   * scales -- MWh and $/MWh share an axis only by accident, never on purpose. */
  unit: string;
  metric: string;
  /** 8,760 values with NaN wherever the hour is filtered out or has no data,
   * or null when the pane refused to build a series at all. */
  values: Float32Array | null;
  /** Shown in place of a chart. Panes refuse rather than plot nonsense. */
  refusal?: string;
  warnings: string[];
  /** Named in the pane header for a weighted-mean column. */
  weightColumn?: string;
  /** Kept values, sorted ascending. */
  sorted: Float32Array;
  n: number;
  stats: Stats;
  quantiles: Quantiles;
  /** Pooled sum(v*w)/sum(w), or null for columns that are not weighted. */
  pooled: number | null;
  /** Zero in every kept hour of this case -- data, not a load error. */
  allZero: boolean;
}

export interface BoxGroup {
  label: string;
  boxes: { color: string; name: string; unit: string; quantiles: Quantiles }[];
}

export interface ChartsInput {
  query: Query;
  /** True when any metric is a price/intensive column, which changes both the
   * header note and the stats table's Average labelling. */
  weighted: boolean;
  series: CaseSeries[];
  boxes: BoxGroup[];
  /** Case-level notes shown under the case list, e.g. the Feb 29 drop. */
  notes: string[];
  /** Set when the selection cannot be drawn at all -- every pane says so
   * instead of drawing part of it. */
  refusal?: string;
}

export interface Charts {
  render(input: ChartsInput): void;
  /** The time pane's current x window, in hour-of-year. Exposed on
   * window.gridview for the harness, which otherwise has only pixels to
   * read the axis from. */
  timeWindow(): [number, number] | null;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`index.html is missing #${id}`);
  return element;
}

/** Replace a pane's body with a message. Warnings render inline in the pane
 * they concern, never as a toast or a notification tray (GUI decision 7). */
function banner(body: HTMLElement, kind: 'refusal' | 'note', text: string): void {
  const element = document.createElement('div');
  element.className = `pane-banner pane-banner-${kind}`;
  element.textContent = text;
  body.appendChild(element);
}

function headerNote(pane: number, text: string): void {
  const header = byId(`pane-${pane}`).querySelector('.pane-note');
  if (header) header.textContent = text;
}

const HOUR_AXIS = Array.from({ length: HOURS_PER_YEAR }, (_, i) => i);
const PERCENT_AXIS = Array.from(
  { length: DURATION_POINTS },
  (_, i) => (i / (DURATION_POINTS - 1)) * 100,
);

/** Month boundaries in hour-of-year, for the time series x axis. The axis is
 * a (month, day, hour) index and never a date: different case years must
 * overlay cleanly, and no Date object may touch this (D4, footgun 3). */
const MONTH_STARTS = (() => {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const starts: number[] = [];
  let hour = 0;
  for (const days of lengths) {
    starts.push(hour);
    hour += days * 24;
  }
  return starts;
})();
/** Hour-of-year -> "Mar 14 · HE 15". Index arithmetic on MONTH_STARTS, never
 * a Date (D4, footgun 3) -- the x axis is a (month, day, hour) index. */
/** Month for an hour-of-year, by index arithmetic on MONTH_STARTS. */
function monthOf(hour: number): number {
  let month = 11;
  while (month > 0 && MONTH_STARTS[month] > hour) month--;
  return month;
}

function hourLabel(hour: number): string {
  const month = monthOf(hour);
  const day = Math.floor((hour - MONTH_STARTS[month]) / 24) + 1;
  return `${MONTH_NAMES[month]} ${day} · HE ${(hour % 24) + 1}`;
}

/**
 * Tick positions for the time axis: calendar boundaries, not uPlot's evenly
 * spaced numbers. A "Jan" label has to sit on Jan 1 -- an auto split lands on
 * an arbitrary hour, gets labelled with whatever month contains it, and the
 * dedupe below then drops whichever month happened to be sampled twice
 * (December, at twelve ticks across 8,760 hours).
 */
function timeSplits(self: uPlot, _axis: number, min: number, max: number): number[] {
  const span = max - min;
  const within = (hours: number[]) => hours.filter((hour) => hour >= min && hour <= max);
  // How many labels fit. "Feb 25" needs ~64 px; without this the ticks are
  // spaced by calendar and overprint each other on a narrow pane.
  const room = Math.max(2, Math.floor(self.bbox.width / (devicePixelRatio || 1) / 64));

  if (span > 60 * 24) return within(MONTH_STARTS);

  if (span > 2 * 24) {
    const firstDay = Math.ceil(min / 24);
    const lastDay = Math.floor(max / 24);
    const step = Math.max(1, Math.ceil((lastDay - firstDay + 1) / room));
    const days: number[] = [];
    for (let day = firstDay; day <= lastDay; day += step) days.push(day * 24);
    return days;
  }

  // Hour boundaries, on a 1/2/3/6/12-hour step.
  const hours = Math.max(1, Math.round(span));
  const step = [1, 2, 3, 6, 12].find((candidate) => hours / candidate <= room) ?? 24;
  const ticks: number[] = [];
  for (let hour = Math.ceil(min / step) * step; hour <= max; hour += step) ticks.push(hour);
  return ticks;
}

/** Labels for those ticks, at the resolution the window is showing. */
function timeAxisValues(self: uPlot, splits: number[]): string[] {
  const scale = self.scales.x;
  const span = (scale.max ?? HOURS_PER_YEAR) - (scale.min ?? 0);
  return splits.map((hour) => {
    const month = monthOf(hour);
    const day = Math.floor((hour - MONTH_STARTS[month]) / 24) + 1;
    if (span > 60 * 24) return MONTH_NAMES[month];
    if (span > 2 * 24) return `${MONTH_NAMES[month]} ${day}`;
    return `${MONTH_NAMES[month]} ${day} HE ${(hour % 24) + 1}`;
  });
}

/**
 * Whether to draw point markers.
 *
 * A line is drawn between ADJACENT kept values, so a filter that keeps one
 * hour a day leaves every value isolated between nulls and there is nothing
 * to stroke: without markers the pane renders empty. That is a property of
 * the gaps, not of how many points there are -- a full year at one hour a day
 * is 365 isolated values, far too many to pass a density test, and still
 * needs every one of them drawn as a dot.
 */
function showPoints(self: uPlot, seriesIndex: number, from: number, to: number): boolean {
  const values = self.data[seriesIndex];
  let kept = 0;
  let segments = 0;
  for (let i = from; i <= to; i++) {
    if (values[i] == null) continue;
    kept++;
    if (i < to && values[i + 1] != null) segments++;
  }
  if (kept === 0) return false;
  // Nothing would be drawn at all: markers are the only thing that can show.
  if (segments === 0) return true;
  // Otherwise markers are decoration, worth it only when they are legible --
  // roughly one every 4 px of the drawn range.
  return kept <= self.bbox.width / (devicePixelRatio || 1) / 4;
}

/** Trim a label to a pixel width, with an ellipsis. Canvas has no text
 * overflow of its own. */
function clip(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && context.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut--;
  return `${text.slice(0, cut)}…`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (magnitude >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}

/** Hover readout. uPlot's own legend is off (the legend lives in the rail,
 * once -- decision 5), so the cursor gets a values-only box: the x position
 * and one number per series, colour-matched to the rail. It pins to a top
 * corner of the plot rather than following the pointer, which keeps it out
 * of the way of the cursor points and off the pane edges. */
function addTooltip(
  options: uPlot.Options,
  labelX: (value: number) => string,
  colors: string[],
): void {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.display = 'none';

  options.hooks = {
    ...options.hooks,
    setCursor: [
      (self) => {
        if (tip.parentElement !== self.over) self.over.appendChild(tip);
        const idx = self.cursor.idx;
        const left = self.cursor.left ?? -1;
        if (idx == null || left < 0) {
          tip.style.display = 'none';
          return;
        }

        const rows: HTMLElement[] = [];
        for (let i = 1; i < self.series.length; i++) {
          const value = self.data[i][idx];
          if (value == null || !Number.isFinite(value)) continue;
          const row = document.createElement('div');
          row.className = 'chart-tip-row';
          const dot = document.createElement('span');
          dot.className = 'chart-tip-dot';
          // Colours come from the case list, not series[i].stroke -- uPlot
          // normalises stroke into a function, which stringifies to garbage.
          dot.style.background = colors[i - 1] ?? '#666';
          row.appendChild(dot);
          const name = document.createElement('span');
          name.className = 'chart-tip-name';
          const label = self.series[i].label;
          name.textContent = typeof label === 'string' ? label : '';
          row.appendChild(name);
          const number = document.createElement('b');
          number.textContent = formatNumber(value);
          row.appendChild(number);
          rows.push(row);
        }
        if (rows.length === 0) {
          tip.style.display = 'none';
          return;
        }

        const head = document.createElement('div');
        head.className = 'chart-tip-x';
        head.textContent = labelX(self.data[0][idx] as number);
        tip.replaceChildren(head, ...rows);
        tip.style.display = '';
        // Sit on the side the cursor is not on, so the box never covers the
        // points it is describing.
        const right = left < self.over.clientWidth / 2;
        tip.style.left = right ? 'auto' : '6px';
        tip.style.right = right ? '6px' : 'auto';
      },
    ],
  };
}

/**
 * A dot on each series' highest and lowest point WITHIN THE VISIBLE WINDOW.
 * Recomputed on every draw, so zooming in re-marks the extremes of what is on
 * screen rather than leaving the year's extremes stranded off-axis.
 */
function markExtremes(options: uPlot.Options, colors: string[]): void {
  options.hooks = {
    ...options.hooks,
    draw: [
      (self) => {
        const { min, max } = self.scales.x;
        if (min == null || max == null) return;
        // The x values ARE the hour indices on this pane, so the visible
        // index range needs no search.
        const lo = Math.max(0, Math.ceil(min));
        const hi = Math.min(self.data[0].length - 1, Math.floor(max));
        if (hi < lo) return;

        const ratio = devicePixelRatio || 1;
        const ctx = self.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(self.bbox.left, self.bbox.top, self.bbox.width, self.bbox.height);
        ctx.clip();

        for (let s = 1; s < self.series.length; s++) {
          if (self.series[s].show === false) continue;
          const values = self.data[s];
          let lowest = -1;
          let highest = -1;
          for (let i = lo; i <= hi; i++) {
            const value = values[i];
            if (value == null) continue;
            if (lowest < 0 || value < (values[lowest] as number)) lowest = i;
            if (highest < 0 || value > (values[highest] as number)) highest = i;
          }
          if (lowest < 0) continue;

          const scale = self.series[s].scale ?? 'y';
          ctx.fillStyle = colors[s - 1] ?? '#666';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5 * ratio;
          for (const index of lowest === highest ? [lowest] : [lowest, highest]) {
            const x = self.valToPos(self.data[0][index] as number, 'x', true);
            const y = self.valToPos(values[index] as number, scale, true);
            ctx.beginPath();
            ctx.arc(x, y, 3.5 * ratio, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      },
    ],
  };
}

/** `count` hidden value tags, one per y scale. */
function makeAxisTags(count: number): HTMLElement[] {
  return Array.from({ length: count }, () => {
    const tag = document.createElement('div');
    tag.className = 'axis-tag';
    tag.style.display = 'none';
    return tag;
  });
}

/**
 * Place one axis value tag, or hide it when there is no reading. Index 0 sits
 * just outside the plot's left edge and index 1 just outside its right --
 * positioned from the plot area's own edges, the only geometry that holds
 * whatever the axis gutters end up sized at.
 *
 * Shared by the uPlot panes and the hand-drawn box canvas. They differ only in
 * how a pixel becomes a value (uPlot's posToVal vs a linear interpolation over
 * the box plot's own scale); everything after that is this function.
 */
function placeAxisTag(
  tag: HTMLElement,
  index: number,
  value: number | null,
  top: number,
  plotLeft: number,
  plotRight: number,
): void {
  if (value === null || !Number.isFinite(value)) {
    tag.style.display = 'none';
    return;
  }
  tag.textContent = formatNumber(value);
  tag.style.display = '';
  tag.style.top = `${top}px`;
  tag.style.left = `${index === 0 ? plotLeft - 4 : plotRight + 4}px`;
  tag.style.transform = index === 0 ? 'translate(-100%, -50%)' : 'translateY(-50%)';
}

/**
 * A value box pinned to the y axis at the cursor's height -- the reading the
 * eye is trying to take off the axis anyway, without tracing a line back to
 * it. One per scale, so a two-unit chart labels both sides.
 */
function addAxisReadout(options: uPlot.Options, scales: string[]): void {
  const tags = makeAxisTags(Math.min(scales.length, 2));

  options.hooks = {
    ...options.hooks,
    setCursor: [
      ...(options.hooks?.setCursor ?? []),
      (self) => {
        const ratio = devicePixelRatio || 1;
        const top = self.cursor.top ?? -1;
        const left = self.cursor.left ?? -1;
        const off = top < 0 || left < 0;
        tags.forEach((tag, index) => {
          if (tag.parentElement !== self.root) self.root.appendChild(tag);
          placeAxisTag(
            tag,
            index,
            off ? null : self.posToVal(top, scales[index]),
            self.bbox.top / ratio + top,
            self.bbox.left / ratio,
            (self.bbox.left + self.bbox.width) / ratio,
          );
        });
      },
    ],
  };
}

export function createCharts(onBoxDimChange: (dim: BoxDim) => void): Charts {
  const timeBody = byId('pane-1-body');
  const durationBody = byId('pane-2-body');
  const boxBody = byId('pane-3-body');
  const statsBody = byId('pane-4-body');

  // uPlot needs explicit pixel dimensions, so both charts live in their own
  // sized host element and get setSize() from one ResizeObserver.
  const timeHost = document.createElement('div');
  timeBody.appendChild(timeHost);
  const durationHost = document.createElement('div');
  durationBody.appendChild(durationHost);

  const canvas = document.createElement('canvas');
  canvas.className = 'box-canvas';
  boxBody.appendChild(canvas);

  /** Geometry and scales of the last box-plot draw, for the axis readout. The
   * box plot is hand-drawn, so nothing else knows how to invert a pixel. */
  let boxGeometry: {
    units: string[];
    range: Map<string, { low: number; high: number }>;
    marginLeft: number;
    marginTop: number;
    plotWidth: number;
    plotHeight: number;
  } | null = null;

  const boxTags = makeAxisTags(2);
  for (const tag of boxTags) boxBody.appendChild(tag);

  /** Where each drawn box sits, so a pointer can be matched to one. The box
   * plot is hand-drawn on a canvas, so there is nothing to hit-test against
   * unless the draw records it. */
  interface BoxHit {
    centre: number;
    label: string;
    name: string;
    unit: string;
    color: string;
    quantiles: Quantiles;
  }
  let boxHits: BoxHit[] = [];
  /** Index into boxHits of the box nearest the pointer, or -1. */
  let hoveredBox = -1;

  const boxTip = document.createElement('div');
  boxTip.className = 'chart-tip';
  boxTip.style.display = 'none';
  boxBody.appendChild(boxTip);

  /** The reading for one box: every number the box actually draws, in the
   * order it draws them top to bottom, so the list matches the shape. */
  function showBoxTip(hit: BoxHit, pointerX: number): void {
    const head = document.createElement('div');
    head.className = 'chart-tip-x';
    head.textContent = hit.label;

    // With `box by: case` the group label IS the series name, so printing
    // both is the same string twice.
    const title = document.createElement('div');
    title.className = 'chart-tip-row';
    const dot = document.createElement('span');
    dot.className = 'chart-tip-dot';
    dot.style.background = hit.color;
    title.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'chart-tip-name';
    name.textContent = hit.name;
    title.appendChild(name);

    const q = hit.quantiles;
    const rows: [string, number | string][] = [
      ['max', q.max],
      ['upper whisker', q.upperWhisker],
      ['p75', q.p75],
      ['median', q.median],
      ['p25', q.p25],
      ['lower whisker', q.lowerWhisker],
      ['min', q.min],
      ['n', q.n.toLocaleString()],
    ];
    // Outliers are counted, not drawn individually, so the count is the only
    // place that number appears at all.
    if (q.outliers > 0) rows.push(['outliers', q.outliers.toLocaleString()]);

    const body = rows.map(([key, value]) => {
      const row = document.createElement('div');
      row.className = 'chart-tip-row';
      const label = document.createElement('span');
      label.className = 'chart-tip-name';
      label.textContent = key;
      row.appendChild(label);
      const number = document.createElement('b');
      number.textContent = typeof value === 'string' ? value : formatNumber(value);
      row.appendChild(number);
      return row;
    });

    if (hit.unit) {
      const unit = document.createElement('div');
      unit.className = 'chart-tip-x';
      unit.style.marginTop = '2px';
      unit.style.marginBottom = '0';
      unit.textContent = hit.unit;
      body.push(unit);
    }

    boxTip.replaceChildren(...(hit.name === hit.label ? [head] : [head, title]), ...body);
    boxTip.style.display = '';
    // Sit on the side the pointer is not on, so it never covers the box it
    // is describing.
    const right = pointerX < boxBody.clientWidth / 2;
    boxTip.style.left = right ? 'auto' : '6px';
    boxTip.style.right = right ? '6px' : 'auto';
  }

  canvas.addEventListener('mousemove', (event) => {
    const geometry = boxGeometry;
    if (!geometry) return;
    const y = event.offsetY;
    const inside =
      y >= geometry.marginTop &&
      y <= geometry.marginTop + geometry.plotHeight &&
      event.offsetX >= geometry.marginLeft &&
      event.offsetX <= geometry.marginLeft + geometry.plotWidth;
    const fraction = 1 - (y - geometry.marginTop) / geometry.plotHeight;

    boxTags.forEach((tag, index) => {
      const unit = geometry.units[index];
      const scale = unit === undefined ? undefined : geometry.range.get(unit);
      placeAxisTag(
        tag,
        index,
        !inside || !scale ? null : scale.low + (scale.high - scale.low) * fraction,
        y,
        geometry.marginLeft,
        geometry.marginLeft + geometry.plotWidth,
      );
    });

    // Nearest by horizontal distance only. Boxes are laid out across the x
    // axis, and a box is a tall thin thing -- requiring the pointer to be
    // inside its vertical span would mean hovering nothing most of the time.
    let nearest = -1;
    if (inside) {
      let best = Infinity;
      boxHits.forEach((hit, index) => {
        const distance = Math.abs(event.offsetX - hit.centre);
        if (distance < best) {
          best = distance;
          nearest = index;
        }
      });
    }
    if (nearest !== hoveredBox) {
      hoveredBox = nearest;
      if (lastInput) drawBoxes(lastInput, true);
    }
    if (nearest < 0) boxTip.style.display = 'none';
    else showBoxTip(boxHits[nearest], event.offsetX);
  });
  canvas.addEventListener('mouseleave', () => {
    for (const tag of boxTags) tag.style.display = 'none';
    boxTip.style.display = 'none';
    if (hoveredBox >= 0) {
      hoveredBox = -1;
      if (lastInput) drawBoxes(lastInput, true);
    }
  });

  const boxDimSelect = byId('box-dim-select') as HTMLSelectElement;
  boxDimSelect.addEventListener('change', () => onBoxDimChange(boxDimSelect.value as BoxDim));

  let timePlot: uPlot | null = null;
  let durationPlot: uPlot | null = null;
  let lastInput: ChartsInput | null = null;
  /** Hour range the current filters keep, or null when they keep nothing. */
  let timeExtent: [number, number] | null = null;

  // Drag-zoom is undone by a double-click on the plot, which nobody guesses.
  // The header button is the same action with a name on it. "Full extent" for
  // pane 1 means the filtered hours, not the calendar year -- returning to
  // eleven empty months would not be a reset of anything the user asked for.
  function resetZoom(plot: uPlot | null, extent: [number, number] | null): void {
    if (!plot) return;
    const x = plot.data[0];
    if (x.length === 0) return;
    const [min, max] = extent ?? [x[0], x[x.length - 1]];
    plot.setScale('x', { min, max });
  }
  byId('zoom-reset-1').addEventListener('click', () => resetZoom(timePlot, timeExtent));

  /**
   * The time pane as CSV: exactly the hours on screen, one column per drawn
   * line. What you exported is what you were looking at -- the zoom and the
   * filters are both already baked into the plot's data and scale, so neither
   * has to be re-derived here and neither can drift from the picture.
   */
  byId('download-1').addEventListener('click', () => {
    if (!timePlot || !lastInput) return;
    const drawn = lastInput.series.filter((s) => s.values !== null);
    const { min, max } = timePlot.scales.x;
    if (min == null || max == null || drawn.length === 0) return;

    const rows = [['Month', 'Day', 'HE', 'HourOfYear', ...drawn.map((s) => s.name)].join(',')];
    for (let hour = Math.max(0, Math.ceil(min)); hour <= Math.min(HOURS_PER_YEAR - 1, max); hour++) {
      const values = drawn.map((s) => (s.values as Float32Array)[hour]);
      // Hours the filter dropped are gaps in the chart and rows that do not
      // exist in the export.
      if (values.every((value) => Number.isNaN(value))) continue;
      const month = monthOf(hour);
      const day = Math.floor((hour - MONTH_STARTS[month]) / 24) + 1;
      rows.push(
        [
          MONTH_NAMES[month],
          day,
          (hour % 24) + 1,
          hour,
          ...values.map((value) => (Number.isNaN(value) ? '' : String(value))),
        ].join(','),
      );
    }

    const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'time-series.csv';
    anchor.click();
    // Revoked on a later task: revoking synchronously races the download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  byId('zoom-reset-2').addEventListener('click', () => resetZoom(durationPlot, null));

  // Quartiles as text on the box plot: off by default, because 24 hour-of-day
  // boxes with five numbers each is not a chart any more.
  const boxValuesCheck = byId('box-values-check') as HTMLInputElement;
  boxValuesCheck.addEventListener('change', () => {
    if (lastInput) drawBoxes(lastInput);
  });

  function paneSize(body: HTMLElement): { width: number; height: number } {
    const rect = body.getBoundingClientRect();
    return { width: Math.max(120, Math.floor(rect.width)), height: Math.max(80, Math.floor(rect.height)) };
  }

  /**
   * One y scale per distinct unit, and one axis each. Two units is the most
   * that can be read off a single plot (left and right); beyond that the
   * pane refuses rather than stack axes nobody can attribute to a line.
   */
  function baseOptions(
    body: HTMLElement,
    xLabel: string,
    units: { scale: string; label: string }[],
    xValues: (self: uPlot, splits: number[]) => string[],
    xSplits?: (self: uPlot, axis: number, min: number, max: number) => number[],
  ): uPlot.Options {
    const { width, height } = paneSize(body);
    return {
      width,
      height,
      padding: [8, 12, 0, 0],
      legend: { show: false }, // the legend lives in the rail, once (decision 5)
      cursor: { drag: { x: true, y: false } },
      scales: { x: { time: false } },
      axes: [
        { label: xLabel, values: xValues, splits: xSplits, grid: { stroke: '#e8e8e8' }, size: 34 },
        ...units.map(({ scale, label }, index) => ({
          scale,
          label,
          side: (index === 0 ? 3 : 1) as 1 | 3,
          grid: { stroke: index === 0 ? '#e8e8e8' : 'transparent' },
          labelSize: 18,
          size: 58,
        })),
      ],
      series: [{}],
    };
  }

  /** Distinct units among the drawn lines, in first-seen order. */
  function unitsOf(series: CaseSeries[]): string[] {
    return Array.from(new Set(series.map((s) => s.unit)));
  }

  function rebuild(input: ChartsInput): void {
    // A refusal (too many series to colour, three or more units on one y) is
    // total: no pane draws a subset of a selection the app has said it cannot
    // render, because a partial chart is the one that gets screenshotted.
    let drawable = input.refusal ? [] : input.series.filter((s) => s.values !== null);
    // Counted in SCALES, not units: MW and MWh share one axis, so an MWh +
    // MW + $/MWh overlay is two axes and draws.
    const tooManyUnits = scalesOf(drawable).length > 2;
    const refusal =
      input.refusal ??
      (tooManyUnits
        ? `${unitsOf(drawable).length} different units selected (${unitsOf(drawable).join(', ')}). ` +
          'Two is the most a chart can carry — one axis on each side.'
        : undefined);
    if (tooManyUnits) drawable = [];

    // ---------------------------------------------------------- pane 1
    timeBody.querySelectorAll('.pane-banner').forEach((node) => node.remove());
    timeHost.style.display = drawable.length > 0 ? '' : 'none';
    if (drawable.length === 0) {
      banner(timeBody, 'refusal', refusal ?? input.series[0]?.refusal ?? 'Drop a CSV export to begin.');
    } else {
      // The kept hours' own extent. Filters blank whole stretches of the year
      // and an axis that still spans Jan-Dec for a January-only selection is
      // mostly empty space, so the window follows the filter.
      let first = HOURS_PER_YEAR;
      let last = -1;
      const data: uPlot.AlignedData = [
        HOUR_AXIS,
        ...drawable.map((s) => {
          const column: (number | null)[] = new Array(HOURS_PER_YEAR);
          const values = s.values as Float32Array;
          for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
            const value = values[hour];
            if (Number.isNaN(value)) {
              column[hour] = null;
              continue;
            }
            column[hour] = value;
            if (hour < first) first = hour;
            if (hour > last) last = hour;
          }
          return column;
        }),
      ];
      // Half an hour of padding keeps a one-hour selection from collapsing to
      // a zero-width scale, which uPlot cannot range.
      timeExtent = last < first ? null : [first - 0.5, last + 0.5];
      // Units are part of the signature: an axis label and its scale are baked
      // in at construction, so a metric change from Load (MWh) to a $/MWh
      // column would otherwise keep the old label and title the chart with
      // the wrong quantity. Filter changes -- the frequent interaction -- do
      // not move this signature, so they still go through setData().
      const scales = scalesOf(drawable);
      const wanted = `${drawable.map((s) => `${s.name}|${s.color}|${s.unit}`).join(',')}`;
      if (!timePlot || timePlot.series.length - 1 !== drawable.length || timeHost.dataset.signature !== wanted) {
        timeHost.dataset.signature = wanted;
        timePlot?.destroy();
        const options = baseOptions(timeBody, '', scales, timeAxisValues, timeSplits);
        options.series = [
          { label: 'hour' },
          ...drawable.map((s) => ({
            label: s.name,
            stroke: s.color,
            scale: scaleOf(s.unit),
            width: 1,
            // A filter that keeps one hour a day leaves every kept value
            // isolated between nulls, and a lone point has no segment to
            // draw: with points off the pane renders empty. They come back
            // on as soon as the kept values are sparse enough to see.
            points: { show: showPoints, size: 3 },
          })),
        ];
        addTooltip(options, hourLabel, drawable.map((s) => s.color));
        addAxisReadout(options, scales.map((s) => s.scale));
        markExtremes(options, drawable.map((s) => s.color));
        timePlot = new uPlot(options, data, timeHost);
      } else {
        timePlot.setData(data);
      }
      // After setData, because setData re-ranges x to the full 8,760-hour
      // array. Every filter change re-frames the window; a drag-zoom inside
      // it survives until the next one.
      if (timeExtent) timePlot.setScale('x', { min: timeExtent[0], max: timeExtent[1] });
    }

    // ---------------------------------------------------------- pane 2
    durationBody.querySelectorAll('.pane-banner').forEach((node) => node.remove());
    durationHost.style.display = drawable.length > 0 ? '' : 'none';
    if (drawable.length === 0) {
      banner(durationBody, 'refusal', refusal ?? input.series[0]?.refusal ?? 'Drop a CSV export to begin.');
    } else {
      const data: uPlot.AlignedData = [
        PERCENT_AXIS,
        ...drawable.map((s) => {
          const column: (number | null)[] = new Array(DURATION_POINTS);
          // % of interval, resampled onto one shared axis. Cases keep
          // different numbers of hours once TOU filters differ per case, and
          // a shared x is what lets them overlay at all.
          for (let i = 0; i < DURATION_POINTS; i++) {
            if (s.n === 0) {
              column[i] = null;
              continue;
            }
            const at = Math.round((i / (DURATION_POINTS - 1)) * (s.n - 1));
            column[i] = s.sorted[at];
          }
          return column;
        }),
      ];
      const wanted = `${drawable.map((s) => `${s.name}|${s.color}|${s.unit}`).join(',')}`;
      if (
        !durationPlot ||
        durationPlot.series.length - 1 !== drawable.length ||
        durationHost.dataset.signature !== wanted
      ) {
        durationHost.dataset.signature = wanted;
        durationPlot?.destroy();
        const options = baseOptions(durationBody, '% of interval', scalesOf(drawable), (_self, splits) =>
          splits.map((value) => `${Math.round(value)}%`),
        );
        options.series = [
          { label: '%' },
          ...drawable.map((s) => ({
            label: s.name,
            stroke: s.color,
            scale: scaleOf(s.unit),
            width: 1.5,
            points: { show: false },
          })),
        ];
        addTooltip(options, (value) => `${value.toFixed(1)}% of interval`, drawable.map((s) => s.color));
        addAxisReadout(options, scalesOf(drawable).map((s) => s.scale));
        durationPlot = new uPlot(options, data, durationHost);
      } else {
        durationPlot.setData(data);
      }
    }

    // ---------------------------------------------------------- headers
    const weights = Array.from(new Set(drawable.map((s) => s.weightColumn).filter(Boolean)));
    const note =
      weights.length > 0
        ? `weighted mean by ${weights.join(', ')}`
        : input.weighted
          ? 'weighted mean'
          : '';
    headerNote(1, note);
    headerNote(2, note);

    // An all-zero column plots as a flat line and produces a degenerate box.
    // That is the data, not a load error, and the pane says so itself.
    const zeroCases = drawable.filter((s) => s.allZero).map((s) => `${s.name} (${s.metric})`);
    if (zeroCases.length > 0) {
      const text =
        `Zero in every selected hour: ${zeroCases.join(', ')}. ` +
        'That is the data, not a load error.';
      banner(timeBody, 'note', text);
      banner(durationBody, 'note', text);
    }

    drawBoxes(input);
    drawStats(input);
  }

  // ------------------------------------------------------------ box plot
  /** `keepHover` is set only by the hover redraw. Any other caller is a data
   * or size change, where the old hit index means nothing. */
  function drawBoxes(input: ChartsInput, keepHover = false): void {
    if (!keepHover) {
      hoveredBox = -1;
      boxTip.style.display = 'none';
    }
    boxBody.querySelectorAll('.pane-banner').forEach((node) => node.remove());
    const { width, height } = paneSize(boxBody);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const groups = input.boxes.filter((group) => group.boxes.some((box) => box.quantiles.n > 0));
    if (groups.length === 0) {
      boxGeometry = null;
      boxHits = [];
      canvas.style.display = 'none';
      banner(boxBody, 'refusal', input.series[0]?.refusal ?? 'Nothing to plot with these filters.');
      return;
    }
    canvas.style.display = '';

    // One y scale per unit, exactly as the two uPlot panes do it: a $/MWh box
    // and an MWh box on a shared axis is a comparison of nothing.
    const units = scalesOf(groups.flatMap((group) => group.boxes));
    const range = new Map<string, { low: number; high: number }>();
    for (const group of groups) {
      for (const box of group.boxes) {
        if (box.quantiles.n === 0) continue;
        const seen = range.get(scaleOf(box.unit)) ?? { low: Infinity, high: -Infinity };
        seen.low = Math.min(seen.low, box.quantiles.min);
        seen.high = Math.max(seen.high, box.quantiles.max);
        range.set(scaleOf(box.unit), seen);
      }
    }
    for (const seen of range.values()) {
      if (seen.low === seen.high) {
        seen.low -= 1;
        seen.high += 1;
      }
    }

    // Room for the tick numbers plus a rotated unit label, the same shape
    // uPlot gives the other panes: 58 px of numbers + 18 px of label.
    const AXIS_LABEL = 16;
    const marginLeft = 56 + AXIS_LABEL;
    const marginRight = units.length > 1 ? 56 + AXIS_LABEL : 8;
    const marginBottom = 22;
    const marginTop = 10;
    const plotHeight = height - marginTop - marginBottom;
    const plotWidth = width - marginLeft - marginRight;
    const y = (value: number, scale: string) => {
      const seen = range.get(scale) ?? { low: 0, high: 1 };
      return marginTop + plotHeight * (1 - (value - seen.low) / (seen.high - seen.low));
    };

    context.font = '10px system-ui, sans-serif';
    context.fillStyle = '#666';
    units.slice(0, 2).forEach(({ scale, label }, index) => {
      const seen = range.get(scale);
      if (!seen) return;
      for (let tick = 0; tick <= 4; tick++) {
        const value = seen.low + ((seen.high - seen.low) * tick) / 4;
        const py = y(value, scale);
        if (index === 0) {
          context.strokeStyle = '#e8e8e8';
          context.beginPath();
          context.moveTo(marginLeft, py);
          context.lineTo(marginLeft + plotWidth, py);
          context.stroke();
          context.textAlign = 'right';
          context.fillText(formatNumber(value), marginLeft - 6, py + 3);
          context.textAlign = 'left';
        } else {
          context.fillText(formatNumber(value), marginLeft + plotWidth + 6, py + 3);
        }
      }

      // The unit, rotated up the axis it belongs to -- always, not only when
      // there are two of them. A box plot of MWh and one of $/MWh look
      // identical until the axis says which is which.
      if (label) {
        context.save();
        context.translate(
          index === 0 ? AXIS_LABEL - 4 : marginLeft + plotWidth + 56 + AXIS_LABEL - 4,
          marginTop + plotHeight / 2,
        );
        context.rotate(-Math.PI / 2);
        context.textAlign = 'center';
        context.fillText(label, 0, 0);
        context.restore();
        context.textAlign = 'left';
      }
    });

    boxGeometry = { units: units.map((u) => u.scale), range, marginLeft, marginTop, plotWidth, plotHeight };

    boxHits = [];
    const anyHover = hoveredBox >= 0;

    const slot = plotWidth / groups.length;
    groups.forEach((group, groupIndex) => {
      const drawn = group.boxes.filter((box) => box.quantiles.n > 0);
      const boxWidth = Math.max(2, Math.min(24, (slot * 0.7) / Math.max(1, drawn.length)));
      drawn.forEach((box, boxIndex) => {
        const centre =
          marginLeft +
          slot * (groupIndex + 0.5) +
          (boxIndex - (drawn.length - 1) / 2) * (boxWidth + 1);
        const q = box.quantiles;

        const hitIndex = boxHits.length;
        boxHits.push({
          centre,
          label: group.label,
          name: box.name,
          unit: box.unit,
          color: box.color,
          quantiles: q,
        });
        const isHovered = hitIndex === hoveredBox;
        const dimmed = anyHover && !isHovered;
        // Dim rather than hide: the point of the pane is comparing boxes, so
        // the others have to stay readable while one is picked out.
        const strokeAlpha = dimmed ? 0.3 : 1;
        const fillAlpha = isHovered ? 0.5 : dimmed ? 0.08 : 0.25;

        context.strokeStyle = box.color;
        context.fillStyle = box.color;
        context.lineWidth = isHovered ? 2 : 1;
        context.globalAlpha = fillAlpha;
        context.fillRect(centre - boxWidth / 2, y(q.p75, scaleOf(box.unit)), boxWidth, y(q.p25, scaleOf(box.unit)) - y(q.p75, scaleOf(box.unit)));
        context.globalAlpha = strokeAlpha;
        context.strokeRect(centre - boxWidth / 2, y(q.p75, scaleOf(box.unit)), boxWidth, y(q.p25, scaleOf(box.unit)) - y(q.p75, scaleOf(box.unit)));

        context.beginPath();
        context.moveTo(centre - boxWidth / 2, y(q.median, scaleOf(box.unit)));
        context.lineTo(centre + boxWidth / 2, y(q.median, scaleOf(box.unit)));
        context.moveTo(centre, y(q.p75, scaleOf(box.unit)));
        context.lineTo(centre, y(q.upperWhisker, scaleOf(box.unit)));
        context.moveTo(centre, y(q.p25, scaleOf(box.unit)));
        context.lineTo(centre, y(q.lowerWhisker, scaleOf(box.unit)));
        context.moveTo(centre - boxWidth / 4, y(q.upperWhisker, scaleOf(box.unit)));
        context.lineTo(centre + boxWidth / 4, y(q.upperWhisker, scaleOf(box.unit)));
        context.moveTo(centre - boxWidth / 4, y(q.lowerWhisker, scaleOf(box.unit)));
        context.lineTo(centre + boxWidth / 4, y(q.lowerWhisker, scaleOf(box.unit)));
        context.stroke();

        context.globalAlpha = 1;
        context.lineWidth = 1;

        // Outlier extremes only. Drawing every outlier of a sparse column
        // means drawing thousands of dots that say one thing.
        if (q.outliers > 0) {
          context.globalAlpha = dimmed ? 0.2 : 0.6;
          context.beginPath();
          context.arc(centre, y(q.max, scaleOf(box.unit)), 1.5, 0, Math.PI * 2);
          context.arc(centre, y(q.min, scaleOf(box.unit)), 1.5, 0, Math.PI * 2);
          context.fill();
          context.globalAlpha = 1;
        }

        if (boxValuesCheck.checked) {
          context.fillStyle = '#333';
          context.textAlign = 'left';
          const at = centre + boxWidth / 2 + 3;
          // Quartiles plus the extremes -- min and max are the 0% and 100%
          // points, which sit at the outlier dots and not at the whiskers.
          // A whisker label is only drawn when the whisker is somewhere other
          // than the extreme, or the two would overprint each other.
          const labels: [number, number][] = [
            [q.max, -1],
            [q.p75, -1],
            [q.median, 3],
            [q.p25, 7],
            [q.min, 7],
          ];
          if (q.upperWhisker !== q.max) labels.push([q.upperWhisker, -1]);
          if (q.lowerWhisker !== q.min) labels.push([q.lowerWhisker, 7]);
          for (const [value, offset] of labels) {
            context.fillText(formatNumber(value), at, y(value, scaleOf(box.unit)) + offset);
          }
          context.fillStyle = box.color;
        }
      });

      context.fillStyle = '#666';
      context.textAlign = 'center';
      // "case · area · metric" labels are long and there is one per group;
      // unclipped they overprint each other into a grey smear.
      context.fillText(clip(context, group.label, slot - 4), marginLeft + slot * (groupIndex + 0.5), height - 6);
      context.textAlign = 'left';
    });

    if (groups.every((group) => group.boxes.every((box) => box.quantiles.degenerate))) {
      banner(
        boxBody,
        'note',
        'Every box is degenerate: p25 = median = p75. That is what a constant or ' +
          'mostly-zero column looks like, and it is the data.',
      );
    }
  }

  // ------------------------------------------------------------ stats table
  function drawStats(input: ChartsInput): void {
    statsBody.replaceChildren();

    if (input.series.length === 0) {
      banner(statsBody, 'refusal', 'Drop a CSV export to begin.');
      return;
    }

    const table = document.createElement('table');
    table.className = 'stats-table';
    const head = table.createTHead().insertRow();
    const columns = ['case', 'Average', 'Min', 'Max', 'StdDev'];
    if (input.weighted) columns.push('Pooled avg');
    for (const column of columns) {
      const cell = document.createElement('th');
      cell.textContent = column;
      head.appendChild(cell);
    }

    const body = table.createTBody();
    for (const entry of input.series) {
      const row = body.insertRow();
      const nameCell = row.insertCell();
      const swatch = document.createElement('span');
      swatch.className = 'case-swatch';
      swatch.style.background = entry.color;
      nameCell.appendChild(swatch);
      nameCell.appendChild(document.createTextNode(entry.name));

      if (entry.values === null) {
        const cell = row.insertCell();
        cell.colSpan = columns.length - 1;
        cell.className = 'stats-refusal';
        cell.textContent = entry.refusal ?? 'no data';
        continue;
      }

      row.insertCell().textContent = formatNumber(entry.stats.mean);
      row.insertCell().textContent = formatNumber(entry.stats.min);
      row.insertCell().textContent = formatNumber(entry.stats.max);
      row.insertCell().textContent = formatNumber(entry.stats.sd);
      if (input.weighted) {
        row.insertCell().textContent = entry.pooled === null ? '—' : formatNumber(entry.pooled);
      }
    }
    statsBody.appendChild(table);

    // The Average paradox, footnoted next to the numbers themselves rather
    // than in a help page: both columns are correct and they will disagree
    // visibly, because high-price hours are high-load hours.
    if (input.weighted) {
      const footnote = document.createElement('p');
      footnote.className = 'stats-footnote';
      footnote.textContent =
        'Average is the mean of the plotted per-hour weighted-mean series. Pooled avg is ' +
        'sum(value × weight) / sum(weight) over the same hours. Both are correct and they ' +
        'disagree on purpose — the pooled figure is higher because high-price hours are ' +
        'high-load hours.';
      statsBody.appendChild(footnote);
    }

    for (const note of input.notes) {
      const element = document.createElement('p');
      element.className = 'stats-note';
      element.textContent = note;
      statsBody.appendChild(element);
    }
  }

  // ------------------------------------------------------------ resize
  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (timePlot) {
        const size = paneSize(timeBody);
        timePlot.setSize(size);
      }
      if (durationPlot) {
        const size = paneSize(durationBody);
        durationPlot.setSize(size);
      }
      if (lastInput) {
        drawBoxes(lastInput);
      }
    });
  });
  // The pane BODIES, not just the chart area: expanding a pane to focus mode
  // leaves the grid the same size and only changes the pane, so an observer
  // on the grid never fires and the plot keeps its 2x2 dimensions.
  observer.observe(byId('chart-area'));
  observer.observe(timeBody);
  observer.observe(durationBody);
  observer.observe(boxBody);

  return {
    render(input) {
      lastInput = input;
      boxDimSelect.value = input.query.boxDim;
      rebuild(input);
    },
    timeWindow() {
      const scale = timePlot?.scales.x;
      return scale?.min == null || scale.max == null ? null : [scale.min, scale.max];
    },
  };
}
