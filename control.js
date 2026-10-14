import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Robot, drawCairo, signature} from './robot.js';

// A virtual pointer and keyboard for the voice assistant, so it can use any app
// the way Umut does: Wayland lets no ordinary program move the pointer or type into
// another window, but the shell itself may. Coordinates are the stage's (logical
// pixels, the size of global.stage). The assistant asks over D-Bus (activities.js);
// it stops itself when Umut touches the keyboard or touchpad.
//
// Harvis has a pointer of its own on screen, the arrow-shaped robot that is Harvis, which
// glides to where it is going, like a second person at the desk. Umut's pointer stays his:
// for a click it goes there for an instant and comes straight back.

const MODIFIERS = {
    ctrl: 'Control_L', control: 'Control_L', shift: 'Shift_L', alt: 'Alt_L',
    super: 'Super_L', win: 'Super_L', meta: 'Super_L', altgr: 'ISO_Level3_Shift',
};
const NAMES = {
    enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space',
    backspace: 'BackSpace', delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
    pageup: 'Page_Up', pagedown: 'Page_Down', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    menu: 'Menu', print: 'Print',
};
const SCROLL = {up: Clutter.ScrollDirection.UP, down: Clutter.ScrollDirection.DOWN,
    left: Clutter.ScrollDirection.LEFT, right: Clutter.ScrollDirection.RIGHT};
// The glide: quick for a short hop, never slow for a long one (ms).
const GLIDE_MIN = 120;
const GLIDE_MAX = 380;
const GLIDE_PER_PX = 0.35;

const us = () => GLib.get_monotonic_time();
// Chromium/Electron apps (Spotify, Discord, VS Code) drop a click whose press,
// release and pointer-return all share one instant; a hand takes a few frames.
const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

function keyval(name) {
    const lower = name.toLowerCase();
    const known = MODIFIERS[lower] ?? NAMES[lower] ?? (/^f\d{1,2}$/.test(lower) ? lower.toUpperCase() : null);
    if (known)
        return Clutter[`KEY_${known}`] ?? 0;
    if ([...name].length === 1)
        return Clutter.unicode_to_keysym(name.codePointAt(0));
    return Clutter[`KEY_${name}`] ?? 0;
}

// Harvis's hand on the screen is the round robot itself: it RUNS to where it is
// going (legs pumping, eyes set on the way) and for a click it jumps and lands
// right on the spot, with a little spark ("avatar koşsun, tıklama yerine zıplayıp
// vursun" - Umut, 2026-10-14). Its feet are the anchor: it stands on the target.
const PX = 1.35; // logical pixels per sprite pixel (the robot is ~43 px tall)
const FRAME = 33;
const FOOT = [16, 29.5]; // the sprite point between the feet, placed on the target

class Ghost {
    constructor() {
        this._robot = new Robot('head');
        this.actor = new St.Widget({reactive: false, can_focus: false, opacity: 0,
            layout_manager: new Clutter.FixedLayout()});
        const {w, h} = this._robot.frame();
        this._area = new St.DrawingArea({width: Math.ceil(w * PX), height: Math.ceil(h * PX),
            x: -Math.round(FOOT[0] * PX), y: -Math.round(FOOT[1] * PX)});
        this._area.connect('repaint', area => {
            const cr = area.get_context();
            const [sw] = area.get_surface_size();
            const scale = sw / Math.max(1, area.width);
            try {
                drawCairo(cr, this._shown ?? this._robot.frame(), {px: PX * scale, Cairo});
            } finally {
                cr.$dispose();
            }
        });
        this.actor.add_child(this._area);
        Main.layoutManager.uiGroup.add_child(this.actor);
        const [px, py] = global.get_pointer();
        this.actor.set_position(px, py);
        this._last = 0;
    }

    destroy() {
        this._run(false);
        this._keepComposited(false);
        this.actor.destroy();
    }

