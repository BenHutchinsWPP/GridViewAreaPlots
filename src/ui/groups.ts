// src/ui/groups.ts
//
// The grouping editor: pick a group on the left, see its members in the
// middle, drag areas in from the right. Membership is many-to-many -- an area
// sits in as many groups as you put it in -- which is why this is not a
// one-select-per-area list: that shape can only express one group per area.
//
// The editor cannot add or remove AREAS. The axis comes from the loaded data
// (see groupings.ts), not from anything editable here. A mapping that names
// areas the data does not have still loads, and those names show up flagged
// rather than silently truncated -- a Groupings.csv written for a bigger
// study is worth keeping.

import { allAreas, areasIn, groupingNames, isOffAxis, ALL_AREAS } from '../groupings';

export interface GroupEditorInput {
  /** Areas that carry data in the loaded cases. Empty before any case is
   * loaded, which switches the "no data" flag off rather than flagging
   * everything. */
  present: Set<string>;
}

/** Resolve to a Groupings.csv, or to null if the user cancels. */
export function showGroupEditor(input: GroupEditorInput): Promise<string | null> {
  return new Promise((resolve) => {
    // Sorted for reading. The cube's axis order lives in groupings.ts and is
    // not what this list is for.
    const axis = [...allAreas()].sort((a, b) => a.localeCompare(b));
    const membership = new Map<string, string[]>();
    for (const name of groupingNames()) {
      if (name !== ALL_AREAS) membership.set(name, areasIn(name).slice());
    }
    let selected = membership.keys().next().value ?? '';

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal modal-wide';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = 'Edit groupings';
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      `${axis.length} areas, read from the loaded data. An area can belong to any number of ` +
      `groups — drag it across, or double-click it. "${ALL_AREAS}" is computed from the axis ` +
      'and is not edited here.';
    modal.appendChild(subtitle);

    const columns = document.createElement('div');
    columns.className = 'groups-grid';
    modal.appendChild(columns);

    // ---------------------------------------------------------- groups column
    const groupsColumn = document.createElement('div');
    groupsColumn.className = 'groups-column';
    const groupsHead = document.createElement('div');
    groupsHead.className = 'groups-head';
    groupsHead.textContent = 'Groups';
    groupsColumn.appendChild(groupsHead);
    const groupsList = document.createElement('div');
    groupsList.className = 'groups-list';
    groupsColumn.appendChild(groupsList);

    const newGroupRow = document.createElement('div');
    newGroupRow.className = 'groups-newrow';
    const newGroup = document.createElement('input');
    newGroup.type = 'text';
    newGroup.placeholder = 'New group…';
    newGroup.className = 'modal-filter';
    const addGroup = document.createElement('button');
    addGroup.type = 'button';
    addGroup.className = 'btn';
    addGroup.textContent = 'Add';
    newGroupRow.append(newGroup, addGroup);
    groupsColumn.appendChild(newGroupRow);
    columns.appendChild(groupsColumn);

    // ---------------------------------------------------------- members column
    const membersColumn = document.createElement('div');
    membersColumn.className = 'groups-column';
    const membersHead = document.createElement('div');
    membersHead.className = 'groups-head';
    membersColumn.appendChild(membersHead);
    const membersList = document.createElement('div');
    membersList.className = 'groups-list drop-target';
    membersColumn.appendChild(membersList);
    columns.appendChild(membersColumn);

    // ---------------------------------------------------------- areas column
    const areasColumn = document.createElement('div');
    areasColumn.className = 'groups-column';
    const areasHead = document.createElement('div');
    areasHead.className = 'groups-head';
    areasHead.textContent = 'Areas in this data';
    areasColumn.appendChild(areasHead);
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'Filter areas…';
    filter.className = 'modal-filter';
    areasColumn.appendChild(filter);
    const areasList = document.createElement('div');
    areasList.className = 'groups-list drop-target';
    areasColumn.appendChild(areasList);
    const addShown = document.createElement('button');
    addShown.type = 'button';
    addShown.className = 'btn';
    addShown.textContent = 'Add all shown';
    areasColumn.appendChild(addShown);
    columns.appendChild(areasColumn);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const fromFile = document.createElement('input');
    fromFile.type = 'file';
    fromFile.accept = '.csv,text/csv';
    fromFile.style.display = 'none';
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'btn';
    load.textContent = 'Load CSV…';
    load.addEventListener('click', () => fromFile.click());
    fromFile.addEventListener('change', () => {
      const file = fromFile.files?.[0];
      if (file) void file.text().then((text) => close(text));
    });
    // Save the mapping as it stands in the editor, without closing: the
    // Groupings.csv the user keeps is the same file the editor eats.
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    save.textContent = 'Save CSV…';
    save.addEventListener('click', () => {
      const blob = new Blob([toCsv()], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'Groupings.csv';
      anchor.click();
      // Revoked on a later task: revoking synchronously races the download.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Apply groupings';
    actions.append(load, save, fromFile, cancel, confirm);
    modal.appendChild(actions);

    // ---------------------------------------------------------- behaviour
    function members(): string[] {
      return membership.get(selected) ?? [];
    }

    /** Why an area cannot be plotted, or null when it can. Two different
     * problems that both read as "this name is in the group and nothing comes
     * out of it", so they are told apart in the flag itself. */
    function problem(area: string): string | null {
      if (isOffAxis(area)) return 'not in the loaded data';
      if (input.present.size > 0 && !input.present.has(area)) return 'no data in the loaded cases';
      return null;
    }

    function addToGroup(area: string): void {
      if (!selected) return;
      const list = membership.get(selected);
      if (!list || list.includes(area)) return;
      list.push(area);
      paint();
    }

    function removeFromGroup(area: string): void {
      const list = membership.get(selected);
      if (!list) return;
      const index = list.indexOf(area);
      if (index >= 0) list.splice(index, 1);
      paint();
    }

    function item(area: string, inGroup: boolean): HTMLElement {
      const row = document.createElement('div');
      row.className = 'groups-item';
      row.draggable = true;
      row.dataset.area = area;

      const name = document.createElement('span');
      name.textContent = area;
      row.appendChild(name);

      if (inGroup) {
        const why = problem(area);
        if (why) {
          row.classList.add('groups-item-missing');
          const flag = document.createElement('span');
          flag.className = 'groups-flag';
          flag.textContent = why;
          row.appendChild(flag);
        }
      } else {
        const count = groupsContaining(area);
        if (count > 0) {
          const badge = document.createElement('span');
          badge.className = 'groups-badge';
          badge.textContent = `in ${count}`;
          badge.title = `Already in ${count} group${count === 1 ? '' : 's'}`;
          row.appendChild(badge);
        }
      }

      row.addEventListener('dblclick', () => (inGroup ? removeFromGroup(area) : addToGroup(area)));
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', area);
        event.dataTransfer?.setData(inGroup ? 'x-from/member' : 'x-from/area', '1');
      });
      return row;
    }

    function groupsContaining(area: string): number {
      let count = 0;
      for (const list of membership.values()) if (list.includes(area)) count++;
      return count;
    }

    function paint(): void {
      groupsList.replaceChildren();
      const ordered = [...membership.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, list] of ordered) {
        const row = document.createElement('div');
        row.className = 'groups-item groups-group' + (name === selected ? ' groups-selected' : '');
        const label = document.createElement('span');
        label.textContent = name;
        row.appendChild(label);
        const count = document.createElement('span');
        count.className = 'groups-badge';
        count.textContent = String(list.length);
        row.appendChild(count);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'case-remove';
        remove.textContent = '×';
        remove.title = 'Delete this group';
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          membership.delete(name);
          if (selected === name) selected = membership.keys().next().value ?? '';
          paint();
        });
        row.appendChild(remove);
        row.addEventListener('click', () => {
          selected = name;
          paint();
        });
        // Dropping an area onto a group row files it there without leaving
        // the group you are looking at.
        row.addEventListener('dragover', (event) => event.preventDefault());
        row.addEventListener('drop', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const area = event.dataTransfer?.getData('text/plain');
          if (!area) return;
          const target = membership.get(name);
          if (target && !target.includes(area)) target.push(area);
          paint();
        });
        groupsList.appendChild(row);
      }

      membersHead.textContent = selected ? `In "${selected}"` : 'No group selected';
      membersList.replaceChildren();
      for (const area of [...members()].sort((a, b) => a.localeCompare(b))) {
        membersList.appendChild(item(area, true));
      }
      if (selected && members().length === 0) {
        const empty = document.createElement('div');
        empty.className = 'groups-empty';
        empty.textContent = 'Empty — drag areas here.';
        membersList.appendChild(empty);
      }

      const needle = filter.value.trim().toLowerCase();
      const shown = axis.filter(
        (area) => !members().includes(area) && (!needle || area.toLowerCase().includes(needle)),
      );
      areasList.replaceChildren();
      for (const area of shown) areasList.appendChild(item(area, false));

      const missing = members().filter((area) => problem(area) !== null).length;
      readout.textContent =
        `${membership.size} group(s) · "${selected}" has ${members().length} area(s)` +
        (missing > 0 ? ` · ${missing} of them cannot be plotted` : '');
    }

    function dropZone(element: HTMLElement, accept: 'x-from/area' | 'x-from/member', act: (area: string) => void): void {
      element.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types.includes(accept)) return;
        event.preventDefault();
        element.classList.add('groups-dropping');
      });
      element.addEventListener('dragleave', () => element.classList.remove('groups-dropping'));
      element.addEventListener('drop', (event) => {
        event.preventDefault();
        element.classList.remove('groups-dropping');
        const area = event.dataTransfer?.getData('text/plain');
        if (area) act(area);
      });
    }
    dropZone(membersList, 'x-from/area', addToGroup);
    dropZone(areasList, 'x-from/member', removeFromGroup);

    function addNewGroup(): void {
      const name = newGroup.value.trim();
      // A comma would split into two columns on the way back out to CSV.
      if (!name || name.includes(',') || name === ALL_AREAS || membership.has(name)) return;
      membership.set(name, []);
      selected = name;
      newGroup.value = '';
      paint();
    }

    addGroup.addEventListener('click', addNewGroup);
    newGroup.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addNewGroup();
    });
    filter.addEventListener('input', paint);
    addShown.addEventListener('click', () => {
      const needle = filter.value.trim().toLowerCase();
      for (const area of axis) {
        if (!needle || area.toLowerCase().includes(needle)) addToGroup(area);
      }
    });

    /** The editor's state as a Groupings.csv: one row per (area, group). */
    function toCsv(): string {
      const lines = ['Name,Grouping'];
      for (const [name, list] of membership) {
        for (const area of list) lines.push(`${area},${name}`);
      }
      return lines.join('\n') + '\n';
    }

    function close(result: string | null): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close(null);
    }

    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => close(toCsv()));
    document.addEventListener('keydown', onKey);

    paint();
    document.body.appendChild(backdrop);
    filter.focus();
  });
}
