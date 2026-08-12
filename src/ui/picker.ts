// src/ui/picker.ts
//
// The column picker, shown on the first drop and skippable (D6).
//
// Two rules make this more than a checkbox list:
//
//   * Every column is an independent choice. A weighted-mean column still
//     NEEDS its weight -- keeping `Avg LMP Weighted by Load ($/MWh)` without
//     `Load (MWh)` makes every multi-area series for it uncomputable, and the
//     tempting fallback, a plain mean, is exactly the wrong answer (footgun
//     20) -- but the answer to that is to say so here and refuse to draw it
//     later, not to take the checkbox away. A single-area series still plots
//     without the weight, because one plane IS the series.
//   * Selection narrows the cube's metric axis itself, not just the parse.
//     A cube allocated at full canonical width delivers the parse speedup
//     and none of the memory win, so the live readout below is the real
//     allocation arithmetic and not an estimate.

import { HOURS_PER_YEAR } from '../calendar';
import {
  CALCULATED_GROUP,
  defaultSelection,
  isDegenerate,
  metricGroups,
  requiredInputs,
  ruleFor,
} from '../rules';

const BYTES_PER_VALUE = 4; // Float32Array (D1)

/**
 * Resolve to the retained column list, or to `union` unchanged if the user
 * skips. A selection missing a weight its own columns depend on is allowed:
 * ingest reports it, and the multi-area series that needs it refuses to draw
 * (footgun 20) rather than silently plain-meaning.
 */
