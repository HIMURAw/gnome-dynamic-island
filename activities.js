import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

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
    <method name="Timer">
      <arg type="u" direction="in" name="seconds"/>
      <arg type="s" direction="in" name="label"/>
      <arg type="s" direction="out" name="id"/>
    </method>
  </interface>
</node>`;
const OBJECT_PATH = '/io/github/himuraw/DynamicIsland';
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
    constructor({onChanged}) {
        this._onChanged = onChanged;
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
