# Better Text Client for Archipelago

An unofficial desktop text client for [Archipelago](https://archipelago.gg) multiworld randomizer rooms, for Windows and Linux.

The official text client can lag, especially while its window is being resized. This client is built around keeping the interface responsive: the log only draws the lines you can see, and incoming messages are batched instead of redrawing the screen once per message.

## Features

- **Log:** chat, item sends, hints, joins and server messages, colored like the official client (progression, useful and trap items each have their own color, and your own name stands out). It follows new messages and shows a "N new" button when you scroll up.
- **Commands:** type chat, or a server command such as `!hint Item Name`, `!help` or `!release`. Up and down arrows recall what you typed earlier.
- **Hints tab:** every hint in the room, not just yours. Search by item, location, player or game (every word must match), filter by who it is for, whose world it is in, status and item type, and sort by any column.
- **History tab:** the items that have been found, with the same kind of search and filters. See the note under [Limitations](#limitations).
- **Stats tab:** how many of your checks are done and how many remain (with a progress bar and how soon your next hint is), the items you have received and the items you have sent to other players, each by type, a summary of the room's hints, the room's settings (versions, the `!release`, `!collect` and `!remaining` permissions, hint cost), and every player's status and game, including who has reached their goal. If you paste the room's tracker link (see below), it also shows how complete the whole lobby is, game by game.
- **Hint points:** your current hint points and the cost of a hint are shown at the top, next to your slot.
- **Light and dark themes:** it follows your system setting.

## Install

Downloads are on the [Releases](../../releases) page. Everything is built for 64-bit x86 (x86_64 / amd64); there are no 32-bit or ARM builds.

**Installers**

- **Windows:** `-setup.exe` and `.msi` installers.
- **Linux:** `.deb` and `.rpm` packages.

**Portable (nothing to install, run it from anywhere, delete it to remove it)**

- **Windows:** `better-text-client_<version>_x64-portable.exe`. It needs the Microsoft Edge WebView2 runtime, which Windows 11 and up-to-date Windows 10 already have. The installers download it if it is missing; the portable file cannot, so on an older Windows 10 install the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) first. It still keeps your saved server address and slot name in your user profile, not next to the executable.
- **Linux, AppImage:** `better-text-client_<version>_amd64.AppImage` (about 77 MB). It carries its own web engine, so it runs on most distributions with nothing else installed. Make it executable (`chmod +x`) and run it. If your system lacks FUSE 2, run it with `--appimage-extract-and-run`.
- **Linux, tar.gz:** `better-text-client_<version>_linux_x86_64.tar.gz` (about 2 MB). Extract it and run `./better-text-client`. It is the bare executable, so it uses your system's WebKitGTK 4.1 instead of carrying its own: install `libwebkit2gtk-4.1-0` (Debian, Ubuntu), `webkit2gtk4.1` (Fedora) or `webkit2gtk-4.1` (Arch) if you do not have it. It is built on Ubuntu 22.04, so it needs glibc 2.35 or newer. The archive includes a README with the same notes. Use the AppImage if this does not work on your system.

None of the downloads are code-signed, so Windows SmartScreen may warn you before running them.

## Using it

1. Enter the server address (`host:port`, or a full `ws://` / `wss://` address), the slot name you play as, and the room password if it has one.
2. Click **Connect**.
3. Use the **Log**, **Hints** and **History** tabs, and the box at the bottom to chat or send commands.

The server address and slot name are remembered between runs. The password is never saved.

### Lobby completion by game

The Stats tab can show how many checks are done across the whole room, game by game, with a total for the lobby. The game connection can't provide this, so it reads the Archipelago website's tracker instead:

1. Open the room's page on the website and copy the address of its **Multiworld Tracker** link (it looks like `https://archipelago.gg/tracker/…`).
2. Paste it into the **Completion by game** card on the Stats tab and press Enter.

The link is remembered for that room. The data is up to a minute old, because that is how often the website refreshes it, and it is only loaded while the Stats tab is open. This needs a room hosted on the website that has a tracker; servers you host yourself can't use it.

## Limitations

- **History starts when you connect.** The Archipelago server never replays other players' finds, so those are recorded only from the moment you connect. Items you have received are listed in full. The protocol has no timestamps for items, so the History tab shows an order number instead of a time.
- **Check progress is for your own slot only, unless you add the tracker link.** The Archipelago server only reports a slot's checked and remaining locations to the clients on that slot, so other players' check counts come only from the website's tracker (see [Lobby completion by game](#lobby-completion-by-game)).
- **No `/` commands.** The official client's client-side commands (such as `/received`) are not implemented. If you type one, it stays on your machine and is not sent to the room. `!` commands work normally.
- **No automatic reconnect.** If the connection drops, click **Connect** again.
- **Hints and history belong to a single team.** Rooms with several teams are untested.

## Building from source

You need [bun](https://bun.sh), a [Rust toolchain](https://rustup.rs) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. On Linux that includes the WebKitGTK 4.1 development packages (for example `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` on Debian and Ubuntu, or `webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel` on Fedora).

```bash
bun install
bun run dev                          # the interface in a browser at http://localhost:1420
bun run tauri dev                    # the full desktop app with hot reload
bun run tauri build                  # installers for your platform
bun run typecheck                    # type check the app and the tests (the build does not run it)
bun test                             # connection and tracker tests against mock servers
```

It is built with [Tauri](https://tauri.app) 2, [SolidJS](https://www.solidjs.com), TypeScript and [archipelago.js](https://www.npmjs.com/package/archipelago.js). [CLAUDE.md](CLAUDE.md) describes how the code is organized.

### Releasing

The app version lives in `package.json` only. Bump it, then push a matching tag such as `v0.2.0`. The GitHub Actions workflow builds the Windows and Linux installers and publishes the release.

## AI use in this project

This project was developed with [Claude Code](https://claude.com/product/claude-code), Anthropic's AI coding assistant, working from instructions given in conversation.

**Who did what**

- **The author** decided what to build and how it should behave: the goals, the choice of Tauri, SolidJS and archipelago.js, which features to include, and how the interface should look and feel. They ran the app, reported what was wrong, and decided what to change.
- **Claude Code** wrote most of the code, the GitHub Actions release workflow, `CLAUDE.md` and this README. It also researched how the Archipelago protocol and server behave by reading the official documentation and the upstream server source, and it did the debugging from the author's descriptions, error output and screenshots.

**How it was checked**

- The code is type-checked with TypeScript, and the release workflow checks that a tag matches the app version.
- The connection, message, hint, history and stats handling is covered by tests in [`tests/`](tests) that run against a mock Archipelago server (`bun test`), and a workflow runs them on Linux and Windows for every push and pull request. The mock follows the upstream server's behavior but is not a real server, and the tests do not check how the interface looks or behaves on screen.
- The author runs and tests the app on Linux. Windows builds come from CI and have had less hands-on testing.

AI-written code can contain mistakes that these checks miss, so please [open an issue](../../issues) if something behaves wrongly.
