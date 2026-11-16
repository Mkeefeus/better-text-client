// What we can learn from the Archipelago website about a room. Plain `fetch`; nothing here touches
// archipelago.js. The website enables cross-origin requests for all of these endpoints.
//
//   /api/room_status/<room id>  the room's details: its port, last activity, idle timeout, the
//                               tracker's id, the players, and patch / slot-file downloads. Not
//                               cached by the website. It fails with a server error for a room that
//                               has no tracker (the website converts the missing tracker id).
//   /api/static_tracker/<id>    slot totals and games; it also contains the room's entire data
//                               package, so it is fetched once per link and only the small part we
//                               need is kept.
//   /api/tracker/<id>           every player's checked locations (plus items and hints we ignore);
//                               the website caches it for a minute, so it is polled no faster.
//
// Given a room link, the room details give the tracker id, so the user only has to paste one link.

import { clockLabel } from '../state/timing';
import {
  clearRoomData,
  clearTrackerData,
  roomUpdated,
  publishTrackerFinds,
  setCompletion,
  setRoomError,
  setRoomStatus,
  setRoomUpdated,
  setTrackerError,
  setTrackerSlots,
  setTrackerStatus,
  setTrackerUpdated,
  setWebsiteRoom,
  trackerUpdated,
} from '../state/tracker';
import type { GameCompletion, RoomPlayer, TrackerFind, WebsiteRoom } from '../state/tracker';

/**
 * How often to ask. The website refreshes tracker data about once a minute, so asking for it more
 * often gains nothing; the room details are not cached, but there is no reason to rush them either.
 * Exported and mutable only so tests can shorten the waits.
 */
export const timing = {
  roomPollMs: 60_000,
  trackerPollMs: 60_000,
  /** The shortest gap before a manual refresh of the room details does anything. */
  roomRefreshFloorMs: 10_000,
};
const REQUEST_TIMEOUT_MS = 90_000;

// --- Link parsing ---------------------------------------------------------------

export type SiteLink =
  | { ok: true; kind: 'room' | 'tracker'; origin: string; id: string }
  | { ok: false; problem: 'empty' | 'invalid' };

const TRACKER_SEGMENTS = new Set(['tracker', 'sphere_tracker', 'generic_tracker', 'static_tracker']);
const ROOM_SEGMENTS = new Set(['room', 'room_status']);

/**
 * Read a link from the website: a room page (`https://archipelago.gg/room/<id>`) or a room's
 * "Multiworld Tracker" (`https://archipelago.gg/tracker/<id>`). The id is passed on exactly as
 * written: the website accepts both short and full UUIDs.
 */
export function parseSiteLink(text: string): SiteLink {
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
  // Take whichever kind of segment comes first, in case a path contains both words.
  let best: { kind: 'room' | 'tracker'; at: number } | undefined;
  parts.forEach((part, at) => {
    if (!parts[at + 1] || (best && best.at < at)) return;
    if (TRACKER_SEGMENTS.has(part)) best ??= { kind: 'tracker', at };
    else if (ROOM_SEGMENTS.has(part)) best ??= { kind: 'room', at };
  });
  if (!best) return { ok: false, problem: 'invalid' };
  return { ok: true, kind: best.kind, origin: url.origin, id: parts[best.at + 1] };
}

// --- Payloads (only the fields we read) -----------------------------------------

interface RawRoomStatus {
  tracker?: string | null;
  /** `[slot name, game]` pairs in slot order, without ids. */
  players?: unknown;
  last_port?: number | null;
  /** An HTTP date (RFC 1123), as Flask serialises a datetime. */
  last_activity?: string | null;
  timeout?: number | null;
  downloads?: { slot?: number; download?: string }[] | null;
}

interface RawStatic {
  groups?: { slot: number }[];
  player_locations_total?: { team: number; player: number; total_locations: number }[];
  player_game?: { team: number; player: number; game: string }[];
}

export interface TrackerDynamic {
  player_checks_done?: { team: number; player: number; locations: number[] }[];
  /**
   * `items` are `[item, location, finder slot, flags]` (the protocol's NetworkItem order: item
   * first), in the order the player received them. The item id is in the receiver's game, the
   * location id in the finder's.
   */
  player_items_received?: { team: number; player: number; items: unknown[] }[];
}

/**
 * Every find of one team, as one list per receiver in the exact order that player received them
 * (the server appends to `received_items` as locations are checked). There are no times, and how
 * the lists interleave is not recorded, so they are kept apart; the connection places them.
 *
 * Starting items and server-granted items have a location <= 0 and are not finds, so they are left
 * out; malformed entries are skipped; players with nothing received give no list.
 */
