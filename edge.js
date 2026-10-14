import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Harvis along the edges of every monitor: a soft green light while it speaks, breathing
// with its voice; yellow while it works on something; purple while it drives the screen
// (Umut, 2026-10-14). From anywhere it is plain what the computer is doing.
//
// Cheap on purpose: four gradient strips per monitor, not one fullscreen layer, so only the edges
// are ever redrawn; the gradient is painted once and cached by St, and the voice moves it only
// through opacity and scale, which the GPU applies without repainting. The 20 fps loop runs only
// while Harvis speaks and skips frames where nothing changed; at rest the glow is a still image.

const THICK = 64;       // px, logical
const FRAME = 50;       // ms (20 fps), only while speaking: light needs no more
const REST = 200;       // opacity while controlling and quiet

export class EdgeGlow {
    // level(): Harvis's loudness 0..1 (VoiceEnvelope)
    constructor(level) {
        this._level = level;
        this._active = false;
        this._speaking = false;
        this._smooth = 0;
        this._shown = -1;
        this._strips = [];
        this._group = new St.Widget({reactive: false, can_focus: false, opacity: 0, visible: false});
        Main.layoutManager.uiGroup.add_child(this._group);
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._build());
        this._build();
    }

    destroy() {
        this._loop(false);
        if (this._unredirect)
            global.compositor.enable_unredirect();
        this._unredirect = false;
        Main.layoutManager.disconnect(this._monitorsId);
        this._group.destroy();
    }

    // below: an actor (the island) the glow must stay under.
    keepBelow(below) {
        this._below = below;
    }

    // mode: null (off), 'speaking' (green, with the voice), 'working' (yellow),
    // 'control' (purple, Harvis drives the screen).
    setMode(mode) {
        if (mode === this._modeName)
            return;
        this._modeName = mode;
        if (mode)
            for (const strip of this._strips)
                strip.style_class = this._stripClass(strip._side);
        this.setActive(!!mode);
        this.setSpeaking(mode === 'speaking');
    }

    _stripClass(side) {
        const color = {speaking: 'green', working: 'yellow'}[this._modeName] ?? 'purple';
        return `dynada-edge dynada-edge-${side}-${color}`;
    }

    setActive(on) {
        if (on === this._active)
            return;
        this._active = on;
        this._group.remove_all_transitions();
        if (on) {
            // Over a fullscreen window the compositor has to stay in the way, or the glow is not drawn.
            if (!this._unredirect)
                global.compositor.disable_unredirect();
            this._unredirect = true;
            const parent = this._group.get_parent();
            let top = this._below;
            while (top && top.get_parent() !== parent)
                top = top.get_parent();
            if (top)
                parent.set_child_below_sibling(this._group, top);
            else
                parent.set_child_above_sibling(this._group, null);
            this._group.show();
            this._group.ease({opacity: 255, duration: 350, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._apply(0);
        } else {
            this._loop(false);
            this._group.ease({opacity: 0, duration: 450, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (!this._active) {
                        this._group.hide();
                        if (this._unredirect)
                            global.compositor.enable_unredirect();
                        this._unredirect = false;
                    }
                }});
        }
        this._loop(on && this._speaking);
    }

    setSpeaking(on) {
        if (on === this._speaking)
            return;
        this._speaking = on;
        this._loop(on && this._active);
        if (!on && this._active) {
            this._smooth = 0;
            this._apply(0);
        }
    }

    _build() {
        this._group.destroy_all_children();
        this._strips = [];
        for (const m of Main.layoutManager.monitors) {
            const t = THICK;
            for (const [side, x, y, w, h, pivot] of [
                ['top', m.x, m.y, m.width, t, [0.5, 0]],
                ['bottom', m.x, m.y + m.height - t, m.width, t, [0.5, 1]],
                ['left', m.x, m.y, t, m.height, [0, 0.5]],
                ['right', m.x + m.width - t, m.y, t, m.height, [1, 0.5]],
            ]) {
                const strip = new St.Widget({style_class: this._stripClass(side), reactive: false,
                    x, y, width: w, height: h, pivot_point: new Graphene.Point({x: pivot[0], y: pivot[1]})});
                strip._vertical = side === 'top' || side === 'bottom';
                strip._side = side;
                this._group.add_child(strip);
                this._strips.push(strip);
            }
        }
        this._shown = -1;
        this._apply(this._smooth);
    }

    _loop(on) {
        if (on && !this._frameId) {
            this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME, () => {
                const l = Math.min(1, Math.max(0, this._level() || 0));
                // Quick to rise, slow to fall: it reads as speech, not flicker.
                this._smooth += (l - this._smooth) * (l > this._smooth ? 0.55 : 0.12);
                this._apply(this._smooth);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._frameId) {
            GLib.source_remove(this._frameId);
            this._frameId = 0;
        }
    }

    // Loudness → brighter and deeper light. Skipped when the change would not show.
    _apply(level) {
        const q = Math.round(level * 40);
        if (q === this._shown)
            return;
        this._shown = q;
        const k = q / 40;
        const opacity = Math.round(REST + (255 - REST) * k);
        const scale = 0.7 + 0.75 * k;
        for (const s of this._strips) {
            s.opacity = opacity;
            if (s._vertical)
                s.scale_y = scale;
            else
                s.scale_x = scale;
        }
    }
}
