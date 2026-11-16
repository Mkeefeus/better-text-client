// Keeping the History between runs of the app.
//
// Per room and slot (seed name, team, slot), two entries in localStorage:
// - the finds, compact: [finder, receiver, item, location, flags, kind, time], rewritten a couple
//   of seconds after the History changes;
// - a small meta entry: when this client was connected (online intervals) and up to when the
//   history is known to be complete (coverage). The connection's estimates depend on these, and
//   they are rewritten every 30 s while connected, so a crash loses at most that much.
//
// Names are not stored: rows are rebuilt from the ids with the room's data package on connect.
// Only the most recent rooms are kept. Without localStorage (tests, or storage blocked) it all
// lives in memory for the run.

import { flushHistory, history, onHistoryChange } from './history';
import type { Coverage } from './historyTimes';
import { pushClientMessage } from './messages';
import { clock } from './timing';
import type { HistoryRow, TimeKind } from './types';

/** [finder, receiver, item, location, flags, kind (0 exact, 1 estimated, 2 unknown), time]. */
export type StoredFind = [number, number, number, number, number, number, number];

const FINDS_PREFIX = 'better-text-client.history.';
const META_PREFIX = 'better-text-client.history-meta.';
const INDEX_KEY = 'better-text-client.history-rooms';
const MAX_ROOMS = 10;
const MAX_INTERVALS = 500;
const SAVE_DELAY_MS = 2000;
const HEARTBEAT_MS = 30_000;
/**
 * How far behind the website tracker can be: the room saves at most once a minute and the API
 * caches its answer for a minute (`auto_save_interval`, `cache.memoize(timeout=60)` upstream).
 */
export const TRACKER_LAG_MS = 150_000;

export const KIND_CODES: Record<TimeKind, number> = { exact: 0, estimated: 1, unknown: 2 };
export const KINDS: readonly TimeKind[] = ['exact', 'estimated', 'unknown'];

interface Meta {
  online: [number, number][];
  team?: number;
  own?: number;
}

// --- Storage: localStorage when it works, else memory ---------------------------

interface Backend {
  get(key: string): string | null;
  set(key: string, value: string): void; // may throw when full
  remove(key: string): void;
}

const memory = new Map<string, string>();
const memoryBackend: Backend = {
  get: (key) => memory.get(key) ?? null,
  set: (key, value) => void memory.set(key, value),
  remove: (key) => void memory.delete(key),
};

function pickBackend(): Backend {
  try {
    if (typeof localStorage === 'undefined') return memoryBackend;
    localStorage.getItem(INDEX_KEY); // throws if storage is blocked
    return {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
      remove: (key) => localStorage.removeItem(key),
    };
  } catch {
    return memoryBackend;
  }
}
const storage = pickBackend();

