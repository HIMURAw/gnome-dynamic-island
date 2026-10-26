// Colour themes (tema-rengi): the stylesheet is written in violet; this swaps in a copy recoloured to
// the chosen theme, and swaps again when ~/.config/tema/current.json changes, live.
// Same file in Dynamic Island, Glass Dock, Glass Widgets and Glass Windows; the Python twin is
// ~/.local/src/mor-theme/tema.py. Keep them identical.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'tema']);
const BASE_HUE = 258;
const THEMES = {
    turkuaz: {hue: 178, sat: 1.0, lum: 0.62},
    yesil: {hue: 150, sat: 0.85, lum: 0.70},
    mavi: {hue: 215, sat: 1.0, lum: 0.90},
    mor: {hue: 258, sat: 1.0, lum: 1.0},
    gri: {hue: 0, sat: 0.0, lum: 0.85},
};

let cached = null;

export function currentPalette() {
    if (cached)
        return cached;
    cached = readPalette();
    return cached;
}

function readPalette() {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([DIR, 'current.json']));
        const name = JSON.parse(new TextDecoder().decode(bytes)).name;
        if (THEMES[name])
            return {name, ...THEMES[name]};
    } catch {}
    return {name: 'mor', ...THEMES.mor};
}

function rgbToHls(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, l, 0];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = ((g - b) / d) % 6;
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [((h * 60) + 360) % 360, l, s];
}

function hlsToRgb(h, l, s) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m];
}

// 0..255 in, 0..255 out. Only the violet family changes.
export function recolor(r, g, b, p = currentPalette()) {
    if (p.name === 'mor')
        return [r, g, b];
    const [deg, l, s] = rgbToHls(r / 255, g / 255, b / 255);
    if (s < 0.08 || deg < 225 || deg > 300)
        return [r, g, b];
    const accent = s >= 0.3 && l >= 0.35 && l <= 0.85;
    const h2 = p.sat === 0 ? deg : (deg + p.hue - BASE_HUE + 360) % 360;
    const s2 = p.sat === 0 ? 0 : Math.min(1, s * p.sat);
    const l2 = accent ? l * p.lum : l;
    return hlsToRgb(h2, l2, s2).map(c => Math.round(c * 255));
}

export function recolorCss(text, p = currentPalette()) {
    if (p.name === 'mor')
        return text;
    const hex = n => n.toString(16).padStart(2, '0');
    text = text.replace(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (_m, v) => {
        if (v.length === 3)
            v = [...v].map(c => c + c).join('');
        const [r, g, b] = recolor(...[0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16)), p);
        return `#${hex(r)}${hex(g)}${hex(b)}`;
    });
    return text.replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(,\s*[\d.]+\s*)?\)/g, (_m, r, g, b, a) => {
        const [r2, g2, b2] = recolor(+r, +g, +b, p);
        return a ? `rgba(${r2}, ${g2}, ${b2}${a.trimEnd()})` : `rgb(${r2}, ${g2}, ${b2})`;
    });
}

// Keeps an extension's stylesheet in the chosen colours. The shell unloads whatever
// extension.stylesheet points at on disable, so the recoloured copy is tracked there.
export class ThemedStylesheet {
    constructor(extension, onChange = null) {
        this._ext = extension;
        this._onChange = onChange;
        this._count = 0;
        this._apply();
        try {
            GLib.mkdir_with_parents(DIR, 0o755);
            this._monitor = Gio.File.new_for_path(DIR).monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', (_m, file) => {
                if (file.get_basename() !== 'current.json')
                    return;
                if (this._timer)
                    GLib.source_remove(this._timer);
                this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    this._timer = 0;
                    cached = null;
                    this._apply();
                    this._onChange?.();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.warn(`${extension.uuid}: theme watch failed: ${e.message}`);
        }
    }

    _apply() {
        const record = Main.extensionManager.lookup(this._ext.uuid);
        const source = Gio.File.new_for_path(GLib.build_filenamev([this._ext.path, 'stylesheet.css']));
        if (!record || !source.query_exists(null))
            return;
        const [, bytes] = source.load_contents(null);
        const css = recolorCss(new TextDecoder().decode(bytes));
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'tema']);
        GLib.mkdir_with_parents(dir, 0o700);
        // A new name each time: St keeps parsed stylesheets by file.
        const out = Gio.File.new_for_path(GLib.build_filenamev([dir, `${this._ext.uuid}-${this._count++}.css`]));
        out.replace_contents(new TextEncoder().encode(css), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (record.stylesheet)
            theme.unload_stylesheet(record.stylesheet);
        const old = this._file;
        theme.load_stylesheet(out);
        record.stylesheet = out;
        this._file = out;
        if (old)
            old.delete(null);
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
        }
        // The shell unloads record.stylesheet (our copy) after disable(); the file goes at logout.
    }
}
