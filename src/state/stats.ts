import { createSignal } from 'solid-js';
import { itemKind } from './style';

// Numbers for the Stats tab. The adapter keeps the raw bookkeeping (sets of location ids,
// per-position item lists) and publishes these small summaries.

/** Locations for the slot we are connected as. The protocol gives no such list for other slots. */
export interface CheckStats {
  checked: number;
  total: number;
  /** Locations that became checked after we connected. */
  sessionChecks: number;
}
export const [checks, setChecks] = createSignal<CheckStats | undefined>();

/** A count of items, in total and by classification. */
export interface ItemCounts {
  total: number;
  progression: number;
  useful: number;
  trap: number;
  filler: number;
}

/** Everything received, including starting items and server-granted items. */
export interface ReceivedStats extends ItemCounts {
  /** Items received from each slot. Slot 0 is the server (starting inventory, cheats). */
  bySender: Readonly<Record<number, number>>;
}
export const [received, setReceived] = createSignal<ReceivedStats | undefined>();

// Items from our own world that went to other players. The adapter fills this from the locations
// we have already checked (complete) plus live ItemSend packets; counts are only published once
// the first is done, so a half-loaded number is never shown as final. Publishing is throttled
// because !collect can send thousands at once.
const SENT_PUBLISH_DELAY_MS = 200;
const sentFlags = new Map<number, number>(); // location id -> item classification flags
let sentLoaded = false;
let sentTimer: ReturnType<typeof setTimeout> | undefined;
const [sent, setSent] = createSignal<ItemCounts | undefined>();
export { sent };

function publishSent() {
  sentTimer = undefined;
  const counts: ItemCounts = { total: 0, progression: 0, useful: 0, trap: 0, filler: 0 };
  for (const flags of sentFlags.values()) {
    counts.total++;
    counts[itemKind(flags)]++;
  }
  setSent(counts);
}

/** Record an item in one of our locations that went to another player. A location is only checked once. */
export function recordSent(location: number, flags: number) {
  sentFlags.set(location, flags);
  if (sentLoaded && sentTimer === undefined) sentTimer = setTimeout(publishSent, SENT_PUBLISH_DELAY_MS);
}

/** The backfill from already-checked locations is complete: show the counts from now on. */
export function finishSentBackfill() {
  sentLoaded = true;
  if (sentTimer !== undefined) clearTimeout(sentTimer);
  publishSent();
}

/** Each player's connection state, keyed by slot (see `clientStatusLabel`). */
export const [clientStatuses, setClientStatuses] = createSignal<Readonly<Record<number, number>>>({});

export interface RoomStats {
  serverVersion: string;
  generatorVersion: string;
  seed: string;
  games: readonly string[];
  /** Permission values for the `!release`, `!collect` and `!remaining` commands. */
  permissions: { release: number; collect: number; remaining: number };
  /** Percentage of all locations that must be checked to earn one hint; 0 means hints are free. */
  hintCostPercent: number;
}
export const [room, setRoom] = createSignal<RoomStats | undefined>();

// Item finds seen since connecting (anyone's). !release can announce thousands at once, so
// the counter is plain and only published to the signal on a short timer.
const PUBLISH_DELAY_MS = 200;
let finds = 0;
let publishTimer: ReturnType<typeof setTimeout> | undefined;
const [findsSeen, setFindsSeen] = createSignal(0);
export { findsSeen };

export function countFind() {
  finds++;
  if (publishTimer === undefined) {
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      setFindsSeen(finds);
    }, PUBLISH_DELAY_MS);
  }
}

/** Forget everything, at the start of a new connection. */
export function resetStats() {
  if (publishTimer !== undefined) clearTimeout(publishTimer);
  publishTimer = undefined;
  finds = 0;
  setFindsSeen(0);
  if (sentTimer !== undefined) clearTimeout(sentTimer);
  sentTimer = undefined;
  sentFlags.clear();
  sentLoaded = false;
  setSent(undefined);
  setChecks(undefined);
  setReceived(undefined);
  setClientStatuses({});
  setRoom(undefined);
}
