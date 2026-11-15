const clock = new Intl.DateTimeFormat([], {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Wall-clock time as HH:MM:SS. One shared formatter, because constructing one per message is slow. */
export function clockLabel(date: Date = new Date()): string {
  return clock.format(date);
}
