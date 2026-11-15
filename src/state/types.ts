// Plain data types shared by the adapter, the stores and the UI.
// Nothing here depends on archipelago.js or Solid.

/** What kind of message this is. Drives subtle per-category styling and, later, filtering. */
export type MessageCategory =
  | 'chat'
  | 'server'
  | 'item'
  | 'hint'
  | 'join'
  | 'part'
  | 'goal'
  | 'command'
  | 'tutorial'
  | 'system'
  | 'client'
  | 'error';

/** A run of text with one style. `cls` is a space-separated list of CSS classes (see App.css). */
export interface Span {
  text: string;
  cls: string;
}

export interface Message {
  /** Monotonically increasing, never reused. Used as the virtualizer's item key. */
  id: number;
  /** Pre-formatted wall-clock time, so rows never format dates while rendering. */
  timeLabel: string;
  category: MessageCategory;
  spans: Span[];
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'closed';

/** One slot of the room, for the player filters. */
export interface RosterEntry {
  slot: number;
  name: string;
  game: string;
  /** This is the slot we are connected as. */
  isMe: boolean;
  /** An item-links group rather than a real player. */
  isGroup: boolean;
}

/** One item that was found (a location was checked). */
export interface HistoryRow {
  /** `${finderSlot}-${locationId}`: a location is checked at most once, so this is unique. */
  id: string;
  /**
   * Position in the history: 1 is the first item recorded. Shown as "Order". Items you received before
   * connecting come first, in the order you received them (their real order), then live finds as they happen.
   */
  seq: number;
  itemName: string;
  itemFlags: number;
  locationName: string;
  finderSlot: number;
  finderName: string;
  finderGame: string;
  receiverSlot: number;
  receiverName: string;
  receiverGame: string;
  forMe: boolean;
  fromMe: boolean;
  /** Lower-cased text used by the search box. */
  search: string;
}

export interface HintRow {
  /** `${finderSlot}-${locationId}`, unique per hint. */
  id: string;
  itemName: string;
  itemFlags: number;
  locationName: string;
  finderSlot: number;
  finderName: string;
  finderGame: string;
  receiverSlot: number;
  receiverName: string;
  receiverGame: string;
  entrance: string;
  found: boolean;
  /** Archipelago HintStatus: 0 unspecified, 10 no priority, 20 avoid, 30 priority, 40 found. */
  status: number;
  /** The receiver is the slot we are connected as. */
  forMe: boolean;
  /** The finder (the world containing the item) is the slot we are connected as. */
  fromMe: boolean;
  /** Lower-cased text used by the search box. */
  search: string;
}
