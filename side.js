import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PressureBarrier} from 'resource:///org/gnome/shell/ui/layout.js';
import {getPointerWatcher} from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {Glass, snapshotExclude} from './glass.js';
import {NotificationCenter} from './center.js';
import {TileGridLayout} from './layouts.js';
import {MediaWatcher, squareArt} from './media.js';
import {spring, stopSpring} from './spring.js';

// Side islands (Umut, 2026-10-25): push the pointer against the left or right edge of the
// screen and a tall glass island grows out of it. Left, the launcher: search (apps, a question
// for Harvis, a quick note), favourite and most used apps, open windows, recent files, a focus
// timer that logs to the notes folder. Right, the control center: Harvis, now playing, nine
// quick settings, volume and brightness, the machine, what is coming up, notifications.
//
// Cheap on purpose. Closed, there is nothing on screen and nothing running: the edges are two
// pressure barriers (the same mechanism as GNOME's hot corner), which only wake up when the
// pointer pushes into them and never take a click from a scrollbar at the edge. A panel's
// content is built the first time it opens and refreshed on each open. While open, the pointer
// is checked ten times a second, the system figures every two seconds and the media players are
// watched; all of it stops the moment the island closes. The focus timer keeps a single
// timeout for its end, not a ticking clock.

const WIDTH = 420;          // px, logical
const TOP_ROOM = 64;        // below the island
const BOTTOM_ROOM = 96;     // above the dock
const EDGE_GAP = 14;        // from the screen edge
const SPAN = 0.7;           // middle share of the edge that reacts: corners stay the island's and the dock's
const PRESSURE = 70;        // px of push before the island opens (hot corner uses 100)
const GRACE = 56;           // px the pointer may stray outside before it counts as leaving
const CLOSE_DELAY = 380;    // ms outside before closing
const STATS_EVERY = 2000;   // ms, system figures while the right island is open
const MAX_NOTIFICATIONS = 6;
const MAX_AGENDA = 4;
const MAX_WINDOWS = 7;
const MAX_RECENT = 5;
const APP_COLUMNS = 5;
const APP_ROWS = 3;
const APP_ICON = 44;
const APP_TILE_HEIGHT = 86;
const TOGGLE_HEIGHT = 78;

const decoder = new TextDecoder();
const fmt = (str, ...args) => str.replace(/%s/g, () => String(args.shift()));

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

function expandPath(path) {
    if (!path)
        return '';
    return path.startsWith('~') ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(1)]) : path;
}

function label(text, styleClass, params = {}) {
    const l = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function minutesText(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h ? fmt(_('%s h %s min'), h, m) : fmt(_('%s min'), m);
}

// ---------- System figures (read only while the left island is open) ----------

class SystemStats {
    constructor() {
        this._prevCpu = null;
        this._tempPath = undefined;
    }

    _cpu() {
        const line = readText('/proc/stat')?.split('\n')[0];
        if (!line)
            return null;
        const v = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = v[3] + (v[4] || 0);
        const total = v.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total === prev.total)
            return null;
        return 100 * (1 - (idle - prev.idle) / (total - prev.total));
    }

    _memory() {
        const text = readText('/proc/meminfo');
        const get = key => Number(text?.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
        const total = get('MemTotal');
        const free = get('MemAvailable');
        return total ? 100 * (1 - free / total) : null;
    }

    _temperature() {
        if (this._tempPath === undefined) {
            this._tempPath = null;
            // The CPU package if the kernel names it, otherwise the ACPI zone.
            for (const want of ['x86_pkg_temp', 'acpitz']) {
                for (let i = 0; i < 32 && !this._tempPath; i++) {
                    const base = `/sys/class/thermal/thermal_zone${i}`;
                    if (readText(`${base}/type`)?.trim() === want)
                        this._tempPath = `${base}/temp`;
                }
            }
        }
        const raw = this._tempPath ? Number(readText(this._tempPath)) : NaN;
        return Number.isFinite(raw) ? raw / 1000 : null;
    }

    _battery() {
        for (const name of ['BAT0', 'BAT1']) {
            const capacity = Number(readText(`/sys/class/power_supply/${name}/capacity`));
            if (Number.isFinite(capacity) && capacity > 0) {
                const status = readText(`/sys/class/power_supply/${name}/status`)?.trim();
                return {percent: capacity, charging: status === 'Charging' || status === 'Full'};
            }
        }
        return null;
    }

    read() {
        return {cpu: this._cpu(), memory: this._memory(), temperature: this._temperature(), battery: this._battery()};
    }

    reset() {
        this._prevCpu = null;
    }
}

// ---------- Focus timer ----------

// One session at a time, kept in a small JSON file so a restart of the shell does not lose
// it. Finished sessions go to a CSV (date, start, minutes, topic): in the notes folder when
// the settings name one, otherwise in the extension's data folder.
class FocusTimer {
    constructor(settings, onChanged) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'dynamic-island']);
        this._statePath = GLib.build_filenamev([this._dataDir, 'focus.json']);
        this._endId = 0;
        try {
            this.session = JSON.parse(readText(this._statePath) ?? 'null');
        } catch {
            this.session = null;
        }
        if (this.session)
            this._scheduleEnd();
    }

    destroy() {
        if (this._endId)
            GLib.source_remove(this._endId);
        this._endId = 0;
    }

    get remaining() {
        if (!this.session)
            return 0;
        return Math.max(0, this.session.start + this.session.minutes * 60000 - Date.now());
    }

    start(minutes, topic) {
        this.session = {start: Date.now(), minutes, topic};
        this._save();
        this._scheduleEnd();
        this._onChanged();
    }

    // Stopped early: kept if it was a real stretch of work.
    stop() {
        if (!this.session)
            return;
        const done = (Date.now() - this.session.start) / 60000;
        if (done >= 5)
            this._log(this.session, Math.round(done));
        this._clear();
    }

    _scheduleEnd() {
        if (this._endId)
            GLib.source_remove(this._endId);
        this._endId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, this.remaining), () => {
            this._endId = 0;
            this._finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish() {
        const s = this.session;
        if (!s)
            return;
        this._log(s, s.minutes);
        this._clear();
        Main.notify(_('Focus session done'), fmt(_('%s of %s. Today: %s'), minutesText(s.minutes), s.topic,
            minutesText(this.todayMinutes())));
    }

    _clear() {
        this.session = null;
        if (this._endId)
            GLib.source_remove(this._endId);
        this._endId = 0;
        try {
            Gio.File.new_for_path(this._statePath).delete(null);
        } catch {
            // already gone
        }
        this._onChanged();
    }

    _save() {
        GLib.mkdir_with_parents(this._dataDir, 0o755);
        GLib.file_set_contents(this._statePath, JSON.stringify(this.session));
    }

    logPath() {
        const notes = expandPath(this._settings.get_string('notes-folder'));
        const rel = expandPath(this._settings.get_string('focus-log'));
        if (rel && GLib.path_is_absolute(rel))
            return rel;
        if (rel && notes && GLib.file_test(notes, GLib.FileTest.IS_DIR))
            return GLib.build_filenamev([notes, rel]);
        return GLib.build_filenamev([this._dataDir, 'focus-log.csv']);
    }

    _log(session, minutes) {
        const path = this.logPath();
        const start = GLib.DateTime.new_from_unix_local(Math.floor(session.start / 1000));
        const row = `${start.format('%Y-%m-%d')},${start.format('%H:%M')},${minutes},${session.topic.replace(/[,\n]/g, ' ')}\n`;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            const file = Gio.File.new_for_path(path);
            const fresh = !file.query_exists(null);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode((fresh ? 'tarih,baslangic,dakika,konu\n' : '') + row), null);
            stream.close(null);
        } catch (e) {
            console.error('Dynamic Island: could not log the focus session', e);
        }
    }

    todayMinutes() {
        const today = GLib.DateTime.new_now_local().format('%Y-%m-%d');
        let sum = 0;
        for (const line of (readText(this.logPath()) ?? '').split('\n')) {
            const [date, , minutes] = line.split(',');
            if (date === today)
                sum += Number(minutes) || 0;
        }
        if (this.session)
            sum += (Date.now() - this.session.start) / 60000;
        return sum;
    }
}

