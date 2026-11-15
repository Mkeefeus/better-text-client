# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A desktop text client for [Archipelago](https://archipelago.gg) multiworld randomizer rooms, for Windows and Linux. It exists because the official Kivy-based text client lags, especially while the window is resized. Responsiveness (a virtualized log, batched updates) is the point of the project; keep it in mind before adding per-message work or per-row widgets.

Stack: Tauri 2 shell + SolidJS + TypeScript + Vite, using bun as the package manager and [archipelago.js](https://www.npmjs.com/package/archipelago.js) for the protocol.

## Commands

```bash
bun install
bun run dev                     # Vite only, http://localhost:1420 (strict port). The UI runs fine in a plain browser.
bun run tauri dev               # full desktop app with hot reload
bun run tauri build [--debug]   # installers; --debug keeps devtools (right-click > Inspect)
bunx tsc --noEmit -p tsconfig.json   # type check
```

- `bun run build` is only `vite build`; it does **not** type check. Run `tsc` separately (strict, plus `noUnusedLocals` / `noUnusedParameters`).
- There is no linter and no test runner configured.
- Linux builds need the WebKitGTK dev packages. Fedora: `webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel`.
- `bun run tauri dev` loads the page over `http://`, so it does not exercise the production `tauri://localhost` origin. Test network behavior in a built binary.
- Releases: pushing a `v*` tag runs `.github/workflows/release.yml` (Windows + Ubuntu 22.04 builds, draft release, then published). The app version lives **only in `package.json`**: `src-tauri/tauri.conf.json` has `"version": "../package.json"` so Tauri reads it from there, and the `version` in `src-tauri/Cargo.toml` is unused and may be stale. The workflow fails unless the tag matches the `package.json` version (and `tauri.conf.json` still points at it), so bump `package.json` before tagging.

## Architecture

The Rust side is a thin shell. `src-tauri/src/lib.rs` only holds the leftover template `greet` command; all logic is in the TypeScript frontend, **including the WebSocket**, which archipelago.js opens from inside the webview. The CSP is `null`. Connecting from `tauri://localhost` to localhost `ws://`, LAN `ws://` and remote `wss://` was verified on Linux. Windows (WebView2) has not been tested; if it blocks `ws://`, the fallback is Tauri's websocket plugin.

Three layers under `src/`, with a strict direction:

```
adapter/archipelago.ts  ->  state/*  ->  ui/*
```

- **`adapter/archipelago.ts` is the only file allowed to import `archipelago.js`.** It converts the library's objects into the plain records in `state/types.ts` (`Message`, `Span`, `HintRow`, `HistoryRow`, `RosterEntry`). Never put library class instances into state or components.
- **`state/`** holds module-level Solid signals (`messages.ts`, `hints.ts`, `history.ts`, `connection.ts`) plus helpers: `style.ts` (flag/status to CSS class), `filtering.ts` (shared filter/sort helpers, one `Intl.Collator`), `timing.ts`. Filter and sort state for the Hints and History tabs also lives here so it survives tab switches.
- **`ui/`** and `App.tsx` are components. `App.tsx` mounts only the active tab. `FilterControls.tsx` holds the controls shared by the Hints and History tabs (player dropdowns, item-type dropdown, sort button).

### Message pipeline

- archipelago.js emits a typed event (`chat`, `itemSent`, ...) and then, synchronously, the generic `message` event. The adapter's typed handlers only record a category; the `message` handler builds the record, defaulting to `system` for untyped messages.
- Spans carry semantic CSS classes (`p-self`, `item-prog`, `loc`, `c-red`, ...), not colors. The palette lives in `:root` tokens in `src/App.css` and mirrors the official client (`NetUtils.py` in the Archipelago repo). Item flag precedence: progression, then useful, then trap. `color` parts may hold several codes separated by `;`.
- The client is created with `maximumMessages: 0` so the library does not keep a second copy of the log.
- Event handlers are wrapped in `safe()`: the library dispatches all packets of a message in one loop, so a throwing handler would drop the rest of them.
- `state/messages.ts` keeps the scrollback in one mutable array. Incoming messages are queued and flushed at most once per animation frame (`requestAnimationFrame` plus a `setTimeout` fallback for hidden windows) and trimmed in chunks. The signal uses `equals: false` because the array is mutated in place. Messages are immutable once created.

### Log view (`ui/LogView.tsx`)

Virtualized with `@tanstack/solid-virtual`, rows absolutely positioned, items keyed by message id (so measured heights survive trimming). Non-obvious points:
- Solid runs a `ref` callback before it sets `data-index` and before the element is attached, and the virtualizer needs both, so `measureElement` is deferred with `queueMicrotask`. Solid does not call refs with `null`, so `onCleanup` does that.
- Only the active tab is mounted. A hidden virtualized list measures zero-height rows.
- Stick-to-bottom detaches only on an *upward* scroll, so content growing underneath (row re-measurement) never detaches it.
- The scroll container needs a bounded height through the grid/flex chain (`minmax(0, 1fr)` / `min-height: 0` in `App.css`) or the virtualizer renders every row.

### Connection lifecycle (adapter)

- A module-level `client` plus an `isCurrent()` closure guard every callback of a given connection. `disconnect()` and `connect()` clear or replace `client` first, so late events from an old client are ignored. Keep that ordering.
- archipelago.js's `socket` emits `disconnected` only after `RoomInfo` was received; a failure before that makes `login()` reject with the reason.
- `login()` keeps waiting for its own 10 s timeout if the socket drops mid-handshake, so it is raced against a `Dropped` rejection.
- A refused login leaves the socket open; the adapter closes it.
- `sendText()` sends a raw `Say` packet (the library's `say()` waits for a chat echo). Input starting with `/` is intercepted locally and never broadcast; the official client's `/` commands are not implemented. The server broadcasts every non-admin `Say` as chat, so `!hint ...` appears in the log, followed by a private command result.

### Hints

- Hint data is not a packet stream; it is data storage. The adapter subscribes (`client.storage.notify`) to `_read_hints_{team}_{slot}` for **every** slot, so the table shows the whole room, not just the user's hints.
- Every update carries that slot's complete list. Each hint is stored under both players it involves, so lists are merged and de-duplicated by `${finderSlot}-${locationId}`; the receiver's copy wins because only the receiver can change a hint's status. Rebuilds are debounced (50 ms) and `replaceHints` reuses unchanged row objects.
- The library's own hint events (`hintReceived`, `hintFound`) ignore status changes, so they are deliberately unused.
- Name resolution: an item belongs to the **receiver's** game, a location to the **finder's** game. Build the slot lookup once per rebuild (`c.players.teams` reconstructs every `Player` on each access).

### History (found items)

- Source is raw packets only (the library's `Item`/`Player` wrappers throw for slot 0 and unknown slots). **Live:** every `PrintJSON` of type `ItemSend`; the server broadcasts these to the whole team, so finds that do not involve the user are included. **Backfill:** only the first `ReceivedItems` (`index === 0`, the full sync), skipping `location <= 0` (starting inventory and server items). Later `ReceivedItems` are ignored because `ItemSend` already reports those, with a time (the server sends `ItemSend` *before* the receiver's `ReceivedItems`).
- **Known limit:** the server never replays other players' finds, so they are only recorded from the moment the user connects; the user's own received items are complete. The protocol carries **no timestamps** for items (`NetworkItem` has none and the server does not store any), so history rows have no time. The table shows **Order** instead: `HistoryRow.seq`, 1 = oldest in the list (backfilled items first, in the order they were received, which is their real order, then live finds). `clearHistory()` restarts the numbering. The History tab explains this in a fixed note line.
- Rows are keyed `${finderSlot}-${locationId}`; the first copy wins. Hints and history share `describeFind()` in the adapter for name resolution (item in the receiver's game, location in the finder's).
- Keep or clear on reconnect is decided in the `roomInfo` handler (seed name + slot), **not after `login()` resolves**: the index-0 `ReceivedItems` normally arrives in the same websocket message as `Connected`, so a later clear would wipe the backfill. Same room and slot keeps the history; a different one clears it.
- `state/history.ts` caps the buffer (20 000 rows, trimmed in chunks) and publishes on a 200 ms timer, because `!release` / `!collect` announce thousands of items at once.
- `ui/HistoryView.tsx` is virtualized with **fixed-height single-line rows** (ellipsis plus a `title` tooltip), so it never measures rows. The header is `position: sticky` inside the scroll element; this over-includes at most one row and is absorbed by overscan. While the user is scrolled away from the top, new rows are held back (rows with a higher `seq` are hidden) and an "N new" button releases them, so the row being read does not move.

### Styling gotchas

- WebKitGTK ignores `background-color` on native `<select>`, giving light text on a light box in dark mode. `App.css` therefore draws selects itself (`appearance: none` plus a gradient arrow) and sets `color-scheme: light dark`. Keep this when restyling form controls.
- Only the server URL and slot name are persisted (`localStorage`); the password is intentionally never stored.

## Protocol references

Use the upstream Archipelago repo (`docs/network protocol.md`, `CommonClient.py`, `NetUtils.py`, `MultiServer.py`), not older forks; fork copies of the docs are stale. Two facts that differ from older docs: `GetDataPackage` requires a `games` list (omitting it returns nothing; archipelago.js handles this), and `items_handling` must be an int, never null.

## Verification

There are no automated tests in the repo. The adapter (messages, hints, history, reconnect, error paths) was checked with a throwaway mock Archipelago server that is not committed; remember that the mock must echo a `Get` request's `uuid` back in `Retrieved`, as the real server does. UI behavior, virtualization, resize smoothness and the Windows webview can only be confirmed by running the app.