    // Animates only while it can be seen, and only paints a changed picture.
    _run(on) {
        if (on && !this._frameId) {
            this._last = 0;
            this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME, () => {
                const now = GLib.get_monotonic_time() / 1e6;
                this._robot.step(this._last ? now - this._last : 0);
                this._last = now;
                const frame = this._robot.frame();
                const key = signature(frame);
                if (key !== this._key) {
                    this._key = key;
                    this._shown = frame;
                    this._area.queue_repaint();
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._frameId) {
            GLib.source_remove(this._frameId);
            this._frameId = 0;
        }
    }

    // A maximized window that fills the screen is scanned out straight to the display
    // and the robot drawn over it would never show; mutter counts these calls, so they
    // nest safely with the island's own.
    _keepComposited(on) {
        if (on === !!this._composited)
            return;
        this._composited = on;
        if (on)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    state(name) {
        this._robot.setState(name);
    }

    show() {
        Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, null);
        this._keepComposited(true);
        this._run(true);
        if (this.actor.opacity < 255)
            this.actor.ease({opacity: 255, duration: 150});
    }

    hide() {
        this._robot.setState('idle');
        this._robot.walking = false;
        this.actor.ease({opacity: 0, duration: 300, onStopped: () => {
            if (this.actor.opacity === 0) {
                this._run(false);
                this._keepComposited(false);
            }
        }});
    }

    // Resolves when it has arrived: a run, legs pumping, eyes set on the way.
    glide(x, y) {
        this.show();
        const dist = Math.hypot(x - this.actor.x, y - this.actor.y);
        const duration = Math.round(Math.min(GLIDE_MAX, Math.max(GLIDE_MIN, dist * GLIDE_PER_PX)));
        if (dist < 2)
            return Promise.resolve();
        this.state('moving');
        this._robot.walking = true;
        this._robot.lookAt(Math.sign(x - this.actor.x), 0);
        return new Promise(resolve => {
            this.actor.ease({x, y, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => {
                    this.state('idle');
                    this._robot.walking = false;
                    this._robot.lookAt(null);
                    resolve();
                }});
        });
    }
}

export class Control {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._ghost = new Ghost();
    }

    destroy() {
        this._ghost?.destroy();
        this._ghost = null;
        this._pointer = null;
        this._keyboard = null;
    }

    size() {
        return [Math.round(global.stage.width), Math.round(global.stage.height)];
    }

    hide() {
        this._ghost.hide();
    }

    // Open windows, front first: what is there without a screenshot.
    windows() {
        const focus = global.display.focus_window;
        return global.display.list_all_windows()
            .filter(w => !w.skip_taskbar && w.get_window_type() === 0)
            .sort((a, b) => b.get_user_time() - a.get_user_time())
            .map(w => {
                const r = w.get_frame_rect();
                return {title: w.get_title() ?? '', app: w.get_wm_class() ?? '', x: r.x, y: r.y, w: r.width,
                    h: r.height, focus: w === focus, minimized: w.minimized};
            });
    }

    // Hover: Umut's pointer goes there and stays (menus that open on hover need it).
    async move(x, y) {
        await this._ghost.glide(x, y);
        this._pointer.notify_absolute_motion(us(), x, y);
    }

    // button: 1 left, 2 middle, 3 right; count: 2 for a double click.
    async click(x, y, button, count) {
        await this._ghost.glide(x, y);
        const code = [0, Clutter.BUTTON_PRIMARY, Clutter.BUTTON_MIDDLE, Clutter.BUTTON_SECONDARY][button] ??
            Clutter.BUTTON_PRIMARY;
        const [ux, uy] = global.get_pointer();
        this._ghost.state('click');
        this._pointer.notify_absolute_motion(us(), x, y);
        await pause(40);  // the app sees the pointer arrive (hover) before the press
        for (let i = 0; i < Math.max(1, count); i++) {
            if (i)
                await pause(60);
            this._pointer.notify_button(us(), code, Clutter.ButtonState.PRESSED);
            await pause(30);
            this._pointer.notify_button(us(), code, Clutter.ButtonState.RELEASED);
        }
        await pause(40);  // the release is handled where it happened, then the pointer goes home
        this._pointer.notify_absolute_motion(us(), ux, uy);
        pause(600).then(() => this._ghost?.state('idle'));
    }

    async drag(x1, y1, x2, y2) {
        await this._ghost.glide(x1, y1);
        const [ux, uy] = global.get_pointer();
        this._pointer.notify_absolute_motion(us(), x1, y1);
        await pause(40);
        this._pointer.notify_button(us(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await pause(40);
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
            this._pointer.notify_absolute_motion(us(), x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
            await pause(16);
        }
        this._ghost.actor.set_position(x2, y2);
        this._pointer.notify_button(us(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await pause(40);
        this._pointer.notify_absolute_motion(us(), ux, uy);
    }

    async scroll(x, y, direction, amount) {
        await this._ghost.glide(x, y);
        const [ux, uy] = global.get_pointer();
        this._pointer.notify_absolute_motion(us(), x, y);
        await pause(40);
        const dir = SCROLL[direction] ?? Clutter.ScrollDirection.DOWN;
        for (let i = 0; i < Math.max(1, Math.min(amount, 30)); i++) {
            this._pointer.notify_discrete_scroll(us(), dir, Clutter.ScrollSource.WHEEL);
            await pause(15);
        }
        await pause(40);
        this._pointer.notify_absolute_motion(us(), ux, uy);
    }

    // Text as typed: the shell finds each character's key (and Shift/AltGr) itself.
    type(text) {
        for (const ch of text) {
            const val = ch === '\n' ? Clutter.KEY_Return : ch === '\t' ? Clutter.KEY_Tab
                : Clutter.unicode_to_keysym(ch.codePointAt(0));
            this._keyboard.notify_keyval(us(), val, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(us(), val, Clutter.KeyState.RELEASED);
        }
    }

    // "ctrl+l", "alt+tab", "Return", "ctrl+shift+t". False if a name is unknown.
    key(combo) {
        const vals = combo.split('+').map(k => k.trim()).filter(Boolean).map(keyval);
        if (!vals.length || vals.includes(0))
            return false;
        for (const v of vals)
            this._keyboard.notify_keyval(us(), v, Clutter.KeyState.PRESSED);
        for (const v of vals.reverse())
            this._keyboard.notify_keyval(us(), v, Clutter.KeyState.RELEASED);
        return true;
    }
}
