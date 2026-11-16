// Tests for the website code (src/adapter/tracker.ts, src/state/tracker.ts): the link parser, the
// room details mapping, the per-game aggregation, the wrong-room guards, and the fetch/poll flow
// against a mock website. Run with `bun test`.
//
// The fixtures are shaped like the real WebHost responses (see WebHostLib/api/tracker.py and
// WebHostLib/api/room.py in the Archipelago repo): /api/room_status/<id>, /api/static_tracker/<id>
// and /api/tracker/<id>.
//
// The fetch/poll tests build on each other (they share one mock website and the module-level
// state), so they must run in file order; do not use `.only` / `.skip` on them.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  completionByGame,
  chainsOf,
  leanStatic,
  parseSiteLink,
  refreshSite,
  refreshTracker,
  sameOriginHttpUrl,
  slotsOf,
  startSite,
  startTracker,
  stopSite,
  stopTracker,
  timing,
  toWebsiteRoom,
} from '../src/adapter/tracker';
import {
  completion,
  getTrackerFinds,
  portMatches,
  rosterMatchesTracker,
  roomError,
  roomStatus,
  slotsOfRoom,
  trackerError,
  trackerSlots,
  trackerStatus,
  trackerUpdated,
  websiteRoom,
} from '../src/state/tracker';
import { portFromAddress } from '../src/state/connection';
import { until, wait } from './helpers';

setDefaultTimeout(30_000);

// --------------------------------------------------------------------------- fixtures

const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

const staticPayload = () => ({
  groups: [{ slot: 4, name: 'Links', members: [1, 2] }],
  datapackage: { games: { Alpha: { filler: 'x'.repeat(200000) } } }, // the real one is huge
  player_locations_total: [
    { team: 0, player: 1, total_locations: 100 },
    { team: 0, player: 2, total_locations: 50 },
    { team: 0, player: 3, total_locations: 200 },
    { team: 0, player: 4, total_locations: 0 }, // item-link group
    { team: 0, player: 5, total_locations: 0 }, // a player with no locations
    { team: 1, player: 1, total_locations: 100 }, // another team
  ],
  player_game: [
    { team: 0, player: 1, game: 'Alpha' },
    { team: 0, player: 2, game: 'Alpha' },
    { team: 0, player: 3, game: 'Beta' },
    { team: 0, player: 4, game: 'Archipelago' },
    { team: 0, player: 5, game: 'Gamma' },
    { team: 1, player: 1, game: 'Alpha' },
  ],
});

const dynamicPayload = (playerChecksDone?: { team: number; player: number; locations: number[] }[]) => ({
  aliases: [], player_items_received: [{ team: 0, player: 1, items: [[7, 5, 2, 1]] }], hints: [], activity_timers: [], connection_timers: [], player_status: [], total_checks_done: [],
  player_checks_done: playerChecksDone ?? [
    { team: 0, player: 1, locations: range(30) },
    { team: 0, player: 2, locations: range(10) },
    { team: 0, player: 3, locations: range(50) },
    { team: 0, player: 4, locations: [] },
    { team: 0, player: 5, locations: [] },
    { team: 1, player: 1, locations: range(100) },
  ],
});

// --------------------------------------------------------------------------- link parser