// ---------- One island ----------

// A tall glass column: a fixed header, then the sections in a scroll view.
class SidePanel {
    constructor(side, title) {
        this.side = side;
        this.actor = new Glass({
            style_class: 'dynada-island dynada-side',
            radius: 30,
            reactive: true,
            track_hover: true,
            visible: false,
            opacity: 0,
            pivot_point: new Graphene.Point({x: side === 'left' ? 0 : 1, y: 0.5}),
        });
        this.column = new St.BoxLayout({
            style_class: 'dynada-side-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.header = new St.BoxLayout({style_class: 'dynada-side-header', x_expand: true});
        this.title = label(title, 'dynada-side-title', {x_expand: true});
        this.header.add_child(this.title);
        this.headerNote = label('', 'dynada-side-header-note');
        this.header.add_child(this.headerNote);
        this.column.add_child(this.header);

        this.content = new St.BoxLayout({
            style_class: 'dynada-side-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.scroll = new St.ScrollView({
            style_class: 'dynada-side-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this.content,
        });
        this.column.add_child(this.scroll);
        this.actor.add_child(this.column);
        snapshotExclude.add(this.actor);
        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: true});
    }

    destroy() {
        stopSpring(this.actor);
        snapshotExclude.delete(this.actor);
        this.actor.destroy();
    }

