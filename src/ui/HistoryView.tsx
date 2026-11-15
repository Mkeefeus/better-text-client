import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { status } from '../state/connection';
import { compareText, matchesClass, searchTerms } from '../state/filtering';
import {
  history,
  historyClass,
  historyFiltersActive,
  historyFinder,
  historyMineOnly,
  historyReceiver,
  historySearch,
  historySortDir,
  historySortKey,
  newestSeq,
  resetHistoryFilters,
  setHistoryClass,
  setHistoryFinder,
  setHistoryMineOnly,
  setHistoryReceiver,
  setHistorySearch,
  setHistorySortDir,
  setHistorySortKey,
} from '../state/history';
import type { HistorySortKey } from '../state/history';
import { itemClass } from '../state/style';
import type { HistoryRow } from '../state/types';
import { ItemTypeSelect, PlayerSelect, SortButton } from './FilterControls';

/**
 * Fixed row height: every row is a single line (long names are cut off with an ellipsis and
 * shown in full as a tooltip), so the virtualizer never has to measure rows.
 */
const ROW_HEIGHT = 28;

function compareBy(key: HistorySortKey): (a: HistoryRow, b: HistoryRow) => number {
  switch (key) {
    case 'item':
      return (a, b) => compareText(a.itemName, b.itemName);
    case 'location':
      return (a, b) => compareText(a.locationName, b.locationName);
    case 'finder':
      return (a, b) => compareText(a.finderName, b.finderName);
    case 'receiver':
      return (a, b) => compareText(a.receiverName, b.receiverName);
    default:
      return (a, b) => a.seq - b.seq;
  }
}

