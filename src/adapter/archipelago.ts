// The only module that talks to archipelago.js. It converts the library's objects into
// the plain records in ../state, so the rest of the app never depends on the library.

import { Client, LoginError, slotTypes } from 'archipelago.js';
import type { API, MessageNode } from 'archipelago.js';
import { setHintPoints, setIdentity, setRoster, setStatus } from '../state/connection';
import { clearHints, replaceHints } from '../state/hints';
import { addHistory, clearHistory } from '../state/history';
import type { NewHistoryRow } from '../state/history';
import { pushClientMessage, pushMessage } from '../state/messages';
import {
  countFind,
  finishSentBackfill,
  recordSent,
  resetStats,
  setChecks,
  setClientStatuses,
  setReceived,
  setRoom,
} from '../state/stats';
import { itemClass, itemKind } from '../state/style';
import type { HintRow, MessageCategory, Span } from '../state/types';

export interface ConnectOptions {
  url: string;
  slot: string;
  password: string;
}

/** Thrown into the login race when the socket drops after it was established. */
class Dropped extends Error {}

/** The current connection. Cleared on disconnect so late events from an old client are ignored. */
let client: Client | undefined;

/** Which room and slot the history belongs to, so reconnecting to the same one keeps it. */
let lastRoomKey: string | undefined;

/** Locations asked about per LocationScouts packet, to keep any one packet and its reply a sane size. */
const SCOUT_CHUNK = 2000;

// --- Public API ---------------------------------------------------------------

