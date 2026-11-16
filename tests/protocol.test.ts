// End-to-end tests of the Archipelago connection (src/adapter/archipelago.ts) against a mock
// Archipelago server that speaks the real protocol. Run with `bun test`.
//
// What they cover: login, the message log, hints for the whole room, the History tab's data
// (backfill, live finds, caps, reconnect policy), the Stats tab's data (checks, received and sent
// items, player status, room info) and the error paths (refusal, drop mid-login, unreachable).
//
// The tests in this file build on each other: one connection is carried from test to test, the
// way a real session goes, so they must run in file order (bun does that) and `.only` / `.skip`
// will break the ones after them.
//
// The mock follows the upstream MultiServer.py behavior that matters here:
//   - Connected, the full ReceivedItems sync and the join message arrive in ONE websocket message
//   - `Get` echoes the request's `uuid` back in `Retrieved`
//   - hints are stored under BOTH players a hint involves, and every update is that slot's full list
//   - LocationScouts is answered with `LocationInfo`, where `player` is the item's receiver
//
// Waiting: tests poll for the state they expect (`until`) instead of sleeping. For "this must NOT
// happen" checks they send an event that DOES count right after, wait for that, and only then
// assert. Messages are handled in order, so the earlier one has certainly been processed.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { connect, disconnect, sendText } from '../src/adapter/archipelago';
import { hintPoints, identity, roster, status } from '../src/state/connection';
import { hints } from '../src/state/hints';
import { history } from '../src/state/history';
import { messages } from '../src/state/messages';
import { checks, clientStatuses, findsSeen, received, room, sent } from '../src/state/stats';
import { TRACKER_LAG_MS } from '../src/state/historyStore';
import { clock } from '../src/state/timing';
import { publishTrackerFinds } from '../src/state/tracker';
import { until, wait } from './helpers';

setDefaultTimeout(60_000);

// --------------------------------------------------------------------------- the mock server

const version = { major: 0, minor: 6, build: 9, class: 'Version' };
const gameData = {
  'Test Game': {
    item_name_to_id: { Sword: 1, Key: 2 },
    location_name_to_id: { 'Chest A': 10, 'Chest B': 11, 'Chest C': 12, 'Chest D': 13 },
    checksum: 'abc',
  },
};
let seed = 'seed-one';
const clientStatusFor: Record<number, number> = { 1: 20, 2: 30, 3: 0 };

// Three hints among three slots. Each is stored under BOTH players it involves, like the real server.
const hintA = (hintStatus: number) => ({
  receiving_player: 1, finding_player: 2, location: 11, item: 2, found: false, entrance: '', item_flags: 2, status: hintStatus,
});
const hintB = { receiving_player: 2, finding_player: 1, location: 10, item: 1, found: false, entrance: 'Cave', item_flags: 1, status: 0 };
const hintC = { receiving_player: 2, finding_player: 3, location: 12, item: 2, found: false, entrance: '', item_flags: 0, status: 0 };
const statusA: Record<number, number> = { 1: 30, 2: 30 };
const hintsFor = (slot: number): unknown[] =>
  slot === 1 ? [hintA(statusA[1]), hintB] : slot === 2 ? [hintA(statusA[2]), hintB, hintC] : slot === 3 ? [hintC] : [];

// What is in this slot's locations (what the real server knows). `player` is who the item is for.
const myLocations: Record<number, { item: number; player: number; flags: number }> = {
  10: { item: 1, player: 2, flags: 1 }, // sent to Bob, progression
  11: { item: 2, player: 1, flags: 2 }, // stayed in our own world
  12: { item: 1, player: 3, flags: 4 }, // sent to Carol, a trap
};
let connectedChecked: number[] = [10];
let connectedMissing: number[] = [11, 12];
/** More items in Alice's full sync, as if received while the client was away. */
let extraReceived: { item: number; location: number; player: number; flags: number }[] = [];
const scoutRequests: { locations: number[]; createAsHint: unknown }[] = [];
const rangeFrom = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i);

type Socket = { send(data: string): void };
const sockets = new Set<Socket>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (ws: Socket, ...packets: any[]) => ws.send(JSON.stringify(packets));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const broadcast = (...packets: any[]) => {
  for (const ws of sockets) send(ws, ...packets);
};
const itemSend = (finder: number, receiver: number, item: number, location: number, flags = 0) => ({
  cmd: 'PrintJSON',
  type: 'ItemSend',
  receiving: receiver,
  item: { item, location, player: finder, flags },
  data: [
    { type: 'player_id', text: String(finder) },
    { text: ' sent ' },
    { type: 'item_id', text: String(item), flags, player: receiver },
    { text: ' to ' },
    { type: 'player_id', text: String(receiver) },
    { text: ' (' },
    { type: 'location_id', text: String(location), player: finder },
    { text: ')' },
  ],
});

