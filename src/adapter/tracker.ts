// Lobby-wide completion from the Archipelago website's tracker API. Plain `fetch`; nothing here
// touches archipelago.js. The website enables cross-origin requests for these endpoints.
//
//   /api/static_tracker/<id>  slot totals and games; it also contains the room's entire data
//                             package, so it is fetched once per link and only the small part we
//                             need is kept.
//   /api/tracker/<id>         every player's checked locations (plus items and hints we ignore);
//                             the website caches it for a minute, so it is polled no faster.

import { clockLabel } from '../state/timing';
import {
  clearTrackerData,
  setCompletion,
  setTrackerError,
  setTrackerSlots,
  setTrackerStatus,
  setTrackerUpdated,
  trackerUpdated,
} from '../state/tracker';
import type { GameCompletion } from '../state/tracker';

/** The website refreshes tracker data about once a minute, so asking more often gains nothing. */
const POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 90_000;

// --- Link parsing ---------------------------------------------------------------

export type ParsedLink =
  | { ok: true; origin: string; id: string }
  | { ok: false; problem: 'empty' | 'room' | 'invalid' };

const TRACKER_SEGMENTS = new Set(['tracker', 'sphere_tracker', 'generic_tracker', 'static_tracker']);

/**
 * Read a room's tracker link, such as `https://archipelago.gg/tracker/<id>`. The id is passed on
 * exactly as written: the website accepts both short and full UUIDs.
 */
export function parseTrackerLink(text: string): ParsedLink {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, problem: 'empty' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, problem: 'invalid' };

  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.findIndex((part) => TRACKER_SEGMENTS.has(part));
  if (at !== -1 && parts[at + 1]) return { ok: true, origin: url.origin, id: parts[at + 1] };

  // A room page has its own id, which the tracker API does not accept.
  if (parts.includes('room')) return { ok: false, problem: 'room' };
  return { ok: false, problem: 'invalid' };
}

// --- Payloads (only the fields we read) -----------------------------------------

interface RawStatic {
  groups?: { slot: number }[];
  player_locations_total?: { team: number; player: number; total_locations: number }[];
  player_game?: { team: number; player: number; game: string }[];
}

export interface TrackerDynamic {
  player_checks_done?: { team: number; player: number; locations: number[] }[];
}

/** The small part of the static payload we keep. */
export interface TrackerStatic {
  /** Slots that are item-link groups, not players. */
  groups: number[];
  players: { team: number; player: number; game: string; total: number }[];
}

export function leanStatic(raw: RawStatic): TrackerStatic {
  const games = new Map<string, string>();
  for (const entry of raw.player_game ?? []) games.set(`${entry.team}:${entry.player}`, entry.game);
  return {
    groups: (raw.groups ?? []).map((group) => group.slot),
    players: (raw.player_locations_total ?? []).map((entry) => ({
      team: entry.team,
      player: entry.player,
      game: games.get(`${entry.team}:${entry.player}`) ?? '',
      total: entry.total_locations,
    })),
  };
}

// --- Aggregation (pure) ---------------------------------------------------------

/**
 * Sum checked and total locations per game over the players of one team. Item-link groups are
 * left out, and so are players with no locations, so nothing divides by zero.
 */
export function completionByGame(stat: TrackerStatic, dynamic: TrackerDynamic, team: number): GameCompletion[] {
  const checked = new Map<number, number>();
  for (const entry of dynamic.player_checks_done ?? []) {
    if (entry.team === team) checked.set(entry.player, entry.locations.length);
  }

  const groups = new Set(stat.groups);
  const byGame = new Map<string, GameCompletion>();
  for (const player of stat.players) {
    if (player.team !== team || groups.has(player.player) || player.total <= 0 || !player.game) continue;
    const row = byGame.get(player.game) ?? { game: player.game, players: 0, checked: 0, total: 0 };
    row.players++;
    row.checked += Math.min(checked.get(player.player) ?? 0, player.total);
    row.total += player.total;
    byGame.set(player.game, row);
  }
  return [...byGame.values()].sort((a, b) => a.game.localeCompare(b.game));
}

