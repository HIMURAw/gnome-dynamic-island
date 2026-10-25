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

import {Glass, snapshotExclude} from './glass.js';
import {NotificationCenter} from './center.js';
import {spring, stopSpring} from './spring.js';

// Side islands (Umut, 2026-10-25): push the pointer against the left or right edge of the
// screen and a glass island grows out of it. Left, "Today": a focus timer that logs to the
// notes folder, what is coming up, and the machine at a glance. Right, "Harvis": ask the
// assistant, drop a quick note, the latest notifications.
//
// Cheap on purpose. Closed, there is nothing on screen and nothing running: the edges are two
// pressure barriers (the same mechanism as GNOME's hot corner), which only wake up when the
// pointer pushes into them and never take a click from a scrollbar at the edge. A panel's
// content is built the first time it opens. While open, the pointer is checked ten times a
// second and the system figures every two seconds; both stop the moment it closes. The focus
// timer keeps a single timeout for its end, not a ticking clock.

const WIDTH = 340;          // px, logical
const EDGE_GAP = 14;        // from the screen edge
const SPAN = 0.7;           // middle share of the edge that reacts: corners stay the island's and the dock's
const PRESSURE = 70;        // px of push before the island opens (hot corner uses 100)
const GRACE = 56;           // px the pointer may stray outside before it counts as leaving
const CLOSE_DELAY = 380;    // ms outside before closing
const STATS_EVERY = 2000;   // ms, system figures while the left island is open
const MAX_NOTIFICATIONS = 5;
const MAX_AGENDA = 4;

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
        this.content = new St.BoxLayout({
            style_class: 'dynada-side-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const header = new St.BoxLayout({style_class: 'dynada-side-header', x_expand: true});
        header.add_child(label(title, 'dynada-center-month', {x_expand: true}));
        this.headerNote = label('', 'dynada-card-time');
        header.add_child(this.headerNote);
        this.content.add_child(header);
        this.actor.add_child(this.content);
        snapshotExclude.add(this.actor);
        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: true});
    }

    destroy() {
        stopSpring(this.actor);
        snapshotExclude.delete(this.actor);
        this.actor.destroy();
    }

    card(styleClass = '') {
        const box = new St.BoxLayout({
            style_class: `dynada-card dynada-side-card ${styleClass}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.content.add_child(box);
        return box;
    }
}

// ---------- The two islands and their edges ----------

export class SideIslands {
    // onAsk(text): send to the island's chat and show it.
    constructor({settings, onAsk}) {
        this._settings = settings;
        this._onAsk = onAsk;
        this._panels = {};
        this._open = null;
        this._closeId = 0;
        this._statsId = 0;
        this._tickId = 0;
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
        for (const panel of Object.values(this._panels))
            panel.destroy();
        this._panels = {};
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
        // Not over a fullscreen video or game, and not in the middle of dragging a window
        // (Desktop Cube switches workspaces on the same edges then).
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
            this._panels[side] = side === 'left' ? this._buildToday() : this._buildHarvis();
        return this._panels[side];
    }

    open(side) {
        if (this._open)
            this.close(true);
        const panel = this._panel(side);
        this._open = side;
        this._refresh(panel);

        const mon = Main.layoutManager.primaryMonitor;
        const actor = panel.actor;
        actor.visible = true;
        const [, natural] = actor.get_preferred_height(WIDTH);
        const height = Math.min(natural, mon.height - 2 * 72);
        actor.set_size(WIDTH, height);
        actor.set_position(
            side === 'left' ? mon.x + EDGE_GAP : mon.x + mon.width - WIDTH - EDGE_GAP,
            Math.round(mon.y + (mon.height - height) / 2));
        Main.layoutManager.uiGroup.set_child_above_sibling(actor, null);

        // Grows out of the edge with a spring, the way the island opens; the cards follow a beat later.
        stopSpring(actor);
        actor.remove_all_transitions();
        actor.set({scale_x: 0.3, scale_y: 0.82, opacity: 0});
        actor.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        spring(actor, {scale_x: 1, scale_y: 1}, {response: 0.46, damping: 0.76});
        const from = side === 'left' ? -14 : 14;
        panel.content.get_children().forEach((child, i) => {
            child.remove_all_transitions();
            child.set({opacity: 0, translation_x: from});
            child.ease({
                opacity: 255,
                translation_x: 0,
                delay: 60 + i * 40,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });

        this._watch = getPointerWatcher().addWatch(100, (x, y) => this._onPointer(x, y));
        if (side === 'left') {
            this._stats.reset();
            this._stats.read();
            this._statsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 400, () => {
                this._syncStats();
                this._statsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, STATS_EVERY, () => {
                    this._syncStats();
                    return GLib.SOURCE_CONTINUE;
                });
                return GLib.SOURCE_REMOVE;
            });
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
            scale_y: 0.9,
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

    _entry(panel, hint, onSubmit) {
        const entry = new St.Entry({
            style_class: 'dynada-palette-entry dynada-side-entry',
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

    _refresh(panel) {
        panel.headerNote.text = GLib.DateTime.new_now_local().format(panel.side === 'left' ? '%A, %e %B' : '%H:%M').trim();
        panel.refresh?.();
    }

    // ---------- Left: Today ----------

    _buildToday() {
        const panel = new SidePanel('left', _('Today'));

        // Focus
        const focus = panel.card('dynada-side-focus');
        const top = new St.BoxLayout({x_expand: true});
        this._timer = label('25:00', 'dynada-side-timer', {x_expand: true});
        top.add_child(this._timer);
        this._focusButton = new St.Button({style_class: 'dynada-pill-button dynada-side-go', can_focus: true});
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
        this._minutes = 25;
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
        const lengths = new St.BoxLayout({style_class: 'dynada-side-chips', y_align: Clutter.ActorAlign.CENTER});
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
        top.insert_child_at_index(lengths, 1);
        focus.add_child(chips);
        this._focusToday = label('', 'dynada-card-time');
        focus.add_child(this._focusToday);

        // Coming up (the agenda file is plain text, one item per line; Brain writes it nightly)
        const agenda = panel.card('dynada-side-agenda');
        agenda.add_child(label(_('Coming up'), 'dynada-card-title'));
        const agendaList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-side-list'});
        agenda.add_child(agendaList);

        // The machine
        const system = panel.card('dynada-side-system');
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

        panel.refresh = () => {
            agendaList.destroy_all_children();
            const path = expandPath(this._settings.get_string('agenda-file'));
            const notes = expandPath(this._settings.get_string('notes-folder'));
            const full = path && !GLib.path_is_absolute(path) && notes ? GLib.build_filenamev([notes, path]) : path;
            const items = (full ? readText(full) ?? '' : '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, MAX_AGENDA);
            agenda.visible = items.length > 0;
            for (const item of items) {
                // "2026-11-01 (7 gün) · Note: text" or "KARAR · Note: text": a short tag in front
                // (the date as day.month, otherwise the first word), two lines of the rest.
                const cut = item.indexOf(' · ');
                const head = cut > 0 ? item.slice(0, cut) : '';
                const rest = cut > 0 ? item.slice(cut + 3) : item;
                const date = head.match(/(\d{4})-(\d\d)-(\d\d)/);
                const tag = date ? `${date[3]}.${date[2]}` : head.split(/\s+/)[0]?.slice(0, 7) ?? '';
                const row = new St.BoxLayout({style_class: 'dynada-side-row', x_expand: true});
                if (tag)
                    row.add_child(label(tag, 'dynada-side-when'));
                const short = rest.length > 84 ? `${rest.slice(0, 82).trimEnd()}…` : rest;
                const text = label(short, 'dynada-card-body', {x_expand: true});
                text.clutter_text.line_wrap = true;
                text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                row.add_child(text);
                agendaList.add_child(row);
            }
        };
        return panel;
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
        this._focusToday.text = running
            ? fmt(_('%s · today %s'), this._focus.session.topic, minutesText(this._focus.todayMinutes()))
            : fmt(_('Today %s of focus'), minutesText(this._focus.todayMinutes()));
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

    _syncStats() {
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

    // ---------- Right: Harvis ----------

    _buildHarvis() {
        const panel = new SidePanel('right', _('Harvis'));

        const ask = panel.card('dynada-side-ask');
        ask.add_child(this._entry(panel, _('Ask Harvis…'), (text, entry) => {
            entry.text = '';
            this.close(true);
            this._onAsk(text);
        }));

        const note = panel.card('dynada-side-note');
        const noteEntry = this._entry(panel, _('Quick note to the inbox…'), (text, entry) => {
            entry.text = '';
            entry.hint_text = this._saveNote(text) ? _('Saved ✓') : _('Could not save the note');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1600, () => {
                try {
                    entry.hint_text = _('Quick note to the inbox…');
                } catch {
                    // the island was rebuilt meanwhile
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        note.add_child(noteEntry);

        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-side-list', x_expand: true});
        const notifications = panel.card('dynada-side-notifications');
        notifications.add_child(label(_('Notifications'), 'dynada-card-title'));
        notifications.add_child(list);

        panel.refresh = () => {
            list.destroy_all_children();
            const all = NotificationCenter.notifications().slice(0, MAX_NOTIFICATIONS);
            if (!all.length)
                list.add_child(label(_('Nothing new'), 'dynada-card-body'));
            for (const n of all) {
                const row = new St.Button({style_class: 'dynada-side-notification', can_focus: true, x_expand: true});
                const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                const head = new St.BoxLayout({x_expand: true});
                head.add_child(label(n.source?.title ?? '', 'dynada-card-time', {x_expand: true}));
                head.add_child(label(n.datetime ? n.datetime.format('%H:%M') : '', 'dynada-card-time'));
                box.add_child(head);
                box.add_child(label(n.title ?? '', 'dynada-side-notification-title'));
                if (n.body)
                    box.add_child(label(n.body.replace(/\s+/g, ' '), 'dynada-card-body'));
                row.set_child(box);
                row.connect('clicked', () => {
                    this.close(true);
                    try {
                        n.activate();
                    } catch (e) {
                        console.error('Dynamic Island: could not open the notification', e);
                    }
                });
                list.add_child(row);
            }
        };
        return panel;
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
