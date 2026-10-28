import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {currentPalette} from './theme.js';

const BLUR_RADIUS = 18;
// The windows behind the glass are re-blurred at most this often (ms).
// 500 since 2026-10-13: the wallpaper is a video now, so what is behind changes every frame and
// this is what sets how often each glass re-blurs. Twice a second reads fine under the blur.
const REFRESH = 500;

// Blur is the costly part; with it off every glass is a plain dark surface.
// Set before building any glass (the extension rebuilds when it changes).
let blurEnabled = true;

export function setBlurEnabled(enabled) {
    blurEnabled = enabled;
}

// GJS turns whole numbers into int GValues, which float uniforms ignore.
const asFloat = v => (Number.isInteger(v) ? v + 1e-4 : v);
// Corners cut at 45 degrees, this many px (Umut: "ilk baştaki gibi altıgene benzeyen", 2026-10-13);
// the frame runs along the cut too.
const CHAMFER = 7;
// Round themes (cam, the Cam Panel look): true rounded corners at the caller's radius, a brighter
// frost and a little more blur.
const ROUND_BLUR = 1.3;
// Not the full 1.0 of the web page: over the bright dusk horizon white text needs a darker frost.
const ROUND_BRIGHTNESS = 0.8;
const isRound = () => Boolean(currentPalette().round);

const MASK_SHADER = `
uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float radius;
uniform float tex_w;
uniform float tex_h;
uniform float frame_width;
uniform float frame_r;
uniform float frame_g;
uniform float frame_b;
uniform float frame_a;
uniform float rounded;

void main(void) {
    vec2 uv = cogl_tex_coord_in[0].xy;
    vec4 color = texture2D(tex, uv);
    // The offscreen texture is a little larger than the actor (its paint box, rounded out):
    // place the shape by the texture's real size, centred, not stretched over it.
    vec2 tex_size = vec2(tex_w, tex_h);
    vec2 half_size = vec2(width, height) * 0.5;
    // A rectangle with its corners cut at 45 degrees (radius = the cut), like a stretched hexagon.
    vec2 p = abs(uv * tex_size - tex_size * 0.5);
    vec2 d = p - half_size;
    float box = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
    float cut = (p.x + p.y - (half_size.x + half_size.y - radius)) * 0.70710678;
    float dist = max(box, cut);
    // Round themes: a rounded rectangle instead.
    if (rounded > 0.5) {
        vec2 q = d + radius;
        dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    }
    float outer = clamp(0.5 - dist, 0.0, 1.0);
    // The frame is drawn here, along the same rounded edge as the cut, so it follows the
    // corners too (a CSS border is clipped away there by this very mask).
    float inner = frame_width > 0.0 ? clamp(0.5 - (dist + frame_width), 0.0, 1.0) : outer;
    vec4 frame = vec4(frame_r, frame_g, frame_b, 1.0) * frame_a;
    vec4 over = frame + color * (1.0 - frame_a);
    cogl_color_out = color * inner + over * (outer - inner);
}`;

// Cuts an actor to a rectangle with chamfered corners (rounded ones in a round theme),
// antialiased edges.
export const RoundedMask = GObject.registerClass(
class RoundedMask extends Clutter.ShaderEffect {
    _init() {
        super._init();
        this.set_shader_source(MASK_SHADER);
        this._round = false;
        this.set_uniform_value('rounded', asFloat(0));
    }

    setGeometry(width, height, radius) {
        if (width === this._w && height === this._h && radius === this._r)
            return;
        this._w = width;
        this._h = height;
        this._r = radius;
        this.set_uniform_value('width', asFloat(width));
        this.set_uniform_value('height', asFloat(height));
        this.set_uniform_value('radius', asFloat(radius));
    }

    vfunc_paint_target(node, paintContext) {
        // In device pixels; the shape is in logical ones (fractional scaling: 1.67).
        const [ok, dw, dh] = this.get_target_size();
        const scale = this.actor?.get_resource_scale?.() || 1;
        const tw = dw / scale;
        const th = dh / scale;
        if (ok && (tw !== this._tw || th !== this._th)) {
            this._tw = tw;
            this._th = th;
            this.set_uniform_value('tex_w', asFloat(tw));
            this.set_uniform_value('tex_h', asFloat(th));
        }
        // Checked on every paint: a theme switch restyles (and so repaints) every actor.
        const round = isRound();
        if (round !== this._round) {
            this._round = round;
            this.set_uniform_value('rounded', asFloat(round ? 1 : 0));
        }
        super.vfunc_paint_target(node, paintContext);
    }

    // A frame along the rounded edge: [r, g, b, a] 0..1 and its width in px; width 0 for none.
    setFrame(rgba, width) {
        const key = `${rgba}|${width}`;
        if (key === this._frame)
            return;
        this._frame = key;
        this.set_uniform_value('frame_width', asFloat(width));
        ['frame_r', 'frame_g', 'frame_b', 'frame_a'].forEach((name, i) =>
            this.set_uniform_value(name, asFloat(rgba[i])));
    }
});