const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    srv.upgrade(req);
    return undefined;
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      send(ws, {
        cmd: 'RoomInfo', version, generator_version: version, tags: [], password: false,
        permissions: { release: 7, collect: 2, remaining: 1 }, hint_cost: 10, location_check_points: 1,
        games: ['Test Game'], datapackage_checksums: { 'Test Game': 'abc' }, seed_name: seed, time: Date.now() / 1000,
      });
    },
    close(ws) {
      sockets.delete(ws);
    },
    message(ws, raw) {
      for (const p of JSON.parse(String(raw))) {
        if (p.cmd === 'GetDataPackage') {
          send(ws, { cmd: 'DataPackage', data: { games: gameData } });
        } else if (p.cmd === 'Connect') {
          if (p.name === 'Drop') {
            ws.close();
            continue;
          }
          if (p.name !== 'Alice' && p.name !== 'Bob') {
            send(ws, { cmd: 'ConnectionRefused', errors: ['InvalidSlot'] });
            continue;
          }
          send(
            ws,
            {
              cmd: 'Connected', team: 0, slot: p.name === 'Bob' ? 2 : 1, // Bob only for the per-slot History test
              players: [
                { team: 0, slot: 1, alias: 'Alice', name: 'Alice' },
                { team: 0, slot: 2, alias: 'Bob', name: 'Bob' },
                { team: 0, slot: 3, alias: 'Carol', name: 'Carol' },
              ],
              missing_locations: connectedMissing, checked_locations: connectedChecked, slot_data: {},
              slot_info: {
                1: { name: 'Alice', game: 'Test Game', type: 1, group_members: [] },
                2: { name: 'Bob', game: 'Test Game', type: 1, group_members: [] },
                3: { name: 'Carol', game: 'Test Game', type: 1, group_members: [] },
              },
              hint_points: 5,
            },
            // Key found by Bob for Alice (a real find), plus a starting item granted by the server (location -2).
            {
              cmd: 'ReceivedItems', index: 0,
              items: [{ item: 2, location: 11, player: 2, flags: 2 }, { item: 1, location: -2, player: 0, flags: 0 }, ...extraReceived],
            },
            { cmd: 'PrintJSON', type: 'Join', team: 0, slot: 1, tags: ['TextOnly'], data: [{ type: 'player_id', text: '1' }, { text: ' (Team #1) viewing.' }] },
            itemSend(2, 1, 1, 10, 1),
            { cmd: 'PrintJSON', type: 'CommandResult', data: [{ type: 'color', color: 'red;bold', text: 'Oops' }] },
            { cmd: 'PrintJSON', data: [{ text: 'untyped message' }] },
          );
        } else if (p.cmd === 'Get') {
          const keys: Record<string, unknown> = {};
          for (const key of p.keys as string[]) {
            const slot = Number(key.split('_').pop());
            keys[key] = key.startsWith('_read_hints_')
              ? hintsFor(slot)
              : key.startsWith('_read_client_status_')
                ? (clientStatusFor[slot] ?? 0)
                : null;
          }
          send(ws, { cmd: 'Retrieved', keys, uuid: p.uuid });
        } else if (p.cmd === 'LocationScouts') {
          scoutRequests.push({ locations: p.locations, createAsHint: p.create_as_hint });
          send(ws, {
            cmd: 'LocationInfo',
            locations: (p.locations as number[]).map((location) => ({
              item: myLocations[location]?.item ?? 1,
              location,
              player: myLocations[location]?.player ?? 2, // for locations the mock does not know: an item for Bob
              flags: myLocations[location]?.flags ?? 0,
            })),
          });
        } else if (p.cmd === 'Say') {
          send(ws, {
            cmd: 'PrintJSON', type: 'Chat', team: 0, slot: 1, message: p.text,
            data: [{ type: 'player_id', text: '1' }, { text: `: ${p.text}` }],
          });
        }
      }
    },
  },
});
afterAll(() => {
  server.stop(true);
});

// --------------------------------------------------------------------------- helpers

/** The log as one string per message, e.g. `[item] {p-other|Bob} sent ...` (`{class|text}` marks styled spans). */
const dump = () =>
  messages().map((m) => `[${m.category}] ` + m.spans.map((s) => (s.cls ? `{${s.cls}|${s.text}}` : s.text)).join(''));
