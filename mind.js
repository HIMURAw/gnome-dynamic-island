import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Cairo from 'cairo';
import Graphene from 'gi://Graphene';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Harvis's own page in the island: its robot (face.js) beside its name, what it is doing
// (green in a conversation, amber at work, red when it failed) and its last answer, with
// Chat / Talk / backend buttons. (Until 2026-10-13 it also drew the Brain vault as a graph;
// Umut asked for only the robot.) BrainGlyph, the old small brain, is no longer used.

const FRAME = 33; // ms, ~30 fps, only while visible
export const COLORS = {
    listening: [0.19, 0.82, 0.35],
    thinking: [0.96, 0.71, 0.32],
    speaking: [0.19, 0.82, 0.35],
    failed: [1.0, 0.27, 0.23],
    person: [0.56, 0.89, 1.0],
    project: [0.96, 0.71, 0.32],
    mistake: [1.0, 0.48, 0.45],
    page: [0.93, 0.93, 0.95],
};
const HARVIS_DATA = GLib.build_filenamev([GLib.get_user_data_dir(), 'harvis']);
const VOICE = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'harvis-voice.json']);

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

// ---------- Harvis's voice, as the service plays it ----------

// voice.py writes (time, loudness) for everything it hands to the player; this
// reads it a few times a second and answers "how loud is Harvis right now".
export class VoiceEnvelope {
    constructor() {
        this._env = [];
        this._read = 0;
    }

    level() {
        const now = Date.now() / 1000;
        if (now - this._read > 0.2) {
            this._read = now;
            try {
                this._env = JSON.parse(readText(VOICE) ?? '{}').env ?? [];
            } catch {
                this._env = [];
            }
        }
        // The last point at or before now.
        let level = 0;
        for (const [t, l] of this._env) {
            if (t > now)
                break;
            if (now - t < 0.1)
                level = l;
        }
        return level;
    }
}

export function drawingArea(width, height, paint) {
    const area = new St.DrawingArea({width, height, y_align: Clutter.ActorAlign.CENTER});
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        try {
            paint(cr, w, h, w / Math.max(1, a.width));
        } finally {
            cr.$dispose();
        }
    });
    return area;
}

// A loop that runs only while its actor is on screen.
export class Ticker {
    constructor(actor, tick) {
        this._actor = actor;
        this._tick = tick;
        this.t = 0;
        actor.connect('notify::mapped', () => this._sync());
        actor.connect('destroy', () => this._stop());
    }

