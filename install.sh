#!/usr/bin/env bash
# Link this folder into the GNOME Shell extensions directory and enable it.
# On Wayland you need to log out and back in once after the first install.
set -euo pipefail
cd "$(dirname "$0")"
UUID="dynamic-island@himuraw"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

./build.sh locale
mkdir -p "$(dirname "$DEST")"
ln -sfn "$PWD" "$DEST"

# The `dynada` command for live activities from scripts and the terminal.
mkdir -p "$HOME/.local/bin"
ln -sfn "$PWD/bin/dynada" "$HOME/.local/bin/dynada"

# The shell only sees new extensions after a restart, so enable through GSettings too.
enabled=$(gsettings get org.gnome.shell enabled-extensions)
if [[ "$enabled" != *"'$UUID'"* ]]; then
    if [[ "$enabled" == "@as []" || "$enabled" == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
        gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']"
    fi
fi

echo "Installed to $DEST"
echo "Log out and back in to start it."
