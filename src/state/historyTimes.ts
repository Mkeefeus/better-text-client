// Estimating when finds happened that this client did not see happen.
//
// Nothing in Archipelago records when an item was found: the server keeps each player's received
// items in the exact order they arrived, with no times (`received_items` in MultiServer.py), and
// broadcasts each find once as it happens. So a find this client saw live has a real time, and
// one it learns about later (from its own item sync, its sent-items scouts or the website tracker)
// does not. Such a find must have happened while this client was not connected, so it is placed:
//
// - after the previous item in the same receiver's list, and before the next one (that order is
//   exact, so it is never broken);
// - after the point up to which the history was already complete (`Coverage`);
// - before the start of the current connection (anything later would have been seen live);
// - only in time when this client was offline (it would have seen anything during `online`).
//
// Finds in one gap are spread evenly over the offline part of it. When nothing bounds a find from
// below (the first connect to a room, before anything was recorded), there is no time to give: it
// is marked `unknown` and only ordered, by its position in its receiver's list.
//
// Pure: no clock, no state. The connection decides the bounds.

import type { TimeKind } from './types';

export interface Interval {
  start: number;
  end: number;
}

/** One find in a list whose order is exact (one receiver's items, oldest first). */
export interface ChainItem {
  id: string;
  /** We are its finder or its receiver, so the own-items coverage bounds it too. */
  mine: boolean;
}

/** What the history is known to hold. Times in ms. */
export interface Coverage {
  /** Every find of the whole team up to this time is recorded (set by a tracker import). */
  team?: number;
  /** Every find we received or sent up to this time is recorded (set by each connection's own sync). */
  own?: number;
  /** When this client was connected: any find in these intervals was seen live. */
  online: readonly Interval[];
}

/** A known row: its time, or for an `unknown` row its ordering position (between -1 and 0). */
export interface KnownTime {
  time: number;
  kind: TimeKind;
}

export interface Estimate {
  time: number;
  kind: Exclude<TimeKind, 'exact'>;
}

/**
 * Estimate a time for every chain item that is not in `known`. `before` is the start of the
 * current connection. An item in several chains (an item-link group's item) is estimated once.
 */
export function estimateTimes(
  chains: readonly (readonly ChainItem[])[],
  known: ReadonlyMap<string, KnownTime>,
  coverage: Coverage,
  before: number,
): Map<string, Estimate> {
  const out = new Map<string, Estimate>();
  const online = [...coverage.online].sort((a, b) => a.start - b.start);
  const lookup = (id: string): KnownTime | undefined => known.get(id) ?? out.get(id);

  for (const chain of chains) {
    let lastTime: number | undefined; // the previous timed item in this chain
    let lastPosition = -1; // the previous `unknown` item's position, so chain order holds among those too

    let i = 0;
    while (i < chain.length) {
      const here = lookup(chain[i].id);
      if (here) {
        if (here.kind === 'unknown') lastPosition = Math.max(lastPosition, here.time);
        else lastTime = Math.max(lastTime ?? here.time, here.time);
        i++;
        continue;
      }

      // A run of items to estimate, up to the next one with a time (or the end of the chain).
      let j = i;
      while (j < chain.length && !lookup(chain[j].id)) j++;
      const run = chain.slice(i, j);
      const next = j < chain.length ? lookup(chain[j].id) : undefined;

      const lows = [lastTime, coverage.team, run.some((item) => item.mine) ? coverage.own : undefined].filter(
        (value): value is number => value !== undefined,
      );
      const low = lows.length > 0 ? Math.max(...lows) : undefined;
      const high = next && next.kind !== 'unknown' ? Math.min(next.time, before) : before;

      if (low === undefined) {
        // No lower bound: no time can be given. Order by position in the chain, which keeps
        // receivers interleaved roughly in step with each other.
        run.forEach((item, k) => {
          const position = Math.max(-1 + (i + k + 0.5) / chain.length, lastPosition + 1e-9);
          lastPosition = position;
          out.set(item.id, { time: position, kind: 'unknown' });
        });
      } else {
        const times = spread(low, high, run.length, online);
        run.forEach((item, k) => out.set(item.id, { time: times[k], kind: 'estimated' }));
        lastTime = times[times.length - 1];
      }
      i = j;
    }
  }
  return out;
}

/**
 * `count` times spread evenly over the offline part of [low, high]: the k-th sits at (k + 0.5) /
 * count of the offline time. If there is no room (inconsistent bounds), they all get `low`.
 */
export function spread(low: number, high: number, count: number, online: readonly Interval[]): number[] {
  if (!(high > low)) return Array.from({ length: count }, () => low);

  const pieces: Interval[] = [];
  let cursor = low;
  for (const interval of online) {
    if (interval.end <= cursor) continue;
    if (interval.start >= high) break;
    if (interval.start > cursor) pieces.push({ start: cursor, end: Math.min(interval.start, high) });
    cursor = Math.max(cursor, interval.end);
    if (cursor >= high) break;
  }
  if (cursor < high) pieces.push({ start: cursor, end: high });

  const total = pieces.reduce((sum, piece) => sum + (piece.end - piece.start), 0);
  if (total <= 0) {
    // Every moment in the window was online, which cannot be right (clock trouble). Use it all.
    pieces.length = 0;
    pieces.push({ start: low, end: high });
  }
  const measure = total > 0 ? total : high - low;

  return Array.from({ length: count }, (_, k) => {
    let at = (measure * (k + 0.5)) / count;
    for (const piece of pieces) {
      const length = piece.end - piece.start;
      if (at <= length) return Math.round(piece.start + at);
      at -= length;
    }
    return Math.round(high);
  });
}
