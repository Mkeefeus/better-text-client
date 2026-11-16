import { createSignal } from 'solid-js';
import { roster, serverPort, status } from './connection';
import type { RosterEntry } from './types';

// What we know from the Archipelago website about the room: lobby-wide completion from its tracker,
// and the room's own details from its room API. The game connection only reports check progress
// for our own slot, so the tracker is the one way to see every player's.

/** Completion for one game, summed over every player of that game. */
export interface GameCompletion {
  game: string;
  players: number;
  checked: number;
  total: number;
}

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The link as entered: a room's page (`…/room/<id>`) or its "Multiworld Tracker" (`…/tracker/<id>`).
 * Empty means none. A room link gives everything; a tracker link gives only the completion.
 */
export const [siteLink, setSiteLink] = createSignal('');
export const [trackerStatus, setTrackerStatus] = createSignal<TrackerStatus>('idle');
export const [trackerError, setTrackerError] = createSignal('');
/** Clock time of the last successful load, e.g. "14:32:05". Empty until the first one. */
export const [trackerUpdated, setTrackerUpdated] = createSignal('');
export const [completion, setCompletion] = createSignal<readonly GameCompletion[]>([]);
/** slot -> game for the players the tracker lists (groups left out), to check it is the right room. */
export const [trackerSlots, setTrackerSlots] = createSignal<Readonly<Record<number, string>>>({});

/**
 * One found item as the tracker reports it: every player's received items, so every find in the
 * team (finds made while this client was not connected included). Plain numbers, like the
 * protocol's; names are resolved by the connection, which holds the data package.
 */
export interface TrackerFind {
  /** Slot whose world holds the location. */
  finder: number;
  receiver: number;
  location: number;
  item: number;
  flags: number;
}

/**
 * Every receiver's finds, each list in the exact order that player received them. The tracker has
 * no times, and nothing records how the lists interleave, so they are kept apart.
 */
export type TrackerChains = readonly (readonly TrackerFind[])[];

// The latest chains are kept here so a connection made after the tracker loaded still gets them,
// and a listener (the connection's History backfill) is told about new ones. A plain callback, not
// an effect: it has to work without a reactive owner.
let latestChains: TrackerChains = [];
let chainsListener: ((chains: TrackerChains) => void) | undefined;

export function publishTrackerFinds(chains: TrackerChains) {
  latestChains = chains;
  chainsListener?.(chains);
}
export function getTrackerFinds(): TrackerChains {
  return latestChains;
}
/** One listener at a time: the current connection's. Pass undefined to remove it. */
export function setTrackerFindsListener(listener: ((chains: TrackerChains) => void) | undefined) {
  chainsListener = listener;
}

/** Forget loaded data, for when the link changes to a different tracker. */
export function clearTrackerData() {
  latestChains = [];
  setTrackerError('');
  setTrackerUpdated('');
  setCompletion([]);
  setTrackerSlots({});
  setTrackerStatus('idle');
}

// --- The website's room details -------------------------------------------------

export interface RoomPlayer {
  /** 1-based. The room API lists players in slot order without ids, so this is the list position + 1. */
  slot: number;
  /** The slot name from generation (the live alias can differ). */
  name: string;
  game: string;
}

export interface WebsiteRoom {
  roomUrl: string;
  /** The tracker's id, if the room has one. */
  trackerId: string | undefined;
  trackerUrl: string | undefined;
  /** > 0: the port the room's server last ran on. 0: it never started. -1: it failed to start. */
  lastPort: number | undefined;
  /** When the website last saw activity. It updates when the room saves (on a location check), so it is approximate. */
  lastActivity: Date | undefined;
  /** The room stops after this many seconds without a location check by any player. */
  timeoutSeconds: number | undefined;
  players: readonly RoomPlayer[];
  /** slot -> a patch or slot-file download link, only where the room has one (same origin as the link, checked). */
  downloads: Readonly<Record<number, string>>;
}

