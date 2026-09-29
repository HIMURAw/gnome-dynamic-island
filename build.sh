#!/usr/bin/env bash
# Usage:
#   ./build.sh pot      refresh po/*.pot from the source
#   ./build.sh locale   compile po/*.po into locale/ (needed when running from this folder)
#   ./build.sh pack     build the zip for extensions.gnome.org
set -euo pipefail
cd "$(dirname "$0")"
UUID="dynamic-island@himuraw"

case "${1:-locale}" in
pot)
    xgettext --from-code=UTF-8 --language=JavaScript --add-comments=Translators \
        --package-name="Dynamic Island" -o "po/$UUID.pot" extension.js
    for po in po/*.po; do msgmerge -q -U --backup=none "$po" "po/$UUID.pot"; done
    ;;
locale)
    for po in po/*.po; do
        lang=$(basename "$po" .po)
        mkdir -p "locale/$lang/LC_MESSAGES"
        msgfmt --check -o "locale/$lang/LC_MESSAGES/$UUID.mo" "$po"
    done
    ;;
pack)
    gnome-extensions pack --force --podir=po --extra-source=LICENSE .
    ;;
*)
    echo "unknown command: $1" >&2
    exit 1
    ;;
esac
