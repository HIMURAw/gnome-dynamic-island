import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const FRAME = 33; // ms, ~30 fps while visible
// Each bar follows the voice with its own weight, so the row moves like a voice
// rather than a single block: loud in the middle, quieter at the edges.
const WEIGHTS = [0.45, 0.75, 1, 0.75, 0.45];

// A small row of bars that rise and fall with the microphone level, like Siri
// listening. level() returns 0..1; with no voice the bars keep a slow idle ripple.
export class Waveform {
    constructor({height = 16, barWidth = 3, styleClass = 'dynada-wave'} = {}) {
        this._height = height;
        this.actor = new St.BoxLayout({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._bars = WEIGHTS.map(() => {
            const bar = new St.Widget({
                style_class: 'dynada-wave-bar',
                width: barWidth,
                height: 3,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.actor.add_child(bar);
            return bar;
        });
        this._smooth = WEIGHTS.map(() => 0);
        this.actor.connect('destroy', () => {
            this._stopFrames();
            this.actor = null;
        });
    }

    start(level) {
        this._level = level;
        this.actor.show();
        if (this._frameId)
            return;
        this._t = 0;
        this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME, () => {
            this._t += FRAME / 1000;
            const now = Math.max(0, Math.min(1, this._level?.() ?? 0));
            this._bars.forEach((bar, i) => {
                const idle = 0.12 + 0.08 * Math.sin(this._t * 5 + i * 0.9);
                const target = Math.max(idle, now * WEIGHTS[i] * (0.8 + 0.2 * Math.sin(this._t * 11 + i * 2)));
                // Rise fast, fall slower, like a level meter.
                const k = target > this._smooth[i] ? 0.55 : 0.18;
                this._smooth[i] += (target - this._smooth[i]) * k;
                bar.height = Math.max(3, Math.round(this._smooth[i] * this._height));
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        this._stopFrames();
        this.actor?.hide();
    }

    _stopFrames() {
        if (this._frameId)
            GLib.source_remove(this._frameId);
        this._frameId = 0;
    }
}