export function showPicker(union: string[], caseCount: number, areaCount: number): Promise<string[]> {
  return new Promise((resolve) => {
    const chosen = new Set(defaultSelection(union));

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = 'Which metrics should be kept?';
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      'A recommended set is ticked — load it as-is, adjust it, or keep everything. ' +
      'Memory is exactly linear in what you keep, which is how case count stops being ' +
      'the binding constraint.';
    modal.appendChild(subtitle);

    const toolbar = document.createElement('div');
    toolbar.className = 'modal-toolbar';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'Filter columns…';
    filter.className = 'modal-filter';
    toolbar.appendChild(filter);

    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'btn';
    selectAll.textContent = 'Select all';
    toolbar.appendChild(selectAll);

    const selectNone = document.createElement('button');
    selectNone.type = 'button';
    selectNone.className = 'btn';
    selectNone.textContent = 'Select none';
    toolbar.appendChild(selectNone);

    // The way back. Without it, "Select none" is a one-way door out of the
    // default set and the only route back is a page reload.
    const selectDefault = document.createElement('button');
    selectDefault.type = 'button';
    selectDefault.className = 'btn';
    selectDefault.textContent = 'Recommended';
    toolbar.appendChild(selectDefault);
    modal.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'modal-list';
    modal.appendChild(list);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn';
    skip.textContent = 'Keep everything';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Load with these';
    actions.append(skip, confirm);
    modal.appendChild(actions);

    /** Columns the current selection depends on -- weights and the operands of
     * calculated columns -- mapped to their dependents. Not enforced; shown, so
     * dropping one is a decision and not a surprise. */
    function lockedInputs(): Map<string, { weight: string[]; operand: string[] }> {
      const locked = new Map<string, { weight: string[]; operand: string[] }>();
      const at = (input: string) => {
        const seen = locked.get(input) ?? { weight: [], operand: [] };
        locked.set(input, seen);
        return seen;
      };
      for (const name of chosen) {
        const rule = ruleFor(name);
        if (!rule) continue;
        for (const weight of [rule.weight, rule.fallbackWeight]) {
          if (weight) at(weight).weight.push(name);
        }
        if (rule.derived) {
          at(rule.derived.minuend).operand.push(name);
          at(rule.derived.subtrahend).operand.push(name);
        }
      }
      return locked;
    }

    /** Folders the user has opened or closed, by title. */
    const openState = new Map<string, boolean>();

    /** Which folders are open before the user touches any: the ones an
     * analyst opens anyway. A UI choice, so it lives here and not with the
     * classification. */
    const OPEN_BY_DEFAULT = new Set(['Load', 'Generation', 'Prices', CALCULATED_GROUP]);

    function grouped(needle: string): { title: string; names: string[] }[] {
      return metricGroups(union.filter((name) => !needle || name.toLowerCase().includes(needle)));
    }

    function paint(): void {
      const locked = lockedInputs();
      const needle = filter.value.trim().toLowerCase();
      list.replaceChildren();

      for (const { title, names } of grouped(needle)) {
        const folder = document.createElement('details');
        folder.dataset.group = title;
        // Calculated columns are not in any file's header, so the folder is
        // marked rather than left to look like another block of export data.
        const calculated = title === CALCULATED_GROUP;
        if (calculated) folder.className = 'picker-calculated';
        // A filter opens everything -- a hit inside a closed folder is a hit
        // the user cannot see. Otherwise the folder remembers what the user
        // last did to it, which has to survive both a repaint and a filter
        // that hid the folder entirely.
        folder.open = needle ? true : (openState.get(title) ?? OPEN_BY_DEFAULT.has(title));

        const summary = document.createElement('summary');
        summary.className = 'picker-folder';
        // Recorded on click, not on the toggle event: painting sets `open`
        // programmatically and that fires toggle too.
        summary.addEventListener('click', () => openState.set(title, !folder.open));
        const label = document.createElement('span');
        label.textContent = calculated ? `${title} — computed at load, not in the export` : title;
        summary.appendChild(label);
        const count = document.createElement('span');
        count.className = 'picker-count';
        count.textContent = `${names.filter((n) => chosen.has(n)).length}/${names.length}`;
        summary.appendChild(count);
        folder.appendChild(summary);

        for (const name of names) {
          const row = document.createElement('label');
          row.className = 'modal-row';

          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = name;
          box.checked = chosen.has(name);
          row.appendChild(box);

          const text = document.createElement('span');
          text.className = 'modal-row-name';
          text.textContent = name;
          row.appendChild(text);

          // Tooltips only; the on-screen badges are gone.
          const dependents = locked.get(name);
          const rule = ruleFor(name);
          if (rule?.derived) {
            const symbol = rule.derived.op === 'div' ? '\u00f7' : '\u2212';
            row.title =
              `Calculated at load: ${rule.derived.minuend} ${symbol} ${rule.derived.subtrahend}. ` +
              'Keep both of those or this cannot be built.';
          } else if (dependents && dependents.operand.length > 0) {
            row.title =
              `${dependents.operand.join(', ')} is calculated from this. Without it, that ` +
              'column cannot be built at all.';
          } else if (dependents && dependents.weight.length > 0) {
            row.title =
              `${dependents.weight.join(', ')} uses this as a weight. Without it, those ` +
              'columns can only be plotted for a single area.';
          } else if (isDegenerate(name)) {
            row.title =
              'Identically zero in every hour of the reference export. Valid data, but a constant.';
          }

          box.addEventListener('change', () => {
            if (box.checked) chosen.add(name);
            else chosen.delete(name);
            paint();
          });
          folder.appendChild(row);
        }
        list.appendChild(folder);
      }

      const missing = requiredInputs([...chosen]).filter((weight) => !chosen.has(weight));
      // Exactly what ingest will allocate: retained x cases x hours x areas x 4.
      const perMetric = caseCount * HOURS_PER_YEAR * areaCount * BYTES_PER_VALUE;
      const bytes = chosen.size * perMetric;
      // What the other button costs, so "keep everything" is an informed click
      // rather than the one number the dialog does not show.
      skip.title = `All ${union.length} columns ≈ ${(
        (union.length * perMetric) /
        (1024 * 1024)
      ).toFixed(0)} MB`;
      readout.textContent =
        `${chosen.size} metric${chosen.size === 1 ? '' : 's'} × ${caseCount} case` +
        `${caseCount === 1 ? '' : 's'} ≈ ${(bytes / (1024 * 1024)).toFixed(0)} MB` +
        (missing.length > 0
          ? ` · without ${missing.join(', ')}, the columns weighted by ${
              missing.length === 1 ? 'it' : 'them'
            } plot for one area only`
          : '');
      confirm.disabled = chosen.size === 0;
    }

    filter.addEventListener('input', paint);
    selectAll.addEventListener('click', () => {
      for (const name of union) chosen.add(name);
      paint();
    });
    selectNone.addEventListener('click', () => {
      chosen.clear();
      paint();
    });
    selectDefault.addEventListener('click', () => {
      chosen.clear();
      for (const name of defaultSelection(union)) chosen.add(name);
      paint();
    });

    function close(result: string[]): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    // Escape takes what is on screen, which is the recommended set until the
    // user changes it. It used to mean "keep everything", and that reading
    // stops being safe the moment the default is a subset: dismissing a dialog
    // should not be the most expensive choice in it.
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && chosen.size > 0) close([...chosen]);
    }
    document.addEventListener('keydown', onKey);
    skip.addEventListener('click', () => close(union));
    // Exactly the ticked columns. Adding the weights back here would make the
    // MB readout above a lie and silence ingest's "not retained" warning --
    // the whole design is that dropping a weight is a stated decision whose
    // consequence the pane names later (footgun 20).
    confirm.addEventListener('click', () => close([...chosen]));

    paint();
    document.body.appendChild(backdrop);
    filter.focus();
  });
}