// The frame colour comes from the stylesheet, so states (hover, editing, playing) can change it:
//   -glass-frame-color: rgba(...);  -glass-frame-width: 1px;
function themeFrame(actor) {
    const node = actor.get_theme_node();
    const [ok, c] = node.lookup_color('-glass-frame-color', false);
    if (!ok)
        return [[0, 0, 0, 0], 0];
    const ch = k => (typeof c[`get_${k}`] === 'function' ? c[`get_${k}`]() : c[k] / 255);
    const [hasWidth, width] = node.lookup_length('-glass-frame-width', false);
    return [[ch('red'), ch('green'), ch('blue'), ch('alpha')], hasWidth ? width : 1];
}

// ---------- The scene behind the glasses, as one shared snapshot ----------
//
// Every glass used to hold a live Clutter.Clone of what is behind it and a custom
// effect suppressed the clone's repaints to save re-blurring. Clearing the dirty
// flag made the compositor now and then paint the clone unmasked for one frame:
// with a video wallpaper that showed as a purple flash around the island (Umut's
// recording, 2026-10-13). Now one snapshot of the scene (a finished frame, the
// cursor left out) is taken for all glasses at most every REFRESH ms and each
// backdrop just shows and blurs that texture: between snapshots nothing behind a
// glass changes, and a finished frame cannot be caught mid-paint.
const snapshot = {content: null, at: 0, timer: 0, idle: 0, startup: 0, clients: new Set()};

function snapshotSource() {
    return global.stage;
}

// Extra actors (the island's strip, the dock) blanked out of the snapshot on top of
// every glass itself, so a glass never sees its own extension in what is "behind".
export const snapshotExclude = new Set();

function takeSnapshot() {
    // Not before the session has drawn its first frame: painting the stage to a
    // texture during start-up left the whole desktop unpainted on some logins
    // (Umut, 2026-10-14: "oturumu açtım, ekranda hiçbir şey görünmüyor").
    if (Main.layoutManager._startingUp)
        return;
    snapshot.at = GLib.get_monotonic_time() / 1000;
    // The glasses and their extension's surfaces are blanked for the capture and
    // restored in the same tick - inside one try, each actor on its own, so a
    // disposed actor can never leave the rest invisible.
    const blanked = [];
    try {
        // A Set: an excluded surface can also be a glass's parent. Visited twice, it was
        // blanked twice and the second restore put back the first blank, leaving it
        // painted invisible for good (side islands open but unseen, 2026-10-27).
        const actors = new Set([...snapshotExclude, ...[...snapshot.clients].map(b => b.get_parent())]);
        for (const actor of actors) {
            try {
                // The paint-only override, not .opacity: setting opacity cancels a running
                // opacity animation, so every snapshot cut the side islands' and the dock's
                // fades short (Umut, 2026-10-26: "kapanırken yok oluyor").
                if (actor && actor.opacity !== 0 && actor.get_opacity_override() !== 0) {
                    blanked.push([actor, actor.get_opacity_override()]);
                    actor.set_opacity_override(0);
                }
            } catch {
                // a disposed actor: skip it
            }
        }
        let scale = 1;
        try {
            scale = global.display.get_monitor_scale(global.display.get_primary_monitor());
        } catch {
            scale = 1;
        }
        const [w, h] = global.stage.get_size();
        const rect = new Mtk.Rectangle({x: 0, y: 0, width: Math.round(w), height: Math.round(h)});
        snapshot.content = global.stage.paint_to_content(rect, scale, null, Clutter.PaintFlag.NO_CURSORS);
    } catch (e) {
        console.error('Dynamic Island: snapshot failed', e);
        return;
    } finally {
        for (const [actor, override] of blanked) {
            try {
                actor.set_opacity_override(override);
            } catch {
                // disposed while blanked: nothing to restore
            }
        }
    }
    for (const backdrop of snapshot.clients)
        backdrop.setSnapshot(snapshot.content);
}

function stopSnapshots() {
    for (const id of [snapshot.timer, snapshot.idle])
        if (id)
            GLib.source_remove(id);
    snapshot.timer = snapshot.idle = 0;
    if (snapshot.startup) {
        Main.layoutManager.disconnect(snapshot.startup);
        snapshot.startup = 0;
    }
    snapshot.content = null; // free the texture while every glass is off screen
    for (const backdrop of snapshot.clients)
        backdrop.setSnapshot(null);
}

