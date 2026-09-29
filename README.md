# Dynamic Island for GNOME

A GNOME Shell extension that turns the top bar into a small black island in the middle
of the screen.

- **Collapsed:** time, date and battery level.
- **Click it:** it springs open with a large clock, remaining battery time, a volume
  slider and every panel icon: Quick Settings, the calendar and icons from your other
  extensions.
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

- The top bar (`Main.panel`) is hidden, not removed. A 40 px transparent strip takes its
  place, so maximized windows stay below the island. Set `STRIP_HEIGHT` in
  `extension.js` to `0` if you want the island to float over windows.
- Icons from the panel's left, center and right boxes move into the island. Icons that
  extensions add later move in on their own. Disabling the extension puts every icon
  back where it was.

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
