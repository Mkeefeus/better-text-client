import { createSignal } from 'solid-js';
import type { ConnectionStatus, RosterEntry } from './types';

export const [status, setStatus] = createSignal<ConnectionStatus>('idle');

/** Every slot in the room, once logged in. */
export const [roster, setRoster] = createSignal<readonly RosterEntry[]>([]);

/** Who we are connected as, once logged in. */
export const [identity, setIdentity] = createSignal<{ name: string; game: string; team: number } | undefined>();

/**
 * Hint points currently held, the cost of one hint, and the points earned per location checked,
 * once logged in.
 */
export const [hintPoints, setHintPoints] = createSignal<{ points: number; cost: number; perCheck: number } | undefined>();

// --- Saved connection details -------------------------------------------------
// Only the URL and slot name are remembered. The password is deliberately never stored.

export interface Profile {
  url: string;
  slot: string;
}

const PROFILE_KEY = 'better-text-client.profile';
const DEFAULT_PROFILE: Profile = { url: 'archipelago.gg:38281', slot: '' };

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : DEFAULT_PROFILE.url,
      slot: typeof parsed.slot === 'string' ? parsed.slot : DEFAULT_PROFILE.slot,
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(profile: Profile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Storage can be unavailable or full; losing the saved profile is not worth surfacing.
  }
}
