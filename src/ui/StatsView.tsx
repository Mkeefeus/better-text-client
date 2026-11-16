import { createMemo, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { parseSiteLink } from '../adapter/tracker';
import { hintPoints, roster, serverPort, status } from '../state/connection';
import { compareText } from '../state/filtering';
import { hints } from '../state/hints';
import { checks, clientStatuses, findsSeen, received, room, sent } from '../state/stats';
import type { ItemCounts } from '../state/stats';
import { clientStatusClass, clientStatusLabel, permissionLabel } from '../state/style';
import {
  completion,
  linkTrusted,
  portCheck,
  siteLink,
  trackerError,
  trackerStatus,
  trackerUpdated,
  websiteRoom,
} from '../state/tracker';
import { openExternal } from './external';

// Every card always renders all of its rows, with "—" where there is no data yet, so nothing
// appears, disappears or shifts as data arrives.

const DASH = '—';

function count(value: number | undefined): string {
  return value === undefined ? DASH : value.toLocaleString();
}

function percent(part: number | undefined, whole: number | undefined): string {
  if (part === undefined || !whole) return DASH;
  return `${((100 * part) / whole).toFixed(1)}%`;
}

/** 7200 -> "2 h", 5400 -> "1.5 h", 600 -> "10 min". */
function formatDuration(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 1) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** "just now", "12 min ago", "3 h ago", "5 days ago". */
function ago(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const timeOfDay = (date: Date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Card(props: { title: string; note?: string; wide?: boolean; children: JSX.Element }) {
  return (
    <section class="stat-card" classList={{ wide: props.wide }}>
      <h2 class="stat-title" title={props.note}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Row(props: { label: JSX.Element; value: JSX.Element; title?: string }) {
  return (
    <div class="stat-row" title={props.title}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

const kinds = [
  { key: 'progression', label: 'Progression', cls: 'item-prog' },
  { key: 'useful', label: 'Useful', cls: 'item-useful' },
  { key: 'trap', label: 'Traps', cls: 'item-trap' },
  { key: 'filler', label: 'Filler', cls: 'item-normal' },
] as const;

/** A total with its split by item type. Shared by "Items received" and "Items sent". */
function ItemCountsCard(props: { title: string; note: string; counts: ItemCounts | undefined }) {
  return (
    <Card title={props.title} note={props.note}>
      <div class="stat-big">{count(props.counts?.total)}</div>
      <dl>
        <For each={kinds}>
          {(kind) => (
            <Row
              label={<span class={kind.cls}>{kind.label}</span>}
              value={
                props.counts
                  ? `${count(props.counts[kind.key])} (${percent(props.counts[kind.key], props.counts.total)})`
                  : DASH
              }
            />
          )}
        </For>
      </dl>
    </Card>
  );
}

export default function StatsView() {
  const connected = () => status() === 'connected';

  // --- Your checks ---
  const remaining = () => {
    const c = checks();
    return c ? c.total - c.checked : undefined;
  };
  const progress = () => {
    const c = checks();
    return c && c.total > 0 ? Math.min(100, (100 * c.checked) / c.total) : 0;
  };

  /** How close the next hint is, from points held, the cost, and points earned per check. */
  const nextHint = () => {
    const h = hintPoints();
    if (!h) return DASH;
    if (h.cost <= 0) return 'Hints are free';
    const affordable = Math.floor(h.points / h.cost);
    if (affordable >= 1) return `${affordable} hint${affordable === 1 ? '' : 's'} available`;
    if (h.perCheck <= 0) return 'No points earned per check';
    const needed = Math.ceil((h.cost - h.points) / h.perCheck);
    return `In ${needed.toLocaleString()} check${needed === 1 ? '' : 's'}`;
  };

  // --- Hints ---
  const hintSummary = createMemo(() => {
    const rows = hints();
    let found = 0;
    let unfoundForYou = 0;
    let unfoundInYourWorld = 0;
    for (const hint of rows) {
      if (hint.found) {
        found++;
        continue;
      }
      if (hint.forMe) unfoundForYou++;
      if (hint.fromMe) unfoundInYourWorld++;
    }
    return { total: rows.length, found, unfound: rows.length - found, unfoundForYou, unfoundInYourWorld };
  });
  const hintsKnown = () => connected() || hints().length > 0;
  const hintValue = (pick: (summary: ReturnType<typeof hintSummary>) => number) =>
    hintsKnown() ? count(pick(hintSummary())) : DASH;

  // --- Room and players ---
  const players = createMemo(() => roster().filter((entry) => !entry.isGroup));
  const sortedPlayers = createMemo(() =>
    [...players()].sort((a, b) => Number(b.isMe) - Number(a.isMe) || compareText(a.name, b.name)),
  );
  const goalsReached = createMemo(() => {
    const statuses = clientStatuses();
    return players().filter((player) => statuses[player.slot] === 30).length;
  });

  // --- What the website says about the room (the link is entered in RoomLinkBar) ---
  const site = () => websiteRoom();
  const portLabel = () => {
    const port = site()?.lastPort;
    if (port === undefined) return DASH;
    if (port === 0) return 'Not started yet';
    if (port < 0) return 'Failed to start';
    switch (portCheck()) {
      case 'match':
        return `${port} · matches your connection`;
      case 'mismatch':
        return `${port} · you are on ${serverPort()}`;
      default:
        return String(port);
    }
  };
  const activityLabel = () => {
    const at = site()?.lastActivity;
    return at ? `${at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (${ago(at)})` : DASH;
  };
  const shutdownLabel = () => {
    const current = site();
    if (!current || current.timeoutSeconds === undefined) return DASH;
    const after = formatDuration(current.timeoutSeconds);
    const at = current.lastActivity;
    if (!at) return `After ${after} without checks`;
    const stopAt = new Date(at.getTime() + current.timeoutSeconds * 1000);
    if (stopAt.getTime() < Date.now()) return `After ${after} without checks · probably stopped`;
    return `After ${after} without checks · at about ${timeOfDay(stopAt)}`;
  };
  const trackerLabel = () => {
    const current = site();
    if (!current) return trackerStatus() === 'ready' ? 'Yes' : DASH;
    return current.trackerId ? 'Yes' : 'No tracker for this room';
  };

  // The roster once connected; before that, the website's list (slot = position in the list).
  const tableRows = createMemo(() => {
    if (sortedPlayers().length > 0) {
      return sortedPlayers().map((player) => ({
        slot: player.slot,
        name: player.name,
        game: player.game,
        isMe: player.isMe,
        live: true,
      }));
    }
    return (site()?.players ?? []).map((player) => ({
      slot: player.slot,
      name: player.name,
      game: player.game,
      isMe: false,
      live: false,
    }));
  });
  const trackerLine = () => {
    switch (trackerStatus()) {
      case 'loading':
        return trackerUpdated() ? `Updated ${trackerUpdated()} · refreshing…` : 'Loading tracker data…';
      case 'error':
        return trackerError();
      case 'ready':
        return `Updated ${trackerUpdated()}. The website refreshes tracker data about once a minute.`;
      default:
        return '';
    }
  };
  const lobby = createMemo(() => {
    let players = 0;
    let checked = 0;
    let total = 0;
    for (const row of completion()) {
      players += row.players;
      checked += row.checked;
      total += row.total;
    }
    return { players, checked, total };
  });

  return (
    <div class="stats">
      <div class="stat-grid">
        <Card
          title="Your checks"
          note="Locations in your own slot. The server only reports these for the slot you are connected as, so other players' check progress is not available here."
        >
          <div class="stat-big">
            {count(checks()?.checked)} <span class="stat-of">/ {count(checks()?.total)}</span>{' '}
            <span class="stat-pct">{percent(checks()?.checked, checks()?.total)}</span>
          </div>
          <div
            class="bar"
            role="progressbar"
            aria-label="Locations checked"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress())}
          >
            <div class="bar-fill" style={{ width: `${progress()}%` }} />
          </div>
          <dl>
            <Row label="Completed" value={count(checks()?.checked)} />
            <Row label="Remaining" value={count(remaining())} />
            <Row
              label="Checked this session"
              value={count(checks()?.sessionChecks)}
              title="Locations that were checked after you connected"
            />
            <Row
              label="Hint points"
              value={hintPoints() ? `${hintPoints()!.points.toLocaleString()} / ${hintPoints()!.cost.toLocaleString()}` : DASH}
              title="Points you have / points needed for one hint"
            />
            <Row label="Next hint" value={nextHint()} />
          </dl>
        </Card>

        <ItemCountsCard
          title="Items received"
          note="Everything sent to you so far, including starting items."
          counts={received()}
        />

        <ItemCountsCard
          title="Items sent"
          note="Items from locations in your world that went to other players. Counted from the locations you have already checked, so it covers the whole run, not just the time since you connected. Items that stayed in your own world are not included."
          counts={sent()}
        />

        <Card title="Hints" note="Hints across the whole room.">
          <div class="stat-big">{hintValue((summary) => summary.total)}</div>
          <dl>
            <Row label="Found" value={hintValue((summary) => summary.found)} />
            <Row label="Unfound" value={hintValue((summary) => summary.unfound)} />
            <Row
              label="Unfound, for you"
              value={hintValue((summary) => summary.unfoundForYou)}
              title="Unfound hints for items you need"
            />
            <Row
              label="Unfound, in your world"
              value={hintValue((summary) => summary.unfoundInYourWorld)}
              title="Unfound hints for items that are in your world, which other players need"
            />
          </dl>
        </Card>

        <Card
          title="Room"
          wide
          note="The left column comes from the game server you are connected to. The right column comes from the room's page on the website: add its link in the bar at the top."
        >
          <div class="room-columns">
            <dl>
              <Row label="Server version" value={room()?.serverVersion ?? DASH} />
              <Row label="Generated with" value={room()?.generatorVersion ?? DASH} />
              <Row label="Seed name" value={room()?.seed ?? DASH} />
              <Row label="Players" value={connected() ? count(players().length) : DASH} />
              <Row
                label="Finds seen"
                value={connected() ? count(findsSeen()) : DASH}
                title="Items found by anyone since you connected"
              />
              <Row
                label="Hint cost"
                value={room() ? (room()!.hintCostPercent > 0 ? `${room()!.hintCostPercent}% of locations` : 'Free') : DASH}
              />
              <Row label="!release" value={permissionLabel(room()?.permissions.release)} />
              <Row label="!collect" value={permissionLabel(room()?.permissions.collect)} />
              <Row label="!remaining" value={permissionLabel(room()?.permissions.remaining)} />
            </dl>
            <dl>
              <Row
                label="Port"
                value={portLabel()}
                title="The port the website last started this room on. A restarted room can get a different port."
              />
              <Row
                label="Last activity"
                value={activityLabel()}
                title="Approximate: the website only updates this when the room saves, which happens when a check is made."
              />
              <Row
                label="Idle shutdown"
                value={shutdownLabel()}
                title="The website stops a room with no checks for this long. Opening the room page starts it again."
              />
              <Row label="Tracker" value={trackerLabel()} />
            </dl>
          </div>
        </Card>

        <Card title="Players" wide>
          <p class="stat-summary">
            Goals reached: <strong>{connected() ? count(goalsReached()) : DASH}</strong> of{' '}
            <strong>{connected() ? count(players().length) : DASH}</strong>
          </p>
          <div class="stats-table-wrap">
            <table class="stats-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Game</th>
                  <th title="Any connection counts, including text clients like this one, so “Connected” does not mean the game is running. Your own row is never Offline while you are connected here.">
                    Status
                  </th>
                  <th class="num" title="Items other players found for you, counted from everything you have received. Starting items come from the server, not a player.">
                    Sent to you
                  </th>
                  <th title="The patch or data file for this slot, from the room's page on the website. Needs the room link.">
                    Download
                  </th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={tableRows()}
                  fallback={
                    <tr>
                      <td colSpan={5} class="stat-muted">
                        {connected() ? 'No players.' : 'Connect to a room, or add its link, to see its players.'}
                      </td>
                    </tr>
                  }
                >
                  {(player) => (
                    <tr>
                      <td class={`player ${player.isMe ? 'p-self' : 'p-other'}`}>{player.name}</td>
                      <td>{player.game}</td>
                      <td>
                        <span class={`status-tag ${clientStatusClass(player.live ? clientStatuses()[player.slot] : undefined)}`}>
                          {clientStatusLabel(player.live ? clientStatuses()[player.slot] : undefined)}
                        </span>
                      </td>
                      <td class="num">
                        {player.isMe || !player.live
                          ? DASH
                          : count(received() ? (received()!.bySender[player.slot] ?? 0) : undefined)}
                      </td>
                      <td>
                        <Show when={linkTrusted() ? site()?.downloads[player.slot] : undefined} fallback={DASH}>
                          {(url) => (
                            <button type="button" class="link-button" onClick={() => void openExternal(url())}>
                              Download
                            </button>
                          )}
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Completion by game"
          wide
          note="Locations checked over all locations, summed over every player of each game. Needs the room link."
        >
          <p class="stat-note stat-status">
            {parseSiteLink(siteLink()).ok ? 'Uses the room link from the bar at the top.' : 'Add the room link in the bar at the top to fill this in.'}
          </p>
          <p class="stat-note stat-status" classList={{ warn: trackerStatus() === 'error' }} aria-live="polite">
            {trackerLine()}
          </p>
          <div class="stats-table-wrap">
            <table class="stats-table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th class="num">Players</th>
                  <th class="num">Checks</th>
                  <th>Completion</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={completion()}
                  fallback={
                    <tr>
                      <td>{DASH}</td>
                      <td class="num">{DASH}</td>
                      <td class="num">{DASH}</td>
                      <td>{DASH}</td>
                    </tr>
                  }
                >
                  {(row) => (
                    <tr>
                      <td>{row.game}</td>
                      <td class="num">{count(row.players)}</td>
                      <td class="num">
                        {count(row.checked)} / {count(row.total)}
                      </td>
                      <td>
                        <div class="completion-cell">
                          <div class="bar small" role="presentation">
                            <div class="bar-fill" style={{ width: `${(100 * row.checked) / row.total}%` }} />
                          </div>
                          <span class="completion-pct">{percent(row.checked, row.total)}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
                <tr class="total-row">
                  <td>Lobby total</td>
                  <td class="num">{completion().length > 0 ? count(lobby().players) : DASH}</td>
                  <td class="num">
                    {completion().length > 0 ? `${count(lobby().checked)} / ${count(lobby().total)}` : DASH}
                  </td>
                  <td>
                    <div class="completion-cell">
                      <div class="bar small" role="presentation">
                        <div
                          class="bar-fill"
                          style={{ width: `${lobby().total > 0 ? (100 * lobby().checked) / lobby().total : 0}%` }}
                        />
                      </div>
                      <span class="completion-pct">
                        {completion().length > 0 ? percent(lobby().checked, lobby().total) : DASH}
                      </span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
