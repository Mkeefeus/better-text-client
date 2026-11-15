Better Text Client - portable Linux build (x86_64)

A text client for Archipelago multiworld rooms.

RUN IT

    ./better-text-client

Nothing is installed. Keep this folder anywhere you like, and delete it to remove the program.
(If it will not start, make the file executable first: chmod +x better-text-client)

WHAT YOUR SYSTEM NEEDS

This build uses your system's web engine instead of carrying its own, so WebKitGTK 4.1 (which
brings GTK 3 and libsoup 3 with it) must be installed:

    Debian / Ubuntu:  sudo apt install libwebkit2gtk-4.1-0
    Fedora:           sudo dnf install webkit2gtk4.1
    Arch:             sudo pacman -S webkit2gtk-4.1

It was built on Ubuntu 22.04, so it needs glibc 2.35 or newer (Ubuntu 22.04 and later, Debian 12
and later, Fedora 36 and later, current Arch, and most distributions of similar age or newer).

If it does not work on your system, use the .AppImage from the same release instead. It carries
what it needs and runs on older systems too.

WHERE YOUR SETTINGS ARE

The last server address, slot name and tracker links are saved by the web engine in
~/.local/share/com.mkeefeus.better-text-client (and a cache folder under ~/.cache). The password
is never saved. Delete that folder to forget them.

MORE

Downloads, source code and documentation: the project's GitHub page, from the release you
downloaded this from.