describe('parseSiteLink', () => {
  test('reads a tracker link', () => {
    expect(parseSiteLink('https://archipelago.gg/tracker/ABC123')).toEqual({
      ok: true, kind: 'tracker', origin: 'https://archipelago.gg', id: 'ABC123',
    });
  });

  test('reads a room link (this used to be a problem; now it is how everything is found)', () => {
    expect(parseSiteLink('https://archipelago.gg/room/ROOMID')).toEqual({
      ok: true, kind: 'room', origin: 'https://archipelago.gg', id: 'ROOMID',
    });
  });

  test('ignores a trailing page, such as a game', () => {
    expect(parseSiteLink('https://archipelago.gg/tracker/ABC123/Hollow%20Knight')).toMatchObject({ ok: true, kind: 'tracker', id: 'ABC123' });
  });

  test('works for a local webhost with a port, and for the sphere tracker', () => {
    expect(parseSiteLink('http://localhost:5000/sphere_tracker/XYZ_-9')).toEqual({
      ok: true, kind: 'tracker', origin: 'http://localhost:5000', id: 'XYZ_-9',
    });
  });

  test('accepts API urls too', () => {
    expect(parseSiteLink('https://archipelago.gg/api/tracker/ABC')).toMatchObject({ ok: true, kind: 'tracker', id: 'ABC' });
    expect(parseSiteLink('https://archipelago.gg/api/room_status/ROOM')).toMatchObject({ ok: true, kind: 'room', id: 'ROOM' });
  });

  test('passes a full UUID through unchanged', () => {
    expect(parseSiteLink('https://archipelago.gg/room/123e4567-e89b-12d3-a456-426614174000')).toMatchObject({
      ok: true, kind: 'room', id: '123e4567-e89b-12d3-a456-426614174000',
    });
  });

  test('takes whichever kind of segment comes first', () => {
    expect(parseSiteLink('https://x.example/room/R1/tracker/T1')).toMatchObject({ kind: 'room', id: 'R1' });
    expect(parseSiteLink('https://x.example/tracker/T1/room/R1')).toMatchObject({ kind: 'tracker', id: 'T1' });
  });

  test('a link that ends at the keyword has no id, so it is invalid', () => {
    expect(parseSiteLink('https://archipelago.gg/room')).toEqual({ ok: false, problem: 'invalid' });
    expect(parseSiteLink('https://archipelago.gg/tracker/')).toEqual({ ok: false, problem: 'invalid' });
  });

  test('empty input is empty', () => {
    expect(parseSiteLink('   ')).toEqual({ ok: false, problem: 'empty' });
  });

  test('nonsense, a missing scheme and a wrong scheme are invalid', () => {
    for (const text of ['hello', 'archipelago.gg/tracker/ABC', 'ftp://x/tracker/ABC', 'https://archipelago.gg/']) {
      expect(parseSiteLink(text)).toEqual({ ok: false, problem: 'invalid' });
    }
  });
});

// --------------------------------------------------------------------------- the room's details (pure)

/** Shaped like the website's /api/room_status response (WebHostLib/api/room.py). */
const roomPayload = (over: Record<string, unknown> = {}) => ({
  tracker: 'TrackerId_-9',
  players: [['Alice', 'Game A'], ['Bob', 'Game B'], ['Carol', 'Game A']],
  last_port: 57380,
  last_activity: 'Sun, 15 Nov 2026 22:36:12 GMT', // how Flask serialises a datetime
  timeout: 7200,
  downloads: [
    { slot: 1, download: '/dl_patch/ROOM/11' },
    { slot: 3, download: '/download_slot_file/ROOM/3' },
  ],
  ...over,
});
const SITE = 'https://archipelago.gg';

