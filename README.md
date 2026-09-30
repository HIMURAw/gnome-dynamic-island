# Dynamic Island for GNOME

A GNOME Shell extension that turns the top bar into a small black island in the middle
of the screen.

- **Collapsed:** a small frosted-glass pill with the time, date and battery level.
  Windows use the whole screen. When a window reaches up under the island, the island
  slides away; rest the pointer on the top edge to bring it back. Desktop icons
  (Desktop Icons NG) keep clear of it.
- **Click it:** it springs open with a large clock, remaining battery time and GNOME's
  Quick Settings right inside the island: Wi-Fi, Bluetooth, volume, brightness, power
  mode, dark style and the toggles other extensions add. A toggle's menu (the Wi-Fi
  network list, the power options) opens inline under its row. Your other extensions'
  panel icons sit on a tidy grid below. Super+S opens it too.
- **Left bubble:** the island's own notification center, in place of GNOME's calendar
  menu: this week, Do Not Disturb, and your notifications as cards you can open or
  dismiss. A red dot means something arrived you have not seen. Super+V opens it too.
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
- GNOME's Quick Settings grid, with the layer its toggle menus open in, moves into the
  island as it is, so it keeps working exactly like GNOME's and picks up toggles other
  extensions add. Its colours are restyled to the island's glass.
- Icons from the panel's left, center and right boxes move into the island. Icons that
  extensions add later move in on their own. The calendar menu and media-control
  indicators stay behind, since the bubbles already cover them. Disabling the
  extension puts every icon back where it was.
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
