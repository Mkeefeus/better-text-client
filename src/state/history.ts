import { batch, createSignal } from 'solid-js';
import type { ClassFilter, SortDir } from './filtering';
import type { HistoryRow } from './types';

// The history of found items, oldest first, in one plain mutable array that the signal only
// announces changes to (same approach as the message log). Rows are immutable once added.
//
// !release and !collect can announce thousands of items at once, so new rows are queued and
// published on a short timer rather than per frame: the table does not need 60 updates a
// second, and this bounds how often filtering and sorting run during a flood.

const MAX_ROWS = 20000;
/** Trim in chunks so a flood does not shift the array on every row. */
const TRIM_SLACK = 1000;
const FLUSH_DELAY_MS = 200;

export type NewHistoryRow = Omit<HistoryRow, 'seq'>;

const rows: HistoryRow[] = [];
const known = new Set<string>();
let queue: HistoryRow[] = [];
let nextSeq = 1;
let timer: ReturnType<typeof setTimeout> | undefined;

const [history, setHistory] = createSignal<readonly HistoryRow[]>(rows, { equals: false });
/** Sequence number of the newest row published so far. */
const [newestSeq, setNewestSeq] = createSignal(0);
export { history, newestSeq };

function flush() {
  timer = undefined;
  if (queue.length === 0) return;

  for (const row of queue) rows.push(row);
  queue = [];

  if (rows.length > MAX_ROWS + TRIM_SLACK) {
    for (const row of rows.splice(0, rows.length - MAX_ROWS)) known.delete(row.id);
  }

  batch(() => {
    setHistory(rows);
    setNewestSeq(nextSeq - 1);
  });
}

/** Record found items. A location is only ever checked once, so a repeated id is ignored (first copy wins). */
export function addHistory(entries: readonly NewHistoryRow[]) {
  for (const entry of entries) {
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    queue.push({ ...entry, seq: nextSeq++ });
  }
  if (queue.length > 0 && timer === undefined) timer = setTimeout(flush, FLUSH_DELAY_MS);
}

export function clearHistory() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  queue = [];
  rows.length = 0;
  known.clear();
  nextSeq = 1; // a new room starts counting from 1 again
  batch(() => {
    setHistory(rows);
    setNewestSeq(nextSeq - 1);
  });
}

// --- Filter and sort state ----------------------------------------------------
// Kept here, not in the component, so it survives switching tabs.

export type HistorySortKey = 'order' | 'item' | 'location' | 'finder' | 'receiver';

export const [historySearch, setHistorySearch] = createSignal('');
/** Slot number as a string of the player who got the item ("For"), or '' for anyone. */
export const [historyReceiver, setHistoryReceiver] = createSignal('');
/** Slot number as a string of the player whose world held the item ("Found in"), or '' for anyone. */
export const [historyFinder, setHistoryFinder] = createSignal('');
/** Only items where we are the receiver or the finder. */
export const [historyMineOnly, setHistoryMineOnly] = createSignal(false);
export const [historyClass, setHistoryClass] = createSignal<ClassFilter>('any');
export const [historySortKey, setHistorySortKey] = createSignal<HistorySortKey>('order');
export const [historySortDir, setHistorySortDir] = createSignal<SortDir>('desc');

export function resetHistoryFilters() {
  setHistorySearch('');
  setHistoryReceiver('');
  setHistoryFinder('');
  setHistoryMineOnly(false);
  setHistoryClass('any');
}

/** True if any filter differs from its default. */
export function historyFiltersActive(): boolean {
  return (
    historySearch() !== '' ||
    historyReceiver() !== '' ||
    historyFinder() !== '' ||
    historyMineOnly() ||
    historyClass() !== 'any'
  );
}