export async function connect({ url, slot, password }: ConnectOptions): Promise<void> {
  teardown();
  clearHints();
  resetStats();
  setRoster([]);
  setIdentity(undefined);
  setHintPoints(undefined);
  setStatus('connecting');
  pushClientMessage('client', `Connecting to ${url} as "${slot}"…`);

  // maximumMessages: 0 stops the library keeping its own copy of the message log.
  const c = new Client({ maximumMessages: 0 });
  client = c;
  const isCurrent = () => client === c;

  let selfTeam = 0;
  let selfSlot = 0;
  let category: MessageCategory | undefined;
  let quiet = false;

  let rejectDropped: (error: Error) => void = () => {};
  const dropped = new Promise<never>((_, reject) => {
    rejectDropped = reject;
  });
  dropped.catch(() => {}); // only ever observed through the race below

  // Handlers must never throw: the library calls them inside the loop that dispatches
  // every packet of a message, so an exception would drop the rest of that message.
  const safe =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      try {
        fn(...args);
      } catch (error) {
        console.error('handler failed', error);
      }
    };

  // The library emits a typed event (chat, itemSent, ...) and then the generic "message"
  // event, synchronously and in that order. The typed event only records the category;
  // the generic one builds the message.
  const tag = (next: MessageCategory) => safe(() => void (category = next));
  c.messages.on('chat', tag('chat'));
  c.messages.on('serverChat', tag('server'));
  c.messages.on('itemSent', tag('item'));
  c.messages.on('itemCheated', tag('item'));
  c.messages.on('itemHinted', tag('hint'));
  c.messages.on('connected', tag('join'));
  c.messages.on('disconnected', tag('part'));
  c.messages.on('tutorial', tag('tutorial'));
  c.messages.on('userCommand', tag('command'));
  c.messages.on('adminCommand', tag('command'));
  c.messages.on('goaled', tag('goal'));
  c.messages.on('released', tag('goal'));
  c.messages.on('collected', tag('goal'));
  c.messages.on('tagsUpdated', tag('system'));
  c.messages.on('countdown', tag('system'));

  c.messages.on(
    'message',
    safe((text, nodes) => {
      if (!isCurrent()) return;
      const kind = category ?? 'system';
      category = undefined;
      pushMessage(kind, toSpans(nodes, text, selfTeam, selfSlot));
    }),
  );

  // --- Check progress (this slot only: the server sends other slots' lists only to their own clients) ---
  // RoomUpdate carries new checks and can repeat ones we already have, so keep a set of ids
  // instead of adding counts. Reset at connect start (above), never after login() resolves.
  const checkedLocations = new Set<number>();
  let totalLocations = 0;
  let sessionChecks = 0;
  const publishChecks = () => setChecks({ checked: checkedLocations.size, total: totalLocations, sessionChecks });

  c.socket.on(
    'connected',
    safe((packet) => {
      selfTeam = packet.team;
      selfSlot = packet.slot;

      checkedLocations.clear();
      for (const id of packet.checked_locations) checkedLocations.add(id);
      totalLocations = packet.checked_locations.length + packet.missing_locations.length;
      sessionChecks = 0;
      publishChecks();
    }),
  );

  // --- History of found items ---
  // Only raw packets are used here: the library's Item/Player wrappers throw for slot 0 and
  // for slots missing from the player list.
  let people: Map<number, PlayerInfo> | undefined;
  const getPeople = () => (people ??= buildPeople(c, selfTeam));

  c.socket.on(
    'roomUpdate',
    safe((packet) => {
      if (packet.players) people = undefined; // aliases changed

      if (packet.checked_locations) {
        for (const id of packet.checked_locations) {
          if (!checkedLocations.has(id)) {
            checkedLocations.add(id);
            sessionChecks++;
          }
        }
        publishChecks();
      }

      if (packet.permissions) {
        const permissions = toPermissions(packet.permissions);
        setRoom((room) => (room ? { ...room, permissions } : room));
      }
      if (packet.hint_cost !== undefined) {
        const percent = packet.hint_cost;
        setRoom((room) => (room ? { ...room, hintCostPercent: percent } : room));
      }
    }),
  );

  // Keep the history when reconnecting to the same room and slot; drop it for a different one.
  // This must be decided here, not after login() resolves: the first ReceivedItems usually
  // arrives in the same message as Connected and would be wiped by a later clear.
  c.socket.on(
    'roomInfo',
    safe((packet) => {
      if (!isCurrent()) return;
      const key = `${packet.seed_name}|${slot}`;
      if (key !== lastRoomKey) clearHistory();
      lastRoomKey = key;

      const version = (v: { major: number; minor: number; build: number }) => `${v.major}.${v.minor}.${v.build}`;
      setRoom({
        serverVersion: version(packet.version),
        generatorVersion: version(packet.generator_version),
        seed: packet.seed_name,
        games: packet.games,
        permissions: toPermissions(packet.permissions),
        hintCostPercent: packet.hint_cost,
      });
    }),
  );

  // Live: every ItemSend is broadcast to the whole team, including finds that do not involve us.
  c.socket.on(
    'printJSON',
    safe((packet) => {
      if (!isCurrent() || packet.type !== 'ItemSend') return;
      const { item, receiving } = packet;
      countFind();
      // An item from a location in our own world that went to someone else.
      if (item.player === selfSlot && receiving !== selfSlot) recordSent(item.location, item.flags);
      addHistory([
        toHistoryRow(c, getPeople(), selfSlot, {
          finder: item.player,
          receiver: receiving,
          item: item.item,
          location: item.location,
          flags: item.flags,
        }),
      ]);
    }),
  );

  // Backfill: the first ReceivedItems (index 0) is everything we have been sent so far. Later
  // ones are new finds that ItemSend already reported, with a time, so they are ignored.
  c.socket.on(
    'receivedItems',
    safe((packet) => {
      if (!isCurrent() || packet.index !== 0) return;
      const names = getPeople();
      addHistory(
        packet.items
          // Locations <= 0 are the starting inventory and server-granted items, not finds.
          .filter((item) => item.location > 0)
          .map((item) =>
            toHistoryRow(c, names, selfSlot, {
              finder: item.player,
              receiver: selfSlot,
              item: item.item,
              location: item.location,
              flags: item.flags,
            }),
          ),
      );
    }),
  );

  // --- Items received, for the Stats tab ---
  // Written by position in the server's item list, across every ReceivedItems packet: index 0
  // starts over, and a resent or duplicate packet just rewrites the same positions instead of
  // being counted twice. Starting items and server-granted items are included.
  const receivedFlags: number[] = [];
  const receivedFrom: number[] = [];
  c.socket.on(
    'receivedItems',
    safe((packet) => {
      if (!isCurrent()) return;
      if (packet.index === 0) {
        receivedFlags.length = 0;
        receivedFrom.length = 0;
      }
      packet.items.forEach((item, offset) => {
        receivedFlags[packet.index + offset] = item.flags;
        receivedFrom[packet.index + offset] = item.player;
      });

      const counts = { progression: 0, useful: 0, trap: 0, filler: 0 };
      const bySender: Record<number, number> = {};
      let total = 0;
      for (let i = 0; i < receivedFlags.length; i++) {
        const flags = receivedFlags[i];
        if (flags === undefined) continue; // a gap, if the server skipped ahead
        counts[itemKind(flags)]++;
        bySender[receivedFrom[i]] = (bySender[receivedFrom[i]] ?? 0) + 1;
        total++;
      }
      setReceived({ total, ...counts, bySender });
    }),
  );

  // --- Items sent (items in our world that went to other players), for the Stats tab ---
  // Backfilled by asking the server what is in the locations we have ALREADY checked. Those items
  // were announced to the whole team when they were checked, so this reveals nothing new.
  // Unchecked locations are never requested, and an answer for one is ignored.
  let scoutsRequested = false;
  let scoutsPending = 0;
  c.socket.on(
    'locationInfo',
    safe((packet) => {
      if (!isCurrent() || !scoutsRequested) return;
      for (const entry of packet.locations) {
        // In a LocationInfo packet `player` is the slot the item belongs to (the receiver).
        if (checkedLocations.has(entry.location) && entry.player !== selfSlot) recordSent(entry.location, entry.flags);
      }
      scoutsPending -= packet.locations.length;
      if (scoutsPending <= 0) {
        scoutsRequested = false;
        finishSentBackfill();
      }
    }),
  );

  const backfillSent = () => {
    const checked = [...checkedLocations];
    if (checked.length === 0) {
      finishSentBackfill();
      return;
    }
    scoutsRequested = true;
    scoutsPending = checked.length;
    try {
      for (let i = 0; i < checked.length; i += SCOUT_CHUNK) {
        // create_as_hint 0: look only, never create hints.
        c.socket.send({ cmd: 'LocationScouts', locations: checked.slice(i, i + SCOUT_CHUNK), create_as_hint: 0 });
      }
    } catch (error) {
      scoutsRequested = false;
      if (isCurrent()) pushClientMessage('error', `Could not load the items you sent: ${describeError(error)}`);
    }
  };

  const updatePoints = safe(() => {
    if (isCurrent() && c.authenticated) {
      setHintPoints({ points: c.room.hintPoints, cost: c.room.hintCost, perCheck: c.room.locationCheckPoints });
    }
  });
  c.room.on('hintPointsUpdated', updatePoints);
  c.room.on('hintCostUpdated', updatePoints);
  c.room.on('locationCheckPointsUpdated', updatePoints);

  // The socket only emits "disconnected" once the connection was fully established
  // (RoomInfo received). A failure before that makes login() reject with the reason.
  c.socket.on(
    'disconnected',
    safe(() => {
      rejectDropped(new Dropped());
      if (!isCurrent() || quiet) return;
      setStatus('closed');
      pushClientMessage('error', 'Disconnected from server.');
    }),
  );

  const login = c.login(url.trim(), slot, '', { password });
  login.catch(() => {}); // if the race below is lost, don't leave an unhandled rejection

  try {
    // login() keeps waiting (until its own timeout) if the socket drops mid-handshake,
    // so race it against the disconnect.
    await Promise.race([login, dropped]);
    if (!isCurrent()) {
      // The user disconnected (or reconnected) while we were still logging in.
      c.socket.disconnect();
      return;
    }

    setStatus('connected');
    setIdentity({ name: c.name, game: c.game, team: selfTeam });
    pushClientMessage('client', `Connected as "${c.name}" (${c.game}).`);
    updatePoints();

    const people = buildPeople(c, selfTeam);
    const slots = [...people.keys()].filter((id) => id > 0).sort((a, b) => a - b);
    setRoster(
      slots.map((id) => {
        const info = people.get(id)!;
        return { slot: id, name: info.name, game: info.game, isMe: id === selfSlot, isGroup: info.isGroup };
      }),
    );
    backfillSent();
    void loadHints(c, selfTeam, selfSlot, slots, isCurrent);
    void loadClientStatuses(
      c,
      selfTeam,
      slots.filter((id) => !people.get(id)!.isGroup),
      isCurrent,
    );
  } catch (error) {
    if (error instanceof Dropped) return; // already reported by the "disconnected" handler
    if (!isCurrent()) {
      c.socket.disconnect();
      return;
    }
    quiet = true;
    setStatus('closed');
    pushClientMessage('error', describeError(error));
    // The server keeps the socket open after a refusal, so close it ourselves.
    c.socket.disconnect();
  }
}