function syncSnapshots() {
    if (![...snapshot.clients].some(b => b.mapped)) {
        stopSnapshots();
        return;
    }
    // At login the glasses map before the shell has drawn anything: wait for the
    // session to finish starting, then begin taking snapshots.
    if (Main.layoutManager._startingUp) {
        if (!snapshot.startup) {
            snapshot.startup = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(snapshot.startup);
                snapshot.startup = 0;
                syncSnapshots();
            });
        }
        return;
    }
    // Never synchronously: a map notification can arrive mid-layout, and painting
    // the scene to a texture right then would re-enter it.
    if (!snapshot.content && !snapshot.idle) {
        snapshot.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            snapshot.idle = 0;
            if ([...snapshot.clients].some(b => b.mapped))
                takeSnapshot();
            return GLib.SOURCE_REMOVE;
        });
    }
    if (!snapshot.timer) {
        snapshot.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH, () => {
            if (![...snapshot.clients].some(b => b.mapped)) {
                snapshot.timer = 0;
                stopSnapshots();
                return GLib.SOURCE_REMOVE;
            }
            takeSnapshot();
            return GLib.SOURCE_CONTINUE;
        });
    }
}

// A blurred picture of whatever sits behind the glass on screen, from the shared
// snapshot, lined up with the screen. Shell.BlurEffect in background mode cannot
// be rounded, so the glass blurs its own copy.
const Backdrop = GObject.registerClass(
class Backdrop extends St.Widget {
    _init() {
        super._init({
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        this._tint = new St.Widget({
            style_class: blurEnabled ? 'dynada-glass-tint' : 'dynada-glass-tint dynada-glass-solid',
        });
        if (!blurEnabled) {
            this.add_child(this._tint);
            return;
        }
        this._shot = new St.Widget();
        this.add_child(this._shot);
        this.add_child(this._tint);
        this._blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
            brightness: 0.9,
        });
        this._blurMax = BLUR_RADIUS;
        this.add_effect(this._blur);
        snapshot.clients.add(this);
        this.setSnapshot(snapshot.content);
        this.connect('notify::mapped', () => syncSnapshots());
        this.connect('destroy', () => {
            this._shot = null;
            snapshot.clients.delete(this);
            syncSnapshots();
        });
    }

    // Round themes: the Cam Panel's bright frost, a little more blur.
    setRound(round) {
        if (!this._blur)
            return;
        this._blur.brightness = round ? ROUND_BRIGHTNESS : 0.9;
        this._blurMax = round ? Math.round(BLUR_RADIUS * ROUND_BLUR) : BLUR_RADIUS;
        this.queue_relayout();
    }

    setSnapshot(content) {
        this._shot?.set_content(content);
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        this._tint.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: box.get_width(), y2: box.get_height()}));
        if (!this._shot)
            return;
        // Lined up with the screen, so the blur shows exactly what is behind.
        const [px, py] = this.get_parent().get_transformed_position();
        const x = px + box.x1;
        const y = py + box.y1;
        const [w, h] = snapshotSource().get_size();
        this._shot.allocate(new Clutter.ActorBox({x1: -x, y1: -y, x2: -x + w, y2: -y + h}));

        // The blur downscales by its radius; on a small actor a large radius would
        // shrink the texture to nothing.
        const side = Math.min(box.get_width(), box.get_height());
        this._blur.enabled = side >= 4;
        this._blur.radius = Math.max(1, Math.min(this._blurMax, Math.floor(side / 3)));
    }
});
// Frosted glass container. Children are stacked (BinLayout) on top of the blur,
// and everything, content included, is clipped to the rounded shape.
export const Glass = GObject.registerClass(
class Glass extends St.Widget {
    _init({radius, ...params}) {
        super._init({
            ...params,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._radius = radius;
        this.backdrop = new Backdrop();
        this.add_child(this.backdrop);
        this._mask = new RoundedMask();
        this.add_effect(this._mask);
        this.connect('style-changed', () => {
            this._mask.setFrame(...themeFrame(this));
            this._syncTheme();
        });
        this._mask.setFrame([0, 0, 0, 0], 0);
        this._round = null;
        this._cssRadius = -1;
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const w = box.get_width();
        const h = box.get_height();
        // Offscreen effects cannot render an empty texture.
        this._mask.enabled = w >= 1 && h >= 1;
        const r = this._round
            ? Math.min(this._cssRadius >= 0 ? this._cssRadius : this._radius, w / 2, h / 2)
            : Math.min(CHAMFER, this._radius, w / 2, h / 2);
        this._mask.setGeometry(w, h, r);
    }

    // Round themes may set the radius from the stylesheet (-glass-radius: 999px for a pill);
    // the theme switches live, and every actor is restyled when it does.
    _syncTheme() {
        const round = isRound();
        const [ok, css] = this.get_theme_node().lookup_length('-glass-radius', false);
        const radius = ok ? css : -1;
        if (round === this._round && radius === this._cssRadius)
            return;
        if (round !== this._round)
            this.backdrop.setRound(round);
        this._round = round;
        this._cssRadius = radius;
        this.queue_relayout();
    }

    setRadius(radius) {
        if (radius === this._radius)
            return;
        this._radius = radius;
        this.queue_relayout();
    }

    // Call when the glass moves without being re-laid out (translation, etc.).
    syncBackdrop() {
        this.backdrop.queue_relayout();
    }
});
