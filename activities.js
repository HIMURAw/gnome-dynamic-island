import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import {Control} from './control.js';

// Live activities: things in progress that the island keeps in view, like
// iPhone's Live Activities. Timers are built in; anything else (a build, a
// deploy, a CI run, a long command) reports itself over D-Bus, usually through
// the `dynada` script that ships with the extension.
//
//   gdbus call --session --dest org.gnome.Shell --object-path /io/github/himuraw/DynamicIsland \
//     --method io.github.himuraw.DynamicIsland.Update deploy "Deploy" "Uploading" "" 0.4

const IFACE = `
<node>
  <interface name="io.github.himuraw.DynamicIsland">
    <method name="Update">
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="title"/>
      <arg type="s" direction="in" name="subtitle"/>
      <arg type="s" direction="in" name="icon"/>
      <arg type="d" direction="in" name="progress"/>
    </method>
    <method name="End">
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="message"/>
      <arg type="b" direction="in" name="success"/>
    </method>
    <method name="Clear">
      <arg type="s" direction="in" name="id"/>
    </method>
    <method name="ShowAnswer">
      <arg type="s" direction="in" name="question"/>
      <arg type="s" direction="in" name="answer"/>
    </method>
    <method name="ShowCard">
      <arg type="s" direction="in" name="card"/>
    </method>
    <method name="Screenshot">
      <arg type="s" direction="in" name="name"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="path"/>
    </method>
    <method name="Control">
      <arg type="s" direction="in" name="action"/>
      <arg type="s" direction="in" name="args"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="info"/>
    </method>
    <method name="Timer">
      <arg type="u" direction="in" name="seconds"/>
      <arg type="s" direction="in" name="label"/>
      <arg type="s" direction="out" name="id"/>
    </method>
  </interface>
</node>`;
const OBJECT_PATH = '/io/github/himuraw/DynamicIsland';
// Screenshots for the assistant only ever land here, under a plain file name.
const SHOTS = GLib.build_filenamev([GLib.get_user_cache_dir(), 'harvis', 'screen']);

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');
// An activity nobody has updated for this long has lost its reporter (ms).
const STALE_AFTER = 30 * 60 * 1000;

const now = () => GLib.get_monotonic_time() / 1000;