function readJson(key: string): unknown {
  try {
    const raw = storage.get(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function readIndex(): Record<string, number> {
  const index = readJson(INDEX_KEY);
  return index && typeof index === 'object' ? (index as Record<string, number>) : {};
}

function forgetRoom(key: string, index: Record<string, number>) {
  storage.remove(FINDS_PREFIX + key);
  storage.remove(META_PREFIX + key);
  delete index[key];
}

/**
 * Write, making room by dropping the least recently used other rooms if storage is full. One copy
 * of the index is used across the attempts, so a room is never picked twice even if writing the
 * index itself fails, and the attempts are bounded.
 */
function write(key: string, value: string): boolean {
  let index: Record<string, number> | undefined;
  for (let attempt = 0; attempt <= MAX_ROOMS + 1; attempt++) {
    try {
      storage.set(key, value);
      return true;
    } catch {
      index ??= readIndex();
      const current = index;
      const oldest = Object.keys(current)
        .filter((other) => other !== room)
        .sort((a, b) => current[a] - current[b])[0];
      if (!oldest) break;
      forgetRoom(oldest, current);
      try {
        storage.set(INDEX_KEY, JSON.stringify(current));
      } catch {
        // the next attempt (or the warning) will tell
      }
    }
  }
  warnOnce();
  return false;
}

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  pushClientMessage('error', 'History could not be saved: the app’s storage is full. It is kept until the app closes.');
}

// --- The open room ----------------------------------------------------------------

let room: string | undefined;
let meta: Meta = { online: [] };
let session: { start: number; teamLive: boolean; ownLive: boolean } | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function isStoredFind(value: unknown): value is StoredFind {
  return Array.isArray(value) && value.length === 7 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function readMeta(key: string): Meta {
  const raw = readJson(META_PREFIX + key) as Partial<Meta> | undefined;
  const online = Array.isArray(raw?.online)
    ? raw.online.filter(
        (pair): pair is [number, number] =>
          Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === 'number' && Number.isFinite(n)),
      )
    : [];
  const finite = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);
  return { online, team: finite(raw?.team), own: finite(raw?.own) };
}

/** Start using a room's stored history. Returns its stored finds, oldest first. Close the previous room first. */
export function openRoomHistory(key: string): StoredFind[] {
  closeRoomHistory();
  room = key;
  meta = readMeta(key);

  const index = readIndex();
  index[key] = clock.now();
  for (const old of Object.keys(index)
    .filter((other) => other !== key)
    .sort((a, b) => index[b] - index[a])
    .slice(MAX_ROOMS - 1)) {
    forgetRoom(old, index);
  }
  write(INDEX_KEY, JSON.stringify(index));

  const finds = readJson(FINDS_PREFIX + key);
  return Array.isArray(finds) ? finds.filter(isStoredFind) : [];
}

/** Save and stop using the open room (switching rooms). */
export function closeRoomHistory() {
  endHistorySession(clock.now());
  saveFindsNow();
  room = undefined;
  meta = { online: [] };
}

/**
 * A connection to the open room starts. Returns what the history held before it: the bounds for
 * estimating anything this connection learns about but did not see happen.
 */
export function beginHistorySession(now: number): Coverage {
  endHistorySession(now);
  const coverage: Coverage = {
    team: meta.team,
    own: meta.own,
    online: meta.online.map(([start, end]) => ({ start, end })),
  };
  meta.online.push([now, now]);
  if (meta.online.length > MAX_INTERVALS) meta.online.splice(0, meta.online.length - MAX_INTERVALS);
  session = { start: now, teamLive: false, ownLive: false };
  saveMeta();
  if (heartbeat === undefined) {
    heartbeat = setInterval(() => {
      extend(clock.now());
      saveMeta();
    }, HEARTBEAT_MS);
    // Do not keep a process (the tests) alive for it.
    (heartbeat as { unref?: () => void }).unref?.();
  }
  return coverage;
}

/** The own sync (received items and sent-items scouts) is complete: from now on everything of ours is seen live. */
export function noteOwnCoverage(now: number) {
  if (!session) return;
  session.ownLive = true;
  meta.own = Math.max(meta.own ?? now, now);
  saveMeta();
}

/**
 * A tracker import that matched this room has filled the history. The tracker can be a couple of
 * minutes behind, so the team's history is complete up to then; once an import is newer than the
 * start of this connection, the live feed carries it on from there.
 */
export function noteTeamCoverage(now: number) {
  if (!session) return;
  const until = Math.min(now - TRACKER_LAG_MS, session.start);
  meta.team = Math.max(meta.team ?? until, until);
  if (now - TRACKER_LAG_MS >= session.start) session.teamLive = true;
  saveMeta();
}

function extend(now: number) {
  if (!session) return;
  const last = meta.online[meta.online.length - 1];
  if (last) last[1] = Math.max(last[1], now);
  if (session.ownLive) meta.own = Math.max(meta.own ?? now, now);
  if (session.teamLive) meta.team = Math.max(meta.team ?? now, now);
}

/** The connection ended (or the app is closing). */
export function endHistorySession(now: number) {
  if (!session) return;
  extend(now);
  session = undefined;
  if (heartbeat !== undefined) clearInterval(heartbeat);
  heartbeat = undefined;
  saveMeta();
  saveFindsNow();
}

function saveMeta() {
  if (room) write(META_PREFIX + room, JSON.stringify(meta));
}

function saveFindsNow() {
  if (!room) return;
  flushHistory(); // may schedule a save through the change listener; this one covers it
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  const rows: readonly HistoryRow[] = history();
  const finds: StoredFind[] = rows.map((row) => [
    row.finderSlot,
    row.receiverSlot,
    row.itemId,
    row.locationId,
    row.itemFlags,
    KIND_CODES[row.timeKind],
    row.time,
  ]);
  write(FINDS_PREFIX + room, JSON.stringify(finds));
}

onHistoryChange(() => {
  if (room && saveTimer === undefined) saveTimer = setTimeout(saveFindsNow, SAVE_DELAY_MS);
});

if (typeof window !== 'undefined') {
  const closing = () => endHistorySession(clock.now());
  window.addEventListener('pagehide', closing);
  window.addEventListener('beforeunload', closing);
}

/** Forget everything stored (tests). */
export function resetHistoryStoreForTests() {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  if (heartbeat !== undefined) clearInterval(heartbeat);
  saveTimer = undefined;
  heartbeat = undefined;
  session = undefined;
  room = undefined;
  meta = { online: [] };
  memory.clear();
}
