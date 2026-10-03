import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const KEEP = 60; // messages kept across sessions
const TIMEOUT = 300; // s for one answer
const HISTORY = GLib.build_filenamev([GLib.get_user_data_dir(), 'dynamic-island', 'chat.json']);

function expandPath(path) {
    if (!path)
        return '';
    return path.startsWith('~') ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(1)]) : path;
}

// The island's chat with the assistant: typed, or spoken through the Harvis
// wake word service (the microphone button asks it to listen without the wake
// word). Spoken exchanges arrive through addExchange() and land in the same
// conversation. Typed ones go to `dikte ask` when Dikte is installed, which
// shares its conversation memory with the spoken ones, or to `claude -p`.
export class ChatView {
    constructor({settings, width, onClose}) {
        this._settings = settings;
        this._onClose = onClose;
        this._messages = this._load();
        this._newConversation = false;
        this._dikte = GLib.find_program_in_path('dikte') ?? this._local('dikte');
        this._claude = GLib.find_program_in_path('claude') ?? this._local('claude');

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
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._status = new St.Label({style_class: 'dynada-chat-status', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._status);
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
        this._micButton = new St.Button({
            style_class: 'dynada-round-button dynada-chat-mic',
            can_focus: true,
            accessible_name: _('Talk'),
            child: new St.Icon({icon_name: 'audio-input-microphone-symbolic', icon_size: 16}),
        });
        this._micButton.connect('clicked', () => this._listen());
        const send = new St.Button({
            style_class: 'dynada-round-button dynada-chat-send',
            can_focus: true,
            accessible_name: _('Send'),
            child: new St.Icon({icon_name: 'go-up-symbolic', icon_size: 16}),
        });
        send.connect('clicked', () => this._send());
        bar.add_child(this.entry);
        bar.add_child(this._micButton);
        bar.add_child(send);
        this.actor.add_child(bar);

        this._render();
    }

    destroy() {
        this._cancel?.cancel();
        this._cancel = null;
        this.actor.destroy();
    }

    focus() {
        this.entry.grab_key_focus();
        this._scrollToEnd();
    }

    // A spoken exchange from the wake word service.
    addExchange(question, answer) {
        this._push('user', question);
        this._push('assistant', answer);
        this.setStatus('');
    }

    // What the wake word service is doing right now ("Listening…"), or ''.
    setStatus(text) {
        this._status.text = text ?? '';
        this._status.visible = !!text;
        if (text)
            this._micButton.add_style_pseudo_class('listening');
        else
            this._micButton.remove_style_pseudo_class('listening');
    }

    _local(name) {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', name]);
        return GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) ? path : null;
    }

    // ---------- History ----------

    _load() {
        try {
            const [, bytes] = GLib.file_get_contents(HISTORY);
            const list = JSON.parse(new TextDecoder().decode(bytes));
            return Array.isArray(list) ? list.slice(-KEEP) : [];
        } catch {
            return [];
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(HISTORY), 0o700);
            GLib.file_set_contents(HISTORY, JSON.stringify(this._messages.slice(-KEEP)));
        } catch (e) {
            console.error('Dynamic Island: could not save the chat', e);
        }
    }

    _push(role, text, pending = false) {
        const message = {role, text, pending};
        this._messages.push(message);
        if (!pending)
            this._save();
        this._render();
        return message;
    }

    _clear() {
        this._cancel?.cancel();
        this._messages = [];
        this._newConversation = true;
        this._save();
        this._render();
    }

    // ---------- Display ----------

    _render() {
        this._list.destroy_all_children();
        for (const message of this._messages)
            this._list.add_child(this._bubble(message));
        this._empty.visible = this._messages.length === 0;
        this._scroll.visible = !this._empty.visible;
        this._scrollToEnd();
    }

    _bubble(message) {
        const mine = message.role === 'user';
        const label = new St.Label({
            style_class: mine ? 'dynada-chat-bubble dynada-chat-mine' : 'dynada-chat-bubble',
            text: message.text,
            x_align: mine ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
        });
        if (message.pending)
            label.add_style_pseudo_class('pending');
        const text = label.clutter_text;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.ellipsize = Pango.EllipsizeMode.NONE;
        text.selectable = true;
        return label;
    }

    _scrollToEnd() {
        // After layout, when the new height is known.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const adjustment = this._scroll.vadjustment;
            if (adjustment)
                adjustment.value = adjustment.upper - adjustment.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Talking ----------

    // Asks the Harvis service to listen now, as if it had heard its name.
    _listen() {
        try {
            const proc = Gio.Subprocess.new(['systemctl', '--user', 'kill', '--kill-whom=main', '--signal=SIGUSR1', 'harvis.service'],
                Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, (p, res) => {
                try {
                    p.wait_check_finish(res);
                    this.setStatus(_('Listening…'));
                } catch {
                    this._push('assistant', _('The Harvis service is not running (systemctl --user start harvis).'));
                }
            });
        } catch (e) {
            console.error('Dynamic Island: could not reach Harvis', e);
        }
    }

    _argv(text) {
        const folder = expandPath(this._settings.get_string('notes-folder'));
        if (this._dikte) {
            const argv = [this._dikte, 'ask', '--json', '-q'];
            if (folder)
                argv.push('--dir', folder);
            if (this._newConversation)
                argv.push('--new');
            return [argv.concat(text), true];
        }
        if (this._claude)
            return [[this._claude, '-p', ...(this._newConversation ? [] : ['--continue']), text], false];
        return [null, false];
    }

    async _send() {
        const text = this.entry.text.trim();
        if (!text || this._busy)
            return;
        this.entry.text = '';
        this._push('user', text);
        const [argv, json] = this._argv(text);
        if (!argv) {
            this._push('assistant', _('Neither Dikte nor the claude command is installed.'));
            return;
        }
        const pending = this._push('assistant', _('Thinking…'), true);
        this._busy = true;
        this._cancel = new Gio.Cancellable();
        let answer;
        let timeout = 0;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            const folder = expandPath(this._settings.get_string('notes-folder'));
            if (folder && GLib.file_test(folder, GLib.FileTest.IS_DIR))
                launcher.set_cwd(folder);
            const proc = launcher.spawnv(argv);
            timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT, () => {
                timeout = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            const [out, err] = await proc.communicate_utf8_async(null, this._cancel);
            answer = json ? this._fromJson(out, err) : (out ?? '').trim();
            this._newConversation = false;
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
        this._save();
        this._render();
    }

    _fromJson(out, err) {
        try {
            const reply = JSON.parse(out);
            if (reply.ok === false && reply.error)
                return `${_('Could not get an answer')}: ${reply.error}`;
            return (reply.answer ?? reply.text ?? '').trim();
        } catch {
            return ((err || out) ?? '').trim().split('\n').slice(-3).join('\n');
        }
    }
}
