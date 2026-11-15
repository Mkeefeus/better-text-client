// Shared helpers that map protocol values to CSS classes and labels.

/**
 * Item classification flags -> CSS class. Precedence matches the official client:
 * progression wins over useful, which wins over trap.
 */
export function itemClass(flags: number): string {
  if (flags & 0b001) return 'item-prog';
  if (flags & 0b010) return 'item-useful';
  if (flags & 0b100) return 'item-trap';
  return 'item-normal';
}

export const STATUS_UNSPECIFIED = 0;
export const STATUS_NO_PRIORITY = 10;
export const STATUS_AVOID = 20;
export const STATUS_PRIORITY = 30;
export const STATUS_FOUND = 40;

export function statusLabel(status: number): string {
  switch (status) {
    case STATUS_PRIORITY:
      return 'Priority';
    case STATUS_NO_PRIORITY:
      return 'No priority';
    case STATUS_AVOID:
      return 'Avoid';
    case STATUS_FOUND:
      return 'Found';
    default:
      return 'Unspecified';
  }
}

/** Lower rank sorts first: priority, unspecified, no priority, avoid, found. */
export function statusRank(status: number): number {
  switch (status) {
    case STATUS_PRIORITY:
      return 0;
    case STATUS_UNSPECIFIED:
      return 1;
    case STATUS_NO_PRIORITY:
      return 2;
    case STATUS_AVOID:
      return 3;
    default:
      return 4;
  }
}

export function statusClass(status: number): string {
  switch (status) {
    case STATUS_PRIORITY:
      return 'st-priority';
    case STATUS_NO_PRIORITY:
      return 'st-nopriority';
    case STATUS_AVOID:
      return 'st-avoid';
    case STATUS_FOUND:
      return 'st-found';
    default:
      return 'st-unspecified';
  }
}