export const [websiteRoom, setWebsiteRoom] = createSignal<WebsiteRoom | undefined>();
export const [roomStatus, setRoomStatus] = createSignal<TrackerStatus>('idle');
export const [roomError, setRoomError] = createSignal('');
/** Clock time of the last successful room load. Empty until the first one. */
export const [roomUpdated, setRoomUpdated] = createSignal('');

/** Forget the room's details, for when the link changes to a different room. */
export function clearRoomData() {
  setWebsiteRoom(undefined);
  setRoomError('');
  setRoomUpdated('');
  setRoomStatus('idle');
}

/** slot -> game for the players the room lists. */
export function slotsOfRoom(room: WebsiteRoom): Record<number, string> {
  const slots: Record<number, string> = {};
  for (const player of room.players) slots[player.slot] = player.game;
  return slots;
}

// --- Checking it is the right room ------------------------------------------------

/**
 * Does the tracker (or room) describe the room we are connected to? Neither the tracker nor the
 * room endpoints return the seed name, so compare who plays what. 'unknown' when there is nothing
 * to compare yet.
 */
export function rosterMatchesTracker(
  roster: readonly RosterEntry[],
  slots: Readonly<Record<number, string>>,
): 'match' | 'mismatch' | 'unknown' {
  const players = roster.filter((entry) => !entry.isGroup);
  const trackerSlotCount = Object.keys(slots).length;
  if (players.length === 0 || trackerSlotCount === 0) return 'unknown';
  if (players.length !== trackerSlotCount) return 'mismatch';
  return players.every((player) => slots[player.slot] === player.game) ? 'match' : 'mismatch';
}

/**
 * Is the port the website reports the one we are connected to? A restarted room can change port,
 * so a mismatch is a hint, not proof. Only a running room has a port to compare (> 0).
 */
export function portMatches(
  roomPort: number | undefined,
  serverPort: number | undefined,
): 'match' | 'mismatch' | 'unknown' {
  if (roomPort === undefined || roomPort <= 0 || serverPort === undefined) return 'unknown';
  return roomPort === serverPort ? 'match' : 'mismatch';
}

// Checks against the room we are connected to, derived from the signals above. Plain functions, not
// memos: they are cheap, and a memo made at module level would have no owner.

/** Does the website's port match the one we are connected to? 'unknown' until connected. */
export function portCheck(): 'match' | 'mismatch' | 'unknown' {
  return status() === 'connected' ? portMatches(websiteRoom()?.lastPort, serverPort()) : 'unknown';
}

/** Who plays what according to the website: the tracker's list, else the room's. */
export function websiteSlots(): Readonly<Record<number, string>> {
  const fromTracker = trackerSlots();
  if (Object.keys(fromTracker).length > 0) return fromTracker;
  const room = websiteRoom();
  return room ? slotsOfRoom(room) : {};
}

/** Do the website's players match the roster we are connected to? 'unknown' until connected. */
export function rosterCheck(): 'match' | 'mismatch' | 'unknown' {
  return status() === 'connected' ? rosterMatchesTracker(roster(), websiteSlots()) : 'unknown';
}

/** False when the page looks like a different room, so nothing that acts on it (a download) is offered. */
export function linkTrusted(): boolean {
  return portCheck() !== 'mismatch' && rosterCheck() !== 'mismatch';
}

// --- Saved links --------------------------------------------------------------
// One link per room (by seed name), so a link is never applied to a different room. The storage
// key predates room links; it is kept so links saved earlier (tracker links) keep working.

const LINKS_KEY = 'better-text-client.tracker-links';

function readLinks(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function loadSavedLink(seed: string): string {
  const link = readLinks()[seed];
  return typeof link === 'string' ? link : '';
}

/** Remember a room's link; an empty link forgets it. */
export function saveLink(seed: string, link: string) {
  try {
    const links = readLinks();
    if (link) links[seed] = link;
    else delete links[seed];
    localStorage.setItem(LINKS_KEY, JSON.stringify(links));
  } catch {
    // Storage can be unavailable or full; losing the saved link is not worth surfacing.
  }
}
