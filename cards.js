import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Cairo from 'cairo';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Ticker, drawingArea} from './mind.js';

// Visual cards: what an answer is about, shown for a moment in an empty part of the
// screen ("Hey Harvis, hava nasıl" → the weather, moving). A card is JSON, through
// D-Bus (ShowCard, `dynada card '{…}'`):
//   {"type": "weather", "place": "Ankara", "now": {"temp": 14, "feels": 12, "cond": "rain", "text": "Hafif yağmur"},
//    "days": [{"day": "Per", "hi": 17, "lo": 8, "cond": "partly"}, …]}
//   {"type": "stats", "title": "Gündem Gözlüğü", "items": [{"label": "İzlenme", "value": "12,4 B", "delta": "+320"}]}
//   {"type": "list", "title": "Bugün", "items": ["…", "…"]}
//   {"type": "text", "title": "…", "text": "…"}
// Optional everywhere: "subtitle", "seconds" (how long it stays). Hovering keeps it,
// a click closes it, a new card replaces it.

const WIDTH = 320;
const MARGIN = 28;
const SECONDS = 15;
const ICONS = {stats: 'view-statistics-symbolic', list: 'view-list-symbolic', text: 'dialog-information-symbolic'};
const TINT = {sun: [1.0, 0.8, 0.3], moon: [0.85, 0.88, 1.0], cloud: [0.85, 0.88, 0.93], rain: [0.45, 0.72, 1.0],
    snow: [0.92, 0.96, 1.0], storm: [1.0, 0.86, 0.35], fog: [0.75, 0.78, 0.82]};

// ---------- Weather, drawn and moving ----------

function cloud(cr, cx, cy, r) {
    // Three puffs on a flat base.
    cr.newSubPath();
    cr.arc(cx - r * 0.55, cy + r * 0.1, r * 0.45, 0, 2 * Math.PI);
    cr.newSubPath();
    cr.arc(cx, cy - r * 0.15, r * 0.6, 0, 2 * Math.PI);
    cr.newSubPath();
    cr.arc(cx + r * 0.6, cy + r * 0.12, r * 0.42, 0, 2 * Math.PI);
    cr.rectangle(cx - r * 0.55, cy + r * 0.1, r * 1.15, r * 0.44);
    cr.fill();
}

function sun(cr, cx, cy, r, t, s) {
    const [R, G, B] = TINT.sun;
    const glow = 0.5 + 0.5 * Math.sin(t * 2);
    cr.setSourceRGBA(R, G, B, 0.15 + 0.1 * glow);
    cr.arc(cx, cy, r * 1.45, 0, 2 * Math.PI);
    cr.fill();
    cr.setSourceRGBA(R, G, B, 0.95);
    cr.setLineWidth(2.2 * s);
    cr.setLineCap(Cairo.LineCap.ROUND);
    for (let i = 0; i < 8; i++) {
        const a = t * 0.6 + (i * Math.PI) / 4;
        cr.moveTo(cx + Math.cos(a) * r * 1.15, cy + Math.sin(a) * r * 1.15);
        cr.lineTo(cx + Math.cos(a) * r * (1.45 + 0.08 * glow), cy + Math.sin(a) * r * (1.45 + 0.08 * glow));
    }
    cr.stroke();
    cr.arc(cx, cy, r * 0.9, 0, 2 * Math.PI);
    cr.fill();
}

function moon(cr, cx, cy, r, t, s) {
    const [R, G, B] = TINT.moon;
    cr.setSourceRGBA(R, G, B, 0.95);
    cr.arc(cx, cy, r, 0, 2 * Math.PI);
    cr.arcNegative(cx + r * 0.45, cy - r * 0.3, r * 0.85, 2 * Math.PI, 0);
    cr.fill();
    [[-1.3, -0.9, 0], [1.2, -1.2, 1.7], [1.4, 0.6, 3.1]].forEach(([dx, dy, phase]) => {
        cr.setSourceRGBA(R, G, B, 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2.5 + phase)));
        cr.arc(cx + dx * r, cy + dy * r, 1.4 * s, 0, 2 * Math.PI);
        cr.fill();
    });
}

