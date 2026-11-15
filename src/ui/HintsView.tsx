import { createMemo, For, onMount, Show } from 'solid-js';
import { status } from '../state/connection';
import { compareText, matchesClass, searchTerms } from '../state/filtering';
import {
  classFilter,
  finderFilter,
  foundFilter,
  hintFiltersActive,
  hints,
  mineOnly,
  receiverFilter,
  resetHintFilters,
  searchText,
  setClassFilter,
  setFinderFilter,
  setFoundFilter,
  setMineOnly,
  setReceiverFilter,
  setSearchText,
  setSortDir,
  setSortKey,
  setStatusFilter,
  sortDir,
  sortKey,
  statusFilter,
} from '../state/hints';
import type { FoundFilter, SortKey, StatusFilter } from '../state/hints';
import { itemClass, statusClass, statusLabel, statusRank } from '../state/style';
import type { HintRow } from '../state/types';
import { ItemTypeSelect, PlayerSelect, SortButton } from './FilterControls';

// --- Filtering and sorting (pure functions) ------------------------------------

function matchesStatus(row: HintRow, filter: StatusFilter): boolean {
  switch (filter) {
    case 'priority':
      return row.status === 30;
    case 'unspecified':
      return row.status === 0;
    case 'no-priority':
      return row.status === 10;
    case 'avoid':
      return row.status === 20;
    default:
      return true;
  }
}

/** Unfound first, then by status (priority first), then by item name. */
function compareDefault(a: HintRow, b: HintRow): number {
  if (a.found !== b.found) return a.found ? 1 : -1;
  const byStatus = statusRank(a.status) - statusRank(b.status);
  if (byStatus !== 0) return byStatus;
  return compareText(a.itemName, b.itemName) || compareText(a.locationName, b.locationName);
}

function compareBy(key: SortKey): (a: HintRow, b: HintRow) => number {
  switch (key) {
    case 'item':
      return (a, b) => compareText(a.itemName, b.itemName);
    case 'location':
      return (a, b) => compareText(a.locationName, b.locationName);
    case 'finder':
      return (a, b) => compareText(a.finderName, b.finderName);
    case 'receiver':
      return (a, b) => compareText(a.receiverName, b.receiverName);
    case 'entrance':
      return (a, b) => compareText(a.entrance, b.entrance);
    case 'status':
      return (a, b) => statusRank(a.status) - statusRank(b.status);
    case 'found':
      return (a, b) => Number(a.found) - Number(b.found);
    default:
      return compareDefault;
  }
}

// --- Component -----------------------------------------------------------------

