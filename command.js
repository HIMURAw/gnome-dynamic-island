import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Glass} from './glass.js';
import {robotIcon} from './face.js';

// One press of the Copilot key: a small box in the upper middle of the screen for a
// written command to Harvis. Enter sends it (the answer lands in the island's chat,
// its bubble gets the dot), Escape or a click anywhere else closes it.
export class CommandBox {
    constructor({dir, onSubmit}) {
        this._onSubmit = onSubmit;
        this.actor = new St.Widget({reactive: true, visible: false});
        this._glass = new Glass({radius: 20, style_class: 'dynada-command', reactive: true,
            layout_manager: new Clutter.BinLayout(), pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        const row = new St.BoxLayout({style_class: 'dynada-command-row', x_expand: true});
        const face = robotIcon(dir, 26);
        face.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(face);
        this.entry = new St.Entry({
            style_class: 'dynada-palette-entry dynada-command-entry',
            hint_text: _('A command for Harvis…'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this.entry);
        this._glass.add_child(row);
        this.actor.add_child(this._glass);
        Main.layoutManager.addTopChrome(this.actor);

        this.entry.clutter_text.connect('activate', () => {
            const text = this.entry.text.trim();
            this.close();
            if (text)
                this._onSubmit(text);
        });
        this.entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // A click outside the box closes it; the box itself swallows its clicks.
        this.actor.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._glass.connect('button-press-event', () => Clutter.EVENT_STOP);
    }

    open() {
        if (this.actor.visible) {
            this.close();
            return;
        }
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);
        const width = Math.min(560, monitor.width - 80);
        this._glass.set_size(width, 64);
        this._glass.set_position(Math.round((monitor.width - width) / 2), Math.round(monitor.height * 0.22));
        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        this.entry.text = '';
        this.actor.show();
        this._glass.opacity = 0;
        this._glass.set_scale(0.92, 0.92);
        this._glass.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this.entry.grab_key_focus();
    }

    close() {
        if (!this.actor.visible)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._glass.ease({opacity: 0, scale_x: 0.94, scale_y: 0.94, duration: 140,
            mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: () => this.actor.hide()});
    }

    destroy() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this.actor.destroy();
    }
}
