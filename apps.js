import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const ICON_SIZE = 34;
// Two rows of four; with more apps the last place says how many are left out.
const PER_ROW = 4;
const MAX_ICONS = 2 * PER_ROW;

// The apps that are open right now, most recently used first. Clicking one
// brings it forward; hovering one shows its name in the heading.
export class AppsCard {
    constructor({onActivated}) {
        this._onActivated = onActivated;
        this._appSystem = Shell.AppSystem.get_default();
        this._tracker = Shell.WindowTracker.get_default();

        this.actor = new St.BoxLayout({
            style_class: 'dynada-card dynada-apps',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._heading = new St.Label({style_class: 'dynada-card-heading', text: _('Open apps')});
        this.actor.add_child(this._heading);
        this._grid = new St.BoxLayout({
            style_class: 'dynada-apps-grid',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.actor.add_child(this._grid);
        this._empty = new St.Label({
            style_class: 'dynada-apps-empty',
            text: _('No open apps'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this.actor.add_child(this._empty);

        this._ids = [
            [this._appSystem, this._appSystem.connect('app-state-changed', () => this._queueSync())],
            [this._tracker, this._tracker.connect('notify::focus-app', () => this._queueSync())],
            [this.actor, this.actor.connect('notify::mapped', () => this._dirty && this._queueSync())],
        ];
        this._dirty = true;
    }

    // Focus changes all the time; the icons are only rebuilt while the card is
    // on screen, and once for a burst of changes.
    _queueSync() {
        this._dirty = true;
        if (this._idle || !this.actor.mapped)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _lastUsed(app) {
        return Math.max(0, ...app.get_windows().map(w => w.get_user_time()));
    }

    _sync() {
        this._dirty = false;
        this._grid.destroy_all_children();
        const apps = this._appSystem.get_running()
            .sort((a, b) => this._lastUsed(b) - this._lastUsed(a));
        const shown = apps.length > MAX_ICONS ? apps.slice(0, MAX_ICONS - 1) : apps;
        const focused = this._tracker.focus_app;

        const items = shown.map(app => this._button(app, app === focused));
        if (shown.length < apps.length) {
            items.push(new St.Label({
                style_class: 'dynada-app dynada-app-more',
                text: `+${apps.length - shown.length}`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        for (let i = 0; i < items.length; i += PER_ROW) {
            const row = new St.BoxLayout({style_class: 'dynada-apps-row'});
            items.slice(i, i + PER_ROW).forEach(item => row.add_child(item));
            this._grid.add_child(row);
        }
        this._grid.visible = apps.length > 0;
        this._empty.visible = apps.length === 0;
        this._heading.text = _('Open apps');
    }

    _button(app, focused) {
        const button = new St.Button({
            style_class: 'dynada-app',
            can_focus: true,
            accessible_name: app.get_name(),
            child: new St.Icon({gicon: app.get_icon(), icon_size: ICON_SIZE}),
        });
        if (focused)
            button.add_style_pseudo_class('focused');
        button.connect('clicked', () => {
            app.activate();
            this._onActivated();
        });
        button.connect('notify::hover', () => {
            this._heading.text = button.hover ? app.get_name() : _('Open apps');
        });
        return button;
    }

    destroy() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        this.actor.destroy();
    }
}