export function chainsOf(dynamic: TrackerDynamic, team: number): TrackerFind[][] {
  const chains: TrackerFind[][] = [];
  for (const entry of dynamic.player_items_received ?? []) {
    if (entry.team !== team || !Array.isArray(entry.items)) continue;
    const chain: TrackerFind[] = [];
    for (const item of entry.items) {
      if (!Array.isArray(item) || item.length < 4) continue;
      const [id, location, finder, flags] = item;
      if (![id, location, finder, flags].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      if (location <= 0) continue;
      chain.push({ finder, receiver: entry.player, location, item: id, flags });
    }
    if (chain.length > 0) chains.push(chain);
  }
  return chains;
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

// --- The room's details (pure) ----------------------------------------------------

/** Tracker ids are URL-safe base64 or a UUID; anything else is not something we put in a link. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Resolve a link from the website's data against the origin the user pasted. Only http(s) links on
 * that same origin are kept: the data is shown to the user as something to click, so a link to
 * anywhere else is dropped, not trusted.
 */
export function sameOriginHttpUrl(origin: string, path: string): string | undefined {
  try {
    const base = new URL(origin);
    const url = new URL(path, base);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== base.origin) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function toWebsiteRoom(origin: string, roomId: string, raw: RawRoomStatus): WebsiteRoom {
  // The room API lists players in slot order without ids, so the slot is the list position + 1.
  // A malformed entry keeps its place, so the entries after it keep the right slot.
  const players: RoomPlayer[] = (Array.isArray(raw.players) ? raw.players : []).map((entry: unknown, index) => {
    const [name, game] = Array.isArray(entry) ? entry : [];
    return {
      slot: index + 1,
      name: typeof name === 'string' ? name : `Slot ${index + 1}`,
      game: typeof game === 'string' ? game : '',
    };
  });

  const downloads: Record<number, string> = {};
  for (const entry of raw.downloads ?? []) {
    if (typeof entry?.slot !== 'number' || typeof entry.download !== 'string') continue;
    const url = sameOriginHttpUrl(origin, entry.download);
    if (url) downloads[entry.slot] = url;
  }

  const trackerId = typeof raw.tracker === 'string' && SAFE_ID.test(raw.tracker) ? raw.tracker : undefined;
  const activity = typeof raw.last_activity === 'string' ? new Date(raw.last_activity) : undefined;

  return {
    roomUrl: `${origin}/room/${roomId}`,
    trackerId,
    trackerUrl: trackerId ? `${origin}/tracker/${trackerId}` : undefined,
    lastPort: typeof raw.last_port === 'number' ? raw.last_port : undefined,
    lastActivity: activity && !Number.isNaN(activity.getTime()) ? activity : undefined,
    timeoutSeconds: typeof raw.timeout === 'number' && raw.timeout > 0 ? raw.timeout : undefined,
    players,
    downloads,
  };
}

// --- Completion by game (pure) -----------------------------------------------------

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

// --- Fetching ----------------------------------------------------------------------

class TrackerError extends Error {
  constructor(
    readonly code: 'not-found' | 'timeout' | 'http',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function getJson<T>(holder: { inflight?: AbortController }, url: string): Promise<T> {
  const controller = new AbortController();
  holder.inflight = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) throw new TrackerError('not-found', 'not found', 404);
    if (!response.ok) throw new TrackerError('http', `HTTP ${response.status}`, response.status);
    return (await response.json()) as T;
  } catch (error) {
    if (timedOut) throw new TrackerError('timeout', 'timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function describe(error: unknown, origin: string): string {
  if (error instanceof TrackerError) {
    switch (error.code) {
      case 'not-found':
        return "The website does not know that tracker. Check the link: it should be the room's Multiworld Tracker link, or the room's page.";
      case 'timeout':
        return `${origin} took too long to answer.`;
      default:
        return `${origin} answered with an error (${error.message}).`;
    }
  }
  // The body arrived but was not JSON.
  if (error instanceof SyntaxError) return 'The website returned data this client could not read.';
  // Anything else is the request itself failing: no connection, an unknown host, or a block by the
  // browser (which reports all of these as a bare TypeError).
  return `Could not reach ${origin}. Check the link and your connection.`;
}

function describeRoomError(error: unknown, origin: string): string {
  if (error instanceof TrackerError && error.code === 'not-found') {
    return "The website does not know that room. Check the link: it should be the address of the room's page.";
  }
  if (error instanceof TrackerError && error.code === 'http' && (error.status ?? 0) >= 500) {
    // The website's room details need the room's tracker id, so it fails for a room without one.
    return 'The website could not describe this room. This most likely means the room has no tracker, because the website needs one to describe a room.';
  }
  return describe(error, origin);
}

// --- Tracker: completion by game ----------------------------------------------------

interface Run {
  origin: string;
  id: string;
  team: number;
  stopped: boolean;
  busy: boolean;
  timer?: ReturnType<typeof setInterval>;
  inflight?: AbortController;
}

/** The active tracker run. A response from any other run is ignored. */
let current: Run | undefined;
/** Which tracker the loaded completion data belongs to. */
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
  run.timer = setInterval(() => void load(run), timing.trackerPollMs);
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
  if (!current || Date.now() - lastLoadAt < timing.trackerPollMs) return;
  void load(current);
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
    publishTrackerFinds(chainsOf(dynamic, run.team));
    setTrackerUpdated(clockLabel());
    setTrackerError('');
    setTrackerStatus('ready');
  } catch (error) {
    if (current !== run) return; // an aborted request after stop or replace is not an error
    setTrackerError(describe(error, run.origin));
    setTrackerStatus('error');
  } finally {
    run.busy = false;
  }
}

// --- The whole site: the room, and the tracker it names -------------------------------

interface SiteRun {
  origin: string;
  id: string;
  team: number;
  stopped: boolean;
  busy: boolean;
  timer?: ReturnType<typeof setInterval>;
  inflight?: AbortController;
}

/** The active room run. A response from any other run is ignored. */
let site: SiteRun | undefined;
/** The tracker the room run last started, so it is only restarted when the room names a different one. */
let siteTrackerKey: string | undefined;
/** Which room the loaded room details belong to. */
let roomDataKey: string | undefined;
let lastRoomLoadAt = 0;

/**
 * Load what the website knows, from a room link or a tracker link, and keep it fresh. A room link
 * gives the room's details and, through them, the tracker; a tracker link gives only the tracker.
 * Call `stopSite` when it is no longer shown.
 */
export function startSite(link: { kind: 'room' | 'tracker'; origin: string; id: string }, team: number) {
  stopSite();

  if (link.kind === 'tracker') {
    roomDataKey = undefined;
    clearRoomData(); // a bare tracker link carries no room details
    startTracker(link, team);
    return;
  }

  const run: SiteRun = { origin: link.origin, id: link.id, team, stopped: false, busy: false };
  const key = `${run.origin}|${run.id}`;
  if (key !== roomDataKey) {
    // Neither the details nor the completion of a different room may linger, not even while the
    // new room loads or if it fails: the old completion would be shown as if it were this room's.
    clearRoomData();
    clearTrackerData();
    roomDataKey = key;
  }
  site = run;
  void loadRoom(run);
  run.timer = setInterval(() => void loadRoom(run), timing.roomPollMs);
}

export function stopSite() {
  const run = site;
  site = undefined;
  siteTrackerKey = undefined;
  if (run) {
    run.stopped = true;
    clearInterval(run.timer);
    run.inflight?.abort();
    setRoomStatus(roomUpdated() ? 'ready' : 'idle');
  }
  stopTracker();
}

/** Reload now. The room details can be asked for after a short while; the tracker keeps its own minute floor. */
export function refreshSite() {
  if (site && Date.now() - lastRoomLoadAt >= timing.roomRefreshFloorMs) void loadRoom(site);
  refreshTracker();
}

async function loadRoom(run: SiteRun) {
  if (site !== run || run.busy) return;
  run.busy = true;
  lastRoomLoadAt = Date.now();
  setRoomStatus('loading');
  try {
    const raw = await getJson<RawRoomStatus>(run, `${run.origin}/api/room_status/${run.id}`);
    if (site !== run) return; // stopped, or replaced by another link, while we waited

    const room = toWebsiteRoom(run.origin, run.id, raw);
    setWebsiteRoom(room);
    setRoomError('');
    setRoomUpdated(clockLabel());
    setRoomStatus('ready');

    if (room.trackerId) {
      // Restart the tracker only when the room names a different one: restarting on every room
      // poll would refetch its large data and double its polling rate.
      const trackerKey = `${run.origin}|${room.trackerId}`;
      if (trackerKey !== siteTrackerKey) {
        siteTrackerKey = trackerKey;
        startTracker({ origin: run.origin, id: room.trackerId }, run.team);
      }
    } else {
      siteTrackerKey = undefined;
      stopTracker();
      clearTrackerData();
      setTrackerError('This room has no tracker, so lobby completion is not available.');
      setTrackerStatus('error');
    }
  } catch (error) {
    if (site !== run) return; // an aborted request after stop or replace is not an error
    setRoomError(describeRoomError(error, run.origin));
    setRoomStatus('error');
  } finally {
    run.busy = false;
  }
}
