// Tests for the lobby-completion code (src/adapter/tracker.ts, src/state/tracker.ts): the tracker
// link parser, the per-game aggregation, the wrong-room guard, and the fetch/poll flow against a
// mock website. Run with `bun test`.
//
// The fixtures are shaped like the real WebHost responses (see WebHostLib/api/tracker.py in the
// Archipelago repo): /api/static_tracker/<id> and /api/tracker/<id>.
//
// The fetch/poll tests build on each other (they share one mock website and the module-level
// tracker state), so they must run in file order; do not use `.only` / `.skip` on them.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  completionByGame,
  leanStatic,
  parseTrackerLink,
  refreshTracker,
  slotsOf,
  startTracker,
  stopTracker,
} from '../src/adapter/tracker';
import {
  completion,
  rosterMatchesTracker,
  trackerError,
  trackerSlots,
  trackerStatus,
  trackerUpdated,
} from '../src/state/tracker';
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
  aliases: [], player_items_received: [], hints: [], activity_timers: [], connection_timers: [], player_status: [], total_checks_done: [],
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

describe('parseTrackerLink', () => {
  test('reads a tracker link', () => {
    expect(parseTrackerLink('https://archipelago.gg/tracker/ABC123')).toEqual({
      ok: true, origin: 'https://archipelago.gg', id: 'ABC123',
    });
  });

  test('ignores a trailing page, such as a game', () => {
    expect(parseTrackerLink('https://archipelago.gg/tracker/ABC123/Hollow%20Knight')).toMatchObject({ ok: true, id: 'ABC123' });
  });

  test('works for a local webhost with a port, and for the sphere tracker', () => {
    expect(parseTrackerLink('http://localhost:5000/sphere_tracker/XYZ_-9')).toEqual({
      ok: true, origin: 'http://localhost:5000', id: 'XYZ_-9',
    });
  });

  test('accepts an API url too', () => {
    expect(parseTrackerLink('https://archipelago.gg/api/tracker/ABC')).toMatchObject({ ok: true, id: 'ABC' });
  });

  test('passes a full UUID through unchanged', () => {
    expect(parseTrackerLink('https://archipelago.gg/tracker/123e4567-e89b-12d3-a456-426614174000')).toMatchObject({
      ok: true, id: '123e4567-e89b-12d3-a456-426614174000',
    });
  });

  test('a room link is its own problem, because the tracker has a different id', () => {
    expect(parseTrackerLink('https://archipelago.gg/room/ROOMID')).toEqual({ ok: false, problem: 'room' });
  });

  test('empty input is empty', () => {
    expect(parseTrackerLink('   ')).toEqual({ ok: false, problem: 'empty' });
  });

  test('nonsense, a missing scheme and a wrong scheme are invalid', () => {
    for (const text of ['hello', 'archipelago.gg/tracker/ABC', 'ftp://x/tracker/ABC', 'https://archipelago.gg/']) {
      expect(parseTrackerLink(text)).toEqual({ ok: false, problem: 'invalid' });
    }
  });
});

// --------------------------------------------------------------------------- aggregation (pure)

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
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    calls[path] = (calls[path] ?? 0) + 1;
    const [, , kind, id] = path.split('/'); // /api/<kind>/<id>
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
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
  stopTracker(); // clears the polling timer
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
