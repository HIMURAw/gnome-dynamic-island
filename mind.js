import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Cairo from 'cairo';
import Graphene from 'gi://Graphene';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Harvis's mind, drawn from the thing it remembers with: the Brain vault's own
// pages and the links between them. A conversation is green, work amber,
// a failure red:
//   listening  green, Umut's voice
//   speaking   green, rings from the centre that follow Harvis's actual voice
//   thinking   amber, a signal hopping from page to page along real links
//   failed     red, Harvis could not do what was asked
// The collapsed island shows a small brain in the same colours (BrainGlyph);
// clicking the Harvis bubble opens MindView, the whole graph.

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
const BRAIN = GLib.build_filenamev([GLib.get_home_dir(), 'Masaüstü', 'Brain']);
const VAULT = 'Brain';
const MAX_NODES = 70;
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

// ---------- The Brain graph ----------

function listMarkdown(dir, base, out) {
    let children;
    try {
        children = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return;
    }
    let info;
    while ((info = children.next_file(null))) {
        const name = info.get_name();
        if (name.startsWith('.'))
            continue;
        const path = GLib.build_filenamev([dir, name]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            listMarkdown(path, `${base}${name}/`, out);
        else if (name.endsWith('.md'))
            out.push({path, rel: `${base}${name}`});
    }
    children.close(null);
}

// Pages that link to others, the best-connected ones, laid out once with a small
// force simulation (pages pull on what they link to, everything pushes apart).
function loadGraph() {
    const files = [];
    listMarkdown(GLib.build_filenamev([BRAIN, 'wiki']), 'wiki/', files);
    listMarkdown(GLib.build_filenamev([BRAIN, 'mistakes']), 'mistakes/', files);
    const byName = new Map(files.map(f => [f.rel.split('/').pop().slice(0, -3).toLowerCase(), f]));
    const edges = new Map();
    for (const file of files) {
        const text = readText(file.path) ?? '';
        for (const match of text.matchAll(/\[\[([^\]|#]+)/g)) {
            const target = byName.get(match[1].trim().toLowerCase());
            if (target && target !== file) {
                const key = [file.rel, target.rel].sort().join('\n');
                edges.set(key, [file.rel, target.rel]);
            }
        }
    }
    const degree = new Map();
    for (const [a, b] of edges.values()) {
        degree.set(a, (degree.get(a) ?? 0) + 1);
        degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    // The best-connected pages, then only those joined to the best-connected one
    // (a stray pair far off would squeeze the rest of the picture).
    let chosen = [...degree.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_NODES).map(([rel]) => rel);
    const inChosen = new Set(chosen);
    const reach = new Set([chosen[0]]);
    for (let grew = true; grew;) {
        grew = false;
        for (const [a, b] of edges.values()) {
            if (inChosen.has(a) && inChosen.has(b) && reach.has(a) !== reach.has(b)) {
                reach.add(a);
                reach.add(b);
                grew = true;
            }
        }
    }
    chosen = chosen.filter(rel => reach.has(rel));
    const index = new Map(chosen.map((rel, i) => [rel, i]));
    const nodes = chosen.map(rel => {
        const kind = rel.startsWith('wiki/people/') ? 'person'
            : rel.startsWith('wiki/projects/') ? 'project'
                : rel.startsWith('mistakes/') ? 'mistake' : 'page';
        return {rel, name: rel.split('/').pop().slice(0, -3), kind, degree: degree.get(rel),
            x: Math.random() - 0.5, y: Math.random() - 0.5, glow: 0};
    });
    const links = [...edges.values()].filter(([a, b]) => index.has(a) && index.has(b))
        .map(([a, b]) => [index.get(a), index.get(b)]);
    const neighbours = nodes.map(() => []);
    for (const [a, b] of links) {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }

    // Fruchterman-Reingold, in a 2:1 box to fit the island.
    const k = 0.9 / Math.sqrt(Math.max(1, nodes.length));
    for (let step = 0; step < 300; step++) {
        const heat = 0.1 * (1 - step / 300) + 0.005;
        const dx = nodes.map(() => 0), dy = nodes.map(() => 0);
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const x = nodes[i].x - nodes[j].x, y = (nodes[i].y - nodes[j].y) * 2;
                const d2 = Math.max(1e-4, x * x + y * y);
                const f = k * k / d2;
                dx[i] += x * f; dy[i] += y * f; dx[j] -= x * f; dy[j] -= y * f;
            }
        }
        for (const [a, b] of links) {
            const x = nodes[a].x - nodes[b].x, y = (nodes[a].y - nodes[b].y) * 2;
            const d = Math.sqrt(x * x + y * y) || 1e-3;
            const f = d / k;
            dx[a] -= x / d * f * d; dy[a] -= y / d * f * d; dx[b] += x / d * f * d; dy[b] += y / d * f * d;
        }
        nodes.forEach((n, i) => {
            if (i === 0) {
                // The best-connected page is Harvis's centre: it stays in the middle.
                n.x = n.y = 0;
                return;
            }
            // A pull to the middle keeps the islands of unlinked groups in view.
            dx[i] -= n.x * 0.6; dy[i] -= n.y * 1.2;
            const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
            n.x += dx[i] / len * Math.min(len, heat);
            n.y += dy[i] / len * Math.min(len, heat) / 2;
        });
    }
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // Symmetric around the centre, so it sits in the middle of the view.
    const sx = Math.max(-x0, x1) || 1, sy = Math.max(-y0, y1) || 1;
    for (const n of nodes) {
        n.x = 0.5 + n.x / sx / 2;
        n.y = 0.5 + n.y / sy / 2;
    }
    return {nodes, links, neighbours, centre: 0};
}

// ---------- The brain view ----------

export class MindView {
    // state(): {mode: 'idle'|'listening'|'thinking'|'speaking'|'failed', text}
    // micLevel(): 0..1 while listening; envelope: VoiceEnvelope
    // onChat(), onListen(): the buttons
    constructor({width, dir, state, micLevel, envelope, onChat, onListen}) {
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

        const stage = new St.Widget({style_class: 'dynada-mind-stage', x_expand: true, reactive: true});
        this._canvas = drawingArea(width - 24, 190, (cr, w, h, s) => this._paint(cr, w, h, s));
        this._canvas.reactive = true;
        stage.add_child(this._canvas);
        this._hoverLabel = new St.Label({style_class: 'dynada-mind-node', visible: false});
        stage.add_child(this._hoverLabel);
        this.actor.add_child(stage);
        this._canvas.connect('motion-event', (_a, event) => this._hover(event));
        this._canvas.connect('leave-event', () => this._hover(null));
        this._canvas.connect('button-release-event', () => this._openHovered());

        this._status = new St.Label({style_class: 'dynada-mind-status', x_expand: true});
        this._last = new St.Label({style_class: 'dynada-mind-last', x_expand: true});
        this._last.clutter_text.ellipsize = 3; // END
        this.actor.add_child(this._status);
        this.actor.add_child(this._last);

        const row = new St.BoxLayout({style_class: 'dynada-mind-actions', x_expand: true});
        row.add_child(this._button(_('Chat'), 'dynada-chat-symbolic', onChat, true));
        row.add_child(this._button(_('Talk'), 'audio-input-microphone-symbolic', onListen));
        this._backend = this._button('', 'network-server-symbolic', () => this._toggleBackend());
        row.add_child(this._backend);
        this._model = new St.Label({style_class: 'dynada-mind-model', y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, x_align: Clutter.ActorAlign.END});
        row.add_child(this._model);
        this.actor.add_child(row);

        this._pulses = [];
        this._rings = [];
        this._lastSpawn = 0;
        this._smoothVoice = 0;
        this._ticker = new Ticker(this.actor, t => this._tick(t));
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
        if (!this._graph || Date.now() - this._graphAt > 10 * 60 * 1000) {
            try {
                this._graph = loadGraph();
            } catch (e) {
                console.error('Dynamic Island: Brain graph', e);
                this._graph = {nodes: [], links: [], neighbours: [], centre: 0};
            }
            this._graphAt = Date.now();
        }
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

    _tick(t) {
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
        const g = this._graph;
        if (g?.nodes.length) {
            // Thinking: signals leave the centre and wander along real links.
            if (mode === 'thinking' && t - this._lastSpawn > 0.14) {
                this._lastSpawn = t;
                const from = this._pulses.length && Math.random() < 0.7
                    ? this._pulses[this._pulses.length - 1].to : g.centre;
                const next = g.neighbours[from];
                if (next?.length)
                    this._pulses.push({from, to: next[Math.floor(Math.random() * next.length)], f: 0});
                if (this._pulses.length > 14)
                    this._pulses.shift();
            }
            for (const p of this._pulses) {
                p.f += 0.08;
                if (p.f >= 1 && !p.done) {
                    p.done = true;
                    g.nodes[p.to].glow = 1;
                }
            }
            this._pulses = this._pulses.filter(p => p.f < 1.6);
            // Speaking: a ring from the centre on each louder moment of the voice.
            const voice = mode === 'speaking' ? this._envelope.level() : 0;
            this._smoothVoice += (voice - this._smoothVoice) * 0.35;
            if (mode === 'speaking' && voice > 0.35 && t - (this._lastRing ?? 0) > 0.28) {
                this._lastRing = t;
                this._rings.push({r: 0, strength: voice});
            }
            for (const ring of this._rings)
                ring.r += 0.02;
            this._rings = this._rings.filter(ring => ring.r < 0.9);
            for (const n of g.nodes)
                n.glow *= 0.94;
        }
        this._canvas.queue_repaint();
    }

    _place(n, w, h) {
        const pad = 14;
        const t = this._ticker.t;
        // A breath of drift, so the graph is alive without moving about.
        const i = n.degree + n.name.length;
        return [pad + n.x * (w - 2 * pad) + Math.sin(t * 0.4 + i) * 1.2,
            pad + n.y * (h - 2 * pad) + Math.cos(t * 0.33 + i * 1.7) * 1.2];
    }

    _paint(cr, w, h, s) {
        const g = this._graph;
        if (!g?.nodes.length)
            return;
        const pos = g.nodes.map(n => this._place(n, w, h));
        const [cx, cy] = pos[g.centre];
        const mode = this._mode;
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Links
        cr.setLineWidth(0.8 * s);
        for (const [a, b] of g.links) {
            const hot = this._hovered === a || this._hovered === b;
            cr.setSourceRGBA(1, 1, 1, hot ? 0.4 : 0.07);
            cr.moveTo(...pos[a]);
            cr.lineTo(...pos[b]);
            cr.stroke();
        }

        // Listening: the centre swells with Umut's voice.
        if (mode === 'listening') {
            const level = this._micLevel?.() ?? 0;
            const [r, gg, b] = COLORS.listening;
            cr.setSourceRGBA(r, gg, b, 0.18 + 0.3 * level);
            cr.arc(cx, cy, (10 + 26 * level) * s, 0, 2 * Math.PI);
            cr.fill();
        }

        // Speaking: rings from the centre.
        for (const ring of this._rings) {
            const [r, gg, b] = COLORS.speaking;
            cr.setSourceRGBA(r, gg, b, (0.9 - ring.r) * 0.6 * ring.strength);
            cr.setLineWidth(1.4 * s);
            cr.arc(cx, cy, ring.r * w * 0.6, 0, 2 * Math.PI);
            cr.stroke();
        }

        // Thinking: the signals.
        const [tr, tg, tb] = COLORS.thinking;
        for (const p of this._pulses) {
            if (p.f > 1)
                continue;
            const [x0, y0] = pos[p.from], [x1, y1] = pos[p.to];
            const f = p.f;
            cr.setLineWidth(1.4 * s);
            cr.setSourceRGBA(tr, tg, tb, 0.5);
            cr.moveTo(x0 + (x1 - x0) * Math.max(0, f - 0.25), y0 + (y1 - y0) * Math.max(0, f - 0.25));
            cr.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
            cr.stroke();
            cr.setSourceRGBA(tr, tg, tb, 0.95);
            cr.arc(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, 2 * s, 0, 2 * Math.PI);
            cr.fill();
        }

        // Pages
        const voice = this._smoothVoice;
        g.nodes.forEach((n, i) => {
            const [x, y] = pos[i];
            const [r, gg, b] = COLORS[n.kind];
            let radius = (1.4 + Math.sqrt(n.degree) * 0.7) * s;
            let alpha = 0.55 + 0.45 * n.glow;
            if (mode === 'speaking') {
                const near = 1 - Math.min(1, Math.hypot(x - cx, y - cy) / (w * 0.5));
                alpha = Math.min(1, alpha + voice * near * 0.6);
                radius *= 1 + voice * near * 0.5;
            }
            if (n.glow > 0.05) {
                cr.setSourceRGBA(tr, tg, tb, 0.25 * n.glow);
                cr.arc(x, y, radius + 5 * s * n.glow, 0, 2 * Math.PI);
                cr.fill();
            }
            cr.setSourceRGBA(r, gg, b, i === this._hovered ? 1 : alpha);
            cr.arc(x, y, i === this._hovered ? radius + 1.5 * s : radius, 0, 2 * Math.PI);
            cr.fill();
        });

        // The centre: Harvis itself, a ring around the best-connected page.
        const ringColor = COLORS[mode] ?? COLORS.page;
        cr.setSourceRGBA(...ringColor, mode === 'idle' ? 0.35 : 0.8);
        cr.setLineWidth(1.2 * s);
        cr.arc(cx, cy, 8 * s, 0, 2 * Math.PI);
        cr.stroke();
    }

    // ---- pointing at a page ----

    _hover(event) {
        const g = this._graph;
        this._hovered = null;
        if (event && g?.nodes.length) {
            const [sx, sy] = event.get_coords();
            const [ok, x, y] = this._canvas.transform_stage_point(sx, sy);
            if (ok) {
                const w = this._canvas.width, h = this._canvas.height;
                let best = 12;
                g.nodes.forEach((n, i) => {
                    const [nx, ny] = this._place(n, w, h);
                    const d = Math.hypot(nx - x, ny - y);
                    if (d < best) {
                        best = d;
                        this._hovered = i;
                    }
                });
                if (this._hovered !== null) {
                    const n = g.nodes[this._hovered];
                    const [nx, ny] = this._place(n, w, h);
                    this._hoverLabel.text = n.name;
                    this._hoverLabel.show();
                    const lw = this._hoverLabel.get_preferred_width(-1)[1];
                    this._hoverLabel.set_position(Math.round(Math.min(Math.max(4, nx - lw / 2), w - lw - 4)),
                        Math.round(ny > h / 2 ? ny - 26 : ny + 10));
                }
            }
        }
        if (this._hovered === null)
            this._hoverLabel.hide();
        this._canvas.queue_repaint();
        return Clutter.EVENT_PROPAGATE;
    }

    _openHovered() {
        if (this._hovered === null)
            return Clutter.EVENT_PROPAGATE;
        const rel = this._graph.nodes[this._hovered].rel.slice(0, -3);
        const uri = `obsidian://open?vault=${encodeURIComponent(VAULT)}&file=${encodeURIComponent(rel)}`;
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error('Dynamic Island: open in Obsidian', e);
        }
        return Clutter.EVENT_STOP;
    }
}
