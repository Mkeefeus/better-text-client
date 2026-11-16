# Better Text Client for Archipelago

An unofficial desktop text client for [Archipelago](https://archipelago.gg) multiworld randomizer rooms, for Windows and Linux.

The official text client can lag, especially while its window is being resized. This client is built around keeping the interface responsive: the log only draws the lines you can see, and incoming messages are batched instead of redrawing the screen once per message.

## Features

- **Log:** chat, item sends, hints, joins and server messages, colored like the official client (progression, useful and trap items each have their own color, and your own name stands out). It follows new messages and shows a "N new" button when you scroll up.
- **Commands:** type chat, or a server command such as `!hint Item Name`, `!help` or `!release`. Up and down arrows recall what you typed earlier.
- **Hints tab:** every hint in the room, not just yours. Search by item, location, player or game (every word must match), filter by who it is for, whose world it is in, status and item type, and sort by any column.
- **History tab:** the items that have been found and when, with the same kind of search and filters. It is kept between runs, per room and slot. Finds made while the client was closed are filled in when you reconnect, at an estimated time marked ≈. See the note under [Limitations](#limitations).
- **Stats tab:** how many of your checks are done and how many remain (with a progress bar and how soon your next hint is), the items you have received and the items you have sent to other players, each by type, a summary of the room's hints, the room's settings (versions, the `!release`, `!collect` and `!remaining` permissions, hint cost), and every player's status and game, including who has reached their goal. If you paste the room's page link (see below), it also shows how complete the whole lobby is, game by game, and what the website knows about the room (port, last activity, downloads).
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

The server address and slot name are remembered between runs, and so is each room's History (the last 10 rooms). The password is never saved.

### The room link: lobby completion, port, activity and downloads

The game connection only tells this client about your own slot. Paste the room's page address from the website (it looks like `https://archipelago.gg/room/…`) into the **room link bar** under the connection bar and press Enter, and the client also reads what the website knows about the room (shown on the Stats tab):

- **Completion by game:** how many checks are done across the whole lobby, game by game, with a total. (The server's `!status` command can report per-player counts, but using it posts a line in the room's chat for everyone, so this client does not.)
- **Port, last activity and idle shutdown:** the port the website started the room on (compared with the one you are connected to), when the room last saved (roughly, when a check was last made), and when the website will stop an idle room.
- **Downloads:** a Download button per player in the Players table, plus buttons that open the room page and the tracker in your browser.
- **A complete History:** the tracker lists every player's received items, so with the link set the History tab also gets the finds between other players that were made while this client was closed or disconnected. They are placed, at an estimated time, in the stretch when you were away. It is only used when it agrees with what the game connection says you received, so a tracker from a different room is ignored.
- **Players before you connect:** the Players table fills in from the website's list.

The link is remembered for a room once the port or the players match the room you are connected to, so a wrong paste is never saved. The data is up to a minute old, because that is how often the website refreshes it, and it is refreshed in the background, about once a minute, for as long as a link is set. A tracker link (`…/tracker/…`) also works but only gives the completion table. This needs a room hosted on the website; servers you host yourself can't use it, and a room without a tracker can't show completion.

## Limitations

- **History times are exact only for finds the client saw happen.** Archipelago records no time for found items, so a find gets its real time only if this client was connected when it happened. The History is saved per room, so those times are kept between runs. Finds made while the client was closed are filled in when you reconnect and given an estimated time (≈) in the stretch you were away; each player's items still appear in their real order. Short absences come out close (in a test against a real room's server log, an hour away put most finds within minutes). A long absence spreads its finds evenly over the whole time, even across a stretch when nothing happened, such as a server shut down overnight. Finds from before you first joined a room have no time at all and show as "earlier".
- **History can miss finds between other players unless you add the room link.** Your own received and sent items are always filled in. Other players' finds made while you were away are only filled in from the website's tracker (see [The room link](#the-room-link-lobby-completion-port-activity-and-downloads)), which needs a room hosted on the website with a tracker. Without it, those are recorded only while you are connected.
- **Check progress is for your own slot only, unless you add the room link.** The Archipelago server only sends a slot's checked and remaining locations to the clients on that slot, so this client shows other players' check counts only from the website's tracker (see [The room link](#the-room-link-lobby-completion-port-activity-and-downloads)). The server's `!status` command reports each player's checks as a count, but it posts the command to the room's chat, and no normal request returns *which* locations other players have checked.
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