    _sync() {
        if (this._actor.mapped && !this._id) {
            this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME, () => {
                this.t += FRAME / 1000;
                this._tick(this.t);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this._actor.mapped) {
            this._stop();
        }
    }

    _stop() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}

// ---------- Collapsed island ----------

// A brain seen from the side, front to the left, drawn in a 1 x 0.7 box: the
// cortex's bumpy outline, the cerebellum and the stem under its back, and the
// folds (sulci) that signals run along.
const CORTEX = (() => {
    const points = [];
    for (let i = 0; i < 64; i++) {
        const a = (i / 64) * 2 * Math.PI;
        const up = Math.max(0, -Math.sin(a)); // gyri bump the top and the sides, not the base
        const r = 1 + 0.07 * up * Math.cos(11 * a) + 0.03 * Math.cos(5 * a);
        const ry = Math.sin(a) > 0 ? 0.25 : 0.31; // a flatter underside
        points.push([0.47 + 0.43 * r * Math.cos(a), 0.34 + ry * r * Math.sin(a)]);
    }
    return points;
})();
const FOLDS = [
    [[0.13, 0.36], [0.21, 0.24], [0.3, 0.31], [0.36, 0.16]], // frontal
    [[0.52, 0.06], [0.47, 0.17], [0.5, 0.26], [0.44, 0.38]], // central sulcus
    [[0.2, 0.47], [0.33, 0.42], [0.48, 0.4], [0.62, 0.32]], // lateral (Sylvian) fissure
    [[0.62, 0.13], [0.67, 0.24], [0.77, 0.22], [0.83, 0.33]], // parietal
    [[0.29, 0.54], [0.41, 0.5], [0.54, 0.53], [0.64, 0.48]], // temporal
    [[0.7, 0.42], [0.79, 0.38], [0.87, 0.45]], // occipital
];

function foldPoint(fold, f) {
    const q = Math.min(fold.length - 1.0001, Math.max(0, f) * (fold.length - 1));
    const i = Math.floor(q);
    const k = q - i;
    return [fold[i][0] + (fold[i + 1][0] - fold[i][0]) * k, fold[i][1] + (fold[i + 1][1] - fold[i][1]) * k];
}

// A smooth curve through the points (their midpoints, with each point as the control).
function smoothPath(cr, points, x, y, closed) {
    const P = points.map(([u, v]) => [x(u), y(v)]);
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (closed) {
        cr.moveTo(...mid(P[P.length - 1], P[0]));
        P.forEach((p, i) => {
            const m = mid(p, P[(i + 1) % P.length]);
            cr.curveTo(p[0], p[1], p[0], p[1], m[0], m[1]);
        });
        cr.closePath();
    } else {
        cr.moveTo(...P[0]);
        for (let i = 1; i < P.length - 1; i++) {
            const m = mid(P[i], P[i + 1]);
            cr.curveTo(P[i][0], P[i][1], P[i][0], P[i][1], m[0], m[1]);
        }
        cr.lineTo(...P[P.length - 1]);
    }
}

// Harvis in the collapsed island: the brain, coloured by what it is doing.
//   listening, speaking  green, glowing with the voice (Umut's, then Harvis's),
//                        a wave running through its folds from front to back
//   thinking             amber, signals running along the folds
//   failed               red, a short shake, then a slow dim pulse
// Colours ease into each other and a new state gives a small pop, so a change
// reads as one motion. level(mode) is the loudness, 0..1, for that state.
export class BrainGlyph {
    constructor(level) {
        this.mode = 'idle';
        this._color = [...COLORS.listening];
        this._since = 0;
        let smooth = 0;
        this.actor = drawingArea(27, 19, (cr, w, h, s) => {
            const t = this._ticker.t;
            const mode = this.mode;
            const target = COLORS[mode] ?? COLORS.listening;
            this._color = this._color.map((c, i) => c + (target[i] - c) * 0.18);
            const [r, g, b] = this._color;
            const loud = mode === 'listening' || mode === 'speaking' ? Math.min(1, level(mode)) : 0;
            smooth += (loud - smooth) * (loud > smooth ? 0.5 : 0.12);
            const age = t - this._since;
            let glow;
            if (mode === 'thinking')
                glow = 0.45 + 0.15 * Math.sin(t * 3);
            else if (mode === 'failed')
                glow = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3.5));
            else
                glow = 0.3 + 0.7 * smooth;
            // Failed: a head shake that dies away within half a second.
            const shake = mode === 'failed' ? Math.sin(age * 45) * 1.6 * s * Math.exp(-age * 6) : 0;
            const pad = 2 * s;
            const scale = Math.min(w - 2 * pad, (h - 2 * pad) / 0.7);
            const ox = (w - scale) / 2 + shake;
            const oy = (h - 0.7 * scale) / 2;
            const x = u => ox + u * scale;
            const y = v => oy + v * scale;
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);

            // Stem and cerebellum, under the back of the brain.
            cr.setSourceRGBA(r, g, b, 0.35 + 0.3 * glow);
            cr.setLineWidth(1.6 * s);
            cr.moveTo(x(0.6), y(0.58));
            cr.curveTo(x(0.61), y(0.64), x(0.6), y(0.66), x(0.62), y(0.7));
            cr.stroke();
            cr.save();
            cr.translate(x(0.75), y(0.6));
            cr.scale(0.13 * scale, 0.075 * scale);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
            cr.setSourceRGBA(r, g, b, 0.18 + 0.2 * glow);
            cr.fillPreserve();
            cr.setSourceRGBA(r, g, b, 0.5 + 0.4 * glow);
            cr.setLineWidth(0.9 * s);
            cr.stroke();

