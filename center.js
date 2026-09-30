import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {RoundedMask} from './glass.js';

const ICON_SIZE = 36;

// The bell ships with the extension: icon themes disagree on what
// "notifications" looks like, and some draw a screen instead of a bell.
export function bellIcon(dir, off = false) {
    const name = off ? 'dynada-bell-off-symbolic.svg' : 'dynada-bell-symbolic.svg';
    return new Gio.FileIcon({file: dir.get_child('icons').get_child(name)});
}
const MAX_ROWS = 30;
// About two lines of body text on a card.
const MAX_BODY = 110;

// Minimal printf for translated strings: %d and %s in order.
function fmt(str, ...args) {
    return str.replace(/%([ds%])/g, (m, c) => (c === '%' ? '%' : String(args.shift())));
}

const plain = text => (text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// The island's own notification center, shown when the left bubble is clicked.
// It replaces GNOME's calendar menu: a strip with this week, Do Not Disturb,
// and every notification in the message tray as a card, newest first.
export class NotificationCenter {
    constructor({width, dir, onActivated}) {
        this._onActivated = onActivated;
        this._dir = dir;
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        this.actor = new St.BoxLayout({
            style_class: 'dynada-expanded dynada-center',
            orientation: Clutter.Orientation.VERTICAL,
            width,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });

        // Month and Do Not Disturb
        const top = new St.BoxLayout({x_expand: true});
        this._month = new St.Label({
            style_class: 'dynada-center-month',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dndIcon = new St.Icon({icon_size: 16});
        const dndContent = new St.BoxLayout({style_class: 'dynada-pill-content'});
        dndContent.add_child(this._dndIcon);
        dndContent.add_child(new St.Label({text: _('Do Not Disturb'), y_align: Clutter.ActorAlign.CENTER}));
        this._dndButton = new St.Button({
            style_class: 'dynada-pill-button',
            can_focus: true,
            toggle_mode: true,
            accessible_name: _('Do Not Disturb'),
            child: dndContent,
        });
        this._dndButton.connect('clicked', () => {
            this._settings.set_boolean('show-banners', !this._dndButton.checked);
        });
        this._settingsId = this._settings.connect('changed::show-banners', () => this._syncDnd());
        top.add_child(this._month);
        top.add_child(this._dndButton);
        this.actor.add_child(top);

        // This week
        this._week = new St.BoxLayout({style_class: 'dynada-week dynada-chip', x_expand: true});
        this._days = [];
        for (let i = 0; i < 7; i++) {
            const name = new St.Label({style_class: 'dynada-day-name', x_align: Clutter.ActorAlign.CENTER});
            const number = new St.Label({style_class: 'dynada-day-number', x_align: Clutter.ActorAlign.CENTER});
            const day = new St.BoxLayout({
                style_class: 'dynada-day',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            day.add_child(name);
            day.add_child(number);
            this._days.push({day, name, number});
            this._week.add_child(day);
        }
        this.actor.add_child(this._week);

        // Notifications header
        const header = new St.BoxLayout({style_class: 'dynada-center-header', x_expand: true});
        this._heading = new St.Label({
            style_class: 'dynada-center-heading',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearButton = new St.Button({
            style_class: 'dynada-pill-button dynada-clear',
            can_focus: true,
            label: _('Clear'),
        });
        this._clearButton.connect('clicked', () => this._clear());
        header.add_child(this._heading);
        header.add_child(this._clearButton);
        this.actor.add_child(header);

        // Cards
        this._list = new St.BoxLayout({
            style_class: 'dynada-center-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'dynada-center-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; a bar would sit on the close buttons.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            child: this._list,
        });
        this.actor.add_child(this._scroll);

        this._empty = new St.BoxLayout({
            style_class: 'dynada-center-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._empty.add_child(new St.Icon({
            gicon: bellIcon(dir, true),
            icon_size: 28,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._empty.add_child(new St.Label({text: _('No notifications'), x_align: Clutter.ActorAlign.CENTER}));
        this.actor.add_child(this._empty);

        this._syncDnd();
        this.refresh();
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._settings = null;
        this.actor.destroy();
    }

    get dndActive() {
        return !this._settings.get_boolean('show-banners');
    }

    _syncDnd() {
        const dnd = this.dndActive;
        this._dndButton.checked = dnd;
        this._dndIcon.gicon = bellIcon(this._dir, dnd);
        this.onDndChanged?.(dnd);
    }

    // An empty list if GNOME's message tray is not what we expect, so the
    // center still opens.
    static notifications() {
        try {
            return Main.messageTray.getSources()
                .flatMap(source => source.notifications ?? [])
                .sort((a, b) => b.datetime.compare(a.datetime));
        } catch (e) {
            console.error('Dynamic Island: could not read notifications', e);
            return [];
        }
    }

    refresh() {
        this._syncWeek();
        this._list.destroy_all_children();
        const all = NotificationCenter.notifications();
        for (const notification of all.slice(0, MAX_ROWS))
            this._list.add_child(this._card(notification));

        this._heading.text = all.length
            ? fmt(_('Notifications · %d'), all.length) : _('Notifications');
        this._clearButton.visible = all.some(n => !n.resident);
        this._scroll.visible = all.length > 0;
        this._empty.visible = all.length === 0;
    }

    // Everything on screen has now been seen.
    acknowledgeAll() {
        for (const notification of NotificationCenter.notifications()) {
            if (!notification.acknowledged)
                notification.acknowledged = true;
        }
    }

    _syncWeek() {
        const now = GLib.DateTime.new_now_local();
        this._month.text = now.format('%B %Y');
        // 0 = Sunday, like GLib's day of week modulo 7.
        const weekStart = Shell.util_get_week_start();
        const offset = (now.get_day_of_week() % 7 - weekStart + 7) % 7;
        const first = now.add_days(-offset);
        this._days.forEach(({day, name, number}, i) => {
            const date = first.add_days(i);
            name.text = date.format('%a');
            number.text = String(date.get_day_of_month());
            if (i === offset)
                day.add_style_pseudo_class('today');
            else
                day.remove_style_pseudo_class('today');
        });
    }

    _card(notification) {
        const button = new St.Button({
            style_class: 'dynada-card',
            can_focus: true,
            x_expand: true,
        });
        const row = new St.BoxLayout({style_class: 'dynada-card-row', x_expand: true});
        button.set_child(row);

        const gicon = notification.gicon ?? notification.source.icon ??
            new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
        const symbolic = gicon instanceof Gio.ThemedIcon &&
            gicon.get_names().some(n => n.endsWith('-symbolic'));
        const iconBin = new St.Bin({
            style_class: 'dynada-card-icon',
            width: ICON_SIZE,
            height: ICON_SIZE,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({gicon, icon_size: symbolic ? 20 : ICON_SIZE}),
        });
        const mask = new RoundedMask();
        mask.setGeometry(ICON_SIZE, ICON_SIZE, 10);
        iconBin.add_effect(mask);

        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const meta = new St.BoxLayout({x_expand: true});
        meta.add_child(new St.Label({
            style_class: 'dynada-card-app',
            text: plain(notification.source.title),
            x_expand: true,
        }));
        meta.add_child(new St.Label({style_class: 'dynada-card-time', text: this._when(notification.datetime)}));
        text.add_child(meta);
        text.add_child(new St.Label({style_class: 'dynada-card-title', text: plain(notification.title)}));
        let bodyText = plain(notification.body);
        if (bodyText) {
            // The list lays cards out at their minimum height, and an ellipsizing
            // label's minimum is one line. So the text is shortened here and
            // wrapped in full instead.
            if (bodyText.length > MAX_BODY)
                bodyText = `${bodyText.slice(0, MAX_BODY - 1).trimEnd()}…`;
            const body = new St.Label({style_class: 'dynada-card-body', text: bodyText});
            body.clutter_text.line_wrap = true;
            body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            text.add_child(body);
        }

        row.add_child(iconBin);
        row.add_child(text);

        if (!notification.resident) {
            const close = new St.Button({
                style_class: 'dynada-card-close',
                can_focus: true,
                accessible_name: _('Dismiss'),
                y_align: Clutter.ActorAlign.START,
                child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            });
            close.connect('clicked', () => notification.destroy());
            row.add_child(close);
        }

        button.connect('clicked', () => {
            this._onActivated();
            notification.activate();
        });
        return button;
    }

    _when(datetime) {
        const now = GLib.DateTime.new_now_local();
        const minutes = Math.floor(now.difference(datetime) / 60e6);
        if (minutes < 1)
            return _('now');
        if (minutes < 60)
            return fmt(_('%d min'), minutes);
        const today = now.get_day_of_year() === datetime.get_day_of_year() &&
            now.get_year() === datetime.get_year();
        if (today)
            return datetime.format('%H:%M');
        return datetime.format('%-d %b');
    }

    _clear() {
        for (const notification of NotificationCenter.notifications()) {
            if (!notification.resident)
                notification.destroy();
        }
    }
}