const hist = () => history();
const url = `ws://127.0.0.1:${server.port}`;
const loginAsAlice = () => connect({ url, slot: 'Alice', password: '' });

/** Everything that arrives after a login (hints, statuses, the sent-items backfill) has landed. */
const settledAfterLogin = (extra: () => boolean = () => true) =>
  until(
    () =>
      status() === 'connected' &&
      hints().length === 3 &&
      sent() !== undefined &&
      Object.keys(clientStatuses()).length === 3 &&
      extra(),
    10_000,
  );

// --------------------------------------------------------------------------- tests

describe('login and the log', () => {
  test('logs in as a text client', async () => {
    await loginAsAlice();
    expect(
      await settledAfterLogin(
        () => hist().length === 3 && findsSeen() === 1 && dump().some((l) => l.includes('untyped message')),
      ),
    ).toBe(true);
    expect(identity()).toMatchObject({ name: 'Alice', game: 'Test Game' });
    expect(hintPoints()?.points).toBe(5);
  });

  test('tags and styles the messages', () => {
    const lines = dump();
    expect(lines.find((l) => l.startsWith('[join]'))).toContain('{p-self|Alice}');
    const item = lines.find((l) => l.startsWith('[item]'));
    expect(item).toContain('{p-other|Bob}');
    expect(item).toContain('{item-prog|Sword}');
    expect(item).toContain('{loc|Chest A}');
    expect(lines.join('\n')).toContain('{c-red c-bold|Oops}'); // several color codes in one part
    expect(lines.find((l) => l.includes('untyped message'))).toMatch(/^\[system\]/);
  });
});

describe('hints for the whole room', () => {
  test('lists every slot in the roster', () => {
    expect(roster()).toHaveLength(3);
    expect(roster().filter((r) => r.isMe).map((r) => r.name)).toEqual(['Alice']);
    expect(roster().every((r) => r.isGroup === false)).toBe(true);
  });

  test('merges the two copies of each hint into 3 hints', () => {
    expect(hints()).toHaveLength(3);
  });

  test('resolves names for a hint that involves me', () => {
    expect(hints().find((r) => r.locationName === 'Chest B')).toMatchObject({
      itemName: 'Key', finderName: 'Bob', receiverName: 'Alice', forMe: true, status: 30,
    });
  });

  test('includes a hint that does not involve me', () => {
    expect(hints().find((r) => r.locationName === 'Chest C')).toMatchObject({
      finderName: 'Carol', receiverName: 'Bob', forMe: false, fromMe: false,
    });
  });
});

describe('stats from login', () => {
  test('checks come from the Connected packet', () => {
    expect(checks()).toEqual({ checked: 1, total: 3, sessionChecks: 0 });
  });

  test('hint points include the points earned per check', () => {
    expect(hintPoints()).toMatchObject({ points: 5, perCheck: 1 });
  });

  test('room info and permissions', () => {
    expect(room()).toMatchObject({
      serverVersion: '0.6.9', seed: 'seed-one', games: ['Test Game'], hintCostPercent: 10,
      permissions: { release: 7, collect: 2, remaining: 1 },
    });
  });

  test('received items include the starting item, counted by sender (the server is slot 0)', () => {
    expect(received()).toMatchObject({ total: 2, useful: 1, filler: 1, progression: 0 });
    expect(received()?.bySender).toEqual({ 0: 1, 2: 1 });
  });

  test('player statuses are loaded', () => {
    expect(clientStatuses()).toEqual({ 1: 20, 2: 30, 3: 0 });
  });

  test('finds seen are counted', () => {
    expect(findsSeen()).toBe(1);
  });
});