describe('toWebsiteRoom', () => {
  test('maps the room: links, port, activity, timeout', () => {
    const room = toWebsiteRoom(SITE, 'ROOM', roomPayload());
    expect(room).toMatchObject({
      roomUrl: 'https://archipelago.gg/room/ROOM',
      trackerId: 'TrackerId_-9',
      trackerUrl: 'https://archipelago.gg/tracker/TrackerId_-9',
      lastPort: 57380,
      timeoutSeconds: 7200,
    });
    expect(room.lastActivity?.toISOString()).toBe('2026-11-15T22:36:12.000Z');
  });

  test('players get slot numbers from their position (the API has no ids): 1, 2, 3', () => {
    const room = toWebsiteRoom(SITE, 'ROOM', roomPayload());
    expect(room.players).toEqual([
      { slot: 1, name: 'Alice', game: 'Game A' },
      { slot: 2, name: 'Bob', game: 'Game B' },
      { slot: 3, name: 'Carol', game: 'Game A' },
    ]);
    expect(slotsOfRoom(room)).toEqual({ 1: 'Game A', 2: 'Game B', 3: 'Game A' });
  });

  test('a malformed player entry keeps its place, so the ones after it keep the right slot', () => {
    const room = toWebsiteRoom(SITE, 'ROOM', roomPayload({ players: [['Alice', 'Game A'], 'oops', ['Carol', 'Game A']] }));
    expect(room.players.map((p) => [p.slot, p.name])).toEqual([[1, 'Alice'], [2, 'Slot 2'], [3, 'Carol']]);
  });

  test('download links are resolved against the origin, per slot', () => {
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload()).downloads).toEqual({
      1: 'https://archipelago.gg/dl_patch/ROOM/11',
      3: 'https://archipelago.gg/download_slot_file/ROOM/3',
    });
  });

  test('a download link to another site, another scheme or no real url is dropped', () => {
    const room = toWebsiteRoom(SITE, 'ROOM', roomPayload({
      downloads: [
        { slot: 1, download: 'https://evil.example/patch' },
        { slot: 2, download: '//evil.example/patch' },
        { slot: 3, download: 'javascript:alert(1)' },
        { slot: 4, download: 'data:text/html,hi' },
        { slot: 5, download: 'http://archipelago.gg/dl' }, // same host but a different scheme is a different origin
        { slot: 6, download: '/ok' },
        { slot: 'x', download: '/bad-slot' },
        { slot: 7 },
      ],
    }));
    expect(room.downloads).toEqual({ 6: 'https://archipelago.gg/ok' });
  });

  test('sameOriginHttpUrl keeps only http(s) on the same origin', () => {
    expect(sameOriginHttpUrl('http://localhost:5000', '/x?y=1')).toBe('http://localhost:5000/x?y=1');
    expect(sameOriginHttpUrl('http://localhost:5000', 'http://localhost:5001/x')).toBeUndefined();
    expect(sameOriginHttpUrl('not a url', '/x')).toBeUndefined();
  });

  test('a date that does not parse is shown as unknown, not as a broken date', () => {
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ last_activity: 'yesterday-ish' })).lastActivity).toBeUndefined();
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ last_activity: null })).lastActivity).toBeUndefined();
  });

  test('a payload copied from the live website (names changed): only some slots have a download', () => {
    // From a real GET https://archipelago.gg/api/room_status/<id>: same keys, a GMT date string,
    // relative download paths, and downloads for slots 7 and 8 only.
    const live = {
      downloads: [
        { download: '/slot_file/RoomId_x/7', slot: 7 },
        { download: '/slot_file/RoomId_x/8', slot: 8 },
      ],
      last_activity: 'Sun, 15 Nov 2026 23:21:30 GMT',
      last_port: 57380,
      players: Array.from({ length: 10 }, (_, i) => [`Player${i + 1}`, i === 2 ? 'EldenRing' : 'Clique']),
      timeout: 7200,
      tracker: 'zwqsctkmQLSVbU1tU95JMw',
    };
    const room = toWebsiteRoom('https://archipelago.gg', 'RoomId_x', live);
    expect(room.lastPort).toBe(57380);
    expect(room.lastActivity?.toISOString()).toBe('2026-11-15T23:21:30.000Z');
    expect(room.timeoutSeconds).toBe(7200);
    expect(room.trackerUrl).toBe('https://archipelago.gg/tracker/zwqsctkmQLSVbU1tU95JMw');
    expect(room.players).toHaveLength(10);
    expect(room.players[7]).toEqual({ slot: 8, name: 'Player8', game: 'Clique' });
    expect(room.downloads).toEqual({
      7: 'https://archipelago.gg/slot_file/RoomId_x/7',
      8: 'https://archipelago.gg/slot_file/RoomId_x/8',
    });
  });

  test('no tracker gives no tracker links, and an unsafe tracker id is not put in a link', () => {
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ tracker: null }))).toMatchObject({ trackerId: undefined, trackerUrl: undefined });
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ tracker: '../../admin' })).trackerUrl).toBeUndefined();
  });

  test('the port is kept as reported: 0 never started, -1 failed, missing unknown', () => {
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ last_port: 0 })).lastPort).toBe(0);
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ last_port: -1 })).lastPort).toBe(-1);
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ last_port: null })).lastPort).toBeUndefined();
  });

  test('a missing or nonsense timeout is unknown', () => {
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ timeout: 0 })).timeoutSeconds).toBeUndefined();
    expect(toWebsiteRoom(SITE, 'ROOM', roomPayload({ timeout: 'soon' })).timeoutSeconds).toBeUndefined();
  });

  test('an empty or odd payload does not throw', () => {
    const room = toWebsiteRoom(SITE, 'ROOM', {});
    expect(room.players).toEqual([]);
    expect(room.downloads).toEqual({});
    expect(toWebsiteRoom(SITE, 'ROOM', { players: 'nope', downloads: 'nope' as never }).players).toEqual([]);
  });
});

