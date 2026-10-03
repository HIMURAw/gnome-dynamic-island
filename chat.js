import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Waveform} from './wave.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const KEEP = 60; // messages kept across sessions
const TIMEOUT = 300; // s for one answer
const HISTORY = GLib.build_filenamev([GLib.get_user_data_dir(), 'dynamic-island', 'chat.json']);
// Harvis reads voice answers aloud unless this file exists (harvis speak off).
const SPEAK_OFF = GLib.build_filenamev([GLib.get_user_data_dir(), 'harvis', 'speak-off']);

function expandPath(path) {
    if (!path)
        return '';
    return path.startsWith('~') ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(1)]) : path;
}

function findProgram(name) {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', name]);
    return GLib.find_program_in_path(name) ??
        (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

// Three dots that rise one after another while an answer is on its way.
class TypingDots {
    constructor() {
        this.actor = new St.BoxLayout({style_class: 'dynada-typing', y_align: Clutter.ActorAlign.CENTER});
        this._dots = [0, 1, 2].map(() => {
            const dot = new St.Widget({style_class: 'dynada-typing-dot'});
            this.actor.add_child(dot);
            return dot;
        });
        let t = 0;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            t += 0.04;
            this._dots.forEach((dot, i) => {
                const phase = Math.max(0, Math.sin((t * 6) - i * 0.9));
                dot.translation_y = -4 * phase;
                dot.opacity = 110 + Math.round(145 * phase);
            });
            return GLib.SOURCE_CONTINUE;
        });
        this.actor.connect('destroy', () => GLib.source_remove(this._id));
    }
}