function weatherPainter(cond, night) {
    return (cr, w, h, s, t) => {
        const r = Math.min(w, h) * 0.24;
        const cx = w / 2;
        const cy = h / 2;
        const drift = Math.sin(t * 0.8) * r * 0.12;
        const kind = cond === 'sun' && night ? 'moon' : cond;
        if (kind === 'sun') {
            sun(cr, cx, cy, r, t, s);
            return;
        }
        if (kind === 'moon') {
            moon(cr, cx, cy, r * 0.95, t, s);
            return;
        }
        if (kind === 'partly')
            (night ? moon : sun)(cr, cx + r * 0.45, cy - r * 0.45, r * 0.7, t, s);
        if (kind === 'fog') {
            cr.setSourceRGBA(...TINT.fog, 0.85);
            cr.setLineWidth(2.4 * s);
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i < 4; i++) {
                const y = cy - r * 0.6 + i * r * 0.42;
                const shift = Math.sin(t * 1.2 + i) * r * 0.3;
                cr.moveTo(cx - r * 1.1 + shift, y);
                cr.lineTo(cx + r * 1.1 + shift - (i % 2) * r * 0.5, y);
            }
            cr.stroke();
            return;
        }
        const dark = kind === 'storm' || kind === 'rain';
        const [cr_, cg, cb] = dark ? [0.7, 0.74, 0.82] : TINT.cloud;
        cr.setSourceRGBA(cr_, cg, cb, 0.95);
        cloud(cr, cx + drift - (kind === 'partly' ? r * 0.15 : 0), cy - (kind === 'cloud' || kind === 'partly' ? 0 : r * 0.35),
            r * 1.05);
        const base = cy + r * 0.35;
        if (kind === 'rain' || kind === 'storm') {
            const [R, G, B] = TINT.rain;
            cr.setLineWidth(1.8 * s);
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i < 5; i++) {
                const phase = (t * 1.6 + i * 0.37) % 1;
                const x = cx - r * 0.8 + i * r * 0.4 + drift - phase * r * 0.15;
                const y = base + phase * r * 1.1;
                cr.setSourceRGBA(R, G, B, 1 - phase);
                cr.moveTo(x, y);
                cr.lineTo(x - r * 0.08, y + r * 0.28);
                cr.stroke();
            }
        }
        if (kind === 'snow') {
            const [R, G, B] = TINT.snow;
            for (let i = 0; i < 6; i++) {
                const phase = (t * 0.5 + i * 0.29) % 1;
                const x = cx - r * 0.9 + i * r * 0.36 + Math.sin(t * 2 + i) * r * 0.1 + drift;
                cr.setSourceRGBA(R, G, B, 1 - phase * 0.8);
                cr.arc(x, base + phase * r * 1.2, 1.9 * s, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        if (kind === 'storm') {
            // A bolt every few seconds, bright then gone.
            const flash = Math.max(0, 1 - ((t % 2.6) / 0.35));
            if (flash > 0) {
                const [R, G, B] = TINT.storm;
                cr.setSourceRGBA(R, G, B, flash);
                cr.moveTo(cx + r * 0.1, base - r * 0.1);
                cr.lineTo(cx - r * 0.25, base + r * 0.55);
                cr.lineTo(cx + r * 0.05, base + r * 0.5);
                cr.lineTo(cx - r * 0.2, base + r * 1.1);
                cr.lineTo(cx + r * 0.35, base + r * 0.35);
                cr.lineTo(cx + r * 0.05, base + r * 0.4);
                cr.closePath();
                cr.fill();
            }
        }
    };
}

function weatherIcon(cond, size, night) {
    const paint = weatherPainter(cond, night);
    let ticker = null;
    const area = drawingArea(size, size, (cr, w, h, s) => paint(cr, w, h, s, ticker?.t ?? 0));
    ticker = new Ticker(area, () => area.queue_repaint());
    return area;
}

// ---------- The card ----------

function label(text, styleClass, params = {}) {
    const l = new St.Label({text: String(text ?? ''), style_class: styleClass, ...params});
    l.clutter_text.line_wrap = true;
    l.clutter_text.ellipsize = 0;
    return l;
}

function header(card, icon) {
    const row = new St.BoxLayout({style_class: 'dynada-card-header', x_expand: true});
    if (icon)
        row.add_child(new St.Icon({icon_name: icon, style_class: 'dynada-card-header-icon'}));
    const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    text.add_child(label(card.title ?? '', 'dynada-card-title'));
    if (card.subtitle)
        text.add_child(label(card.subtitle, 'dynada-card-subtitle'));
    row.add_child(text);
    return row;
}

function weatherBody(card, box) {
    const hour = new Date().getHours();
    const night = hour < 6 || hour >= 20;
    const now = card.now ?? {};
    const top = new St.BoxLayout({style_class: 'dynada-card-weather-now', x_expand: true});
    top.add_child(weatherIcon(now.cond ?? 'cloud', 92, night));
    const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER,
        x_expand: true});
    text.add_child(label(card.place ?? '', 'dynada-card-subtitle'));
    text.add_child(label(`${Math.round(now.temp ?? 0)}°`, 'dynada-card-temp'));
    text.add_child(label([now.text, now.feels !== undefined ? `hissedilen ${Math.round(now.feels)}°` : '']
        .filter(Boolean).join(' · '), 'dynada-card-subtitle'));
    top.add_child(text);
    box.add_child(top);
    const days = (card.days ?? []).slice(0, 4);
    if (days.length) {
        const row = new St.BoxLayout({style_class: 'dynada-card-days', x_expand: true});
        days.forEach(d => {
            const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-card-day',
                x_expand: true});
            col.add_child(label(d.day, 'dynada-card-day-name', {x_align: Clutter.ActorAlign.CENTER}));
            const icon = weatherIcon(d.cond ?? 'cloud', 34, false);
            icon.x_align = Clutter.ActorAlign.CENTER;
            col.add_child(icon);
            col.add_child(label(`${Math.round(d.hi)}° ${Math.round(d.lo)}°`, 'dynada-card-day-temp',
                {x_align: Clutter.ActorAlign.CENTER}));
            row.add_child(col);
        });
        box.add_child(row);
    }
}

