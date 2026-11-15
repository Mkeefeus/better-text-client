# Better Text Client for Archipelago

An unofficial desktop text client for [Archipelago](https://archipelago.gg) multiworld randomizer rooms, for Windows and Linux.

The official text client can lag, especially while its window is being resized. This client is built around keeping the interface responsive: the log only draws the lines you can see, and incoming messages are batched instead of redrawing the screen once per message.

## Features

- **Log:** chat, item sends, hints, joins and server messages, colored like the official client (progression, useful and trap items each have their own color, and your own name stands out). It follows new messages and shows a "N new" button when you scroll up.
- **Commands:** type chat, or a server command such as `!hint Item Name`, `!help` or `!release`. Up and down arrows recall what you typed earlier.
- **Hints tab:** every hint in the room, not just yours. Search by item, location, player or game (every word must match), filter by who it is for, whose world it is in, status and item type, and sort by any column. The toolbar shows your hint points.
- **History tab:** the items that have been found, with the same kind of search and filters. See the note under [Limitations](#limitations).
- **Light and dark themes:** it follows your system setting.

## Install

Installers are published on the [Releases](../../releases) page:

- **Windows:** `.exe` and `.msi` installers.
- **Linux:** `.deb`, `.rpm` and AppImage packages.

The installers are not code-signed, so Windows SmartScreen may warn you before running them.

## Using it

1. Enter the server address (`host:port`, or a full `ws://` / `wss://` address), the slot name you play as, and the room password if it has one.
2. Click **Connect**.
3. Use the **Log**, **Hints** and **History** tabs, and the box at the bottom to chat or send commands.

The server address and slot name are remembered between runs. The password is never saved.

## Limitations

- **History starts when you connect.** The Archipelago server never replays other players' finds, so those are recorded only from the moment you connect. Items you have received are listed in full. The protocol has no timestamps for items, so the History tab shows an order number instead of a time.
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
bunx tsc --noEmit -p tsconfig.json   # type check (the build does not run it)
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
- The connection and message handling were exercised during development against a throwaway mock Archipelago server written for the purpose. It is not part of this repository, and there is no automated test suite.
- The author runs and tests the app on Linux. Windows builds come from CI and have had less hands-on testing.

AI-written code can contain mistakes that these checks miss, so please [open an issue](../../issues) if something behaves wrongly.
