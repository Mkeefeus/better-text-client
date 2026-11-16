import type { TimeKind } from './types';

const clock24 = new Intl.DateTimeFormat([], {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Wall-clock time as HH:MM:SS. One shared formatter, because constructing one per message is slow. */
export function clockLabel(date: Date = new Date()): string {
  return clock24.format(date);
}

/**
 * The current time in milliseconds. History timestamps are taken from here so tests can control
 * time; the app itself never replaces it.
 */
export const clock = { now: (): number => Date.now() };

const toSecond = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const toMinute = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * The History tab's time column. Exact times to the second; estimates to the minute with "≈",
 * because more precision would be false; and no time at all when none can be given.
 */
export function historyTimeLabel(time: number, kind: TimeKind): string {
  switch (kind) {
    case 'exact':
      return toSecond.format(time);
    case 'estimated':
      return `≈ ${toMinute.format(time)}`;
    default:
      return 'earlier';
  }
}