function statsBody(card, box) {
    const grid = new St.BoxLayout({style_class: 'dynada-card-stats', x_expand: true});
    (card.items ?? []).slice(0, 3).forEach(item => {
        const cell = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-card-stat',
            x_expand: true});
        cell.add_child(label(item.value, 'dynada-card-stat-value'));
        cell.add_child(label(item.label, 'dynada-card-stat-label'));
        if (item.delta) {
            const up = !String(item.delta).trim().startsWith('-');
            cell.add_child(label(item.delta, `dynada-card-stat-delta ${up ? 'up' : 'down'}`));
        }
        grid.add_child(cell);
    });
    box.add_child(grid);
}

function listBody(card, box) {
    (card.items ?? []).slice(0, 8).forEach((item, i) => {
        const row = new St.BoxLayout({style_class: 'dynada-card-row', x_expand: true});
        row.add_child(label(`${i + 1}`, 'dynada-card-row-n'));
        row.add_child(label(item, 'dynada-card-row-text', {x_expand: true}));
        box.add_child(row);
    });
}

export class Cards {
    constructor() {
        this._card = null;
    }

    show(json) {
        let card;
        try {
            card = JSON.parse(json);
        } catch (e) {
            console.error('Dynamic Island: a card that is not JSON', e);
            return false;
        }
        this.dismiss();
        // A plain dark surface, not the island's blurred glass: the blur is laid out once and
        // would slide off the card while it scales and moves in.
        const glass = new St.Bin({style_class: 'dynada-card', width: WIDTH, reactive: true, track_hover: true,
            opacity: 0});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'dynada-card-content',
            x_expand: true});
        if (card.type === 'weather') {
            card.title ??= 'Hava durumu';
            weatherBody(card, box);
        } else {
            box.add_child(header(card, ICONS[card.type] ?? ICONS.text));
            if (card.type === 'stats')
                statsBody(card, box);
            else if (card.type === 'list')
                listBody(card, box);
            else
                box.add_child(label(card.text ?? '', 'dynada-card-text'));
        }
        glass.set_child(box);
        Main.layoutManager.addTopChrome(glass);

        const [, height] = glass.get_preferred_height(WIDTH);
        const [x, y] = this._emptySpot(WIDTH, height);
        glass.set_position(x, y);
        glass.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        glass.set_scale(0.9, 0.9);
        glass.translation_y = 14;
        glass.ease({opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0, duration: 480,
            mode: Clutter.AnimationMode.EASE_OUT_BACK});

        const entry = {glass, timeout: 0};
        const arm = () => {
            if (entry.timeout)
                GLib.source_remove(entry.timeout);
            entry.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Number(card.seconds) || SECONDS, () => {
                entry.timeout = 0;
                if (glass.hover) {
                    arm();
                    return GLib.SOURCE_REMOVE;
                }
                this.dismiss(entry);
                return GLib.SOURCE_REMOVE;
            });
        };
        arm();
        glass.connect('button-release-event', () => {
            this.dismiss(entry);
            return Clutter.EVENT_STOP;
        });
        this._card = entry;
        return true;
    }

    dismiss(entry = this._card) {
        if (!entry)
            return;
        if (entry.timeout)
            GLib.source_remove(entry.timeout);
        entry.timeout = 0;
        if (this._card === entry)
            this._card = null;
        const glass = entry.glass;
        glass.remove_all_transitions();
        glass.ease({opacity: 0, scale_x: 0.94, scale_y: 0.94, translation_y: 8, duration: 220,
            mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: () => glass.destroy()});
    }

    destroy() {
        if (this._card?.timeout)
            GLib.source_remove(this._card.timeout);
        this._card?.glass.destroy();
        this._card = null;
    }

    // The corner (or side) of the main screen that the fewest windows cover; ties go to
    // the top right, under the island's row.
    _emptySpot(w, h) {
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const top = area.y + 64;
        const bottom = area.y + area.height - h - MARGIN;
        const left = area.x + MARGIN;
        const right = area.x + area.width - w - MARGIN;
        const middle = area.y + (area.height - h) / 2;
        const spots = [[right, top], [left, top], [right, bottom], [left, bottom], [right, middle], [left, middle]];
        const workspace = global.workspace_manager.get_active_workspace();
        const rects = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(win => win && !win.minimized && win.get_window_type() === Meta.WindowType.NORMAL &&
                win.located_on_workspace(workspace) && win.get_monitor() === Main.layoutManager.primaryIndex)
            .map(win => win.get_frame_rect());
        const covered = ([x, y]) => rects.reduce((sum, r) => {
            const ox = Math.max(0, Math.min(x + w, r.x + r.width) - Math.max(x, r.x));
            const oy = Math.max(0, Math.min(y + h, r.y + r.height) - Math.max(y, r.y));
            return sum + ox * oy;
        }, 0);
        let best = spots[0];
        let least = Infinity;
        for (const spot of spots) {
            const c = covered(spot);
            if (c < least - 1) {
                least = c;
                best = spot;
            }
        }
        return best.map(Math.round);
    }
}