describe('history: backfill and live', () => {
  test('has the received find, the live one and the item I sent, and skips the starting item', () => {
    expect(hist().map((r) => r.id).sort()).toEqual(['1-10', '2-10', '2-11']);
  });

  test('the item I sent is backfilled from my checked locations: Sword from me to Bob', () => {
    expect(hist().find((r) => r.id === '1-10')).toMatchObject({
      itemName: 'Sword', finderName: 'Alice', receiverName: 'Bob', itemFlags: 1, fromMe: true, forMe: false,
    });
  });

  test('backfilled row: Key from Bob to me', () => {
    expect(hist().find((r) => r.id === '2-11')).toMatchObject({ itemName: 'Key', finderName: 'Bob', forMe: true });
  });

  test('live row: names, flags and the time it was seen', () => {
    const row = hist().find((r) => r.id === '2-10')!;
    expect(row).toMatchObject({ itemName: 'Sword', locationName: 'Chest A', receiverName: 'Alice', itemFlags: 1, timeKind: 'exact' });
    expect(Math.abs(row.time - Date.now())).toBeLessThan(60_000);
    expect(row.timeLabel).not.toBe('earlier');
  });

  test('on the first connect to a room, what came before has no known time and sorts first', () => {
    for (const id of ['2-11', '1-10']) {
      expect(hist().find((r) => r.id === id)).toMatchObject({ timeKind: 'unknown', timeLabel: 'earlier' });
    }
    expect(hist().map((r) => r.id)).toEqual(['2-11', '1-10', '2-10']); // the History is kept in time order
  });

  test('records a find that does not involve me', async () => {
    const before = hist().length;
    broadcast(itemSend(3, 2, 2, 12, 0)); // Carol -> Bob
    expect(await until(() => hist().some((r) => r.id === '3-12'))).toBe(true);
    expect(hist().find((r) => r.id === '3-12')).toMatchObject({
      finderName: 'Carol', receiverName: 'Bob', forMe: false, fromMe: false,
    });
    expect(hist()).toHaveLength(before + 1);
  });

  test('an exact duplicate gives one row', async () => {
    const before = hist().length;
    broadcast(itemSend(3, 2, 2, 12, 0)); // the same find again
    broadcast(itemSend(3, 2, 1, 900, 0)); // then a new one, to know the duplicate was handled
    expect(await until(() => hist().some((r) => r.id === '3-900'))).toBe(true);
    expect(hist()).toHaveLength(before + 1); // only the new one was added
  });

  test('a ReceivedItems packet with index > 0 is not a find', async () => {
    const before = hist().length;
    broadcast({ cmd: 'ReceivedItems', index: 2, items: [{ item: 1, location: 13, player: 3, flags: 0 }] });
    broadcast(itemSend(3, 2, 1, 901, 0)); // a real find after it
    expect(await until(() => hist().some((r) => r.id === '3-901'))).toBe(true);
    expect(hist().some((r) => r.id === '3-13')).toBe(false);
    expect(hist()).toHaveLength(before + 1);
  });
});

describe('stats: live updates', () => {
  test('a RoomUpdate adds only the checks we did not have', async () => {
    broadcast({ cmd: 'RoomUpdate', checked_locations: [11, 10] }); // one new, one we already had
    expect(await until(() => checks()?.checked === 2)).toBe(true);
    expect(checks()).toEqual({ checked: 2, total: 3, sessionChecks: 1 });
  });

  test('a repeated check is not counted twice', async () => {
    broadcast({ cmd: 'RoomUpdate', checked_locations: [11] }); // repeated
    broadcast({ cmd: 'RoomUpdate', checked_locations: [12] }); // new, so we know the repeat was handled
    expect(await until(() => checks()?.checked === 3)).toBe(true);
    expect(checks()).toEqual({ checked: 3, total: 3, sessionChecks: 2 });
  });

  test('later ReceivedItems packets add by position', async () => {
    // Position 2 already holds an item (an earlier test sent one), so this rewrites it as a trap.
    broadcast({ cmd: 'ReceivedItems', index: 2, items: [{ item: 1, location: 13, player: 3, flags: 4 }] });
    expect(await until(() => received()?.trap === 1)).toBe(true);
    expect(received()).toMatchObject({ total: 3, trap: 1 });
    expect(received()?.bySender[3]).toBe(1);
  });

  test('a resent packet is not counted twice', async () => {
    broadcast({ cmd: 'ReceivedItems', index: 2, items: [{ item: 1, location: 13, player: 3, flags: 4 }] }); // resent
    broadcast({ cmd: 'ReceivedItems', index: 3, items: [{ item: 1, location: 14, player: 2, flags: 0 }] }); // a new one after it
    expect(await until(() => received()?.total === 4)).toBe(true);
    expect(received()).toMatchObject({ total: 4, trap: 1 }); // the resent trap was not counted again
  });

  test('index 0 starts the list over', async () => {
    broadcast({ cmd: 'ReceivedItems', index: 0, items: [{ item: 2, location: 11, player: 2, flags: 2 }, { item: 1, location: -2, player: 0, flags: 0 }] });
    expect(await until(() => received()?.total === 2)).toBe(true);
    expect(received()).toMatchObject({ total: 2, trap: 0 });
  });

  test('a player status change arrives live', async () => {
    clientStatusFor[3] = 5;
    broadcast({ cmd: 'SetReply', key: '_read_client_status_0_3', value: 5, original_value: 0, slot: 3 });
    expect(await until(() => clientStatuses()[3] === 5)).toBe(true);
  });

  test('a RoomUpdate refreshes the permissions and hint cost but keeps the rest', async () => {
    broadcast({ cmd: 'RoomUpdate', permissions: { release: 0, collect: 0, remaining: 0 }, hint_cost: 25 });
    expect(await until(() => room()?.hintCostPercent === 25)).toBe(true);
    expect(room()).toMatchObject({ seed: 'seed-one', permissions: { release: 0, collect: 0, remaining: 0 } });
  });
});

