// Unit tests of the History time estimate (src/state/historyTimes.ts). Pure functions, explicit
// times, no clock: each test stands alone.

import { describe, expect, test } from 'bun:test';
import { estimateTimes, spread } from '../src/state/historyTimes';
import type { ChainItem, KnownTime } from '../src/state/historyTimes';

const item = (id: string, mine = false): ChainItem => ({ id, mine });
const chain = (...ids: string[]) => ids.map((id) => item(id));
const exact = (time: number): KnownTime => ({ time, kind: 'exact' });
const known = (entries: Record<string, KnownTime>) => new Map(Object.entries(entries));

describe('spread', () => {
  test('evenly over the window, each in the middle of its share', () => {
    expect(spread(0, 1000, 4, [])).toEqual([125, 375, 625, 875]);
  });

  test('only over the offline part: time online is skipped', () => {
    // Online 200-800, so the offline time is 0-200 and 800-1000 (400 in all).
    expect(spread(0, 1000, 2, [{ start: 200, end: 800 }])).toEqual([100, 900]);
  });

  test('an empty or inverted window puts everything at its start', () => {
    expect(spread(500, 500, 2, [])).toEqual([500, 500]);
    expect(spread(600, 500, 1, [])).toEqual([600]);
  });

  test('a window that is all online (clock trouble) uses the whole window', () => {
    expect(spread(0, 100, 1, [{ start: 0, end: 100 }])).toEqual([50]);
  });
});

describe('estimateTimes', () => {
  test('a run between two known items is placed between them, in order', () => {
    const out = estimateTimes([chain('a', 'x', 'y', 'b')], known({ a: exact(1000), b: exact(4000) }), { online: [] }, 10_000);
    expect(out.get('x')).toEqual({ time: 1750, kind: 'estimated' });
    expect(out.get('y')).toEqual({ time: 3250, kind: 'estimated' });
    expect(out.has('a') || out.has('b')).toBe(false); // known rows are not touched
  });

  test('nothing is placed after the start of the current connection', () => {
    const out = estimateTimes([chain('a', 'x')], known({ a: exact(1000) }), { online: [] }, 3000);
    expect(out.get('x')).toEqual({ time: 2000, kind: 'estimated' });
  });

  test('time this client was online is skipped: it would have seen a find then', () => {
    const out = estimateTimes(
      [chain('a', 'x')],
      known({ a: exact(0) }),
      { online: [{ start: 0, end: 900 }] }, // connected until 900, then away until 1000
      1000,
    );
    expect(out.get('x')).toEqual({ time: 950, kind: 'estimated' });
  });

  test('the team coverage is a lower bound for every run', () => {
    const out = estimateTimes([chain('x')], new Map(), { team: 2000, online: [] }, 4000);
    expect(out.get('x')).toEqual({ time: 3000, kind: 'estimated' });
  });

  test('the own coverage bounds only runs that involve us', () => {
    const coverage = { own: 2000, online: [] };
    const theirs = estimateTimes([chain('x')], new Map(), coverage, 4000);
    const ours = estimateTimes([[item('y', true)]], new Map(), coverage, 4000);
    expect(theirs.get('x')?.kind).toBe('unknown'); // nothing bounds it from below
    expect(ours.get('y')).toEqual({ time: 3000, kind: 'estimated' });
  });

  test('with no lower bound the time is unknown: only an order, before every real time', () => {
    const out = estimateTimes([chain('x', 'y'), chain('p', 'q', 'r', 's')], new Map(), { online: [] }, 5000);
    for (const estimate of out.values()) {
      expect(estimate.kind).toBe('unknown');
      expect(estimate.time).toBeGreaterThan(-1);
      expect(estimate.time).toBeLessThan(0);
    }
    // Interleaved by position in each list: x at 1/4, y at 3/4; p..s at 1/8, 3/8, 5/8, 7/8.
    const order = [...out.entries()].sort((a, b) => a[1].time - b[1].time).map(([id]) => id);
    expect(order).toEqual(['p', 'x', 'q', 'r', 'y', 's']);
  });

  test('an unknown run before a known item stays before it, and the rest of the list is still bounded', () => {
    const out = estimateTimes([chain('x', 'a', 'y')], known({ a: exact(1000) }), { online: [] }, 3000);
    expect(out.get('x')?.kind).toBe('unknown');
    expect(out.get('y')).toEqual({ time: 2000, kind: 'estimated' });
  });

  test('an item in two lists (an item-link group) is placed once, by the first list', () => {
    const out = estimateTimes(
      [chain('a', 'g', 'b'), chain('c', 'g')],
      known({ a: exact(1000), b: exact(2000), c: exact(1800) }),
      { online: [] },
      5000,
    );
    expect(out.get('g')).toEqual({ time: 1500, kind: 'estimated' });
  });

  test('each list keeps its exact order, whatever mix of known, unknown and estimated items it has', () => {
    const chains = [
      chain('u1', 'a', 'x1', 'x2', 'b', 'x3'),
      chain('u2', 'u3', 'c', 'x4', 'x5'),
      [item('m1', true), item('m2', true)],
    ];
    const knownRows = known({ a: exact(1000), b: exact(3000), c: exact(2500) });
    const out = estimateTimes(chains, knownRows, { own: 500, online: [{ start: 3500, end: 3600 }] }, 6000);
    const timeOf = (id: string) => knownRows.get(id)?.time ?? out.get(id)!.time;
    for (const list of chains) {
      for (let i = 1; i < list.length; i++) {
        expect(timeOf(list[i].id)).toBeGreaterThanOrEqual(timeOf(list[i - 1].id));
      }
    }
  });
});
