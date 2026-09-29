#!/usr/bin/env bash
# Eklentiyi bu klasöre sembolik bağla ve etkinleştir. Wayland'de ilk kurulumdan sonra
# oturumu kapatıp açmak gerekir; sonraki kod değişikliklerinde de aynısı geçerli.
set -euo pipefail
UUID="dinamik-ada@himuraw"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$(dirname "$DEST")"
ln -sfn "$(cd "$(dirname "$0")" && pwd)" "$DEST"
gnome-extensions enable "$UUID" 2>/dev/null || true
echo "Kuruldu: $DEST"
echo "Oturumu kapatıp aç, sonra: gnome-extensions info $UUID"