describe('sending and live hint updates', () => {
  test('a "/" command stays on this machine', async () => {
    expect(sendText('/received')).toBe('client-command');
    expect(sendText('!hint Key')).toBe('sent');
    expect(await until(() => dump().some((l) => l.startsWith('[chat]') && l.includes('!hint Key')))).toBe(true);
    expect(dump().some((l) => l.startsWith('[chat]') && l.includes('/received'))).toBe(false);
  });

  test("the receiver's copy of a hint wins over a stale finder-side copy", async () => {
    statusA[1] = 10; // only the receiver's list carries the new status
    broadcast({ cmd: 'SetReply', key: '_read_hints_0_1', value: hintsFor(1), original_value: [], slot: 1 });
    expect(await until(() => hints().find((r) => r.locationName === 'Chest B')?.status === 10)).toBe(true);
  });

  test('an update to a hint that does not involve me arrives', async () => {
    hintC.status = 20;
    broadcast(
      { cmd: 'SetReply', key: '_read_hints_0_2', value: hintsFor(2), original_value: [], slot: 2 },
      { cmd: 'SetReply', key: '_read_hints_0_3', value: hintsFor(3), original_value: [], slot: 3 },
    );
    expect(await until(() => hints().find((r) => r.locationName === 'Chest C')?.status === 20)).toBe(true);
  });

  test('hint rows that did not change keep their identity', async () => {
    const before = hints().find((r) => r.locationName === 'Chest A');
    hintC.status = 30; // a change elsewhere, so we know the update was handled
    broadcast(
      { cmd: 'SetReply', key: '_read_hints_0_1', value: hintsFor(1), original_value: [], slot: 1 },
      { cmd: 'SetReply', key: '_read_hints_0_2', value: hintsFor(2), original_value: [], slot: 2 },
      { cmd: 'SetReply', key: '_read_hints_0_3', value: hintsFor(3), original_value: [], slot: 3 },
    );
    expect(await until(() => hints().find((r) => r.locationName === 'Chest C')?.status === 30)).toBe(true);
    expect(hints().find((r) => r.locationName === 'Chest A')).toBe(before);
  });
});

describe('a burst of finds (like !release)', () => {
  test('records all 2000, in order', async () => {
    const before = hist().length;
    const burst = [];
    for (let i = 0; i < 2000; i++) burst.push(itemSend(3, 2, (i % 2) + 1, 1000 + i, i % 5 === 0 ? 1 : 0));
    broadcast(...burst);
    expect(await until(() => hist().length === before + 2000, 15_000)).toBe(true);
    // The burst keeps the order it was sent in, and the History stays in time order.
    const burstIds = hist().filter((r) => r.finderSlot === 3 && r.locationId >= 1000 && r.locationId < 3000).map((r) => r.id);
    expect(burstIds).toEqual(burst.map((_, i) => `3-${1000 + i}`));
    expect(hist().every((r, i) => i === 0 || r.time >= hist()[i - 1].time)).toBe(true);
  });
});

describe('reconnecting', () => {
  let historyBefore = 0;

  test('disconnecting closes the connection and keeps the history', () => {
    historyBefore = hist().length;
    disconnect();
    expect(status()).toBe('closed');
    expect(hist()).toHaveLength(historyBefore);
  });

  test('the same seed and slot keeps the history, and the backfill is not duplicated', async () => {
    await loginAsAlice();
    expect(await settledAfterLogin()).toBe(true);
    expect(hist()).toHaveLength(historyBefore);
  });

  test('stats are rebuilt, with nothing left over from the old connection', () => {
    expect(checks()).toEqual({ checked: 1, total: 3, sessionChecks: 0 });
    expect(received()).toMatchObject({ total: 2, trap: 0 });
    expect(clientStatuses()[3]).toBe(5); // what the mock server reports now
    expect(room()).toMatchObject({ permissions: { release: 7, collect: 2, remaining: 1 }, hintCostPercent: 10 });
  });

  test('a different seed clears the history, then rebuilds it from the new sync', async () => {
    disconnect();
    await wait(50);
    seed = 'seed-two';
    await loginAsAlice();
    expect(await settledAfterLogin(() => hist().length === 3)).toBe(true);
    expect(hist().map((r) => r.id)).toEqual(['2-11', '1-10', '2-10']);
    expect(hist().map((r) => r.seq).sort()).toEqual([1, 2, 3]); // the numbering restarts at 1
  });
});

