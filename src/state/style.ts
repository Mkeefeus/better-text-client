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

export type ItemKind = 'progression' | 'useful' | 'trap' | 'filler';

/** Item classification flags -> kind, with the same precedence as `itemClass`. */
export function itemKind(flags: number): ItemKind {
  if (flags & 0b001) return 'progression';
  if (flags & 0b010) return 'useful';
  if (flags & 0b100) return 'trap';
  return 'filler';
}

/** Player connection state as the server reports it (`_read_client_status_*`). */
export function clientStatusLabel(status: number | undefined): string {
  switch (status) {
    case 5:
      return 'Connected';
    case 10:
      return 'Ready';
    case 20:
      return 'Playing';
    case 30:
      return 'Goal reached';
    case 0:
      // The server sets this when a slot's last client leaves (and before anyone ever joined).
      return 'Offline';
    default:
      return '—';
  }
}

export function clientStatusClass(status: number | undefined): string {
  switch (status) {
    case 5:
      return 'cs-connected';
    case 10:
      return 'cs-ready';
    case 20:
      return 'cs-playing';
    case 30:
      return 'cs-goal';
    default:
      return 'cs-offline';
  }
}

/** How a room permission (release, collect, remaining) is set. */
export function permissionLabel(value: number | undefined): string {
  switch (value) {
    case 0:
      return 'Disabled';
    case 1:
      return 'Any time';
    case 2:
      return 'After goal';
    case 6:
      return 'Automatic after goal';
    case 7:
      return 'Automatic after goal, or any time';
    default:
      return '—';
  }
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
