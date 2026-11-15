import { createSignal } from 'solid-js';
import type { RosterEntry } from './types';

// Lobby-wide completion, from the Archipelago website's tracker. The game connection only reports
// check progress for our own slot, so this is the one way to see every player's.

/** Completion for one game, summed over every player of that game. */
export interface GameCompletion {
  game: string;
  players: number;
  checked: number;
  total: number;
}

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The tracker link as entered (a room's "Multiworld Tracker" link). Empty means none. */
export const [trackerLink, setTrackerLink] = createSignal('');
export const [trackerStatus, setTrackerStatus] = createSignal<TrackerStatus>('idle');
export const [trackerError, setTrackerError] = createSignal('');
/** Clock time of the last successful load, e.g. "14:32:05". Empty until the first one. */
export const [trackerUpdated, setTrackerUpdated] = createSignal('');
export const [completion, setCompletion] = createSignal<readonly GameCompletion[]>([]);
/** slot -> game for the players the tracker lists (groups left out), to check it is the right room. */
export const [trackerSlots, setTrackerSlots] = createSignal<Readonly<Record<number, string>>>({});

/** Forget loaded data, for when the link changes to a different tracker. */
export function clearTrackerData() {
  setTrackerError('');
  setTrackerUpdated('');
  setCompletion([]);
  setTrackerSlots({});
  setTrackerStatus('idle');
}

/**
 * Does the tracker describe the room we are connected to? Neither tracker endpoint returns the
 * seed name, so compare who plays what. 'unknown' when there is nothing to compare yet.
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

// --- Saved links --------------------------------------------------------------
// One link per room (by seed name), so a link is never applied to a different room.

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

/** Remember a room's tracker link; an empty link forgets it. */
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