describe('portFromAddress', () => {
  test('reads the port from an address with or without a scheme', () => {
    expect(portFromAddress('archipelago.gg:57380')).toBe(57380);
    expect(portFromAddress('ws://localhost:54402')).toBe(54402);
    expect(portFromAddress('wss://archipelago.gg:57380/')).toBe(57380);
    expect(portFromAddress('  192.168.1.5:38281  ')).toBe(38281);
  });

  test('a missing port is the library default, 38281', () => {
    expect(portFromAddress('archipelago.gg')).toBe(38281);
    expect(portFromAddress('wss://archipelago.gg')).toBe(38281);
  });

  test('nonsense gives no port', () => {
    expect(portFromAddress('')).toBeUndefined();
    expect(portFromAddress('   ')).toBeUndefined();
    expect(portFromAddress('://')).toBeUndefined();
  });
});

describe('portMatches', () => {
  test('matches or differs when both ports are known', () => {
    expect(portMatches(57380, 57380)).toBe('match');
    expect(portMatches(57380, 60000)).toBe('mismatch');
  });

  test('is unknown when the room has no running port or we are not connected', () => {
    expect(portMatches(0, 57380)).toBe('unknown'); // never started
    expect(portMatches(-1, 57380)).toBe('unknown'); // failed to start
    expect(portMatches(undefined, 57380)).toBe('unknown');
    expect(portMatches(57380, undefined)).toBe('unknown');
  });
});

// --------------------------------------------------------------------------- aggregation (pure)

describe("chainsOf (each player's received items, in order)", () => {
  // Item entries are [item, location, finder slot, flags] (NetworkItem order), like the real
  // /api/tracker payload. The first two rows are real values: item 1220 is in the receiver's game
  // (slot 1), location 71519 in the finder's (slot 8). Getting the order wrong once made every
  // real tracker find unusable, so it is pinned here.
  const dynamic = {
    player_items_received: [
      { team: 0, player: 1, items: [[1220, 71519, 8, 1], [5, -2, 0, 0], [238493038, 1268, 4, 0]] },
      { team: 0, player: 2, items: [] },
      { team: 1, player: 3, items: [[7, 7, 3, 0]] }, // another team
      { team: 0, player: 4, items: [[9, 9, 1, 2], 'oops', [1, 2], [null, 1, 1, 1]] },
    ],
  };

  test('one list per receiver, in the order received: receiver from the entry, finder from the item', () => {
    expect(chainsOf(dynamic, 0)).toEqual([
      [
        { finder: 8, receiver: 1, location: 71519, item: 1220, flags: 1 },
        { finder: 4, receiver: 1, location: 1268, item: 238493038, flags: 0 },
      ],
      [{ finder: 1, receiver: 4, location: 9, item: 9, flags: 2 }],
    ]);
  });

  test('starting and server items (location <= 0), other teams, empty lists and malformed entries are left out', () => {
    const finds = chainsOf(dynamic, 0).flat();
    expect(finds.some((f) => f.location <= 0)).toBe(false);
    expect(finds.some((f) => f.receiver === 3 || f.receiver === 2)).toBe(false);
    expect(chainsOf({}, 0)).toEqual([]);
  });
});