describe('history: kept between runs, and gaps filled', () => {
  const mineFromBob = { finder: 2, receiver: 1, location: 11, item: 2, flags: 2 };
  const sentToBob = { finder: 1, receiver: 2, location: 10, item: 1, flags: 1 };
  const timesOf = () => hist().map((r) => ({ id: r.id, time: r.time, timeKind: r.timeKind }));

  test('the History is saved per room and comes back, with names, when that room is joined again', async () => {
    const before = timesOf();
    disconnect();
    await wait(50);
    seed = 'seed-three';
    await loginAsAlice();
    expect(await settledAfterLogin(() => hist().length === 3)).toBe(true);
    // Another room: the same mock items, but its own History, seen live just now.
    expect(hist().find((r) => r.id === '2-10')!.time).toBeGreaterThan(before.find((r) => r.id === '2-10')!.time);

    disconnect();
    await wait(50);
    seed = 'seed-two';
    await loginAsAlice();
    expect(await settledAfterLogin(() => hist().length === before.length)).toBe(true);
    expect(timesOf()).toEqual(before);
    expect(hist().find((r) => r.id === '2-10')).toMatchObject({ itemName: 'Sword', finderName: 'Bob', receiverName: 'Alice' });
  });

  test('another slot in the same room has its own History, with its own items marked as its own', async () => {
    const aliceRows = hist().length;
    disconnect();
    await wait(50);
    await connect({ url, slot: 'Bob', password: '' });
    // As Bob: his own received item and the one seen live as he connected (he found it for Alice).
    expect(await settledAfterLogin(() => hist().length === 2)).toBe(true);
    expect(hist().find((r) => r.id === '2-10')).toMatchObject({ fromMe: true, forMe: false });

    disconnect();
    await wait(50);
    await loginAsAlice();
    expect(await settledAfterLogin(() => hist().length === aliceRows)).toBe(true);
    expect(hist().find((r) => r.id === '2-10')).toMatchObject({ fromMe: false, forMe: true });
  });

  test("finds made while away are placed in that gap, each receiver's list in its real order", async () => {
    // The clock is set so the gap is exact. It is ahead of the real one, so it never overlaps a
    // connection made earlier in this file.
    let now = Date.now() + 1_000_000;
    clock.now = () => now;
    try {
      // A connection at a known time, and a tracker import that matches this room and is new
      // enough to cover it: from then on the whole team's History is complete.
      disconnect();
      await wait(50);
      await loginAsAlice();
      expect(await settledAfterLogin()).toBe(true);
      now += TRACKER_LAG_MS + 1000;
      publishTrackerFinds([[mineFromBob], [sentToBob]]);
      now += 1000;
      const leftAt = now;
      disconnect();
      await wait(50);

      // A minute away. Carol found something for Alice, which Alice's own item sync reports...
      now += 60_000;
      extraReceived = [{ item: 1, location: 12, player: 3, flags: 0 }];
      await loginAsAlice();
      expect(await settledAfterLogin(() => hist().some((r) => r.id === '3-12'))).toBe(true);
      const row = (id: string) => hist().find((r) => r.id === id);
      expect(row('3-12')).toMatchObject({ timeKind: 'estimated', time: leftAt + 30_000, finderName: 'Carol' });
      expect(row('3-12')!.timeLabel.startsWith('≈')).toBe(true);

      // ...and two things for Bob, which only the tracker knows. They go in the same gap, in Bob's order.
      publishTrackerFinds([
        [mineFromBob, { finder: 3, receiver: 1, location: 12, item: 1, flags: 0 }],
        [sentToBob, { finder: 3, receiver: 2, location: 70, item: 1, flags: 0 }, { finder: 3, receiver: 2, location: 71, item: 2, flags: 0 }],
      ]);
      expect(await until(() => row('3-71') !== undefined)).toBe(true);
      expect(row('3-70')).toMatchObject({ timeKind: 'estimated', time: leftAt + 15_000, receiverName: 'Bob' });
      expect(row('3-71')).toMatchObject({ timeKind: 'estimated', time: leftAt + 45_000, receiverName: 'Bob' });
      expect(row('3-12')).toMatchObject({ time: leftAt + 30_000 }); // placed again by the tracker: the same

      const times = hist().map((r) => r.time);
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    } finally {
      clock.now = () => Date.now();
      extraReceived = [];
      publishTrackerFinds([]);
    }
  });
});

