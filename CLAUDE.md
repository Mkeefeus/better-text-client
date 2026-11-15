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
bun run typecheck                    # type-checks the app and the tests (tsc, two projects)
bun test                             # all tests (bun:test); bun test tests/tracker.test.ts for one file
```

- `bun run build` is only `vite build`; it does **not** type check. Run `tsc` separately (strict, plus `noUnusedLocals` / `noUnusedParameters`).
- There is no linter. Tests run with Bun's built-in runner (see Verification); `@types/bun` is only needed for type-checking them. `.github/workflows/ci.yml` runs `typecheck`, `bun test` and `bun run build` on Ubuntu and Windows for every push to `main` and every pull request.
- Linux builds need the WebKitGTK dev packages. Fedora: `webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel`.
- `bun run tauri dev` loads the page over `http://`, so it does not exercise the production `tauri://localhost` origin. Test network behavior in a built binary.
- Releases: pushing a `v*` tag runs `.github/workflows/release.yml` (Windows + Ubuntu 22.04 builds, draft release, then published). The app version lives **only in `package.json`**: `src-tauri/tauri.conf.json` has `"version": "../package.json"` so Tauri reads it from there, and the `version` in `src-tauri/Cargo.toml` is unused and may be stale. The workflow fails unless the tag matches the `package.json` version (and `tauri.conf.json` still points at it), so bump `package.json` before tagging.
- Portable builds (x86_64 only; no 32-bit or ARM builds exist): **Windows** gets the bare release executable, copied from `src-tauri/target/release/better-text-client.exe` (the Cargo package name, not `productName`) to `better-text-client_<version>_x64-portable.exe` and uploaded by a `curl` step in the `build` job to the still-draft release by **id** (drafts cannot be looked up by tag). It needs the WebView2 runtime, which a bare executable cannot bootstrap. **Linux** gets two portable downloads: the `.AppImage` that `tauri-action` already uploads (carries its own web engine, 77 MB) and a `better-text-client_<version>_linux_x86_64.tar.gz` made by the same step from `src-tauri/target/release/better-text-client` plus `packaging/linux/README.txt` (about 2 MB). The tarball's binary links the system's WebKitGTK 4.1, GTK 3 and libsoup 3 (its direct `NEEDED` libraries), so its README tells users what to install, and it needs glibc 2.35+ because it is built on Ubuntu 22.04. Keep that README in step with those requirements if they change. The Linux branch of the step was run locally against a real release build with only the upload stubbed; neither branch has run on a real CI runner yet, and the Windows exe and the Linux binary were never launched.

## Architecture

The Rust side is a thin shell. `src-tauri/src/lib.rs` only holds the leftover template `greet` command; all logic is in the TypeScript frontend, **including the WebSocket**, which archipelago.js opens from inside the webview. The CSP is `null`. Connecting from `tauri://localhost` to localhost `ws://`, LAN `ws://` and remote `wss://` was verified on Linux. Windows (WebView2) has not been tested; if it blocks `ws://`, the fallback is Tauri's websocket plugin.

Three layers under `src/`, with a strict direction:

```
adapter/*  ->  state/*  ->  ui/*
```

- **`adapter/` holds the two modules that talk to the outside world.** `archipelago.ts` is the Archipelago connection and **the only file allowed to import `archipelago.js`**; it converts the library's objects into the plain records in `state/types.ts` (`Message`, `Span`, `HintRow`, `HistoryRow`, `RosterEntry`). Never put library class instances into state or components. `tracker.ts` is plain `fetch` to the Archipelago website's tracker API (see Stats) and does not touch the library.
- **`state/`** holds module-level Solid signals (`messages.ts`, `hints.ts`, `history.ts`, `stats.ts`, `connection.ts`) plus helpers: `style.ts` (flag/status to CSS class), `filtering.ts` (shared filter/sort helpers, one `Intl.Collator`), `timing.ts`. Filter and sort state for the Hints and History tabs also lives here so it survives tab switches.
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

### Stats

- **Check progress is for the connected slot only.** `Connected` carries that slot's `checked_locations` / `missing_locations`, and the server sends later `RoomUpdate.checked_locations` only to clients on the same slot; there is no protocol way to get other slots' check lists. The card is titled "Your checks" for that reason. Whole-lobby progress comes from the WebHost tracker API instead (the "Completion by game" card, `adapter/tracker.ts`), described below.
- Checks use a `Set` of location ids because `RoomUpdate` is partial and can repeat ids; totals are `checked + missing` at connect. `resetStats()` runs at connect start, never after `login()` resolves (same trap as the history backfill).
- Items received are written **by position** across every `ReceivedItems` packet (`index === 0` starts over), so resent or duplicate packets are not double counted. Unlike History, this includes starting items and server-granted items (location <= 0).
- **Items sent** (items from our world that went to other players) are complete, not just "since connecting", because the adapter asks the server what is in the locations we have **already checked** (`LocationScouts`, `create_as_hint: 0`, in chunks of 2000; the reply is `LocationInfo`, where `player` is the *receiver*). Those items were already announced to the whole team when checked, so this reveals nothing. **Never scout unchecked locations** (that would spoil the run): the adapter only requests ids from the checked set and ignores any `LocationInfo` entry for a location outside it, or one that arrives when no request is pending. Live `ItemSend`s with `item.player === selfSlot && receiving !== selfSlot` are added, keyed by location id so repeats and the backfill overlap safely. Counts are only published after the backfill finishes (`finishSentBackfill`), so a partial number is never shown as final, then throttled on a 200 ms timer.
- Player status comes from `_read_client_status_{team}_{slot}` (`storage.notify`, like hints): 0 offline, 5 connected, 10 ready, 20 playing, 30 goal reached (permanent). Any client counts, including this text client, so 5 does not mean the game is running and the user's own row is never offline. Item-link groups are skipped (`isGroup`, from `slot_info`).
- The "Finds seen" counter increments per `ItemSend` and is published on a 200 ms timer, because `!release` can announce thousands at once. `ui/StatsView.tsx` always renders every row (with "—" for missing data) so nothing shifts as data arrives; keep it that way.

