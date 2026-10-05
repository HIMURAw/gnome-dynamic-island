import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// A virtual pointer and keyboard for the voice assistant, so it can use any app
// the way Umut does: Wayland lets no ordinary program move the pointer or type into
// another window, but the shell itself may. Coordinates are the stage's (logical
// pixels, the size of global.stage). The assistant asks over D-Bus (activities.js);
// it stops itself when Umut touches the keyboard or touchpad.

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

const us = () => GLib.get_monotonic_time();

function keyval(name) {
    const lower = name.toLowerCase();
    const known = MODIFIERS[lower] ?? NAMES[lower] ?? (/^f\d{1,2}$/.test(lower) ? lower.toUpperCase() : null);
    if (known)
        return Clutter[`KEY_${known}`] ?? 0;
    if ([...name].length === 1)
        return Clutter.unicode_to_keysym(name.codePointAt(0));
    return Clutter[`KEY_${name}`] ?? 0;
}

export class Control {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }

    destroy() {
        this._pointer = null;
        this._keyboard = null;
    }

    size() {
        return [Math.round(global.stage.width), Math.round(global.stage.height)];
    }

    move(x, y) {
        this._pointer.notify_absolute_motion(us(), x, y);
    }

    // button: 1 left, 2 middle, 3 right; count: 2 for a double click.
    click(x, y, button, count) {
        this.move(x, y);
        const code = [0, Clutter.BUTTON_PRIMARY, Clutter.BUTTON_MIDDLE, Clutter.BUTTON_SECONDARY][button] ??
            Clutter.BUTTON_PRIMARY;
        for (let i = 0; i < Math.max(1, count); i++) {
            this._pointer.notify_button(us(), code, Clutter.ButtonState.PRESSED);
            this._pointer.notify_button(us(), code, Clutter.ButtonState.RELEASED);
        }
    }

    drag(x1, y1, x2, y2) {
        this.move(x1, y1);
        this._pointer.notify_button(us(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        const steps = 12;
        for (let i = 1; i <= steps; i++)
            this.move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
        this._pointer.notify_button(us(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    scroll(x, y, direction, amount) {
        this.move(x, y);
        const dir = SCROLL[direction] ?? Clutter.ScrollDirection.DOWN;
        for (let i = 0; i < Math.max(1, Math.min(amount, 30)); i++)
            this._pointer.notify_discrete_scroll(us(), dir, Clutter.ScrollSource.WHEEL);
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
