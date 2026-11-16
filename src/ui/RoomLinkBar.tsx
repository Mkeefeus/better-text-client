import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { parseSiteLink, refreshSite, startSite, stopSite } from '../adapter/tracker';
import { identity, serverPort } from '../state/connection';
import { room } from '../state/stats';
import {
  clearRoomData,
  clearTrackerData,
  loadSavedLink,
  portCheck,
  rosterCheck,
  roomError,
  roomStatus,
  roomUpdated,
  saveLink,
  setSiteLink,
  siteLink,
  trackerStatus,
  websiteRoom,
} from '../state/tracker';
import { openExternal } from './external';

const LINK_HELP =
  'Paste the room’s page link from the website (https://archipelago.gg/room/…). It finds the room’s tracker, port, activity and downloads, which the game connection cannot provide. It is remembered for each room once it matches the one you are connected to. Rooms hosted elsewhere have no page.';

/**
 * The room's website link. It lives here, not on the Stats tab, because what it unlocks (port
 * check, downloads, the tracker) is not only statistics, and because this bar is always mounted:
 * the room details load and refresh for as long as a link is set.
 */
export default function RoomLinkBar() {
  const [draft, setDraft] = createSignal(siteLink());
  const [linkProblem, setLinkProblem] = createSignal('');
  const parsed = () => parseSiteLink(siteLink());
  const site = () => websiteRoom();
  const team = () => identity()?.team ?? 0;

  // Each room remembers its own link. Switching to a room with nothing saved keeps what was typed,
  // so pasting before connecting works; a saved link for a different room replaces it.
  createEffect(
    on(
      () => room()?.seed,
      (seed) => {
        if (!seed) return;
        const saved = loadSavedLink(seed);
        if (!saved) return;
        setSiteLink(saved);
        setDraft(saved);
      },
    ),
  );

  // Load and keep refreshing while a link is set.
  createEffect(() => {
    const link = parsed();
    if (!link.ok) return;
    startSite(link, team());
    onCleanup(stopSite);
  });

  // Only a link that matches the connected room is remembered for it; a wrong paste never sticks.
  createEffect(() => {
    const seed = room()?.seed;
    const link = siteLink();
    if (!seed || !link || !parsed().ok) return;
    if (portCheck() === 'mismatch' || rosterCheck() === 'mismatch') return;
    if (portCheck() === 'match' || rosterCheck() === 'match') saveLink(seed, link);
  });

  function commit(text: string) {
    const result = parseSiteLink(text);
    if (result.ok) {
      setLinkProblem('');
      setSiteLink(text.trim());
    } else if (result.problem === 'empty') {
      // Clearing the field forgets the link for this room and drops what it had loaded.
      setLinkProblem('');
      setSiteLink('');
      const seed = room()?.seed;
      if (seed) saveLink(seed, '');
      clearRoomData();
      clearTrackerData();
    } else {
      setLinkProblem('That is not a link to a room or tracker. It should look like https://archipelago.gg/room/…');
    }
  }

  const warning = () => {
    if (linkProblem()) return linkProblem();
    if (roomStatus() === 'error') return roomError();
    if (portCheck() === 'mismatch')
      return `The website lists this room on port ${site()?.lastPort}, but you are connected to port ${serverPort()}. A restarted room gets a new port, so this may just be an old link — check it.`;
    if (rosterCheck() === 'mismatch')
      return 'This page does not look like the room you are connected to (different players or games). Check the link.';
    return '';
  };
  const note = () => {
    const problem = warning();
    if (problem) return problem;
    const link = parsed();
    if (!link.ok) return LINK_HELP;
    if (link.kind === 'tracker')
      return 'This is a tracker link, so only lobby completion is available. Use the room page link to also get the port, activity and downloads.';
    switch (roomStatus()) {
      case 'loading':
        return roomUpdated() ? `Updated ${roomUpdated()} · refreshing…` : 'Loading room details…';
      case 'ready':
        return `Updated ${roomUpdated()}. The website refreshes tracker data about once a minute.`;
      default:
        return '';
    }
  };

  return (
    <div class="room-bar">
      <input
        class="link-input"
        type="url"
        value={draft()}
        placeholder="Room link, e.g. https://archipelago.gg/room/…  (optional)"
        title="The room's page on the website. It adds the port check, downloads and lobby completion."
        aria-label="Room link"
        spellcheck={false}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onChange={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
        }}
      />
      <button
        type="button"
        onClick={refreshSite}
        disabled={!parsed().ok || roomStatus() === 'loading' || trackerStatus() === 'loading'}
        title="Reload now. The website only refreshes tracker data about once a minute."
      >
        Refresh
      </button>
      <button
        type="button"
        onClick={() => site() && void openExternal(site()!.roomUrl)}
        disabled={!site()}
        title="Open the room's page in your browser"
      >
        Room page
      </button>
      <button
        type="button"
        onClick={() => site()?.trackerUrl && void openExternal(site()!.trackerUrl!)}
        disabled={!site()?.trackerUrl}
        title="Open the room's tracker in your browser"
      >
        Tracker
      </button>
      <p class="room-note" classList={{ warn: warning() !== '' }} title={note()} aria-live="polite">
        {note()}
      </p>
    </div>
  );
}
