import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

// Which recordings do not count as "the microphone is in use": the sound
// settings and pavucontrol show a level meter (as GNOME's own indicator skips
// them), and the island's own meter below.
const SKIPPED_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];
const METER_NAME = 'Dynamic Island';
// Always-listening wake word services: they keep the mic open all the time, so
// on their own they show as standby rather than in use.
const STANDBY_NAMES = ['Harvis'];

const METER_RATE = 8000;
const METER_CHUNK = 400; // 50 ms of 16-bit mono
// A room is rarely quiet (measured here: -32 to -12 dBFS peaks with a video on),
// so speech is loudness well above the room's own floor, not above a fixed level.
const FLOOR_CHUNKS = 100; // the floor is the quiet end of the last 5 s
const ABOVE_FLOOR_DB = 12;
const MIN_SPEECH_DB = -55;
const SPEAKING_HOLD = 6; // chunks the green stays after the voice stops (300 ms)

// Watches the microphone and the camera for the island's privacy bubble.
//   mic: 'off' | 'standby' (only a wake word service) | 'on'
//   speaking: the microphone is in use and someone is talking
//   camera: a camera is in use
export class PrivacyWatcher {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this.mic = 'off';
        this.speaking = false;
        this.camera = false;

        this._control = getMixerControl();
        this._controlIds = ['stream-added', 'stream-removed', 'stream-changed', 'state-changed']
            .map(signal => this._control.connect(signal, () => this._sync()));

        this._cameraMonitor = new Shell.CameraMonitor();
        this._cameraId = this._cameraMonitor.connect('notify::cameras-in-use', () => this._sync());
        this._sync();
    }

    destroy() {
        this._onChanged = null;
        this._controlIds.forEach(id => this._control.disconnect(id));
        this._cameraMonitor.disconnect(this._cameraId);
        this._cameraMonitor = null;
        this._stopMeter();
    }

    _recordings() {
        return this._control.get_source_outputs().filter(output => {
            const name = output.get_name() ?? '';
            return !SKIPPED_APPS.includes(output.get_application_id()) && name !== METER_NAME &&
                output.get_description?.() !== METER_NAME;
        });
    }

    _sync() {
        const outputs = this._recordings();
        const standby = output => STANDBY_NAMES.includes(output.get_name()) ||
            STANDBY_NAMES.includes(output.get_description?.());
        const mic = outputs.length === 0 ? 'off' : outputs.every(standby) ? 'standby' : 'on';
        const camera = !!this._cameraMonitor?.cameras_in_use;
        if (mic === this.mic && camera === this.camera)
            return;
        this.mic = mic;
        this.camera = camera;
        // Only measure the voice while something other than a wake word listener records.
        if (mic === 'on')
            this._startMeter();
        else
            this._stopMeter();
        this._onChanged?.();
    }

    // A small parec stream at 8 kHz gives the level GNOME's mixer does not.
    _startMeter() {
        if (this._meter)
            return;
        const parec = GLib.find_program_in_path('parec');
        if (!parec)
            return;
        try {
            this._meter = Gio.Subprocess.new([parec, `--rate=${METER_RATE}`, '--channels=1', '--format=s16le',
                '--latency-msec=50', `--client-name=${METER_NAME}`, `--stream-name=${METER_NAME}`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error('Dynamic Island: microphone level unavailable', e);
            return;
        }
        this._meterCancel = new Gio.Cancellable();
        this._hold = 0;
        this._levels = [];
        this._read(this._meter.get_stdout_pipe(), this._meterCancel);
    }

    _read(stream, cancel) {
        stream.read_bytes_async(METER_CHUNK * 2, GLib.PRIORITY_LOW, cancel, (s, res) => {
            let bytes;
            try {
                bytes = s.read_bytes_finish(res);
            } catch {
                return; // cancelled, or the meter went away
            }
            if (!bytes || bytes.get_size() === 0)
                return;
            const data = bytes.get_data();
            const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
            let sum = 0;
            for (const v of samples)
                sum += v * v;
            const db = 10 * Math.log10(sum / Math.max(1, samples.length) / 32768 ** 2 + 1e-12);
            this._levels.push(db);
            if (this._levels.length > FLOOR_CHUNKS)
                this._levels.shift();
            const sorted = [...this._levels].sort((a, b) => a - b);
            const floor = sorted[Math.floor(sorted.length * 0.2)];
            const voice = db > MIN_SPEECH_DB && db > floor + ABOVE_FLOOR_DB;
            this._hold = voice ? SPEAKING_HOLD : Math.max(0, this._hold - 1);
            const speaking = this._hold > 0;
            if (speaking !== this.speaking) {
                this.speaking = speaking;
                this._onChanged?.();
            }
            this._read(stream, cancel);
        });
    }

    _stopMeter() {
        this._meterCancel?.cancel();
        this._meterCancel = null;
        this._meter?.force_exit();
        this._meter = null;
        if (this.speaking) {
            this.speaking = false;
            this._onChanged?.();
        }
    }
}
