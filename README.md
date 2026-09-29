# Dynamic Island for GNOME

A GNOME Shell extension that turns the top bar into a small black island in the middle
of the screen.

- **Collapsed:** a small frosted-glass pill with the time, date and battery level.
  Windows use the whole screen; the island floats over them.
- **Click it:** it springs open with a large clock, remaining battery time, a volume
  slider and every panel icon (Quick Settings and your other extensions) laid out as
  tidy chips.
- **Left bubble:** notifications and the calendar.
- **Right bubble:** what is playing right now, from Spotify, a browser video or any
  MPRIS player. Click it for cover art, progress and play/pause/next/previous.
- **Fullscreen:** the island slides away. Push the pointer to the top edge to bring it back.
- **Closing:** click the clock or move the pointer away. It stays open while a menu is open.

The text follows your system language. Translations live in `po/`.

Works on GNOME Shell 48, 49 and 50. Built and used on Fedora.

## Install

```bash
git clone https://github.com/HIMURAw/gnome-dynamic-island.git
cd gnome-dynamic-island
./install.sh
```

Then log out and back in. Wayland only loads new extensions at login.

To turn it off and get the normal top bar back:

```bash
gnome-extensions disable dynamic-island@himuraw
```

## How it works

- The top bar (`Main.panel`) is hidden, not removed, and reserves no space.
- Icons from the panel's left, center and right boxes move into the island. Icons that
  extensions add later move in on their own. Disabling the extension puts every icon
  back where it was.
- The glass is a blurred clone of the windows behind the island, clipped to a rounded
  shape by a small shader (`glass.js`). Motion uses a damped spring (`spring.js`).

## Development

Test in a nested session so you do not have to log out:

```bash
sudo dnf install mutter-devkit   # Fedora
./build.sh locale
dbus-run-session gnome-shell --devkit --wayland
```

Logs: `journalctl -f -o cat /usr/bin/gnome-shell`

`./build.sh pot` refreshes the translation template after changing strings.
`./build.sh pack` builds the zip for extensions.gnome.org.

## Translating

Copy `po/dynamic-island@himuraw.pot` to `po/<language>.po`, fill in the `msgstr` lines
and open a pull request.

## License

GPL-3.0-or-later
