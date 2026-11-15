import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import type { VirtualItem } from '@tanstack/solid-virtual';
import { lastMessageId, messages } from '../state/messages';

/** Distance from the bottom (px) that still counts as "at the bottom". */
const STICK_THRESHOLD = 24;
const ESTIMATED_ROW_HEIGHT = 22;

function Row(props: { item: VirtualItem; measure: (element: HTMLDivElement | null) => void }) {
  // Messages are immutable, so this only changes if the scrollback shifts underneath the row.
  const message = createMemo(() => messages()[props.item.index]);

  // Solid does not call refs with null on unmount, so tell the virtualizer ourselves.
  onCleanup(() => props.measure(null));

  return (
    <div
      class={`msg cat-${message()?.category ?? ''}`}
      data-index={props.item.index}
      // Solid runs this ref before it sets data-index and before the row is in the document,
      // and the virtualizer needs both. Deferring one microtask lets the row finish rendering.
      ref={(element) => queueMicrotask(() => props.measure(element))}
      style={{ transform: `translateY(${props.item.start}px)` }}
    >
      <Show when={message()}>
        {(m) => (
          <>
            <span class="time">{m().timeLabel}</span>
            <For each={m().spans}>{(span) => <span class={span.cls}>{span.text}</span>}</For>
          </>
        )}
      </Show>
    </div>
  );
}

export default function LogView() {
  let scrollElement!: HTMLDivElement;
  const [atBottom, setAtBottom] = createSignal(true);
  const [unseen, setUnseen] = createSignal(0);
  let lastScrollTop = 0;
  let stickQueued = false;

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return messages().length;
    },
    getScrollElement: () => scrollElement,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 12,
    // Key by message id, not index, so measured heights stay valid when old messages are trimmed.
    getItemKey: (index) => messages()[index]?.id ?? index,
  });

  function scrollToBottom() {
    scrollElement.scrollTop = scrollElement.scrollHeight;
  }

  // Coalesce "stay at the bottom" requests into one per frame.
  function queueStick() {
    if (stickQueued) return;
    stickQueued = true;
    requestAnimationFrame(() => {
      stickQueued = false;
      if (atBottom()) scrollToBottom();
    });
  }

  // Follow new messages, and also row-height changes (rows are measured after they render).
  createEffect(() => {
    messages();
    virtualizer.getTotalSize();
    if (atBottom()) queueStick();
  });

  // Count messages that arrive while the user is scrolled up.
  createEffect(
    on(lastMessageId, (now, previous) => {
      if (previous !== undefined && !atBottom()) setUnseen((count) => count + (now - previous));
    }),
  );

  function onScroll() {
    const top = scrollElement.scrollTop;
    const distanceFromBottom = scrollElement.scrollHeight - top - scrollElement.clientHeight;
    if (distanceFromBottom <= STICK_THRESHOLD) {
      setAtBottom(true);
      setUnseen(0);
    } else if (top < lastScrollTop) {
      // Only an upward scroll detaches us; content growing underneath must not.
      setAtBottom(false);
    }
    lastScrollTop = top;
  }

  function jumpToLatest() {
    setAtBottom(true);
    setUnseen(0);
    scrollToBottom();
  }

  onMount(() => {
    // Window resizes change both the viewport height and (via wrapping) every row's height.
    const observer = new ResizeObserver(() => {
      if (atBottom()) queueStick();
    });
    observer.observe(scrollElement);
    onCleanup(() => observer.disconnect());
    queueStick();
  });

  return (
    <div class="log-wrap">
      <div class="log" ref={scrollElement} onScroll={onScroll}>
        <div class="log-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => <Row item={item} measure={virtualizer.measureElement} />}
          </For>
        </div>
      </div>
      <Show when={!atBottom()}>
        <button type="button" class="jump" onClick={jumpToLatest}>
          ↓ {unseen() > 0 ? `${unseen()} new` : 'Latest'}
        </button>
      </Show>
    </div>
  );
}