function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class Activities {
    // onChanged(): the list or a countdown changed.
    // onAnswer(question, answer): a voice assistant has an answer to show.
    // onScreenshot(): a screenshot was taken for the assistant (the island flashes).
    constructor({onChanged, onAnswer, onScreenshot, onCard}) {
        this._onChanged = onChanged;
        this._onAnswer = onAnswer;
        this._onCard = onCard;
        this._onScreenshot = onScreenshot;
        this._items = new Map();
        this._timerCount = 0;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        try {
            this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        } catch (e) {
            console.error('Dynamic Island: live activities D-Bus API unavailable', e);
            this._dbus = null;
        }
    }

    destroy() {
        this._control?.destroy();
        this._control = null;
        this._dbus?.unexport();
        this._dbus = null;
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._items.clear();
    }

    get items() {
        return [...this._items.values()];
    }

    // ---- D-Bus methods (also used directly) ----

    Update(id, title, subtitle, icon, progress) {
        const item = this._items.get(id) ?? {id, started: now()};
        Object.assign(item, {
            title: title || item.title || id,
            subtitle,
            icon: icon || item.icon || 'emblem-synchronizing-symbolic',
            progress: progress >= 0 ? Math.min(1, progress) : -1,
            touched: now(),
        });
        this._items.set(id, item);
        this._ensureTick();
        this._onChanged();
    }

    End(id, message, success) {
        const item = this._items.get(id);
        this._items.delete(id);
        this._onChanged();
        const title = item?.title ?? id;
        const seconds = item ? (now() - item.started) / 1000 : 0;
        const body = [message, seconds >= 5 ? clock(seconds) : ''].filter(Boolean).join(' · ');
        Main.notify(`${success ? '✓' : '✕'} ${title}`, body);
        this._playSound(success ? 'complete' : 'dialog-warning');
    }

    // Gone without a notification, e.g. "listening" once the speaker stops.
    Clear(id) {
        if (this._items.delete(id))
            this._onChanged();
    }

    ShowAnswer(question, answer) {
        this._onAnswer?.(question, answer);
    }

    // A visual card (cards.js) in an empty part of the screen.
    ShowCard(card) {
        this._onCard?.(card);
    }

    // The whole screen with the pointer in it, so "this green thing" can be found.
    // GNOME keeps its own screenshot API to a few programs; the island lives in the
    // shell, so the voice assistant asks here. Files go to SHOTS only.
    async ScreenshotAsync([name], invocation) {
        const base = GLib.path_get_basename(name || 'screen').replace(/[^\w.-]/g, '_');
        const path = GLib.build_filenamev([SHOTS, base.endsWith('.png') ? base : `${base}.png`]);
        try {
            GLib.mkdir_with_parents(SHOTS, 0o700);
            const file = Gio.File.new_for_path(path);
            const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            // The island itself ("Harvis · Listening…") is not part of what is on screen:
            // out of the picture while it is taken, then a flash to say it was.
            // A watcher looks every half minute: out of the picture, but no flash.
            const quiet = base.startsWith('watch-');
            this._onScreenshot?.('before');
            try {
                await new Shell.Screenshot().screenshot(true, stream);
            } finally {
                this._onScreenshot?.(quiet ? 'quiet' : 'after');
            }
            stream.close(null);
            invocation.return_value(new GLib.Variant('(bs)', [true, path]));
        } catch (e) {
            console.error('Dynamic Island: screenshot failed', e);
            invocation.return_value(new GLib.Variant('(bs)', [false, '']));
        }
    }

    // The assistant's hands (control.js): size, windows, move, click, drag, scroll, type,
    // key, hide. args is JSON: {x, y, button, count, x2, y2, direction, amount, text, combo}.
    // Answers once Harvis's own pointer has arrived, so the next screenshot sees the result.
    async ControlAsync([action, args], invocation) {
        const reply = (ok, info = '') => invocation.return_value(new GLib.Variant('(bs)', [ok, info]));
        try {
            this._control ??= new Control();
            const a = args ? JSON.parse(args) : {};
            const c = this._control;
            switch (action) {
            case 'size':
                return reply(true, c.size().join('x'));
            case 'windows':
                return reply(true, JSON.stringify(c.windows()));
            case 'hide':
                c.hide();
                break;
            case 'move':
                await c.move(a.x, a.y);
                break;
            case 'click':
                await c.click(a.x, a.y, a.button ?? 1, a.count ?? 1);
                break;
            case 'drag':
                await c.drag(a.x, a.y, a.x2, a.y2);
                break;
            case 'scroll':
                await c.scroll(a.x, a.y, a.direction ?? 'down', a.amount ?? 3);
                break;
            case 'type':
                c.type(String(a.text ?? ''));
                break;
            case 'key':
                if (!c.key(String(a.combo ?? '')))
                    return reply(false, `unknown key: ${a.combo}`);
                break;
            default:
                return reply(false, `unknown action: ${action}`);
            }
            return reply(true);
        } catch (e) {
            console.error('Dynamic Island: control failed', e);
            return reply(false, String(e));
        }
    }

    Timer(seconds, label) {
        const id = `timer-${++this._timerCount}`;
        this._items.set(id, {
            id,
            timer: true,
            title: label || _('Timer'),
            icon: 'alarm-symbolic',
            started: now(),
            ends: now() + seconds * 1000,
            length: seconds,
            progress: 0,
            touched: now(),
        });
        this._ensureTick();
        this._onChanged();
        return id;
    }

    cancel(id) {
        this._items.delete(id);
        this._onChanged();
    }

    // ---- Display helpers ----

    // What the collapsed island shows for an item: a countdown for timers,
    // the percentage or the title otherwise.
    static short(item) {
        if (item.timer)
            return clock((item.ends - now()) / 1000);
        if (item.progress >= 0)
            return `${Math.round(item.progress * 100)}%`;
        return item.title;
    }

    static detail(item) {
        if (item.timer)
            return clock((item.ends - now()) / 1000);
        return item.subtitle ?? '';
    }

    _ensureTick() {
        if (this._tickId)
            return;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            const t = now();
            for (const item of this.items) {
                if (item.timer) {
                    item.progress = Math.min(1, 1 - (item.ends - t) / (item.length * 1000));
                    if (t >= item.ends) {
                        this._items.delete(item.id);
                        Main.notify(`⏰ ${item.title}`, _('Time is up'));
                        this._playSound('alarm-clock-elapsed');
                    }
                } else if (t - item.touched > STALE_AFTER) {
                    this._items.delete(item.id);
                }
            }
            this._onChanged();
            if (this._items.size)
                return GLib.SOURCE_CONTINUE;
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _playSound(name) {
        try {
            global.display.get_sound_player().play_from_theme(name, name, null);
        } catch {
            // no sound theme
        }
    }
}

// The card at the top of the control center: one row per activity.
export class ActivitiesCard {
    constructor(activities) {
        this._activities = activities;
        this.actor = new St.BoxLayout({
            style_class: 'dynada-card dynada-activities',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
    }

    sync() {
        const items = this._activities.items;
        this.actor.visible = items.length > 0;
        this.actor.destroy_all_children();
        for (const item of items)
            this.actor.add_child(this._row(item));
    }

    _row(item) {
        const row = new St.BoxLayout({
            style_class: 'dynada-activity',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const top = new St.BoxLayout({x_expand: true});
        top.add_child(new St.Icon({
            icon_name: item.icon,
            style_class: item.timer ? 'dynada-activity-icon dynada-timer' : 'dynada-activity-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        text.add_child(new St.Label({style_class: 'dynada-activity-title', text: item.title}));
        const detail = Activities.detail(item);
        if (detail)
            text.add_child(new St.Label({style_class: 'dynada-activity-detail', text: detail}));
        top.add_child(text);
        if (item.progress >= 0 && !item.timer) {
            top.add_child(new St.Label({
                style_class: 'dynada-activity-percent',
                text: Activities.short(item),
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        const close = new St.Button({
            style_class: 'dynada-card-close',
            can_focus: true,
            accessible_name: _('Dismiss'),
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
        });
        close.connect('clicked', () => this._activities.cancel(item.id));
        top.add_child(close);
        row.add_child(top);

        if (item.progress >= 0) {
            const bar = new BarLevel({style_class: 'dynada-progress dynada-activity-bar', x_expand: true});
            bar.value = item.progress;
            row.add_child(bar);
        }
        return row;
    }
}
