import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {Robot, drawCairo, signature} from './robot.js';
import {drawingArea} from './mind.js';

// Harvis in the collapsed island, as its character: the purple neon pixel robot (robot.js,
// shared with the Harvis app). It is always there, not only when Harvis is busy, because it
// is meant to feel alive:
//   idle       breathes, blinks, its eyes follow the pointer; ^^ when the pointer comes close
//   listening  hops up, its ear lights flash with Umut's voice
//   thinking   eyes scan the visor side to side, the antenna blinks fast
//   speaking   a mouth in the visor and the chest light move with Harvis's own voice
//   failed     red X eyes, the antenna flashes red
//   sleeping   the Harvis service is not running: eyes shut, lights dim, a "z"
// The mood (mind.json) sets its tempo; high spirits give it ^^ eyes when idle.

// The robot's own box inside its 32 x 32 sprite (ears to feet, antenna to soles).
const CROP = {x: 2, y: 3, w: 28, h: 26};

const FAST = 33;  // ms, while something happens
const SLOW = 100; // ms, idle (only a changed frame is painted)
const MIND = GLib.build_filenamev([GLib.get_user_data_dir(), 'harvis', 'mind.json']);

// A still picture of the robot (icons/harvis-robot.svg), for places that need no motion
// (beside each of Harvis's chat messages): nothing ticks for it.
export function robotIcon(dir, size) {
    return new St.Icon({gicon: new Gio.FileIcon({file: dir.get_child('icons').get_child('harvis-robot.svg')}),
        icon_size: size, style_class: 'dynada-robot-icon'});
}

export class AvatarGlyph {
    // level(mode): loudness 0..1 for that state
    // scale: logical px per sprite pixel (1 in the collapsed island, larger in the brain view)
    constructor(level, {scale = 1} = {}) {
        this.mode = 'idle';
        this._level = level;
        this._avatar = new Robot('head');
        this._serviceUp = true;
        this._last = 0;
        // One sprite pixel per logical pixel; drawCairo snaps them to device pixels.
        this.actor = drawingArea(Math.round(CROP.w * scale), Math.round(CROP.h * scale), (cr, w, h, s) => {
            const px = s * scale;
            drawCairo(cr, this._shown ?? this._avatar.frame(), {x: -CROP.x * px, y: -CROP.y * px, px, Cairo});
        });
        if (scale === 1)
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
        // Pixel art changes a few times a second when idle: repaint only then, so the
        // compositor is not woken for identical frames.
        const frame = a.frame();
        const key = signature(frame);
        if (key === this._key)
            return;
        this._key = key;
        this._shown = frame;
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
            // Pixel eyes move a whole pixel or not at all: look only when the pointer is clearly aside.
            a.lookAt(Math.abs(dx) > 60 ? Math.sign(dx) : 0, dy > 80 ? 1 : 0);
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