/** slot -> game for the players of one team (groups left out), used to confirm it is the right room. */
export function slotsOf(stat: TrackerStatic, team: number): Record<number, string> {
  const groups = new Set(stat.groups);
  const slots: Record<number, string> = {};
  for (const player of stat.players) {
    if (player.team === team && !groups.has(player.player)) slots[player.player] = player.game;
  }
  return slots;
}

// --- Fetching and polling -------------------------------------------------------

class TrackerError extends Error {
  constructor(readonly code: 'not-found' | 'timeout' | 'http', message: string) {
    super(message);
  }
}

interface Run {
  origin: string;
  id: string;
  team: number;
  stopped: boolean;
  busy: boolean;
  timer?: ReturnType<typeof setInterval>;
  inflight?: AbortController;
}

/** The active polling run. A response from any other run is ignored. */
let current: Run | undefined;
/** Which link the loaded data belongs to. */
let dataKey: string | undefined;
let staticCache: { key: string; data: TrackerStatic } | undefined;
let lastLoadAt = 0;

const keyOf = (run: Pick<Run, 'origin' | 'id'>) => `${run.origin}|${run.id}`;

/** Start loading and then refreshing completion data. Call `stopTracker` when it is no longer shown. */
export function startTracker(link: { origin: string; id: string }, team: number) {
  stopTracker();
  const run: Run = { ...link, team, stopped: false, busy: false };
  if (keyOf(run) !== dataKey) {
    clearTrackerData(); // data from a different tracker must not linger
    dataKey = keyOf(run);
  }
  current = run;
  void load(run);
  run.timer = setInterval(() => void load(run), POLL_MS);
}

export function stopTracker() {
  const run = current;
  current = undefined;
  if (!run) return;
  run.stopped = true;
  clearInterval(run.timer);
  run.inflight?.abort();
  // A load that was cut short leaves the previous data in place.
  setTrackerStatus(trackerUpdated() ? 'ready' : 'idle');
}

/** Reload now, unless data was fetched less than a minute ago (the website would return the same). */
export function refreshTracker() {
  if (!current || Date.now() - lastLoadAt < POLL_MS) return;
  void load(current);
}

async function getJson<T>(run: Run, url: string): Promise<T> {
  const controller = new AbortController();
  run.inflight = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) throw new TrackerError('not-found', 'not found');
    if (!response.ok) throw new TrackerError('http', `HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (timedOut) throw new TrackerError('timeout', 'timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function describe(error: unknown, run: Run): string {
  if (error instanceof TrackerError) {
    switch (error.code) {
      case 'not-found':
        return "The website does not know that tracker. Check the link: it should be the room's Multiworld Tracker link.";
      case 'timeout':
        return `${run.origin} took too long to answer.`;
      default:
        return `${run.origin} answered with an error (${error.message}).`;
    }
  }
  // The body arrived but was not JSON.
  if (error instanceof SyntaxError) return 'The tracker returned data this client could not read.';
  // Anything else is the request itself failing: no connection, an unknown host, or a block by the
  // browser (which reports all of these as a bare TypeError).
  return `Could not reach ${run.origin}. Check the link and your connection.`;
}

async function load(run: Run) {
  if (current !== run || run.busy) return;
  run.busy = true;
  lastLoadAt = Date.now();
  setTrackerStatus('loading');
  try {
    const key = keyOf(run);
    let stat = staticCache?.key === key ? staticCache.data : undefined;
    if (!stat) {
      stat = leanStatic(await getJson<RawStatic>(run, `${run.origin}/api/static_tracker/${run.id}`));
      staticCache = { key, data: stat };
    }
    const dynamic = await getJson<TrackerDynamic>(run, `${run.origin}/api/tracker/${run.id}`);
    if (current !== run) return; // stopped, or replaced by another link, while we waited

    setCompletion(completionByGame(stat, dynamic, run.team));
    setTrackerSlots(slotsOf(stat, run.team));
    setTrackerUpdated(clockLabel());
    setTrackerError('');
    setTrackerStatus('ready');
  } catch (error) {
    if (current !== run) return; // an aborted request after stop or replace is not an error
    setTrackerError(describe(error, run));
    setTrackerStatus('error');
  } finally {
    run.busy = false;
  }
}
