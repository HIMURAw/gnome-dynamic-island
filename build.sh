#!/usr/bin/env bash
# Usage:
#   ./build.sh pot      refresh po/*.pot from the source
#   ./build.sh locale   compile translations and schemas (needed when running from this folder)
#   ./build.sh pack     build the zip for extensions.gnome.org and GitHub releases
set -euo pipefail
cd "$(dirname "$0")"
UUID="dynamic-island@himuraw"

case "${1:-locale}" in
pot)
    xgettext --from-code=UTF-8 --language=JavaScript --add-comments=Translators \
        --package-name="Dynamic Island" -o "po/$UUID.pot" extension.js prefs.js center.js quicksettings.js apps.js
    for po in po/*.po; do msgmerge -q -U --backup=none "$po" "po/$UUID.pot"; done
    ;;
locale)
    # Compiled schemas are needed when running straight from this folder.
    glib-compile-schemas --strict schemas
    for po in po/*.po; do
        lang=$(basename "$po" .po)
        mkdir -p "locale/$lang/LC_MESSAGES"
        msgfmt --check -o "locale/$lang/LC_MESSAGES/$UUID.mo" "$po"
    done
    ;;
pack)
    # The same zip either way; without GNOME's tools (in CI) it is put together by hand.
    sources=(metadata.json stylesheet.css LICENSE icons schemas/*.gschema.xml)
    for js in *.js; do [[ "$js" == eslint.config.js ]] || sources+=("$js"); done
    if command -v gnome-extensions >/dev/null; then
        extra=()
        for f in "${sources[@]}"; do
            case "$f" in
            metadata.json|stylesheet.css|extension.js|prefs.js|schemas/*) ;;
            *) extra+=("--extra-source=$f") ;;
            esac
        done
        gnome-extensions pack --force --podir=po \
            --schema=schemas/org.gnome.shell.extensions.dynamic-island.gschema.xml "${extra[@]}" .
    else
        "$0" locale
        rm -f "$UUID.shell-extension.zip"
        zip -qr "$UUID.shell-extension.zip" "${sources[@]}" locale
    fi
    ;;
*)
    echo "unknown command: $1" >&2
    exit 1
    ;;
esac