export default function HistoryView() {
  let searchElement!: HTMLInputElement;
  let scrollElement!: HTMLDivElement;

  onMount(() => searchElement.focus());

  /**
   * While the user is scrolled away from the top, new rows are held back (rows with a higher
   * sequence number than this are hidden), so the row they are reading does not move. The
   * "N new" button releases them.
   */
  const [frozenSeq, setFrozenSeq] = createSignal<number | undefined>();
  const pending = () => {
    const frozen = frozenSeq();
    return frozen === undefined ? 0 : newestSeq() - frozen;
  };
  /** Oldest-first by time appends at the bottom, which never moves what is being read. */
  const canFreeze = () => !(historySortKey() === 'order' && historySortDir() === 'asc');

  const visible = createMemo(() => {
    const limit = frozenSeq();
    const terms = searchTerms(historySearch());
    const receiver = historyReceiver();
    const finder = historyFinder();
    const mine = historyMineOnly();
    const classF = historyClass();

    const rows = history().filter((row) => {
      if (limit !== undefined && row.seq > limit) return false;
      if (receiver && String(row.receiverSlot) !== receiver) return false;
      if (finder && String(row.finderSlot) !== finder) return false;
      if (mine && !row.forMe && !row.fromMe) return false;
      if (!matchesClass(row.itemFlags, classF)) return false;
      return terms.every((term) => row.search.includes(term));
    });

    const key = historySortKey();
    const descending = historySortDir() === 'desc';
    if (key === 'order') {
      // The history is already in order, so newest-first is just the reverse.
      return descending ? rows.reverse() : rows;
    }
    const compare = compareBy(key);
    return rows.sort((a, b) => (descending ? -1 : 1) * compare(a, b));
  });

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return visible().length;
    },
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
  });

  function onScroll() {
    const top = scrollElement.scrollTop;
    if (frozenSeq() === undefined) {
      if (top > ROW_HEIGHT * 2 && canFreeze()) setFrozenSeq(newestSeq());
    } else if (top <= ROW_HEIGHT) {
      setFrozenSeq(undefined);
    }
  }

  function showNew() {
    setFrozenSeq(undefined);
    scrollElement.scrollTop = 0;
  }

  function toggleSort(key: HistorySortKey) {
    if (historySortKey() === key) {
      setHistorySortDir(historySortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      setHistorySortKey(key);
      // Newest first is the useful way to read the order column; names read best A to Z.
      setHistorySortDir(key === 'order' ? 'desc' : 'asc');
    }
  }

  function HeaderCell(props: { key: HistorySortKey; children: string; title?: string }) {
    return (
      <div class="hist-hcell" title={props.title}>
        <SortButton
          active={historySortKey() === props.key}
          dir={historySortDir()}
          onClick={() => toggleSort(props.key)}
        >
          {props.children}
        </SortButton>
      </div>
    );
  }

  return (
    <div class="hist">
      {/* Reuses the Hints toolbar styles. */}
      <div class="hints-toolbar">
        <div class="search">
          <input
            ref={searchElement}
            type="search"
            value={historySearch()}
            onInput={(event) => setHistorySearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setHistorySearch('');
            }}
            placeholder="Search items, locations, players, games…  (all words must match)"
            aria-label="Search found items"
            spellcheck={false}
          />
        </div>

        <PlayerSelect
          label="For"
          title="Only items this player received (the “For” column)"
          value={historyReceiver()}
          onChange={setHistoryReceiver}
        />

        <PlayerSelect
          label="Found in"
          title="Only items that were in this player's world (the “Found in” column)"
          value={historyFinder()}
          onChange={setHistoryFinder}
        />

        <label class="check" title="Only items where you are the player who received it or the player who found it">
          <input
            type="checkbox"
            checked={historyMineOnly()}
            onChange={(event) => setHistoryMineOnly(event.currentTarget.checked)}
          />
          Only my items
        </label>

        <ItemTypeSelect value={historyClass()} onChange={setHistoryClass} />

        {/* Always rendered (just disabled) so the toolbar does not reflow when filters change. */}
        <button type="button" onClick={resetHistoryFilters} disabled={!historyFiltersActive()}>
          Reset filters
        </button>

        <div class="hint-meta">
          <span class="hint-count" aria-live="polite">
            {visible().length} of {history().length} items
          </span>
        </div>
      </div>

      {/* A fixed line, so it never shifts the table. */}
      <p class="hist-note">
        Items found by other players are recorded from the moment you connect. Items you have received are listed in
        full. Order counts items in this list, oldest first.
      </p>

      <div class="hist-wrap">
        <div class="hist-scroll" ref={scrollElement} onScroll={onScroll}>
          <Show
            when={visible().length > 0}
            fallback={
              <p class="empty">
                {history().length > 0
                  ? 'No items match these filters.'
                  : status() === 'connected'
                    ? 'No items found yet. New finds show up here as they happen.'
                    : 'Connect to a room to see found items.'}
              </p>
            }
          >
            <div class="hist-inner">
              <div class="hist-head">
                <HeaderCell
                  key="order"
                  title="1 is the oldest item in this list. The list holds your received items plus finds seen since you connected."
                >
                  Order
                </HeaderCell>
                <HeaderCell key="item">Item</HeaderCell>
                <HeaderCell key="location">Location</HeaderCell>
                <HeaderCell key="finder">Found in</HeaderCell>
                <HeaderCell key="receiver">For</HeaderCell>
              </div>
              <div class="hist-body" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                <For each={virtualizer.getVirtualItems()}>
                  {(item) => {
                    const row = createMemo(() => visible()[item.index]);
                    return (
                      <div
                        class="hist-row"
                        style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${item.start}px)` }}
                      >
                        <Show when={row()}>
                          {(r) => (
                            <>
                              <div class="cell order">{r().seq}</div>
                              <div class="cell" title={`${r().itemName} (${r().receiverGame})`}>
                                <span class={itemClass(r().itemFlags)}>{r().itemName}</span>
                              </div>
                              <div class="cell" title={`${r().locationName} (${r().finderGame})`}>
                                <span class="loc">{r().locationName}</span>
                              </div>
                              <div class={`cell ${r().fromMe ? 'p-self' : 'p-other'}`} title={r().finderName}>
                                {r().finderName}
                              </div>
                              <div class={`cell ${r().forMe ? 'p-self' : 'p-other'}`} title={r().receiverName}>
                                {r().receiverName}
                              </div>
                            </>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
        </div>

        <Show when={pending() > 0}>
          <button type="button" class="hist-pill" onClick={showNew}>
            ↑ {pending()} new
          </button>
        </Show>
      </div>
    </div>
  );
}