            // The cortex: a soft halo, a tinted fill, a bright rim.
            smoothPath(cr, CORTEX, x, y, true);
            cr.setSourceRGBA(r, g, b, 0.1 * glow);
            cr.setLineWidth(4 * s);
            cr.strokePreserve();
            cr.setSourceRGBA(r, g, b, 0.1 + 0.2 * glow);
            cr.fillPreserve();
            cr.setSourceRGBA(r, g, b, 0.6 + 0.4 * glow);
            cr.setLineWidth(1.15 * s);
            cr.stroke();

            // The folds: lit by a wave (voice) or by the signals (thinking).
            FOLDS.forEach((fold, k) => {
                let alpha = 0.3 + 0.25 * glow;
                if (mode === 'listening' || mode === 'speaking')
                    alpha = 0.25 + (0.25 + 0.5 * smooth) * (0.5 + 0.5 * Math.sin(fold[0][0] * 9 - t * 7));
                smoothPath(cr, fold, x, y, false);
                cr.setSourceRGBA(r, g, b, alpha);
                cr.setLineWidth(0.85 * s);
                cr.stroke();
                if (mode !== 'thinking')
                    return;
                // A signal per fold, out of step with the others, with a short tail.
                const pos = (t * (0.7 + 0.13 * k) + k * 0.37) % 1.5;
                for (let i = 0; i < 5; i++) {
                    const f = pos - i * 0.05;
                    if (f < 0 || f > 1)
                        continue;
                    const [u, v] = foldPoint(fold, f);
                    cr.setSourceRGBA(1, 1, 0.92, (0.9 - i * 0.17) * (0.6 + 0.4 * glow));
                    cr.arc(x(u), y(v), (1.3 - i * 0.18) * s, 0, 2 * Math.PI);
                    cr.fill();
                }
            });
        });
        this.actor.margin_right = 8;
        this.actor.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        this.actor.visible = false;
        this._ticker = new Ticker(this.actor, () => this.actor.queue_repaint());
    }

    setMode(mode) {
        if (mode === this.mode)
            return;
        this.mode = mode;
        this._since = this._ticker.t;
        this.actor.visible = mode !== 'idle';
        if (!this.actor.visible)
            return;
        // A small pop on each change of state.
        this.actor.remove_all_transitions();
        this.actor.set_scale(0.8, 0.8);
        this.actor.ease({scale_x: 1, scale_y: 1, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }
}

// ---------- The brain view ----------

export class MindView {
    // state(): {mode: 'idle'|'listening'|'thinking'|'speaking'|'failed', text}
    // micLevel(): 0..1 while listening; envelope: VoiceEnvelope
    // onChat(), onListen(): the buttons; avatar: Harvis's robot (face.js), shown beside its name
    constructor({width, dir, state, micLevel, envelope, onChat, onListen, avatar}) {
        this._dir = dir;
        this._state = state;
        this._micLevel = micLevel;
        this._envelope = envelope;
        this.actor = new St.BoxLayout({
            style_class: 'dynada-expanded dynada-mind',
            orientation: Clutter.Orientation.VERTICAL,
            width,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
            opacity: 0,
            visible: false,
        });

        // Harvis itself on top: the robot, its name, what it is doing and what it did last.
        const head = new St.BoxLayout({style_class: 'dynada-mind-head', x_expand: true});
        if (avatar) {
            avatar.actor.y_align = Clutter.ActorAlign.CENTER;
            head.add_child(avatar.actor);
        }
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'dynada-mind-words'});
        words.add_child(new St.Label({style_class: 'dynada-mind-name', text: 'Harvis'}));
        this._status = new St.Label({style_class: 'dynada-mind-status', x_expand: true});
        this._last = new St.Label({style_class: 'dynada-mind-last', x_expand: true});
        this._last.clutter_text.ellipsize = 3; // END
        words.add_child(this._status);
        words.add_child(this._last);
        head.add_child(words);
        this.actor.add_child(head);

        const row = new St.BoxLayout({style_class: 'dynada-mind-actions', x_expand: true});
        row.add_child(this._button(_('Chat'), 'dynada-chat-symbolic', onChat, true));
        row.add_child(this._button(_('Talk'), 'audio-input-microphone-symbolic', onListen));
        this._backend = this._button('', 'network-server-symbolic', () => this._toggleBackend());
        row.add_child(this._backend);
        this._model = new St.Label({style_class: 'dynada-mind-model', y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, x_align: Clutter.ActorAlign.END});
        row.add_child(this._model);
        this.actor.add_child(row);

        this._ticker = new Ticker(this.actor, () => this._tick());
        this.actor.connect('notify::mapped', () => {
            if (this.actor.mapped)
                this.refresh();
        });
    }

    _button(label, icon, onClick, primary = false) {
        const box = new St.BoxLayout({style_class: 'dynada-mind-button-box'});
        const iconActor = icon.startsWith('dynada')
            ? new St.Icon({gicon: new Gio.FileIcon({file: this._dir.get_child('icons').get_child(`${icon}.svg`)}),
                icon_size: 14})
            : new St.Icon({icon_name: icon, icon_size: 14});
        box.add_child(iconActor);
        const text = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(text);
        const button = new St.Button({
            style_class: `dynada-mind-button${primary ? ' primary' : ''}`,
            can_focus: true,
            child: box,
        });
        button._label = text;
        button._icon = iconActor;
        button.connect('clicked', () => onClick());
        return button;
    }

    // ---- data ----

    refresh() {
        let history = [];
        try {
            history = JSON.parse(readText(GLib.build_filenamev([GLib.get_user_data_dir(), 'dynamic-island',
                'chat.json'])) ?? '[]');
        } catch {
            // no history or state yet
        }
        const lastQuestion = [...history].reverse().find(m => m.role === 'user');
        this._last.text = lastQuestion ? _('Last: “%s”').format(lastQuestion.text) : _('No conversation yet.');
        let model = '';
        try {
            const state = JSON.parse(readText(GLib.build_filenamev([HARVIS_DATA, 'state.json'])) ?? '{}');
            model = state.model ?? '';
        } catch {
            // no history or state yet
        }
        this._model.text = model ? _('Last answer: %s').format(model) : '';
        this._local = (readText(GLib.build_filenamev([HARVIS_DATA, 'backend'])) ?? 'auto').trim() === 'local';
        this._backend._label.text = this._local ? _('Local model') : _('Claude');
        this._backend._icon.icon_name = this._local ? 'computer-symbolic' : 'weather-overcast-symbolic';
    }

    _toggleBackend() {
        const harvis = GLib.find_program_in_path('harvis') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'harvis']);
        try {
            Gio.Subprocess.new([harvis, 'backend', this._local ? 'auto' : 'local'], Gio.SubprocessFlags.STDOUT_SILENCE)
                .wait_async(null, () => this.refresh());
        } catch (e) {
            console.error('Dynamic Island: harvis backend', e);
        }
    }

    // ---- motion ----

    _tick() {
        const {mode, text} = this._state();
        this._status.text = {
            idle: _('Ready. Say “Hey Harvis” or snap twice.'),
            listening: _('Listening'),
            thinking: text || _('Thinking'),
            speaking: _('Speaking'),
            failed: text || _('Could not do it'),
        }[mode] ?? '';
        for (const m of ['idle', 'listening', 'thinking', 'speaking', 'failed'])
            (m === mode ? this._status.add_style_class_name : this._status.remove_style_class_name)
                .call(this._status, `dynada-mind-${m}`);
        this._mode = mode;
    }
}
