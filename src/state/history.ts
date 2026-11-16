import { batch, createSignal } from 'solid-js';
import type { ClassFilter, SortDir } from './filtering';
import type { HistoryRow, TimeKind } from './types';

// The history of found items in one plain mutable array that the signal only announces changes
// to (same approach as the message log). Rows are immutable once added; a better time estimate
// replaces a row rather than changing it.
//
// The array is kept in time order (oldest first; rows with an unknown time first of all), so the
// History tab's default newest-first view is just the reverse, with no sort per update. Live finds
// arrive in time order and are appended; only backfills, which land mid-history, cause a sort.
//
// !release and !collect can announce thousands of items at once, so new rows are queued and
// published on a short timer rather than per frame: the table does not need 60 updates a
// second, and this bounds how often filtering runs during a flood.

const MAX_ROWS = 20000;
/** Trim in chunks so a flood does not shift the array on every row. */
const TRIM_SLACK = 1000;
const FLUSH_DELAY_MS = 200;

export type NewHistoryRow = Omit<HistoryRow, 'seq'>;

const rows: HistoryRow[] = [];
/** Every recorded row (queued or published) by id. */
const byId = new Map<string, HistoryRow>();
let queue: HistoryRow[] = [];
let nextSeq = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let changeListener: (() => void) | undefined;

const [history, setHistory] = createSignal<readonly HistoryRow[]>(rows, { equals: false });
/** Sequence number of the newest row published so far. */
const [newestSeq, setNewestSeq] = createSignal(0);
export { history, newestSeq };

const inTimeOrder = (a: HistoryRow, b: HistoryRow) => a.time - b.time || a.seq - b.seq;

/** Called after every published change (the store saves on it). One listener. */
export function onHistoryChange(listener: (() => void) | undefined) {
  changeListener = listener;
}

function publish() {
  trim();
  batch(() => {
    setHistory(rows);
    setNewestSeq(nextSeq - 1);
  });
  changeListener?.();
}

function trim() {
  if (rows.length > MAX_ROWS + TRIM_SLACK) {
    for (const row of rows.splice(0, rows.length - MAX_ROWS)) byId.delete(row.id);
  }
}

/** Move queued rows into the array, keeping it in time order. Returns whether anything moved. */
function drain(): boolean {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (queue.length === 0) return false;

  let ordered = true;
  let last = rows[rows.length - 1];
  for (const row of queue) {
    if (last && inTimeOrder(row, last) < 0) ordered = false;
    rows.push(row);
    last = row;
  }
  queue = [];
  if (!ordered) rows.sort(inTimeOrder);
  return true;
}

/** Publish whatever is queued now, instead of on the timer (before saving, for example). */
export function flushHistory() {
  if (drain()) publish();
}

/** Record found items. A location is only ever checked once, so a repeated id is ignored (first copy wins). */
export function addHistory(entries: readonly NewHistoryRow[]) {
  for (const entry of entries) {
    if (byId.has(entry.id)) continue;
    const row: HistoryRow = { ...entry, seq: nextSeq++ };
    byId.set(row.id, row);
    queue.push(row);
  }
  if (queue.length > 0 && timer === undefined) timer = setTimeout(flushHistory, FLUSH_DELAY_MS);
}

/** The recorded row with this id (`${finder}-${location}`), queued or published. */
export function getHistoryRow(id: string): HistoryRow | undefined {
  return byId.get(id);
}

export interface RowTime {
  time: number;
  timeKind: TimeKind;
  timeLabel: string;
}

/** Give recorded rows a new time (a better estimate). Unchanged rows are left alone. */
export function retimeHistory(changes: ReadonlyMap<string, RowTime>) {
  if (changes.size === 0) return;
  // A tracker poll usually re-places rows exactly where they were: then nothing is published, so
  // the view does not refilter and the store does not rewrite for nothing.
  let changed = drain();
  for (let i = 0; i < rows.length; i++) {
    const change = changes.get(rows[i].id);
    if (!change || (rows[i].time === change.time && rows[i].timeKind === change.timeKind)) continue;
    const row: HistoryRow = { ...rows[i], ...change };
    rows[i] = row;
    byId.set(row.id, row);
    changed = true;
  }
  if (!changed) return;
  rows.sort(inTimeOrder);
  publish();
}

export function clearHistory() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  queue = [];
  rows.length = 0;
  byId.clear();
  nextSeq = 1;
  batch(() => {
    setHistory(rows);
    setNewestSeq(nextSeq - 1);
  });
}

// --- Filter and sort state ----------------------------------------------------
// Kept here, not in the component, so it survives switching tabs.

export type HistorySortKey = 'time' | 'item' | 'location' | 'finder' | 'receiver';

export const [historySearch, setHistorySearch] = createSignal('');
/** Slot number as a string of the player who got the item ("For"), or '' for anyone. */
export const [historyReceiver, setHistoryReceiver] = createSignal('');
/** Slot number as a string of the player whose world held the item ("Found in"), or '' for anyone. */
export const [historyFinder, setHistoryFinder] = createSignal('');
/** Only items where we are the receiver or the finder. */
export const [historyMineOnly, setHistoryMineOnly] = createSignal(false);
export const [historyClass, setHistoryClass] = createSignal<ClassFilter>('any');
export const [historySortKey, setHistorySortKey] = createSignal<HistorySortKey>('time');
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