export function disconnect() {
  const c = client;
  if (!c) return;
  client = undefined; // from here on, every callback of this client sees it is stale
  setStatus('closed');
  setHintPoints(undefined);
  pushClientMessage('client', 'Disconnected.');
  c.socket.disconnect();
}

/** Result of trying to send what the user typed. */
export type SendResult = 'sent' | 'not-connected' | 'client-command';

/**
 * Send chat or a `!command` (for example `!hint Item Name`) to the room.
 * `/commands` belong to the official client and are not implemented, so they are
 * kept local instead of being broadcast to everyone as chat.
 */
export function sendText(input: string): SendResult {
  const text = input.trim();
  if (!text) return 'not-connected';

  if (text.startsWith('/')) {
    pushClientMessage('client', 'Client-side "/" commands are not supported yet. Use "!" commands, for example !help.');
    return 'client-command';
  }

  const c = client;
  if (!c || !c.authenticated) return 'not-connected';
  try {
    c.socket.send({ cmd: 'Say', text });
    return 'sent';
  } catch (error) {
    pushClientMessage('error', `Could not send: ${describeError(error)}`);
    return 'not-connected';
  }
}

// --- Internals ----------------------------------------------------------------

// Drop our reference first so the old client's handlers see it is no longer current.
function teardown() {
  const old = client;
  client = undefined;
  old?.socket.disconnect();
}