describe('items sent', () => {
  test('is backfilled from the checked locations: one item for Bob, progression', () => {
    expect(sent()).toEqual({ total: 1, progression: 1, useful: 0, trap: 0, filler: 0 });
  });

  test('only CHECKED locations are ever asked about, and no hints are created', () => {
    const last = scoutRequests[scoutRequests.length - 1];
    expect(last.locations).toEqual([10]);
    expect(last.createAsHint).toBe(0);
    for (const request of scoutRequests) expect(request.locations).toEqual([10]);
  });

  test('an unsolicited answer for an unchecked location is ignored', async () => {
    broadcast({ cmd: 'LocationInfo', locations: [{ item: 1, location: 13, player: 3, flags: 4 }] }); // 13 is not checked
    broadcast(itemSend(1, 3, 1, 12, 4)); // then a real send from our world: a trap for Carol
    expect(await until(() => sent()?.total === 2)).toBe(true);
    expect(sent()).toMatchObject({ total: 2, progression: 1, trap: 1 }); // a counted 13 would make two traps
  });

  test('a repeated ItemSend is not counted twice', async () => {
    broadcast(itemSend(1, 3, 1, 12, 4)); // the same one again
    broadcast(itemSend(1, 2, 1, 15, 0)); // then a new one
    expect(await until(() => sent()?.total === 3)).toBe(true);
    expect(sent()).toMatchObject({ total: 3, trap: 1, filler: 1 });
  });

  test("items kept for ourselves and other players' finds are not counted", async () => {
    broadcast(itemSend(1, 1, 2, 11, 2)); // found our own item: it stays in our world
    broadcast(itemSend(2, 1, 2, 13, 0)); // Bob found something for us: that is "received"
    broadcast(itemSend(3, 2, 1, 14, 0)); // two other players
    broadcast(itemSend(1, 2, 2, 16, 0)); // then one that does count
    expect(await until(() => sent()?.total === 4)).toBe(true);
    expect(sent()).toMatchObject({ total: 4, filler: 2 });
  });

  test('is reset and rebuilt from the checked locations on reconnect', async () => {
    disconnect();
    await wait(50);
    await loginAsAlice();
    expect(await settledAfterLogin()).toBe(true);
    expect(sent()).toEqual({ total: 1, progression: 1, useful: 0, trap: 0, filler: 0 });
  });

  test('an item sent while this client was disconnected is in History after reconnecting', async () => {
    disconnect();
    await wait(50);
    // We checked location 20 (an item for Bob) through another client while the text client was away,
    // so no live ItemSend for it was ever seen here.
    myLocations[20] = { item: 2, player: 2, flags: 2 };
    connectedChecked = [10, 20];
    try {
      await loginAsAlice();
      expect(await settledAfterLogin(() => hist().some((r) => r.id === '1-20'))).toBe(true);
      expect(hist().find((r) => r.id === '1-20')).toMatchObject({
        finderName: 'Alice', receiverName: 'Bob', itemName: 'Key', itemFlags: 2, fromMe: true, forMe: false,
        timeKind: 'estimated', // our own items are complete from the last connection, so it lies after that
      });
      expect(hist().filter((r) => r.id === '1-10')).toHaveLength(1); // the one already there is not duplicated
    } finally {
      delete myLocations[20];
      connectedChecked = [10];
    }
  });

  test('a lot of checked locations are scouted in packets of at most 2000', async () => {
    disconnect();
    await wait(50);
    connectedChecked = rangeFrom(4500, 2000);
    connectedMissing = [];
    scoutRequests.length = 0;
    try {
      await loginAsAlice();
      expect(await settledAfterLogin(() => sent()?.total === 4500)).toBe(true);
      expect(scoutRequests.map((r) => r.locations.length)).toEqual([2000, 2000, 500]);
      for (const request of scoutRequests) expect(request.createAsHint).toBe(0);
      expect(sent()).toMatchObject({ total: 4500, filler: 4500 });
      expect(checks()).toEqual({ checked: 4500, total: 4500, sessionChecks: 0 });
    } finally {
      // Whatever happened, the tests after this one expect the normal mock room.
      connectedChecked = [10];
      connectedMissing = [11, 12];
    }
  });
});

