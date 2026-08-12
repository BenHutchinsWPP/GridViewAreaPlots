// src/ui/chips.ts
//
// Generic chip-grid widget used for the five filter rows (month, hour,
// day-of-week, season, TOU). One instance is created once per grid at
// shell.ts init time -- event listeners live on the container, which
// survives every render() -- and `.render(selection)` is called on every
// render(query) to redraw the chip contents cheaply (plan.md GUI decision
// 4: no Apply button, everything recomputes on every click).
//
// Gestures, Excel-filter semantics (plan.md GUI decision 3):
//   - click a chip: select only that chip; clicking the one already selected
//     alone clears the filter
//   - ctrl/cmd-click: toggle one chip in/out, counting from everything when
//     the filter is unset -- so the first ctrl-click unchecks one item
//   - shift-click: select the range from the last clicked chip to this one
//     (add ctrl to keep what is already selected)
//   - click-drag across chips: paint that range, replacing the selection,
//     from a snapshot taken at gesture start so a drag that overshoots and
//     comes back never leaves stray chips selected
// A selection that would end up empty or covering every chip snaps back to
// `null` ("no constraint") -- Filters' own convention (src/types.ts).

export interface ChipItem<T> {
  readonly value: T;
  readonly label: string;
}

export interface ChipGridController<T> {
  /** Redraw chip contents for the given selection. `null` = no constraint,
   * rendered as every chip active (src/types.ts's Filters convention). */
  render(selection: ReadonlySet<T> | null): void;
}

export function createChipGrid<T>(
  container: HTMLElement,
  items: readonly ChipItem<T>[],
  onChange: (next: Set<T> | null) => void
): ChipGridController<T> {
  let current: ReadonlySet<T> | null = null;
  let anchorIndex: number | null = null;
  let gestureBase: Set<T> | null = null; // selection snapshot at gesture start
  let dragging = false;

  function isActive(idx: number): boolean {
    return current === null || current.has(items[idx].value);
  }

  function commit(next: Set<T>): void {
    if (next.size === 0 || next.size === items.length) onChange(null);
    else onChange(next);
  }

  function chipIndexAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const chip = el?.closest<HTMLElement>('.chip');
    if (!chip || chip.parentElement !== container) return null;
    const idx = Number(chip.dataset.idx);
    return Number.isNaN(idx) ? null : idx;
  }

  /** The selection as an explicit set. `null` means "no constraint", which
   * for a ctrl-click is every chip -- unchecking one has to start from all
   * of them, not from nothing. */
  function expanded(): Set<T> {
    return current === null ? new Set(items.map((item) => item.value)) : new Set(current);
  }

  container.addEventListener('pointerdown', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
    if (!chip || chip.parentElement !== container) return;
    const idx = Number(chip.dataset.idx);
    const additive = e.ctrlKey || e.metaKey;

    if (e.shiftKey && anchorIndex !== null) {
      // Range from the anchor. Ctrl keeps what is already selected; plain
      // shift replaces it, the way a spreadsheet's shift-click does.
      const base = additive ? expanded() : new Set<T>();
      const lo = Math.min(anchorIndex, idx);
      const hi = Math.max(anchorIndex, idx);
      for (let i = lo; i <= hi; i++) base.add(items[i].value);
      commit(base);
      return;
    }

    if (additive) {
      const next = expanded();
      if (next.has(items[idx].value)) next.delete(items[idx].value);
      else next.add(items[idx].value);
      anchorIndex = idx;
      commit(next);
      return;
    }

    // Plain click: this chip only. Clicking the chip that is already the
    // whole selection clears the filter, so single-select is reversible
    // without reaching for the clear button.
    gestureBase = new Set<T>();
    anchorIndex = idx;
    dragging = true;
    const alone = current !== null && current.size === 1 && current.has(items[idx].value);
    commit(alone ? new Set<T>() : new Set([items[idx].value]));
    container.setPointerCapture(e.pointerId);
  });

  container.addEventListener('pointermove', (e) => {
    if (!dragging || anchorIndex === null || gestureBase === null) return;
    const idx = chipIndexAt(e.clientX, e.clientY);
    if (idx === null || idx === anchorIndex) return;
    const next = new Set(gestureBase);
    const lo = Math.min(anchorIndex, idx);
    const hi = Math.max(anchorIndex, idx);
    for (let i = lo; i <= hi; i++) next.add(items[i].value);
    commit(next);
  });

  function endGesture(e: PointerEvent): void {
    dragging = false;
    gestureBase = null;
    try {
      container.releasePointerCapture(e.pointerId);
    } catch {
      // pointer was never captured (e.g. gesture started off a chip) -- fine to ignore.
    }
  }
  container.addEventListener('pointerup', endGesture);
  container.addEventListener('pointercancel', endGesture);

  return {
    render(selection) {
      current = selection;
      container.innerHTML = '';
      items.forEach((item, idx) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (isActive(idx) ? ' chip-active' : '');
        chip.textContent = item.label;
        chip.dataset.idx = String(idx);
        container.appendChild(chip);
      });
    },
  };
}