describe('completionByGame', () => {
  const lean = leanStatic(staticPayload());

  test('leanStatic keeps only what is needed, not the data package', () => {
    expect(lean).not.toHaveProperty('datapackage');
    expect(lean.groups).toEqual([4]);
    expect(lean.players).toHaveLength(6);
  });

  test('sums over the players of each game, leaving out groups, empty players and other teams', () => {
    expect(completionByGame(lean, dynamicPayload(), 0)).toEqual([
      { game: 'Alpha', players: 2, checked: 40, total: 150 },
      { game: 'Beta', players: 1, checked: 50, total: 200 },
    ]);
  });

  test('another team is computed separately', () => {
    expect(completionByGame(lean, dynamicPayload(), 1)).toEqual([
      { game: 'Alpha', players: 1, checked: 100, total: 100 },
    ]);
  });

  test('checks are capped at the total, and a player with no entry counts as 0', () => {
    const rows = completionByGame(lean, dynamicPayload([{ team: 0, player: 1, locations: range(500) }]), 0);
    expect(rows[0].checked).toBe(100);
    expect(rows[1].checked).toBe(0);
  });

  test('a player with no locations never makes a row (nothing divides by zero)', () => {
    const empty = { groups: [], players: [{ team: 0, player: 1, game: 'A', total: 0 }] };
    expect(completionByGame(empty, { player_checks_done: [] }, 0)).toEqual([]);
  });

  test('slotsOf lists the players of one team, without groups', () => {
    expect(slotsOf(lean, 0)).toEqual({ 1: 'Alpha', 2: 'Alpha', 3: 'Beta', 5: 'Gamma' });
  });
});

// --------------------------------------------------------------------------- wrong-room guard (pure)

describe('rosterMatchesTracker', () => {
  const slots = slotsOf(leanStatic(staticPayload()), 0);
  const rosterOf = (entries: [number, string][]) =>
    entries.map(([slot, game]) => ({ slot, name: 'P' + slot, game, isMe: slot === 1, isGroup: false }));
  const sameRoom: [number, string][] = [[1, 'Alpha'], [2, 'Alpha'], [3, 'Beta'], [5, 'Gamma']];

  test('matches when players and games agree', () => {
    expect(rosterMatchesTracker(rosterOf(sameRoom), slots)).toBe('match');
  });

  test('a different game in a slot is a mismatch', () => {
    expect(rosterMatchesTracker(rosterOf([[1, 'Alpha'], [2, 'Beta'], [3, 'Beta'], [5, 'Gamma']]), slots)).toBe('mismatch');
  });

  test('a different number of players is a mismatch', () => {
    expect(rosterMatchesTracker(rosterOf([[1, 'Alpha']]), slots)).toBe('mismatch');
  });

  test('with nothing to compare yet, it is unknown', () => {
    expect(rosterMatchesTracker([], slots)).toBe('unknown');
    expect(rosterMatchesTracker(rosterOf([[1, 'Alpha']]), {})).toBe('unknown');
  });

  test('groups in the roster are ignored', () => {
    const withGroup = [...rosterOf(sameRoom), { slot: 4, name: 'Links', game: 'Archipelago', isMe: false, isGroup: true }];
    expect(rosterMatchesTracker(withGroup, slots)).toBe('match');
  });
});

// --------------------------------------------------------------------------- fetching and polling against a mock website