function describeError(error: unknown): string {
  if (error instanceof LoginError) {
    return `Login refused: ${error.errors.join(', ') || 'no reason given'}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

// --- Messages -----------------------------------------------------------------

function toSpans(nodes: MessageNode[], fallback: string, selfTeam: number, selfSlot: number): Span[] {
  try {
    return nodes.map((node) => nodeToSpan(node, selfTeam, selfSlot));
  } catch {
    return [{ text: fallback, cls: '' }];
  }
}

function nodeToSpan(node: MessageNode, selfTeam: number, selfSlot: number): Span {
  switch (node.type) {
    case 'player': {
      const mine = node.player.slot === selfSlot && node.player.team === selfTeam;
      return { text: node.text, cls: mine ? 'p-self' : 'p-other' };
    }
    case 'item':
      return { text: node.text, cls: itemClass(node.item.flags) };
    case 'location':
      return { text: node.text, cls: 'loc' };
    case 'color':
      // The reference client allows several codes in one value, separated by ";".
      return { text: node.text, cls: String(node.color).split(';').map((code) => `c-${code}`).join(' ') };
    default:
      return { text: node.text, cls: node.type === 'entrance' ? 'entrance' : '' };
  }
}

// --- Hints --------------------------------------------------------------------

/** Wait this long after a hint update for more to arrive before rebuilding the table. */
const HINT_REBUILD_DELAY_MS = 50;

/**
 * Subscribe to the hint list of every slot, so the table shows the whole room's hints and not
 * only the ones involving us. The server stores each hint under both players it involves,
 * and every update carries that slot's complete list, so we keep the latest list per slot
 * and rebuild the merged table from them.
 */
async function loadHints(c: Client, team: number, selfSlot: number, slots: number[], isCurrent: () => boolean) {
  const keyFor = (slot: number) => `_read_hints_${team}_${slot}`;
  const slotForKey = new Map(slots.map((slot) => [keyFor(slot), slot]));
  const latest = new Map<number, API.NetworkHint[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const rebuild = () => {
    timer = undefined;
    if (!isCurrent()) return;
    try {
      const people = buildPeople(c, team);
      const merged = new Map<string, API.NetworkHint>();
      for (const [slot, list] of latest) {
        for (const hint of list) {
          const id = hintId(hint);
          // Both involved players hold a copy. The receiver's copy is authoritative: only the
          // receiver can change a hint's status, so a stale finder-side copy must not win.
          if (!merged.has(id) || slot === hint.receiving_player) merged.set(id, hint);
        }
      }
      replaceHints([...merged.values()].map((hint) => toHintRow(c, people, selfSlot, hint)));
    } catch (error) {
      console.error('could not convert hints', error);
    }
  };

  const store = (key: string, value: unknown) => {
    const slot = slotForKey.get(key);
    if (slot !== undefined) latest.set(slot, Array.isArray(value) ? (value as API.NetworkHint[]) : []);
  };

  const keys = slots.map(keyFor);
  try {
    const data = (await c.storage.notify(keys, (key, value) => {
      store(key, value);
      if (isCurrent() && timer === undefined) timer = setTimeout(rebuild, HINT_REBUILD_DELAY_MS);
    })) as Record<string, unknown>;
    for (const key of keys) store(key, data[key]);
    if (timer !== undefined) clearTimeout(timer);
    rebuild();
  } catch (error) {
    if (isCurrent()) pushClientMessage('error', `Could not load hints: ${describeError(error)}`);
  }
}

/** The library types these awkwardly (`remaining` in particular); the Stats tab just wants numbers. */
function toPermissions(table: API.PermissionTable) {
  return { release: Number(table.release), collect: Number(table.collect), remaining: Number(table.remaining) };
}

/**
 * Subscribe to every player's connection state (`_read_client_status_{team}_{slot}`): 0 when
 * the slot has no client connected, 5 once any client is connected (a text client counts, so it
 * does not mean the game is running), 10 ready, 20 playing, 30 goal reached (permanent).
 */
async function loadClientStatuses(c: Client, team: number, slots: number[], isCurrent: () => boolean) {
  const keyFor = (slot: number) => `_read_client_status_${team}_${slot}`;
  const slotForKey = new Map(slots.map((slot) => [keyFor(slot), slot]));
  const statuses: Record<number, number> = {};

  const apply = (key: string, value: unknown) => {
    const slot = slotForKey.get(key);
    if (slot === undefined) return;
    statuses[slot] = typeof value === 'number' ? value : 0;
  };

  const keys = slots.map(keyFor);
  try {
    const data = (await c.storage.notify(keys, (key, value) => {
      apply(key, value);
      if (isCurrent()) setClientStatuses({ ...statuses });
    })) as Record<string, unknown>;
    for (const key of keys) apply(key, data[key]);
    if (isCurrent()) setClientStatuses({ ...statuses });
  } catch (error) {
    if (isCurrent()) pushClientMessage('error', `Could not load player statuses: ${describeError(error)}`);
  }
}

/** A location belongs to exactly one slot, so (finder, location) identifies a hint. */
function hintId(hint: API.NetworkHint): string {
  return `${hint.finding_player}-${hint.location}`;
}


interface PlayerInfo {
  name: string;
  game: string;
  /** An item-links group rather than a real player. */
  isGroup: boolean;
}

/**
 * Build a slot -> name/game lookup once per rebuild. Aliases come from the player list;
 * slot_info covers every slot (including item links and groups) and gives the game, which
 * is required to resolve item and location names.
 */
function buildPeople(c: Client, team: number): Map<number, PlayerInfo> {
  const people = new Map<number, PlayerInfo>();
  for (const [slot, info] of Object.entries(c.players.slots)) {
    people.set(Number(slot), { name: info.name, game: info.game, isGroup: info.type === slotTypes.group });
  }
  try {
    // `teams` rebuilds every Player object on each access, so read it once.
    for (const player of c.players.teams[team] ?? []) {
      try {
        const isGroup = people.get(player.slot)?.isGroup ?? false;
        people.set(player.slot, { name: player.alias, game: player.game, isGroup });
      } catch {
        // an empty entry (slot 0 has no real player); keep the slot_info value
      }
    }
  } catch {
    // keep the slot_info values
  }
  return people;
}

/** An item in a location: shared by hints and by the history of found items. */
interface Find {
  /** Slot whose world holds the location. */
  finder: number;
  /** Slot the item is for. */
  receiver: number;
  item: number;
  location: number;
  flags: number;
}

/** Resolve a find's player and item names. Used by both the hint table and the history. */
function describeFind(c: Client, people: Map<number, PlayerInfo>, selfSlot: number, find: Find) {
  const who = (slot: number): PlayerInfo =>
    people.get(slot) ?? { name: slot === 0 ? 'Archipelago' : `Slot ${slot}`, game: 'Archipelago', isGroup: false };
  const finder = who(find.finder);
  const receiver = who(find.receiver);
  return {
    id: `${find.finder}-${find.location}`,
    // An item id belongs to the receiving player's game, a location id to the finder's.
    itemName: c.package.lookupItemName(receiver.game, find.item, true),
    itemFlags: find.flags,
    locationName: c.package.lookupLocationName(finder.game, find.location, true),
    finderSlot: find.finder,
    finderName: finder.name,
    finderGame: finder.game,
    receiverSlot: find.receiver,
    receiverName: receiver.name,
    receiverGame: receiver.game,
    forMe: find.receiver === selfSlot,
    fromMe: find.finder === selfSlot,
  };
}

type Described = ReturnType<typeof describeFind>;

/** Lower-cased text the search boxes look in. */
function searchText(base: Described, ...extra: string[]): string {
  return [base.itemName, base.locationName, base.finderName, base.finderGame, base.receiverName, base.receiverGame, ...extra]
    .join('\u0000')
    .toLowerCase();
}

function toHintRow(
  c: Client,
  people: Map<number, PlayerInfo>,
  selfSlot: number,
  hint: API.NetworkHint,
): HintRow {
  const base = describeFind(c, people, selfSlot, {
    finder: hint.finding_player,
    receiver: hint.receiving_player,
    item: hint.item,
    location: hint.location,
    flags: hint.item_flags ?? 0,
  });
  const entrance = hint.entrance ?? '';

  return {
    ...base,
    entrance,
    found: hint.found,
    status: Number(hint.status ?? 0),
    search: searchText(base, entrance),
  };
}

function toHistoryRow(c: Client, people: Map<number, PlayerInfo>, selfSlot: number, find: Find): NewHistoryRow {
  const base = describeFind(c, people, selfSlot, find);
  return { ...base, search: searchText(base) };
}
