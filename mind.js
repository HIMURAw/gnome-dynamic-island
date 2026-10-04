import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Cairo from 'cairo';
import Graphene from 'gi://Graphene';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Harvis's mind, drawn from the thing it remembers with: the Brain vault's own
// pages and the links between them. Three states, three motions, one colour each:
//   listening  green, Umut's voice (the bars in wave.js)
//   thinking   amber, a signal hopping from page to page along real links
//   speaking   cyan, rings from the centre that follow Harvis's actual voice
// The collapsed island shows small versions of the last two (ThinkingGlyph,
// VoiceGlyph); clicking the Harvis bubble opens MindView, the whole graph.

const FRAME = 33; // ms, ~30 fps, only while visible
export const COLORS = {
    listening: [0.19, 0.82, 0.35],
    thinking: [0.96, 0.71, 0.32],
    speaking: [0.56, 0.89, 1.0],
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

function drawingArea(width, height, paint) {
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
class Ticker {
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

// Thinking: five pages and the links between them; an amber signal runs the
// path and each page it reaches lights up and fades.
export class ThinkingGlyph {
    constructor() {
        const nodes = [[0.08, 0.6], [0.3, 0.25], [0.52, 0.7], [0.74, 0.3], [0.93, 0.62]];
        const lit = nodes.map(() => 0);
        this.actor = drawingArea(38, 16, (cr, w, h, s) => {
            const [r, g, b] = COLORS.thinking;
            const p = nodes.map(([x, y]) => [x * w, y * h]);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(1 * s);
            cr.setSourceRGBA(r, g, b, 0.22);
            p.slice(1).forEach(([x, y], i) => {
                cr.moveTo(...p[i]);
                cr.lineTo(x, y);
            });
            cr.stroke();
            // The signal: where on the path it is now, with a short tail.
            const pos = (this._ticker.t * 2.2) % (nodes.length - 1 + 0.6);
            for (let k = 0; k < 6; k++) {
                const q = pos - k * 0.06;
                if (q < 0 || q > nodes.length - 1)
                    continue;
                const i = Math.min(nodes.length - 2, Math.floor(q));
                const f = q - i;
                const x = p[i][0] + (p[i + 1][0] - p[i][0]) * f;
                const y = p[i][1] + (p[i + 1][1] - p[i][1]) * f;
                cr.setSourceRGBA(r, g, b, 0.9 - k * 0.15);
                cr.arc(x, y, (1.8 - k * 0.2) * s, 0, 2 * Math.PI);
                cr.fill();
            }
            const reached = Math.floor(pos + 0.02);
            if (reached < nodes.length)
                lit[reached] = 1;
            p.forEach(([x, y], i) => {
                cr.setSourceRGBA(r, g, b, 0.35 + 0.65 * lit[i]);
                cr.arc(x, y, (1.6 + 1.2 * lit[i]) * s, 0, 2 * Math.PI);
                cr.fill();
                lit[i] *= 0.9;
            });
        });
        this.actor.margin_right = 9;
        this._ticker = new Ticker(this.actor, () => this.actor.queue_repaint());
    }
}

// Speaking: three strands of one wave, wide when Harvis is loud, a thin line
// between words. The loudness is the real voice, not a guess.
export class VoiceGlyph {
    constructor(envelope) {
        let smooth = 0;
        this.actor = drawingArea(40, 16, (cr, w, h, s) => {
            const [r, g, b] = COLORS.speaking;
            const target = envelope.level();
            smooth += (target - smooth) * (target > smooth ? 0.5 : 0.15);
            const t = this._ticker.t;
            cr.setLineCap(Cairo.LineCap.ROUND);
            [[1, 0.95, 1.6], [0.7, 0.45, 1.1], [0.5, 0.25, 0.8]].forEach(([amp, alpha, width], k) => {
                cr.setSourceRGBA(r, g, b, alpha);
                cr.setLineWidth(width * s);
                for (let i = 0; i <= 40; i++) {
                    const x = (i / 40) * w;
                    // Pinned at both ends, fullest in the middle.
                    const envelopeX = Math.sin((i / 40) * Math.PI);
                    const a = (0.08 + smooth * 0.92) * amp * envelopeX * (h / 2 - 1.5 * s);
                    const y = h / 2 + a * Math.sin(i / 40 * Math.PI * (2.5 + k) - t * (7 + k * 2.3) + k);
                    if (i === 0)
                        cr.moveTo(x, y);
                    else
                        cr.lineTo(x, y);
                }
                cr.stroke();
            });
        });
        this.actor.margin_right = 9;
        this._ticker = new Ticker(this.actor, () => this.actor.queue_repaint());
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
    // state(): {mode: 'idle'|'listening'|'thinking'|'speaking', text}
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
        }[mode] ?? '';
        for (const m of ['idle', 'listening', 'thinking', 'speaking'])
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
