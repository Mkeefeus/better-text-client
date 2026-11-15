// The only module that talks to archipelago.js. It converts the library's objects into
// the plain records in ../state, so the rest of the app never depends on the library.

import { Client, LoginError } from 'archipelago.js';
import type { API, MessageNode } from 'archipelago.js';
import { setHintPoints, setIdentity, setRoster, setStatus } from '../state/connection';
import { clearHints, replaceHints } from '../state/hints';
import { addHistory, clearHistory } from '../state/history';
import type { NewHistoryRow } from '../state/history';
import { pushClientMessage, pushMessage } from '../state/messages';
import { itemClass } from '../state/style';
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

// --- Public API ---------------------------------------------------------------

export async function connect({ url, slot, password }: ConnectOptions): Promise<void> {
  teardown();
  clearHints();
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

  c.socket.on(
    'connected',
    safe((packet) => {
      selfTeam = packet.team;
      selfSlot = packet.slot;
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
    }),
  );

  // Live: every ItemSend is broadcast to the whole team, including finds that do not involve us.
  c.socket.on(
    'printJSON',
    safe((packet) => {
      if (!isCurrent() || packet.type !== 'ItemSend') return;
      const { item, receiving } = packet;
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

  const updatePoints = safe(() => {
    if (isCurrent() && c.authenticated) setHintPoints({ points: c.room.hintPoints, cost: c.room.hintCost });
  });
  c.room.on('hintPointsUpdated', updatePoints);
  c.room.on('hintCostUpdated', updatePoints);

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
    setIdentity({ name: c.name, game: c.game });
    pushClientMessage('client', `Connected as "${c.name}" (${c.game}).`);
    updatePoints();

    const people = buildPeople(c, selfTeam);
    const slots = [...people.keys()].filter((id) => id > 0).sort((a, b) => a - b);
    setRoster(
      slots.map((id) => ({ slot: id, name: people.get(id)!.name, game: people.get(id)!.game, isMe: id === selfSlot })),
    );
    void loadHints(c, selfTeam, selfSlot, slots, isCurrent);
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

/** A location belongs to exactly one slot, so (finder, location) identifies a hint. */
function hintId(hint: API.NetworkHint): string {
  return `${hint.finding_player}-${hint.location}`;
}


interface PlayerInfo {
  name: string;
  game: string;
}

/**
 * Build a slot -> name/game lookup once per rebuild. Aliases come from the player list;
 * slot_info covers every slot (including item links and groups) and gives the game, which
 * is required to resolve item and location names.
 */
function buildPeople(c: Client, team: number): Map<number, PlayerInfo> {
  const people = new Map<number, PlayerInfo>();
  for (const [slot, info] of Object.entries(c.players.slots)) {
    people.set(Number(slot), { name: info.name, game: info.game });
  }
  try {
    // `teams` rebuilds every Player object on each access, so read it once.
    for (const player of c.players.teams[team] ?? []) {
      try {
        people.set(player.slot, { name: player.alias, game: player.game });
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
    people.get(slot) ?? { name: slot === 0 ? 'Archipelago' : `Slot ${slot}`, game: 'Archipelago' };
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