const calls: Record<string, number> = {};
/** The tracker the room "ROOMCHANGE" names; a test changes it between polls. */
let changingRoomTracker = 'GOOD';
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    calls[path] = (calls[path] ?? 0) + 1;
    const [, , kind, id] = path.split('/'); // /api/<kind>/<id>
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (kind === 'room_status') {
      if (id === 'ROOM404') return new Response('not found', { status: 404 });
      // A room without a tracker: the real website fails converting the missing tracker id.
      if (id === 'ROOMBARE') return new Response('Internal Server Error', { status: 500 });
      if (id === 'ROOMNULL') return json(roomPayload({ tracker: null })); // defensive: not what the website does
      if (id === 'ROOMSLOW') {
        await wait(500);
        return json(roomPayload({ last_port: 11111 }));
      }
      if (id === 'ROOMOTHER') return json(roomPayload({ tracker: 'OTHER', last_port: 22222 }));
      if (id === 'ROOMCHANGE') return json(roomPayload({ tracker: changingRoomTracker }));
      return json(roomPayload({
        tracker: 'GOOD',
        downloads: [
          { slot: 1, download: '/dl_patch/ROOM/11' },
          { slot: 3, download: 'https://evil.example/x' }, // another site: must be dropped
        ],
      }));
    }
    if (id === 'MISSING') return new Response('not found', { status: 404 });
    if (id === 'BROKEN') return new Response('oops', { status: 500 });
    if (id === 'SLOW') {
      await wait(500);
      return kind === 'static_tracker'
        ? json(staticPayload())
        : json(dynamicPayload([{ team: 0, player: 1, locations: range(99) }]));
    }
    return kind === 'static_tracker' ? json(staticPayload()) : json(dynamicPayload());
  },
});
afterAll(() => {
  stopSite(); // clears the polling timers
  stopTracker();
  server.stop(true);
});
const origin = `http://127.0.0.1:${server.port}`;

describe('loading and refreshing', () => {
  test('shows loading, then the per-game completion', async () => {
    startTracker({ origin, id: 'GOOD' }, 0);
    expect(trackerStatus()).toBe('loading');
    expect(await until(() => trackerStatus() === 'ready')).toBe(true);
    expect(completion().map((r) => `${r.game}:${r.checked}/${r.total}`)).toEqual(['Alpha:40/150', 'Beta:50/200']);
    expect(trackerSlots()).toEqual({ 1: 'Alpha', 2: 'Alpha', 3: 'Beta', 5: 'Gamma' }); // for the wrong-room guard
    expect(getTrackerFinds()).toEqual([[{ finder: 2, receiver: 1, location: 5, item: 7, flags: 1 }]]); // for History
    expect(trackerUpdated()).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(trackerError()).toBe('');
  });

  test('fetched the large static data once and the live data once', () => {
    expect(calls['/api/static_tracker/GOOD']).toBe(1);
    expect(calls['/api/tracker/GOOD']).toBe(1);
  });

  test('restarting on the same link does not refetch the static data, and keeps showing the data', async () => {
    startTracker({ origin, id: 'GOOD' }, 0); // e.g. the user's team became known
    expect(completion()).toHaveLength(2); // still shown while refreshing
    expect(await until(() => calls['/api/tracker/GOOD'] === 2 && trackerStatus() === 'ready')).toBe(true);
    expect(calls['/api/static_tracker/GOOD']).toBe(1);
  });

  test('a refresh within a minute does nothing', async () => {
    refreshTracker();
    await wait(150);
    expect(calls['/api/tracker/GOOD']).toBe(2);
  });
});

describe('problems', () => {
  test('a 404 is reported in plain words, and data from the previous link does not linger', async () => {
    startTracker({ origin, id: 'MISSING' }, 0);
    expect(await until(() => trackerStatus() === 'error')).toBe(true);
    expect(trackerError()).toMatch(/Multiworld Tracker/);
    expect(completion()).toEqual([]);
    expect(trackerUpdated()).toBe('');
  });

  test('a server error is reported', async () => {
    startTracker({ origin, id: 'BROKEN' }, 0);
    expect(await until(() => trackerStatus() === 'error')).toBe(true);
    expect(trackerError()).toMatch(/error \(HTTP 500\)/);
  });

  test('an unreachable website is reported', async () => {
    startTracker({ origin: 'http://127.0.0.1:1', id: 'GOOD' }, 0);
    expect(await until(() => trackerStatus() === 'error')).toBe(true);
    expect(trackerError()).toMatch(/Could not reach http:\/\/127\.0\.0\.1:1/);
  });
});

