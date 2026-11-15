import { createSignal } from 'solid-js';
import type { HintRow } from './types';

// --- The hint list ------------------------------------------------------------

const [hints, setHints] = createSignal<readonly HintRow[]>([]);
export { hints };

/**
 * Replace the whole hint list. The server always sends the complete list, so there is
 * no delta handling. Rows that did not change keep their previous object identity,
 * which lets the table skip re-rendering them.
 */
export function replaceHints(next: HintRow[]) {
  const previous = new Map<string, HintRow>();
  for (const row of hints()) previous.set(row.id, row);

  setHints(
    next.map((row) => {
      const old = previous.get(row.id);
      const unchanged =
        old !== undefined &&
        old.found === row.found &&
        old.status === row.status &&
        old.entrance === row.entrance &&
        old.itemName === row.itemName &&
        old.locationName === row.locationName &&
        old.finderName === row.finderName &&
        old.receiverName === row.receiverName;
      return unchanged ? old : row;
    }),
  );
}

export function clearHints() {
  setHints([]);
}

// --- Filter and sort state ----------------------------------------------------
// Kept here, not in the component, so it survives switching tabs.

export type FoundFilter = 'all' | 'unfound' | 'found';
export type StatusFilter = 'any' | 'priority' | 'unspecified' | 'no-priority' | 'avoid';
export type ClassFilter = 'any' | 'progression' | 'useful' | 'trap' | 'filler';
export type SortKey = 'default' | 'item' | 'location' | 'finder' | 'receiver' | 'entrance' | 'status' | 'found';
export type SortDir = 'asc' | 'desc';

export const [searchText, setSearchText] = createSignal('');
export const [foundFilter, setFoundFilter] = createSignal<FoundFilter>('unfound');
/** Slot number as a string of the player who needs the item ("For"), or '' for anyone. */
export const [receiverFilter, setReceiverFilter] = createSignal('');
/** Slot number as a string of the player whose world holds the item ("Found in"), or '' for anyone. */
export const [finderFilter, setFinderFilter] = createSignal('');
/** Only hints where we are the receiver or the finder. */
export const [mineOnly, setMineOnly] = createSignal(false);
export const [statusFilter, setStatusFilter] = createSignal<StatusFilter>('any');
export const [classFilter, setClassFilter] = createSignal<ClassFilter>('any');
export const [sortKey, setSortKey] = createSignal<SortKey>('default');
export const [sortDir, setSortDir] = createSignal<SortDir>('asc');

export function resetHintFilters() {
  setSearchText('');
  setFoundFilter('unfound');
  setReceiverFilter('');
  setFinderFilter('');
  setMineOnly(false);
  setStatusFilter('any');
  setClassFilter('any');
}

/** True if any filter differs from its default. */
export function hintFiltersActive(): boolean {
  return (
    searchText() !== '' ||
    foundFilter() !== 'unfound' ||
    receiverFilter() !== '' ||
    finderFilter() !== '' ||
    mineOnly() ||
    statusFilter() !== 'any' ||
    classFilter() !== 'any'
  );
}