#### Completion by game (website tracker)

- Needs the room's **tracker link** pasted by the user (the "Multiworld Tracker" link on the website's room page). The tracker has its own id, separate from the room id, and only exists for rooms hosted on the website that have one; self-hosted servers cannot use it. A pasted `/room/<id>` link gets its own message. The id is passed on exactly as written (short or full UUIDs both work).
- Two endpoints, both with CORS open (`origins: *`) in the upstream code: `/api/static_tracker/<id>` (slot totals, games, item-link groups; it also contains the room's **entire data package**, so it is fetched once per link and only the small part we need is kept) and `/api/tracker/<id>` (every player's checked locations, plus items and hints we ignore). The website caches the latter for 60 s, so polling is 60 s at most and runs **only while the Stats tab is mounted** (`startTracker` / `stopTracker` in an effect with `onCleanup`).
- Per-game rows come from the pure `completionByGame()`: filtered to the user's team (`identity().team`), item-link groups and players with 0 locations excluded, checks capped at the total.
- Neither endpoint returns the seed name, so `rosterMatchesTracker()` compares who plays what against the roster and the card warns on a mismatch. Links are saved per seed in `localStorage` and never applied to a different seed.
- Stale responses are dropped with the same "is this still the current run" guard the connection uses, and every part of the card (link field, two fixed-height note lines, table, total row) always renders so an error or help text never pushes the table down.
- Not verified against a real tracker (only fixtures shaped like the upstream payloads and a mock HTTP server). A plain-`http` tracker on a LAN address may be blocked by the webview when it is served from `tauri://`; `https` sites and `http://localhost` should work.

### Styling gotchas

- WebKitGTK ignores `background-color` on native `<select>`, giving light text on a light box in dark mode. `App.css` therefore draws selects itself (`appearance: none` plus a gradient arrow) and sets `color-scheme: light dark`. Keep this when restyling form controls.
- Only the server URL and slot name are persisted (`localStorage`); the password is intentionally never stored.

## Protocol references

Use the upstream Archipelago repo (`docs/network protocol.md`, `CommonClient.py`, `NetUtils.py`, `MultiServer.py`), not older forks; fork copies of the docs are stale. Two facts that differ from older docs: `GetDataPackage` requires a `games` list (omitting it returns nothing; archipelago.js handles this), and `items_handling` must be an int, never null.

## Verification

Tests live in `tests/` and use `bun:test` (`bun test`, which finds `*.test.ts`). CI runs them (see Commands).

- `tests/protocol.test.ts` runs the real adapter (`src/adapter/archipelago.ts`) and state modules against a **mock Archipelago server** (`Bun.serve` websocket) and asserts on the resulting state: login, the message log, hints, History, Stats (checks, received and sent items, player status, room info) and the error paths (refusal, drop mid-login, unreachable). Keep the mock faithful to upstream `MultiServer.py`: `Connected`, the full `ReceivedItems` sync and the join message arrive in **one** websocket message, `Get` must echo the request's `uuid` in `Retrieved`, hints are stored under both players they involve, and `LocationInfo.player` is the item's receiver.
- `tests/tracker.test.ts` covers the tracker link parser, the per-game aggregation and the wrong-room guard (pure functions), and the fetch/poll flow against a mock HTTP server serving fixtures shaped like the upstream `/api/static_tracker` and `/api/tracker` payloads.
- `bunfig.toml` preloads `tests/setup.ts` before every test file: it stubs `requestAnimationFrame`. Under `bun test`, `solid-js` resolves to its server build where signals are plain getters and setters, which is what these tests want (they read state, not the DOM). They cannot test rendering.
- **Both files are scenarios, not independent unit tests:** one connection (or one tracker run) is carried from test to test, so they must run in file order and `.only` / `.skip` will break the tests after them.
- **Do not sleep; wait for the state you expect** with `until()` from `tests/helpers.ts`, so the tests are fast on a fast machine and do not flake on a slow CI runner. For a "this must NOT happen" check, send an event that *does* count right after it, wait for that, and only then assert: messages are handled in order, so the earlier one has certainly been processed.
- `tests/tsconfig.json` type-checks the tests with the Bun types, separate from the app's `tsconfig.json` so Bun globals do not leak into the frontend.

Not covered by any test: UI behavior, virtualization, resize smoothness, styling, and the Windows webview. Those can only be confirmed by running the app. The tracker code has only been run against mock data, never a real tracker.