describe('switching and stopping', () => {
  test('a slow response from an old link does not overwrite the new link', async () => {
    startTracker({ origin, id: 'SLOW' }, 0);
    await wait(50);
    startTracker({ origin, id: 'GOOD' }, 0);
    expect(await until(() => trackerStatus() === 'ready' && completion().length === 2)).toBe(true);
    await wait(900); // the slow response is back by now
    expect(completion().map((r) => `${r.game}:${r.checked}`)).toEqual(['Alpha:40', 'Beta:50']);
    expect(trackerStatus()).toBe('ready');
    expect(trackerError()).toBe('');
  });

  test('stopping mid-load applies nothing and reports no error', async () => {
    startTracker({ origin, id: 'SLOW' }, 0);
    await wait(50);
    stopTracker();
    await wait(900);
    expect(trackerStatus()).not.toBe('loading');
    expect(trackerStatus()).not.toBe('error');
    expect(completion()).toEqual([]);
  });
});

// --------------------------------------------------------------------------- one link finds everything

const roomLink = (id: string) => ({ kind: 'room' as const, origin, id });
const loadedRoom = () => roomStatus() === 'ready' && trackerStatus() === 'ready' && completion().length === 2;

describe('a room link', () => {
  test('loads the room details, then the tracker the room names', async () => {
    startSite(roomLink('ROOM'), 0);
    expect(roomStatus()).toBe('loading');
    expect(await until(loadedRoom)).toBe(true);
    expect(websiteRoom()).toMatchObject({ trackerId: 'GOOD', lastPort: 57380, timeoutSeconds: 7200 });
    expect(websiteRoom()?.players).toHaveLength(3);
    expect(completion().map((r) => `${r.game}:${r.checked}/${r.total}`)).toEqual(['Alpha:40/150', 'Beta:50/200']);
  });

  test('only the download on the same site is kept', () => {
    expect(websiteRoom()?.downloads).toEqual({ 1: `${origin}/dl_patch/ROOM/11` });
  });

  test('polling the room again does not restart the tracker', async () => {
    const trackerBefore = calls['/api/tracker/GOOD'];
    const roomBefore = calls['/api/room_status/ROOM'];
    timing.roomPollMs = 100; // poll the room quickly; the tracker keeps its own, much longer, interval
    try {
      startSite(roomLink('ROOM'), 0); // one restart of the run, so the tracker is started once more here
      expect(await until(() => (calls['/api/room_status/ROOM'] ?? 0) >= roomBefore + 5, 10_000)).toBe(true);
      expect(await until(loadedRoom)).toBe(true);
      // Five room polls, but the tracker was started once, not five times.
      expect(calls['/api/tracker/GOOD'] - trackerBefore).toBe(1);
    } finally {
      timing.roomPollMs = 60_000;
      stopSite();
    }
  });

  test('a room that later names a different tracker switches to it', async () => {
    changingRoomTracker = 'GOOD';
    timing.roomPollMs = 100;
    try {
      startSite(roomLink('ROOMCHANGE'), 0);
      expect(await until(loadedRoom)).toBe(true);
      expect(calls['/api/tracker/OTHER'] ?? 0).toBe(0);
      changingRoomTracker = 'OTHER';
      expect(await until(() => (calls['/api/tracker/OTHER'] ?? 0) >= 1)).toBe(true);
      expect(await until(() => trackerStatus() === 'ready' && completion().length === 2)).toBe(true);
      expect(calls['/api/static_tracker/OTHER']).toBe(1);
    } finally {
      timing.roomPollMs = 60_000;
      stopSite();
    }
  });

  test('a manual refresh waits for the floor, then asks again', async () => {
    startSite(roomLink('ROOM'), 0);
    expect(await until(loadedRoom)).toBe(true);
    const before = calls['/api/room_status/ROOM'];
    refreshSite(); // far too soon (the floor is 10 s)
    await wait(150);
    expect(calls['/api/room_status/ROOM']).toBe(before);

    timing.roomRefreshFloorMs = 0;
    try {
      refreshSite();
      expect(await until(() => calls['/api/room_status/ROOM'] === before + 1)).toBe(true);
    } finally {
      timing.roomRefreshFloorMs = 10_000;
      stopSite();
    }
  });

  test('switching to another room clears the old details at once, then shows the new ones', async () => {
    startSite(roomLink('ROOM'), 0);
    expect(await until(loadedRoom)).toBe(true);
    startSite(roomLink('ROOMOTHER'), 0);
    expect(websiteRoom()).toBeUndefined(); // the old room's details do not linger
    expect(completion()).toEqual([]); // nor does its completion
    expect(await until(() => websiteRoom()?.lastPort === 22222)).toBe(true);
    expect(await until(() => websiteRoom()?.trackerId === 'OTHER' && trackerStatus() === 'ready')).toBe(true);
  });

  test('a tracker link on its own gives the completion, with no room details', async () => {
    startSite({ kind: 'tracker', origin, id: 'GOOD' }, 0);
    expect(websiteRoom()).toBeUndefined();
    expect(await until(() => trackerStatus() === 'ready' && completion().length === 2)).toBe(true);
    expect(websiteRoom()).toBeUndefined();
    expect(roomStatus()).toBe('idle');
    stopSite();
  });
});

