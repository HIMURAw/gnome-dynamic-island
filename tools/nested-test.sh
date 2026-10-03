#!/bin/bash
# Run a script of steps against the extension in a nested GNOME Shell, without
# touching the real session more than it has to.
#
#   tools/nested-test.sh steps.sh [outdir]
#
# A steps file is bash, sourced inside the nested session, with:
#   ev 'JS'      evaluate in the nested shell (X is the extension object)
#   shot NAME    screenshot to OUT/NAME.png
# The nested session shares dconf, /run/user/$UID and the data directories with
# the real one, so afterwards: the "extensions disabled" marker it leaves is
# removed, the document portal it unmounts is restarted, and the chat history is
# put back as it was.
set -u
steps=$(realpath "$1")
OUT=$(realpath "${2:-${TMPDIR:-/tmp}/dynada-nested}")
mkdir -p "$OUT"
uid=$(id -u)
history="${XDG_DATA_HOME:-$HOME/.local/share}/dynamic-island/chat.json"
marker="/run/user/$uid/gnome-shell-disable-extensions"
had_marker=0; [ -e "$marker" ] && had_marker=1
[ -f "$history" ] && cp -a "$history" "$OUT/chat.backup.json"

inner=$(mktemp)
cat >"$inner" <<'INNER'
#!/bin/bash
gnome-shell --devkit --wayland --unsafe-mode --virtual-monitor 1600x1000 >"$OUT/shell.log" 2>&1 </dev/null &
PID=$!
for _ in $(seq 40); do
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval '1' \
    2>/dev/null | grep -q true && break
  sleep 0.5
done
sleep 4
X="Main.extensionManager.lookup('dynamic-island@himuraw').stateObj"
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" >/dev/null; }
ev "Main.screenShield.deactivate(false); const m=Main.extensionManager; if (m.lookup('dynamic-island@himuraw').state !== 1) m.enableExtension('dynamic-island@himuraw'); 'ready'" >/dev/null
sleep 3
source "$STEPS"
kill $PID; wait $PID 2>/dev/null
INNER
chmod +x "$inner"
OUT="$OUT" STEPS="$steps" timeout "${TEST_TIMEOUT:-150}" dbus-run-session -- "$inner" 2>/dev/null
rm -f "$inner"

# Cleanup, outside the nested session (its D-Bus has to be gone first).
[ $had_marker = 0 ] && rm -f "$marker"
sleep 1
ls "/run/user/$uid/doc/by-app" >/dev/null 2>&1 || { systemctl --user restart xdg-document-portal; echo "(document portal restarted)"; }
[ -f "$OUT/chat.backup.json" ] && cp -a "$OUT/chat.backup.json" "$history"
echo "--- extension log:"; grep -iE 'dynamic island|JS ERROR.*dynamic-island|TypeError.*dynamic-island' "$OUT/shell.log" | head -15