// The island's chat with Harvis: typed, or spoken (the microphone button asks the
// Harvis service to listen without the wake word). Typed messages go to
// `harvis ask --stream`, which shares one Claude conversation with the wake word,
// so spoken and typed turns follow on from each other. Without Harvis, `claude -p`.
export class ChatView {
    constructor({settings, width, onClose}) {
        this._settings = settings;
        this._onClose = onClose;
        this._messages = this._load();
        this._harvis = findProgram('harvis');
        this._claude = findProgram('claude');

        this.actor = new St.BoxLayout({
            style_class: 'dynada-expanded dynada-chat',
            orientation: Clutter.Orientation.VERTICAL,
            width,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
            opacity: 0,
            visible: false,
        });

        const header = new St.BoxLayout({style_class: 'dynada-chat-header', x_expand: true});
        header.add_child(new St.Label({
            style_class: 'dynada-center-month',
            text: _('Harvis'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.wave = new Waveform({height: 18, styleClass: 'dynada-wave dynada-chat-wave'});
        header.add_child(this.wave.actor);
        this._status = new St.Label({
            style_class: 'dynada-chat-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);
        if (this._harvis) {
            this._speaker = this._roundButton('dynada-chat-speaker', 'audio-volume-high-symbolic',
                _('Read voice answers aloud'), () => this._toggleSpeaking());
            header.add_child(this._speaker);
            this._syncSpeaker();
        }
        const fresh = new St.Button({
            style_class: 'dynada-pill-button',
            can_focus: true,
            label: _('New chat'),
        });
        fresh.connect('clicked', () => this._clear());
        header.add_child(fresh);
        this.actor.add_child(header);

        this._list = new St.BoxLayout({
            style_class: 'dynada-chat-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'dynada-chat-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            child: this._list,
        });
        this.actor.add_child(this._scroll);
        this._empty = new St.Label({
            style_class: 'dynada-chat-empty',
            text: _('Write, or press the microphone and talk. “Hey Harvis” works from anywhere.'),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.clutter_text.line_wrap = true;
        this.actor.add_child(this._empty);

        const bar = new St.BoxLayout({style_class: 'dynada-chat-bar dynada-chip', x_expand: true});
        this.entry = new St.Entry({
            style_class: 'dynada-palette-entry dynada-chat-entry',
            hint_text: _('Message Harvis'),
            can_focus: true,
            x_expand: true,
        });
        this.entry.clutter_text.connect('activate', () => this._send());
        this.entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._onClose?.();
            return Clutter.EVENT_STOP;
        });
        this._micButton = this._roundButton('dynada-chat-mic', 'audio-input-microphone-symbolic', _('Talk'),
            () => this._listen());
        const send = this._roundButton('dynada-chat-send', 'go-up-symbolic', _('Send'), () => this._send());
        bar.add_child(this.entry);
        bar.add_child(this._micButton);
        bar.add_child(send);
        this.actor.add_child(bar);

        this._render();
    }

    destroy() {
        this._cancel?.cancel();
        this._cancel = null;
        this.wave.stop();
        this.actor.destroy();
    }

    focus() {
        this.entry.grab_key_focus();
        this._scrollToEnd();
    }

    _roundButton(styleClass, icon, name, callback) {
        const button = new St.Button({
            style_class: `dynada-round-button ${styleClass}`,
            can_focus: true,
            accessible_name: name,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            child: new St.Icon({icon_name: icon, icon_size: 16}),
        });
        button.connect('clicked', callback);
        button.connect('notify::pressed', () => button.ease({
            scale_x: button.pressed ? 0.86 : 1,
            scale_y: button.pressed ? 0.86 : 1,
            duration: button.pressed ? 80 : 260,
            mode: button.pressed ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_OUT_BACK,
        }));
        return button;
    }

    _syncSpeaker() {
        const on = !GLib.file_test(SPEAK_OFF, GLib.FileTest.EXISTS);
        this._speaker.child.icon_name = on ? 'audio-volume-high-symbolic' : 'audio-volume-muted-symbolic';
        (on ? this._speaker.add_style_pseudo_class : this._speaker.remove_style_pseudo_class)
            .call(this._speaker, 'checked');
    }

    _toggleSpeaking() {
        this._run(['speak', 'toggle'], () => this._syncSpeaker());
    }

    // harvis <args>, then done() when it exits.
    _run(args, done) {
        try {
            const proc = Gio.Subprocess.new([this._harvis, ...args],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_async(null).then(() => done?.()).catch(() => {});
        } catch (e) {
            console.error('Dynamic Island: could not run harvis', e);
        }
    }

    // A spoken exchange from the wake word service.
    addExchange(question, answer) {
        this._push('user', question);
        this._push('assistant', answer);
        this.setStatus('');
    }

    // What the wake word service is doing ("Listening…", "Reading files…"), or ''.
    // level: a function giving the voice level while listening, else null.
    setStatus(text, level = null) {
        this._status.text = text ?? '';
        if (level) {
            this.wave.start(level);
            this._micButton.add_style_pseudo_class('listening');
        } else {
            this.wave.stop();
            this._micButton.remove_style_pseudo_class('listening');
        }
    }

    // ---------- History ----------

    _load() {
        try {
            const [, bytes] = GLib.file_get_contents(HISTORY);
            const list = JSON.parse(new TextDecoder().decode(bytes));
            return Array.isArray(list) ? list.filter(m => !m.pending).slice(-KEEP) : [];
        } catch {
            return [];
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(HISTORY), 0o700);
            const done = this._messages.filter(m => !m.pending).slice(-KEEP)
                .map(({role, text}) => ({role, text}));
            GLib.file_set_contents(HISTORY, JSON.stringify(done));
        } catch (e) {
            console.error('Dynamic Island: could not save the chat', e);
        }
    }

    _push(role, text, pending = false) {
        const message = {role, text, pending};
        this._messages.push(message);
        if (!pending)
            this._save();
        this._append(message, true);
        return message;
    }

    _clear() {
        this._cancel?.cancel();
        this._messages = [];
        this._save();
        this._render();
        // A new conversation for Claude too.
        if (this._harvis) {
            try {
                Gio.Subprocess.new([this._harvis, 'ask', '--new'], Gio.SubprocessFlags.STDOUT_SILENCE |
                    Gio.SubprocessFlags.STDERR_SILENCE);
            } catch {
                // the next message starts fresh anyway once the session times out
            }
        }
        this._freshClaude = true;
    }

    // ---------- Display ----------

    _render() {
        this._list.destroy_all_children();
        for (const message of this._messages)
            this._append(message, false);
        this._syncEmpty();
    }

    _syncEmpty() {
        this._empty.visible = this._messages.length === 0;
        this._scroll.visible = !this._empty.visible;
    }

    _append(message, animate) {
        const mine = message.role === 'user';
        const box = new St.BoxLayout({
            style_class: mine ? 'dynada-chat-bubble dynada-chat-mine' : 'dynada-chat-bubble',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: mine ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: mine ? 1 : 0, y: 1}),
        });
        message.actor = box;
        this._fill(message);
        this._list.add_child(box);
        this._syncEmpty();
        if (animate) {
            // Slides up and grows from the corner it is anchored to.
            box.opacity = 0;
            box.translation_y = 10;
            box.set_scale(0.92, 0.92);
            box.ease({
                opacity: 255,
                translation_y: 0,
                scale_x: 1,
                scale_y: 1,
                duration: 320,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
        this._scrollToEnd();
    }

    // The bubble's content: the text, or dots and a status line while pending.
    _fill(message) {
        const box = message.actor;
        box.destroy_all_children();
        if (message.pending) {
            box.add_child(new TypingDots().actor);
            if (message.status)
                box.add_child(new St.Label({style_class: 'dynada-chat-working', text: message.status}));
            return;
        }
        const label = new St.Label({text: message.text});
        const text = label.clutter_text;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.ellipsize = Pango.EllipsizeMode.NONE;
        text.selectable = true;
        box.add_child(label);
        // Harvis's answers can be read aloud.
        if (message.role === 'assistant' && this._harvis) {
            const play = new St.Button({
                style_class: 'dynada-chat-play',
                can_focus: true,
                accessible_name: _('Read aloud'),
                x_align: Clutter.ActorAlign.START,
                child: new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: 11}),
            });
            play.connect('clicked', () => this._run(['say', message.text]));
            box.add_child(play);
        }
    }

    _scrollToEnd() {
        // After layout, when the new height is known.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const adjustment = this._scroll?.vadjustment;
            if (adjustment) {
                adjustment.ease(adjustment.upper - adjustment.page_size, {
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Talking ----------

    // Asks the Harvis service to listen now, as if it had heard its name.
    _listen() {
        try {
            const proc = Gio.Subprocess.new(['systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGUSR1',
                'harvis.service'], Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, (p, res) => {
                try {
                    p.wait_check_finish(res);
                } catch {
                    this._push('assistant', _('The Harvis service is not running (systemctl --user start harvis).'));
                }
            });
        } catch (e) {
            console.error('Dynamic Island: could not reach Harvis', e);
        }
    }

    _argv(text) {
        if (this._harvis)
            return [[this._harvis, 'ask', '--stream', text], true];
        if (this._claude) {
            const argv = [this._claude, '-p', ...(this._freshClaude ? [] : ['--continue']), text];
            return [argv, false];
        }
        return [null, false];
    }

    async _send() {
        const text = this.entry.text.trim();
        if (!text || this._busy)
            return;
        this.entry.text = '';
        this._push('user', text);
        const [argv, stream] = this._argv(text);
        if (!argv) {
            this._push('assistant', _('Neither Harvis nor the claude command is installed.'));
            return;
        }
        const pending = this._push('assistant', '', true);
        this._busy = true;
        this._cancel = new Gio.Cancellable();
        let answer = '';
        let timeout = 0;
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE});
            const folder = expandPath(this._settings.get_string('notes-folder'));
            if (folder && GLib.file_test(folder, GLib.FileTest.IS_DIR))
                launcher.set_cwd(folder);
            const proc = launcher.spawnv(argv);
            timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT, () => {
                timeout = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            const lines = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
            const plain = [];
            for (;;) {
                const [line] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel);
                if (line === null)
                    break;
                const textLine = new TextDecoder().decode(line);
                if (!stream) {
                    plain.push(textLine);
                    continue;
                }
                let event;
                try {
                    event = JSON.parse(textLine);
                } catch {
                    continue;
                }
                if (event.status) {
                    // Claude is working: say what with, under the dots.
                    pending.status = event.status;
                    this._fill(pending);
                } else if (event.answer !== undefined) {
                    answer = event.answer;
                } else if (event.error) {
                    answer = `${_('Could not get an answer')}: ${event.error}`;
                }
            }
            await proc.wait_async(null);
            if (!stream)
                answer = plain.join('\n').trim();
            this._freshClaude = false;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            answer = `${_('Could not get an answer')}: ${e.message}`;
        } finally {
            if (timeout)
                GLib.source_remove(timeout);
            this._busy = false;
        }
        pending.text = answer || _('No answer came back.');
        pending.pending = false;
        delete pending.status;
        this._save();
        this._fill(pending);
        // The answer replaces the dots with a little settle.
        pending.actor.set_scale(0.97, 0.97);
        pending.actor.ease({scale_x: 1, scale_y: 1, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this._scrollToEnd();
    }
}