describe('a room link that does not work', () => {
  test('a room the website does not know is reported plainly', async () => {
    startSite(roomLink('ROOM404'), 0);
    expect(await until(() => roomStatus() === 'error')).toBe(true);
    expect(roomError()).toMatch(/does not know that room/);
    expect(websiteRoom()).toBeUndefined();
    stopSite();
  });

  test('a room the website cannot describe (a server error) says why it probably is', async () => {
    startSite(roomLink('ROOMBARE'), 0);
    expect(await until(() => roomStatus() === 'error')).toBe(true);
    expect(roomError()).toMatch(/could not describe this room/);
    expect(roomError()).toMatch(/most likely.*no tracker/);
    expect(roomError()).not.toMatch(/Could not reach/); // the website answered, it was not unreachable
    expect(completion()).toEqual([]);
    stopSite();
  });

  test('a room whose reply names no tracker says completion is unavailable', async () => {
    startSite(roomLink('ROOMNULL'), 0);
    expect(await until(() => roomStatus() === 'ready' && trackerStatus() === 'error')).toBe(true);
    expect(websiteRoom()?.trackerId).toBeUndefined();
    expect(trackerError()).toMatch(/no tracker/);
    expect(completion()).toEqual([]);
    stopSite();
  });

  test('an unreachable website is reported as unreachable', async () => {
    startSite({ kind: 'room', origin: 'http://127.0.0.1:1', id: 'ROOM' }, 0);
    expect(await until(() => roomStatus() === 'error')).toBe(true);
    expect(roomError()).toMatch(/Could not reach http:\/\/127\.0\.0\.1:1/);
    stopSite();
  });
});

describe('switching and stopping a room link', () => {
  test('a slow room response from an old link does not overwrite the new link', async () => {
    startSite(roomLink('ROOMSLOW'), 0);
    await wait(50);
    startSite(roomLink('ROOM'), 0);
    expect(await until(loadedRoom)).toBe(true);
    await wait(900); // the slow response is back by now
    expect(websiteRoom()?.lastPort).toBe(57380); // not the slow room's 11111
    expect(roomStatus()).toBe('ready');
    expect(roomError()).toBe('');
    stopSite();
  });

  test('stopping mid-load applies nothing and reports no error', async () => {
    startSite(roomLink('ROOMSLOW'), 0);
    await wait(50);
    stopSite();
    await wait(900);
    expect(roomStatus()).not.toBe('loading');
    expect(roomStatus()).not.toBe('error');
    expect(websiteRoom()).toBeUndefined();
  });
});