describe('history: backfill from the website tracker', () => {
  // The tracker lists every player's received items, so it knows finds between other players that
  // were made while this client was away. It is only trusted when what it says Alice received
  // matches what the game connection told us she received (location 11, from Bob).
  const mineFromBob = { finder: 2, receiver: 1, location: 11, item: 2, flags: 2 };
  const bobGotSwordFromCarol = { finder: 3, receiver: 2, location: 50, item: 1, flags: 1 };

  test('adds finds that do not involve me, with names and flags, and does not duplicate the ones I know', async () => {
    publishTrackerFinds([[mineFromBob], [bobGotSwordFromCarol]]);
    expect(await until(() => hist().some((r) => r.id === '3-50'))).toBe(true);
    expect(hist().find((r) => r.id === '3-50')).toMatchObject({
      finderName: 'Carol', receiverName: 'Bob', itemName: 'Sword', itemFlags: 1, forMe: false, fromMe: false,
    });
    expect(hist().filter((r) => r.id === '2-11')).toHaveLength(1);
  });

  test('a tracker that disagrees with what I received is ignored (it is another room)', async () => {
    publishTrackerFinds([
      [{ finder: 2, receiver: 1, location: 999, item: 1, flags: 0 }], // I never received this
      [{ finder: 3, receiver: 2, location: 998, item: 1, flags: 0 }],
    ]);
    publishTrackerFinds([[mineFromBob], [{ finder: 3, receiver: 2, location: 51, item: 1, flags: 0 }]]); // then a good one
    expect(await until(() => hist().some((r) => r.id === '3-51'))).toBe(true);
    expect(hist().some((r) => r.id === '3-998' || r.id === '2-999')).toBe(false);
  });

  test('a repeat poll adds only what is new', async () => {
    const before = hist().length;
    publishTrackerFinds([[mineFromBob], [bobGotSwordFromCarol, { finder: 3, receiver: 2, location: 52, item: 1, flags: 0 }]]);
    expect(await until(() => hist().some((r) => r.id === '3-52'))).toBe(true);
    expect(hist().length).toBe(before + 1);
  });

  test('finds loaded before connecting are applied once connected', async () => {
    disconnect();
    await wait(50);
    publishTrackerFinds([[mineFromBob], [{ finder: 3, receiver: 2, location: 53, item: 1, flags: 0 }]]);
    await loginAsAlice();
    expect(await settledAfterLogin(() => hist().some((r) => r.id === '3-53'))).toBe(true);
    publishTrackerFinds([]);
  });
});

describe('the history cap', () => {
  test('keeps about 20000 rows and drops the oldest first', async () => {
    disconnect();
    await wait(50);
    await loginAsAlice();
    expect(await settledAfterLogin()).toBe(true);

    const flood = [];
    for (let i = 0; i < 22000; i++) flood.push(itemSend(3, 2, 1, 100000 + i));
    for (let i = 0; i < flood.length; i += 2000) broadcast(...flood.slice(i, i + 2000));
    expect(await until(() => hist().some((r) => r.id === '3-121999') && hist().length <= 21000, 20_000)).toBe(true);

    expect(hist().length).toBeGreaterThanOrEqual(20000);
    expect(hist().some((r) => r.id === '2-11')).toBe(false); // the oldest row is gone
  });
});

describe('errors', () => {
  test('a refused login is reported and closes quickly', async () => {
    disconnect();
    await wait(50);
    const started = performance.now();
    await connect({ url, slot: 'Nobody', password: '' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(status()).toBe('closed');
    expect(await until(() => dump().some((l) => l.startsWith('[error]') && l.includes('InvalidSlot')))).toBe(true);
  });

  test('a connection dropped mid-login does not wait for the library timeout, and is reported once', async () => {
    const started = performance.now();
    await connect({ url, slot: 'Drop', password: '' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(status()).toBe('closed');
    expect(await until(() => dump().some((l) => l.includes('Disconnected from server.')))).toBe(true);
    expect(dump().filter((l) => l.includes('Disconnected from server.'))).toHaveLength(1);
  });

  test('an unreachable server is reported with the real reason', async () => {
    await connect({ url: 'ws://127.0.0.1:1', slot: 'Alice', password: '' });
    expect(status()).toBe('closed');
    expect(await until(() => dump()[dump().length - 1]?.includes('Failed to connect') === true)).toBe(true);
  });
});