    // A titled section: a card in the column, optional action button on the title's right.
    section(title, styleClass = '', {action, onAction} = {}) {
        const box = new St.BoxLayout({
            style_class: `dynada-card dynada-side-card ${styleClass}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        if (title) {
            const head = new St.BoxLayout({style_class: 'dynada-side-section-head', x_expand: true});
            box.titleLabel = label(title, 'dynada-side-section-title', {x_expand: true});
            head.add_child(box.titleLabel);
            if (action) {
                box.actionButton = new St.Button({style_class: 'dynada-side-link', label: action, can_focus: true});
                box.actionButton.connect('clicked', onAction);
                head.add_child(box.actionButton);
            }
            box.add_child(head);
        }
        this.content.add_child(box);
        return box;
    }
}

// ---------- Quick settings (right island) ----------

// Each toggle reads its state when the island opens and flips it on click; nothing is watched
// while the island is closed.
function settingsToggle(schema, key, on, off = null) {
    let settings = null;
    try {
        settings = new Gio.Settings({schema_id: schema});
    } catch {
        return null;
    }
    return {
        get: () => (off === null ? settings.get_boolean(key) : settings.get_string(key) === on),
        set: value => (off === null ? settings.set_boolean(key, value) : settings.set_string(key, value ? on : off)),
    };
}

function run(argv) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    resolve(out ?? '');
                } catch {
                    resolve('');
                }
            });
        } catch {
            resolve('');
        }
    });
}

function dbusProperty(bus, name, path, iface, prop, value = undefined) {
    return new Promise(resolve => {
        const set = value !== undefined;
        bus.call(name, path, 'org.freedesktop.DBus.Properties', set ? 'Set' : 'Get',
            set ? new GLib.Variant('(ssv)', [iface, prop, value]) : new GLib.Variant('(ss)', [iface, prop]),
            null, Gio.DBusCallFlags.NONE, 2000, null, (conn, res) => {
                try {
                    const reply = conn.call_finish(res);
                    resolve(set ? true : reply.deepUnpack()[0].deepUnpack());
                } catch {
                    resolve(null);
                }
            });
    });
}

// ---------- The two islands and their edges ----------

export class SideIslands {
    // onAsk(text): send to the island's chat and show it. onTalk(): ask Harvis to listen.
    // onOpenChat(): show the island's chat. avatar: a live AvatarGlyph for the right island's header.
    constructor({settings, onAsk, onTalk, onOpenChat, avatar}) {
        this._settings = settings;
        this._onAsk = onAsk;
        this._onTalk = onTalk;
        this._onOpenChat = onOpenChat;
        this._avatar = avatar;
        this._panels = {};
        this._open = null;
        this._closeId = 0;
        this._statsId = 0;
        this._tickId = 0;
        this._inhibitCookie = 0;
        this._stats = new SystemStats();
        this._focus = new FocusTimer(settings, () => this._syncFocus());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            this.close(true);
            this._buildEdges();
        });
        this._buildEdges();
    }

    destroy() {
        this.close(true);
        this._clearEdges();
        Main.layoutManager.disconnect(this._monitorsId);
        this._focus.destroy();
        if (this._inhibitCookie)
            this._uninhibit();
        for (const panel of Object.values(this._panels))
            panel.destroy();
        this._panels = {};
        // Never opened: the robot was never put on the stage.
        if (this._avatar && !this._avatar.actor.get_parent())
            this._avatar.actor.destroy();
    }

    // ---------- Edges ----------

    _buildEdges() {
        this._clearEdges();
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const y1 = Math.round(mon.y + mon.height * (1 - SPAN) / 2);
        const y2 = Math.round(mon.y + mon.height * (1 + SPAN) / 2);
        this._edges = ['left', 'right'].map(side => {
            const x = side === 'left' ? mon.x : mon.x + mon.width;
            const barrier = new Meta.Barrier({
                backend: global.backend,
                x1: x, x2: x, y1, y2,
                directions: side === 'left' ? Meta.BarrierDirection.POSITIVE_X : Meta.BarrierDirection.NEGATIVE_X,
            });
            const pressure = new PressureBarrier(PRESSURE, 1000, Shell.ActionMode.NORMAL);
            pressure.addBarrier(barrier);
            pressure.connect('trigger', () => this._onEdge(side));
            return {barrier, pressure};
        });
    }

    _clearEdges() {
        for (const {barrier, pressure} of this._edges ?? []) {
            pressure.removeBarrier(barrier);
            pressure.destroy();
            barrier.destroy();
        }
        this._edges = [];
    }

    _onEdge(side) {
        const mon = Main.layoutManager.primaryMonitor;
        // Not over a fullscreen video or game, not over the overview, not over another menu.
        if (global.display.get_monitor_in_fullscreen(mon.index) || Main.overview.visible)
            return;
        if (Main.modalCount > 0 && !this._grab)
            return;
        if (this._open === side)
            return;
        this.open(side);
    }

    // ---------- Open / close ----------

    _panel(side) {
        if (!this._panels[side])
            this._panels[side] = side === 'left' ? this._buildLauncher() : this._buildControl();
        return this._panels[side];
    }

    open(side) {
        if (this._open)
            this.close(true);
        const panel = this._panel(side);
        this._open = side;

        // A tall column between the island at the top and the dock at the bottom.
        const mon = Main.layoutManager.primaryMonitor;
        const height = Math.round(mon.height - TOP_ROOM - BOTTOM_ROOM);
        const actor = panel.actor;
        actor.set_size(WIDTH, height);
        actor.set_position(
            side === 'left' ? mon.x + EDGE_GAP : mon.x + mon.width - WIDTH - EDGE_GAP,
            mon.y + TOP_ROOM);
        actor.visible = true;
        Main.layoutManager.uiGroup.set_child_above_sibling(actor, null);
        this._refresh(panel);
        panel.scroll.vadjustment.value = 0;

        // Grows out of the edge with a spring, the way the island opens; the sections follow.
        stopSpring(actor);
        actor.remove_all_transitions();
        actor.set({scale_x: 0.3, scale_y: 0.9, opacity: 0});
        actor.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        spring(actor, {scale_x: 1, scale_y: 1}, {response: 0.48, damping: 0.78});
        const from = side === 'left' ? -16 : 16;
        [panel.header, ...panel.content.get_children()].forEach((child, i) => {
            child.remove_all_transitions();
            child.set({opacity: 0, translation_x: from});
            child.ease({
                opacity: 255,
                translation_x: 0,
                delay: 50 + Math.min(i, 8) * 35,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });

        this._watch = getPointerWatcher().addWatch(100, (x, y) => this._onPointer(x, y));
        if (side === 'right') {
            this._stats.reset();
            this._stats.read();
            this._statsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 400, () => {
                this._syncStats();
                this._statsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, STATS_EVERY, () => this._syncStats());
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._syncFocus();
        }
    }

    close(now = false) {
        if (!this._open)
            return;
        const panel = this._panels[this._open];
        this._open = null;
        this._ungrab();
        this._watch?.remove();
        this._watch = null;
        for (const id of ['_closeId', '_statsId', '_tickId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        panel.closed?.();
        const actor = panel.actor;
        stopSpring(actor);
        actor.remove_all_transitions();
        if (now) {
            actor.set({visible: false, opacity: 0});
            return;
        }
        actor.ease({
            opacity: 0,
            scale_x: 0.55,
            scale_y: 0.94,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._panels[panel.side] === panel && this._open !== panel.side)
                    actor.visible = false;
            },
        });
    }

    _onPointer(x, y) {
        const panel = this._panels[this._open];
        if (!panel || this._grab)
            return;
        const [ax, ay] = panel.actor.get_transformed_position();
        const [w, h] = panel.actor.get_size();
        const mon = Main.layoutManager.primaryMonitor;
        const atEdge = this._open === 'left' ? x <= mon.x + 2 : x >= mon.x + mon.width - 3;
        const inside = atEdge || (x >= ax - GRACE && x <= ax + w + GRACE && y >= ay - GRACE && y <= ay + h + GRACE);
        if (inside) {
            if (this._closeId)
                GLib.source_remove(this._closeId);
            this._closeId = 0;
        } else if (!this._closeId) {
            this._closeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_DELAY, () => {
                this._closeId = 0;
                this.close();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Typing needs the keyboard, which a chrome actor only gets inside a modal grab: taken
    // on the first click into an entry, given back on close. Escape or a click outside closes.
    _grabFor(panel, entry) {
        if (!this._grab) {
            this._grab = Main.pushModal(panel.actor, {actionMode: Shell.ActionMode.POPUP});
            this._grabEventId = global.stage.connect('captured-event', (_stage, event) => {
                const type = event.type();
                if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                    this.close();
                    return Clutter.EVENT_STOP;
                }
                if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
                    return Clutter.EVENT_PROPAGATE;
                const source = global.stage.get_event_actor(event);
                if (source && panel.actor.contains(source))
                    return Clutter.EVENT_PROPAGATE;
                this.close();
                return Clutter.EVENT_STOP;
            });
        }
        entry.grab_key_focus();
    }

    _ungrab() {
        if (this._grabEventId)
            global.stage.disconnect(this._grabEventId);
        this._grabEventId = 0;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
    }

    _entry(panel, hint, onSubmit, styleClass = '') {
        const entry = new St.Entry({
            style_class: `dynada-palette-entry dynada-side-entry ${styleClass}`,
            hint_text: hint,
            can_focus: true,
            x_expand: true,
        });
        entry.clutter_text.connect('button-press-event', () => {
            this._grabFor(panel, entry);
            return Clutter.EVENT_PROPAGATE;
        });
        entry.clutter_text.connect('activate', () => {
            const text = entry.text.trim();
            if (text)
                onSubmit(text, entry);
        });
        return entry;
    }

    _round(icon, name, styleClass, onClick, size = 15) {
        const b = new St.Button({
            style_class: `dynada-side-round ${styleClass}`,
            can_focus: true,
            accessible_name: name,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: icon, icon_size: size}),
        });
        b.connect('clicked', onClick);
        return b;
    }

    _refresh(panel) {
        panel.headerNote.text = GLib.DateTime.new_now_local().format(panel.side === 'left' ? '%A, %e %B' : '%H:%M').trim();
        panel.refresh?.();
    }

    // ---------- Left: launcher ----------

    _buildLauncher() {
        const panel = new SidePanel('left', _('Launch'));

        // Search: apps as you type; Enter opens the first; nothing found offers Harvis.
        const searchCard = new St.BoxLayout({style_class: 'dynada-side-search', x_expand: true});
        searchCard.add_child(new St.Icon({icon_name: 'system-search-symbolic', icon_size: 18,
            style_class: 'dynada-side-search-icon', y_align: Clutter.ActorAlign.CENTER}));
        const results = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-side-list',
            x_expand: true, visible: false});
        let first = null;
        const search = this._entry(panel, _('Search apps, or ask Harvis…'), text => {
            if (first)
                first();
            else {
                this.close(true);
                this._onAsk(text);
            }
        }, 'dynada-side-search-entry');
        searchCard.add_child(search);
        panel.column.insert_child_at_index(searchCard, 1);

        const sections = [];
        search.clutter_text.connect('text-changed', () => {
            const q = search.text.trim();
            sections.forEach(s => (s.visible = !q));
            results.visible = !!q;
            first = null;
            results.destroy_all_children();
            if (!q)
                return;
            const system = Shell.AppSystem.get_default();
            const apps = Shell.AppSystem.search(q).flat().map(id => system.lookup_app(id)).filter(Boolean).slice(0, 7);
            for (const app of apps) {
                const launch = () => {
                    this.close(true);
                    app.activate();
                };
                first ??= launch;
                results.add_child(this._row(app.create_icon_texture(28), app.get_name(), app.get_description() ?? '', launch));
            }
            results.add_child(this._row(new St.Icon({icon_name: 'dialog-question-symbolic', icon_size: 20}),
                fmt(_('Ask Harvis: %s'), q), '', () => {
                    this.close(true);
                    this._onAsk(q);
                }));
            results.add_child(this._row(new St.Icon({icon_name: 'document-edit-symbolic', icon_size: 20}),
                _('Save as a quick note'), _('Into the inbox of the notes folder'), () => {
                    search.text = '';
                    search.hint_text = this._saveNote(q) ? _('Saved ✓') : _('Could not save the note');
                }));
        });
        panel.content.add_child(results);

        // Apps: favourites first, then the most used, three rows of five.
        const apps = panel.section(_('Apps'), 'dynada-side-apps', {
            action: _('All apps'),
            onAction: () => {
                this.close(true);
                Main.overview.showApps();
            },
        });
        const grid = new St.Widget({layout_manager: new TileGridLayout(APP_COLUMNS, APP_TILE_HEIGHT, 6, 1), x_expand: true});
        apps.add_child(grid);
        sections.push(apps);

        // Open windows, most recent first.
        const windows = panel.section(_('Open windows'), 'dynada-side-windows');
        const windowList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-side-list', x_expand: true});
        windows.add_child(windowList);
        sections.push(windows);

        // Focus
        const focus = panel.section(_('Focus'), 'dynada-side-focus');
        this._buildFocus(focus);
        sections.push(focus);

        // Recent files (GTK's list, which Files and most apps write).
        const recent = panel.section(_('Recent files'), 'dynada-side-recent');
        const recentList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-side-list', x_expand: true});
        recent.add_child(recentList);
        sections.push(recent);

        panel.refresh = () => {
            search.text = '';
            this._fillApps(grid);
            this._fillWindows(windows, windowList);
            this._fillRecent(recent, recentList);
        };
        return panel;
    }

    _row(icon, title, subtitle, onClick, {onClose} = {}) {
        const row = new St.BoxLayout({style_class: 'dynada-side-row-item', x_expand: true, reactive: true, track_hover: true});
        const button = new St.Button({style_class: 'dynada-side-row-button', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style_class: 'dynada-side-row-box', x_expand: true});
        const bin = new St.Bin({style_class: 'dynada-side-row-icon', child: icon, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(bin);
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label(title, 'dynada-side-row-title'));
        if (subtitle)
            text.add_child(label(subtitle, 'dynada-side-row-subtitle'));
        box.add_child(text);
        button.set_child(box);
        button.connect('clicked', onClick);
        row.add_child(button);
        if (onClose) {
            const close = this._round('window-close-symbolic', _('Close'), 'dynada-side-dismiss', onClose, 12);
            close.opacity = 0;
            row.connect('notify::hover', () => close.ease({opacity: row.hover ? 255 : 0, duration: 120}));
            row.add_child(close);
        }
        return row;
    }

    _fillApps(grid) {
        grid.destroy_all_children();
        const system = Shell.AppSystem.get_default();
        const seen = new Set();
        const list = [];
        const add = app => {
            if (app && !seen.has(app.get_id()) && list.length < APP_COLUMNS * APP_ROWS) {
                seen.add(app.get_id());
                list.push(app);
            }
        };
        for (const id of global.settings.get_strv('favorite-apps'))
            add(system.lookup_app(id));
        for (const app of Shell.AppUsage.get_default().get_most_used())
            add(app);
        for (const app of list) {
            const tile = new St.Button({style_class: 'dynada-side-app', can_focus: true, accessible_name: app.get_name()});
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const icon = new St.Bin({child: app.create_icon_texture(APP_ICON), x_align: Clutter.ActorAlign.CENTER});
            box.add_child(icon);
            const name = label(app.get_name(), 'dynada-side-app-name', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(name);
            const dot = new St.Widget({style_class: 'dynada-side-app-dot', x_align: Clutter.ActorAlign.CENTER,
                opacity: app.state === Shell.AppState.RUNNING ? 255 : 0});
            box.add_child(dot);
            tile.set_child(box);
            tile.connect('clicked', () => {
                this.close(true);
                app.activate();
            });
            grid.add_child(tile);
        }
    }

    _fillWindows(section, list) {
        list.destroy_all_children();
        const tracker = Shell.WindowTracker.get_default();
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(w => !w.skip_taskbar).slice(0, MAX_WINDOWS);
        section.titleLabel.text = windows.length ? fmt(_('Open windows · %s'), windows.length) : _('Open windows');
        if (!windows.length)
            list.add_child(label(_('No open windows'), 'dynada-card-body dynada-side-empty'));
        for (const w of windows) {
            const app = tracker.get_window_app(w);
            const icon = app ? app.create_icon_texture(24) : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 20});
            list.add_child(this._row(icon, w.get_title() || app?.get_name() || '', app?.get_name() ?? '', () => {
                this.close(true);
                Main.activateWindow(w);
            }, {
                onClose: () => {
                    w.delete(global.get_current_time());
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                        if (this._open === 'left')
                            this._fillWindows(section, list);
                        return GLib.SOURCE_REMOVE;
                    });
                },
            }));
        }
    }

    _fillRecent(section, list) {
        list.destroy_all_children();
        const xbel = readText(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel'])) ?? '';
        const items = [];
        for (const m of xbel.matchAll(/<bookmark href="(file:\/\/[^"]+)"[^>]*?modified="([^"]+)"/g))
            items.push({uri: m[1], modified: m[2]});
        items.sort((a, b) => b.modified.localeCompare(a.modified));
        const shown = [];
        for (const {uri} of items) {
            if (shown.length >= MAX_RECENT)
                break;
            const file = Gio.File.new_for_uri(uri);
            const path = file.get_path();
            if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS) || shown.some(s => s.uri === uri))
                continue;
            shown.push({uri, file, path});
        }
        section.visible = shown.length > 0;
        for (const {uri, file, path} of shown) {
            const [type] = Gio.content_type_guess(path, null);
            const icon = new St.Icon({gicon: Gio.content_type_get_icon(type), icon_size: 22});
            const dir = GLib.path_get_dirname(path).replace(GLib.get_home_dir(), '~');
            list.add_child(this._row(icon, file.get_basename(), dir, () => {
                this.close(true);
                try {
                    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
                } catch (e) {
                    console.error('Dynamic Island: could not open the file', e);
                }
            }));
        }
    }

    _buildFocus(focus) {
        const top = new St.BoxLayout({x_expand: true, style_class: 'dynada-side-focus-top'});
        this._timer = label('25:00', 'dynada-side-timer', {x_expand: true});
        top.add_child(this._timer);
        const lengths = new St.BoxLayout({style_class: 'dynada-side-chips', y_align: Clutter.ActorAlign.CENTER});
        this._minutes = 25;
        this._minuteButtons = [25, 50].map(m => {
            const b = new St.Button({style_class: 'dynada-pill-button dynada-side-chip', label: String(m),
                toggle_mode: true, can_focus: true, checked: m === this._minutes});
            b.connect('clicked', () => {
                this._minutes = m;
                this._minuteButtons.forEach(o => (o.checked = o === b));
                this._syncFocus();
            });
            lengths.add_child(b);
            return b;
        });
        top.add_child(lengths);
        this._focusButton = new St.Button({style_class: 'dynada-pill-button dynada-side-go', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._focusButton.connect('clicked', () => {
            if (this._focus.session)
                this._focus.stop();
            else
                this._focus.start(this._minutes, this._topic);
        });
        top.add_child(this._focusButton);
        focus.add_child(top);

        const chips = new St.BoxLayout({style_class: 'dynada-side-chips', x_expand: true});
        this._topic = _('Study');
        this._topicButtons = [_('Study'), _('Code'), _('Other')].map(topic => {
            const b = new St.Button({style_class: 'dynada-pill-button dynada-side-chip', label: topic,
                toggle_mode: true, can_focus: true, checked: topic === this._topic});
            b.connect('clicked', () => {
                this._topic = topic;
                this._topicButtons.forEach(o => (o.checked = o === b));
            });
            chips.add_child(b);
            return b;
        });
        chips.add_child(new St.Widget({x_expand: true}));
        this._focusToday = label('', 'dynada-card-time', {y_align: Clutter.ActorAlign.CENTER});
        chips.add_child(this._focusToday);
        focus.add_child(chips);
    }

    _syncFocus() {
        if (!this._timer)
            return;
        const running = !!this._focus.session;
        const ms = running ? this._focus.remaining : this._minutes * 60000;
        const s = Math.ceil(ms / 1000);
        this._timer.text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        this._focusButton.label = running ? _('Stop') : _('Start');
        this._focusButton.checked = running;
        if (running)
            this._timer.add_style_pseudo_class('running');
        else
            this._timer.remove_style_pseudo_class('running');
        this._focusToday.text = fmt(_('Today %s'), minutesText(this._focus.todayMinutes()));
        // The clock ticks only while the island is open and a session runs.
        const want = running && this._open === 'left';
        if (want && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._syncFocus();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    // ---------- Right: control ----------

    _buildControl() {
        const panel = new SidePanel('right', _('Harvis'));

        // Header: the live robot (it moves only while on screen), the name, what it is doing.
        panel.header.add_style_class_name('dynada-side-harvis-header');
        if (this._avatar) {
            this._avatar.actor.y_align = Clutter.ActorAlign.CENTER;
            panel.header.insert_child_at_index(this._avatar.actor, 0);
        }
        const names = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        panel.header.remove_child(panel.title);
        names.add_child(panel.title);
        this._harvisStatus = label(_('Ready'), 'dynada-side-status');
        names.add_child(this._harvisStatus);
        panel.header.insert_child_at_index(names, this._avatar ? 1 : 0);

        // Ask: type and Enter, the arrow, or the microphone to say it; three one-tap questions.
        const ask = panel.section(null, 'dynada-side-ask');
        const askRow = new St.BoxLayout({style_class: 'dynada-side-ask-row', x_expand: true});
        const askEntry = this._entry(panel, _('Ask Harvis…'), (text, entry) => {
            entry.text = '';
            this.close(true);
            this._onAsk(text);
        });
        askRow.add_child(askEntry);
        askRow.add_child(this._round('audio-input-microphone-symbolic', _('Say it'), 'dynada-side-mic', () => {
            this.close(true);
            this._onTalk();
        }));
        askRow.add_child(this._round('go-up-symbolic', _('Send'), 'dynada-side-send', () => {
            const text = askEntry.text.trim();
            if (!text)
                return;
            askEntry.text = '';
            this.close(true);
            this._onAsk(text);
        }));
        ask.add_child(askRow);
        const quick = new St.BoxLayout({style_class: 'dynada-side-chips', x_expand: true});
        for (const [text, prompt] of [
            [_('Today'), _('What is on today? Deadlines, open threads and what I should do first.')],
            [_('Deadlines'), _('Which deadlines and decisions are coming up?')],
            [_('Where was I?'), _('Where did I leave off last time, and what is the next step?')],
        ]) {
            const b = new St.Button({style_class: 'dynada-pill-button dynada-side-chip', label: text, can_focus: true});
            b.connect('clicked', () => {
                this.close(true);
                this._onAsk(prompt);
            });
            quick.add_child(b);
        }
        ask.add_child(quick);
        this._lastAnswerLabel = label('', 'dynada-side-last-text');
        this._lastAnswerLabel.clutter_text.line_wrap = true;
        this._lastAnswerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const last = new St.Button({style_class: 'dynada-side-last', can_focus: true, x_expand: true,
            child: this._lastAnswerLabel});
        last.connect('clicked', () => {
            this.close(true);
            this._onOpenChat();
        });
        ask.add_child(last);

        // Now playing: watched only while this island is open.
        const media = panel.section(null, 'dynada-side-media');
        this._buildMedia(media);

        // Quick settings: nine tiles.
        const toggles = panel.section(_('Quick settings'), 'dynada-side-toggles');
        const tiles = new St.Widget({layout_manager: new TileGridLayout(3, TOGGLE_HEIGHT, 8, 1), x_expand: true});
        toggles.add_child(tiles);
        this._toggles = this._makeToggles().map(t => {
            const button = new St.Button({style_class: 'dynada-side-toggle', can_focus: true, toggle_mode: !!t.get,
                accessible_name: t.name});
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            box.add_child(new St.Icon({icon_name: t.icon, icon_size: 20, style_class: 'dynada-side-toggle-icon',
                x_align: Clutter.ActorAlign.START}));
            box.add_child(label(t.name, 'dynada-side-toggle-name'));
            t.state = label('', 'dynada-side-toggle-state');
            box.add_child(t.state);
            button.set_child(box);
            button.connect('clicked', async () => {
                if (t.get) {
                    await t.set(!t.on);
                    await this._syncToggle(t);
                } else {
                    this.close(true);
                    t.run();
                }
            });
            t.button = button;
            tiles.add_child(button);
            return t;
        });

        // Volume and brightness.
        const sliders = panel.section(null, 'dynada-side-sliders');
        this._volume = this._sliderRow(sliders, 'audio-volume-high-symbolic', value => {
            const sink = getMixerControl().get_default_sink();
            if (!sink)
                return;
            const max = getMixerControl().get_vol_max_norm();
            sink.volume = value * max;
            sink.push_volume();
            if (sink.is_muted && value > 0)
                sink.change_is_muted(false);
        });
        this._brightness = this._sliderRow(sliders, 'display-brightness-symbolic', value => {
            const scale = Main.brightnessManager?.globalScale;
            if (scale)
                scale.value = value;
        });

        // The machine
        const system = panel.section(_('System'), 'dynada-side-system');
        const grid = new St.BoxLayout({style_class: 'dynada-side-stats', x_expand: true});
        this._statTiles = {};
        for (const [key, name] of [['cpu', _('CPU')], ['memory', _('Memory')], ['temperature', _('Heat')], ['battery', _('Battery')]]) {
            const tile = new St.BoxLayout({style_class: 'dynada-side-stat', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const value = label('—', 'dynada-side-stat-value');
            const track = new St.Widget({style_class: 'dynada-side-bar-track', x_expand: true});
            const bar = new St.Widget({style_class: 'dynada-side-bar', width: 0});
            track.add_child(bar);
            tile.add_child(value);
            tile.add_child(track);
            tile.add_child(label(name, 'dynada-card-time'));
            grid.add_child(tile);
            this._statTiles[key] = {value, bar, track};
        }
        system.add_child(grid);

        // Coming up (the agenda file: plain text, one item per line; Brain writes it nightly)
        const agenda = panel.section(_('Coming up'), 'dynada-side-agenda');
        const agendaList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-side-list'});
        agenda.add_child(agendaList);

        // Notifications
        const notifications = panel.section(_('Notifications'), 'dynada-side-notifications', {
            action: _('Clear'),
            onAction: () => {
                for (const n of NotificationCenter.notifications()) {
                    try {
                        n.destroy();
                    } catch {
                        // already gone
                    }
                }
                this._fillNotifications(notifications, notifList);
            },
        });
        const notifList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-side-list', x_expand: true});
        notifications.add_child(notifList);

        panel.refresh = () => {
            const answer = this._lastAnswer();
            last.visible = !!answer;
            this._lastAnswerLabel.text = answer.length > 160 ? `${answer.slice(0, 158).trimEnd()}…` : answer;
            this._media = new MediaWatcher(() => this._syncMedia());
            this._syncMedia();
            for (const t of this._toggles)
                this._syncToggle(t);
            const sink = getMixerControl().get_default_sink();
            this._volume.row.visible = !!sink;
            if (sink)
                this._volume.set(sink.is_muted ? 0 : sink.volume / getMixerControl().get_vol_max_norm());
            const scale = Main.brightnessManager?.globalScale;
            this._brightness.row.visible = !!scale;
            if (scale)
                this._brightness.set(scale.value);
            this._fillAgenda(agenda, agendaList);
            this._fillNotifications(notifications, notifList);
        };
        panel.closed = () => {
            this._media?.destroy();
            this._media = null;
        };
        return panel;
    }

    _sliderRow(section, icon, onChange) {
        const row = new St.BoxLayout({style_class: 'dynada-side-slider-row', x_expand: true});
        row.add_child(new St.Icon({icon_name: icon, icon_size: 18, style_class: 'dynada-side-slider-icon',
            y_align: Clutter.ActorAlign.CENTER}));
        const slider = new Slider(0);
        slider.add_style_class_name('dynada-side-slider');
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        let quiet = false;
        slider.connect('notify::value', () => {
            if (!quiet)
                onChange(slider.value);
        });
        row.add_child(slider);
        section.add_child(row);
        return {
            row,
            set: value => {
                quiet = true;
                slider.value = Math.max(0, Math.min(1, value));
                quiet = false;
            },
        };
    }

    _buildMedia(section) {
        const row = new St.BoxLayout({style_class: 'dynada-side-media-row', x_expand: true});
        this._art = new St.Button({style_class: 'dynada-side-art', can_focus: true});
        this._art.connect('clicked', () => {
            const entry = this._media?.current();
            if (entry) {
                this.close(true);
                this._media.raise(entry);
            }
        });
        row.add_child(this._art);
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._mediaApp = label('', 'dynada-card-time');
        this._mediaTitle = label('', 'dynada-side-media-title');
        this._mediaArtist = label('', 'dynada-card-body');
        text.add_child(this._mediaApp);
        text.add_child(this._mediaTitle);
        text.add_child(this._mediaArtist);
        row.add_child(text);
        section.add_child(row);
        const controls = new St.BoxLayout({style_class: 'dynada-side-media-controls', x_align: Clutter.ActorAlign.CENTER});
        const act = fn => () => {
            const entry = this._media?.current();
            if (entry)
                fn(entry);
        };
        this._prev = this._round('media-skip-backward-symbolic', _('Previous'), 'dynada-side-media-button',
            act(e => this._media.previous(e)), 18);
        this._play = this._round('media-playback-start-symbolic', _('Play'), 'dynada-side-media-play',
            act(e => this._media.playPause(e)), 22);
        this._next = this._round('media-skip-forward-symbolic', _('Next'), 'dynada-side-media-button',
            act(e => this._media.next(e)), 18);
        controls.add_child(this._prev);
        controls.add_child(this._play);
        controls.add_child(this._next);
        section.add_child(controls);
        this._mediaSection = section;
    }

    _syncMedia() {
        if (!this._mediaSection)
            return;
        const entry = this._media?.current();
        this._mediaSection.visible = !!entry;
        if (!entry)
            return;
        const info = this._media.info(entry);
        this._mediaApp.text = info.appName;
        this._mediaTitle.text = info.title || info.appName;
        this._mediaArtist.text = info.artist;
        this._play.child.icon_name = info.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = info.canPrevious;
        this._next.reactive = info.canNext;
        this._prev.opacity = info.canPrevious ? 255 : 90;
        this._next.opacity = info.canNext ? 255 : 90;
        const art = squareArt(info.artUrl);
        if (art) {
            this._art.child = null;
            this._art.style = `background-image: url("${art}");`;
        } else {
            this._art.style = null;
            this._art.child = info.app ? info.app.create_icon_texture(36)
                : new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 26});
        }
    }

    _makeToggles() {
        const notifications = settingsToggle('org.gnome.desktop.notifications', 'show-banners');
        const dark = settingsToggle('org.gnome.desktop.interface', 'color-scheme', 'prefer-dark', 'default');
        const night = settingsToggle('org.gnome.settings-daemon.plugins.color', 'night-light-enabled');
        const toggles = [
            {
                name: _('Wi-Fi'), icon: 'network-wireless-signal-excellent-symbolic',
                get: async () => (await run(['nmcli', '-t', 'radio', 'wifi'])).trim() === 'enabled',
                set: on => run(['nmcli', 'radio', 'wifi', on ? 'on' : 'off']),
            },
            {
                name: _('Bluetooth'), icon: 'bluetooth-active-symbolic',
                get: async () => (await dbusProperty(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill',
                    '/org/gnome/SettingsDaemon/Rfkill', 'org.gnome.SettingsDaemon.Rfkill', 'BluetoothAirplaneMode')) === false,
                set: on => dbusProperty(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
                    'org.gnome.SettingsDaemon.Rfkill', 'BluetoothAirplaneMode', new GLib.Variant('b', !on)),
            },
            notifications && {
                name: _('Do Not Disturb'), icon: 'notifications-disabled-symbolic',
                get: () => !notifications.get(), set: on => notifications.set(!on),
            },
            dark && {name: _('Dark style'), icon: 'dark-mode-symbolic', get: () => dark.get(), set: on => dark.set(on)},
            night && {name: _('Night light'), icon: 'night-light-symbolic', get: () => night.get(), set: on => night.set(on)},
            {
                name: _('Stay awake'), icon: 'view-reveal-symbolic',
                get: () => !!this._inhibitCookie,
                set: on => (on ? this._inhibit() : this._uninhibit()),
            },
            {name: _('Screenshot'), icon: 'camera-photo-symbolic', run: () => Main.screenshotUI.open()},
            {name: _('Lock'), icon: 'system-lock-screen-symbolic', run: () => Main.screenShield.lock(true)},
            {
                name: _('Settings'), icon: 'emblem-system-symbolic',
                run: () => Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate(),
            },
        ].filter(Boolean);
        return toggles;
    }

    async _syncToggle(t) {
        if (!t.get) {
            t.state.text = '';
            return;
        }
        try {
            t.on = !!(await t.get());
        } catch {
            t.on = false;
        }
        if (!t.button)
            return;
        t.button.checked = t.on;
        t.state.text = t.on ? _('On') : _('Off');
    }

    // Stay awake: GNOME's own session inhibitor (idle and suspend), released when switched off
    // or when the extension stops.
    _inhibit() {
        return new Promise(resolve => {
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
                'Inhibit', new GLib.Variant('(susu)', ['dynamic-island', 0, 'Stay awake (side island)', 4 | 8]),
                null, Gio.DBusCallFlags.NONE, 2000, null, (conn, res) => {
                    try {
                        [this._inhibitCookie] = conn.call_finish(res).deepUnpack();
                    } catch (e) {
                        console.error('Dynamic Island: could not keep the screen awake', e);
                    }
                    resolve();
                });
        });
    }

    _uninhibit() {
        const cookie = this._inhibitCookie;
        this._inhibitCookie = 0;
        if (!cookie)
            return Promise.resolve();
        return new Promise(resolve => {
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
                'Uninhibit', new GLib.Variant('(u)', [cookie]), null, Gio.DBusCallFlags.NONE, 2000, null, () => resolve());
        });
    }

    _fillAgenda(section, list) {
        list.destroy_all_children();
        const path = expandPath(this._settings.get_string('agenda-file'));
        const notes = expandPath(this._settings.get_string('notes-folder'));
        const full = path && !GLib.path_is_absolute(path) && notes ? GLib.build_filenamev([notes, path]) : path;
        const items = (full ? readText(full) ?? '' : '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, MAX_AGENDA);
        section.visible = items.length > 0;
        for (const item of items) {
            // "2026-11-01 (7 gün) · Note: text" or "KARAR · Note: text": a short tag in front
            // (the date as day.month, otherwise the first word), two lines of the rest.
            const cut = item.indexOf(' · ');
            const head = cut > 0 ? item.slice(0, cut) : '';
            const rest = cut > 0 ? item.slice(cut + 3) : item;
            const date = head.match(/(\d{4})-(\d\d)-(\d\d)/);
            const tag = date ? `${date[3]}.${date[2]}` : head.split(/\s+/)[0]?.slice(0, 7) ?? '';
            const row = new St.BoxLayout({style_class: 'dynada-side-agenda-row', x_expand: true});
            if (tag)
                row.add_child(label(tag, 'dynada-side-when'));
            const short = rest.length > 96 ? `${rest.slice(0, 94).trimEnd()}…` : rest;
            const text = label(short, 'dynada-card-body', {x_expand: true});
            text.clutter_text.line_wrap = true;
            text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            row.add_child(text);
            list.add_child(row);
        }
    }

    _fillNotifications(section, list) {
        list.destroy_all_children();
        const all = NotificationCenter.notifications();
        section.actionButton.visible = all.length > 0;
        section.titleLabel.text = all.length ? fmt(_('Notifications · %s'), all.length) : _('Notifications');
        if (!all.length)
            list.add_child(label(_('Nothing new'), 'dynada-card-body dynada-side-empty'));
        for (const n of all.slice(0, MAX_NOTIFICATIONS)) {
            const gicon = n.gicon ?? n.source?.icon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
            const symbolic = gicon instanceof Gio.ThemedIcon && gicon.get_names().some(i => i.endsWith('-symbolic'));
            const time = n.datetime ? n.datetime.format('%H:%M') : '';
            const body = (n.body ?? '').replace(/\s+/g, ' ');
            list.add_child(this._row(new St.Icon({gicon, icon_size: symbolic ? 18 : 28}),
                n.title ?? '', [n.source?.title, time, body].filter(Boolean).join(' · '), () => {
                    this.close(true);
                    try {
                        n.activate();
                    } catch (e) {
                        console.error('Dynamic Island: could not open the notification', e);
                    }
                }, {
                    onClose: () => {
                        try {
                            n.destroy();
                        } catch {
                            // already gone
                        }
                        this._fillNotifications(section, list);
                    },
                }));
        }
    }

    _syncStats() {
        if (!this._statTiles)
            return GLib.SOURCE_REMOVE;
        const s = this._stats.read();
        const set = (key, fraction, text, hot) => {
            const tile = this._statTiles[key];
            tile.value.text = text;
            const w = tile.track.width || 50;
            tile.bar.width = Math.round(Math.max(0, Math.min(1, fraction ?? 0)) * w);
            if (hot)
                tile.bar.add_style_pseudo_class('hot');
            else
                tile.bar.remove_style_pseudo_class('hot');
        };
        set('cpu', s.cpu / 100, s.cpu === null ? '—' : `${Math.round(s.cpu)}%`, s.cpu > 85);
        set('memory', s.memory / 100, s.memory === null ? '—' : `${Math.round(s.memory)}%`, s.memory > 90);
        set('temperature', (s.temperature - 30) / 70, s.temperature === null ? '—' : `${Math.round(s.temperature)}°`, s.temperature > 85);
        set('battery', s.battery?.percent / 100, s.battery ? `${s.battery.charging ? '⚡' : ''}${s.battery.percent}%` : '—',
            s.battery && !s.battery.charging && s.battery.percent <= 15);
        return GLib.SOURCE_CONTINUE;
    }

    // The newest assistant message of the island's chat (chat.js keeps the last 60).
    _lastAnswer() {
        try {
            const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'dynamic-island', 'chat.json']);
            const messages = JSON.parse(readText(path) ?? '[]');
            const m = [...messages].reverse().find(x => x.role === 'assistant' && x.text);
            return m ? m.text.replace(/\s+/g, ' ').trim() : '';
        } catch {
            return '';
        }
    }

    // Harvis's state from the island (idle, listening, thinking, speaking, failed).
    setMode(mode) {
        this._avatar?.setMode(mode);
        if (this._harvisStatus) {
            this._harvisStatus.text = {
                listening: _('Listening'),
                thinking: _('Thinking'),
                speaking: _('Speaking'),
                failed: _('Something went wrong'),
            }[mode] ?? _('Ready');
        }
    }

    // Same place and form as the palette's quick notes (palette.js).
    _saveNote(text) {
        const notes = expandPath(this._settings.get_string('notes-folder'));
        let inbox = expandPath(this._settings.get_string('inbox-folder'));
        if (inbox && !GLib.path_is_absolute(inbox))
            inbox = notes ? GLib.build_filenamev([notes, inbox]) : '';
        const folder = inbox || notes;
        if (!folder)
            return false;
        try {
            GLib.mkdir_with_parents(folder, 0o755);
            const words = text.replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H%M');
            const name = `${stamp} ${words || _('Note')}`.slice(0, 80);
            let path = GLib.build_filenamev([folder, `${name}.md`]);
            for (let i = 2; GLib.file_test(path, GLib.FileTest.EXISTS); i++)
                path = GLib.build_filenamev([folder, `${name} ${i}.md`]);
            GLib.file_set_contents(path, `${text}\n\n— ${GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M')}\n`);
            return true;
        } catch (e) {
            console.error('Dynamic Island: could not save the note', e);
            return false;
        }
    }
}
