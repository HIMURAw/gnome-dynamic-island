import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';

import {Avatar, drawCairo} from './avatar.js';
import {drawingArea} from './mind.js';

// Harvis in the collapsed island, as its character (avatar.js, shared with the Harvis app and
// the cursor theme): an orange spark with a face. It is always there, not only when Harvis is
// busy, because it is meant to feel alive:
//   idle       breathes, blinks, its eyes follow the pointer; happy when the pointer comes close
//   listening  perks up, rays shiver with Umut's voice
//   thinking   spins like a pinwheel, eyes up and aside
//   speaking   mouth and rays move with Harvis's own voice
//   failed     droops, turns red, frowns
//   sleeping   the Harvis service is not running: eyes shut, rays pulled in
// The mood (mind.json, valence/arousal) tints it and sets its tempo.

const FAST = 33;  // ms, while something happens
const SLOW = 50;  // ms, idle
const MIND = GLib.build_filenamev([GLib.get_user_data_dir(), 'harvis', 'mind.json']);

export class AvatarGlyph {
    // level(mode): loudness 0..1 for that state
    constructor(level) {
        this.mode = 'idle';
        this._level = level;
        this._avatar = new Avatar({compact: true});
        this._serviceUp = true;
        this._last = 0;
        this.actor = drawingArea(24, 24, (cr, w, h) => {
            drawCairo(cr, this._avatar.shapes(), {x: w / 2, y: h / 2, size: Math.min(w, h)});
        });
        this.actor.margin_right = 7;
        this.actor.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        this.actor.connect('notify::mapped', () => this._sync());
        this.actor.connect('destroy', () => this._stop());
    }

    setMode(mode) {
        if (mode === this.mode)
            return;
        this.mode = mode;
        this._apply();
        this._sync();
    }

    emote(name) {
        this._avatar.emote(name);
    }

    _apply() {
        const mode = this.mode === 'idle' && !this._serviceUp ? 'sleeping' : this.mode;
        this._avatar.setState(mode);
    }

    _sync() {
        if (this.actor.mapped && !this._frameId) {
            this._readMood();
            this._checkService();
            this._slowId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 20, () => {
                this._readMood();
                this._checkService();
                return GLib.SOURCE_CONTINUE;
            });
            this._schedule();
        } else if (!this.actor.mapped) {
            this._stop();
        } else if (this._frameId) {
            this._schedule();  // the tempo may have changed
        }
    }

    _schedule() {
        if (this._frameId)
            GLib.source_remove(this._frameId);
        const fast = this.mode !== 'idle';
        this._fast = fast;
        this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, fast ? FAST : SLOW, () => {
            this._frame();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _frame() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = this._last ? now - this._last : 0;
        this._last = now;
        const a = this._avatar;
        a.setLevel(this.mode === 'listening' || this.mode === 'speaking' ? Math.min(1, this._level(this.mode)) : 0);
        this._follow(a);
        a.step(dt);
        this.actor.queue_repaint();
    }

    // The eyes follow the pointer; it gets happy when the pointer comes close.
    _follow(a) {
        const [px, py] = global.get_pointer();
        const [ax, ay] = this.actor.get_transformed_position();
        const dx = px - (ax + this.actor.width / 2);
        const dy = py - (ay + this.actor.height / 2);
        const d = Math.hypot(dx, dy);
        if (px !== this._px || py !== this._py) {
            this._px = px;
            this._py = py;
            this._still = 0;
            const k = Math.min(1, d / 120) / Math.max(d, 1);
            a.lookAt(dx * k, dy * k);
        } else if ((this._still = (this._still ?? 0) + 1) > 90) {
            a.lookAt(null);  // the pointer has rested: look around by itself
        }
        const near = d < 36;
        if (near && !this._near && this.mode === 'idle')
            a.emote('joy');
        this._near = near;
    }

    _readMood() {
        try {
            const [ok, bytes] = GLib.file_get_contents(MIND);
            if (!ok)
                return;
            const {mood} = JSON.parse(new TextDecoder().decode(bytes));
            if (mood)
                this._avatar.setMood(mood.valence, mood.arousal);
        } catch {
            // no mind yet: a neutral mood
        }
    }

    _checkService() {
        try {
            const proc = Gio.Subprocess.new(['systemctl', '--user', 'is-active', '--quiet', 'harvis.service'],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, (p, res) => {
                let up = false;
                try {
                    up = p.wait_check_finish(res);
                } catch {
                    // not running
                }
                if (up === this._serviceUp || !this._frameId)
                    return;
                this._serviceUp = up;
                this._apply();
            });
        } catch {
            // no systemctl: leave it awake
        }
    }

    _stop() {
        if (this._frameId)
            GLib.source_remove(this._frameId);
        if (this._slowId)
            GLib.source_remove(this._slowId);
        this._frameId = this._slowId = 0;
        this._last = 0;
    }
}