export default function HintsView() {
  let searchElement!: HTMLInputElement;

  onMount(() => searchElement.focus());

  const visible = createMemo(() => {
    const terms = searchTerms(searchText());
    const found = foundFilter();
    const receiver = receiverFilter();
    const finder = finderFilter();
    const mine = mineOnly();
    const statusF = statusFilter();
    const classF = classFilter();

    const rows = hints().filter((row) => {
      if (found === 'unfound' && row.found) return false;
      if (found === 'found' && !row.found) return false;
      if (receiver && String(row.receiverSlot) !== receiver) return false;
      if (finder && String(row.finderSlot) !== finder) return false;
      if (mine && !row.forMe && !row.fromMe) return false;
      if (!matchesStatus(row, statusF) || !matchesClass(row.itemFlags, classF)) return false;
      // Every search word must appear somewhere in the row.
      return terms.every((term) => row.search.includes(term));
    });

    const compare = compareBy(sortKey());
    const direction = sortKey() !== 'default' && sortDir() === 'desc' ? -1 : 1;
    return rows.sort((a, b) => direction * compare(a, b));
  });

  /** Click a header: ascending, then descending, then back to the default order. */
  function toggleSort(key: SortKey) {
    if (sortKey() !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else if (sortDir() === 'asc') {
      setSortDir('desc');
    } else {
      setSortKey('default');
      setSortDir('asc');
    }
  }

  function SortHeader(props: { key: SortKey; children: string }) {
    return (
      <th>
        <SortButton active={sortKey() === props.key} dir={sortDir()} onClick={() => toggleSort(props.key)}>
          {props.children}
        </SortButton>
      </th>
    );
  }

  return (
    <div class="hints">
      <div class="hints-toolbar">
        <div class="search">
          <input
            ref={searchElement}
            type="search"
            value={searchText()}
            onInput={(event) => setSearchText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSearchText('');
            }}
            placeholder="Search items, locations, players, games…  (all words must match)"
            aria-label="Search hints"
            spellcheck={false}
          />
        </div>

        <label>
          Show
          <select value={foundFilter()} onChange={(event) => setFoundFilter(event.currentTarget.value as FoundFilter)}>
            <option value="unfound">Unfound</option>
            <option value="found">Found</option>
            <option value="all">All</option>
          </select>
        </label>

        <PlayerSelect
          label="For"
          title="Only hints for items this player needs (the “For” column)"
          value={receiverFilter()}
          onChange={setReceiverFilter}
        />

        <PlayerSelect
          label="Found in"
          title="Only hints for items located in this player's world (the “Found in” column)"
          value={finderFilter()}
          onChange={setFinderFilter}
        />

        <label class="check" title="Only hints where you are the player who needs the item or the player who holds it">
          <input type="checkbox" checked={mineOnly()} onChange={(event) => setMineOnly(event.currentTarget.checked)} />
          Only my hints
        </label>

        <label>
          Status
          <select
            value={statusFilter()}
            onChange={(event) => setStatusFilter(event.currentTarget.value as StatusFilter)}
          >
            <option value="any">Any</option>
            <option value="priority">Priority</option>
            <option value="unspecified">Unspecified</option>
            <option value="no-priority">No priority</option>
            <option value="avoid">Avoid</option>
          </select>
        </label>

        <ItemTypeSelect value={classFilter()} onChange={setClassFilter} />

        {/* Always rendered (just disabled) so the toolbar does not reflow when filters change. */}
        <button type="button" onClick={resetHintFilters} disabled={!hintFiltersActive()}>
          Reset filters
        </button>

        <div class="hint-meta">
          <span class="hint-count" aria-live="polite">
            {visible().length} of {hints().length} hints
          </span>
        </div>
      </div>

      <div class="hints-scroll">
        <Show
          when={visible().length > 0}
          fallback={
            <p class="empty">
              {status() !== 'connected'
                ? 'Connect to a room to see your hints.'
                : hints().length === 0
                  ? 'No hints in this room yet. Ask for one with  !hint Item Name  in the box below.'
                  : 'No hints match these filters.'}
            </p>
          }
        >
          <table class="hints-table">
            <thead>
              <tr>
                <SortHeader key="item">Item</SortHeader>
                <SortHeader key="location">Location</SortHeader>
                <SortHeader key="finder">Found in</SortHeader>
                <SortHeader key="receiver">For</SortHeader>
                <SortHeader key="entrance">Entrance</SortHeader>
                <SortHeader key="status">Status</SortHeader>
                <SortHeader key="found">Found</SortHeader>
              </tr>
            </thead>
            <tbody>
              <For each={visible()}>
                {(row) => (
                  <tr classList={{ 'row-found': row.found }}>
                    <td>
                      <span class={itemClass(row.itemFlags)}>{row.itemName}</span>
                      <span class="sub">{row.receiverGame}</span>
                    </td>
                    <td>
                      <span class="loc">{row.locationName}</span>
                      <span class="sub">{row.finderGame}</span>
                    </td>
                    <td class={`player ${row.fromMe ? 'p-self' : 'p-other'}`}>{row.finderName}</td>
                    <td class={`player ${row.forMe ? 'p-self' : 'p-other'}`}>{row.receiverName}</td>
                    <td class="entrance">{row.entrance || '—'}</td>
                    <td>
                      <span class={`status-tag ${statusClass(row.status)}`}>{statusLabel(row.status)}</span>
                    </td>
                    <td class="found-cell">{row.found ? '✓' : ''}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  );
}
