import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {calculate, convert, formatNumber, parseDuration} from './calc.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const MAX_APPS = 5;
const MAX_NOTES = 5;
const SEARCH_DELAY = 160; // ms after the last key before searching notes
const CLAUDE_TIMEOUT = 180; // s
const CLAUDE_HINT = 'You are answering from a small popup on the desktop. Be brief: a few short ' +
    "sentences or a short list, plain text without markdown headings or tables. Answer in the user's language.";

const fmt = (str, ...args) => str.replace(/%s/g, () => String(args.shift()));

function expandPath(path) {
    if (!path)
        return '';
    return path.startsWith('~') ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(1)]) : path;
}

// A file name from the first words of a note.
function noteName(text) {
    const words = text.replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
    const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H%M');
    return `${stamp} ${words || _('Note')}`.slice(0, 80);
}

// The island's command palette (Super+Space): apps, a calculator, unit
// conversions, timers, notes search, quick notes, Claude and the web, all
// from one line. The island keeps it open until Escape or a click elsewhere.
export class Palette {
    // settings: the extension's settings; activities: Activities;
    // onClose(): the palette wants the island closed.
    constructor({settings, activities, width, onClose, onResize}) {
        this._settings = settings;
        this._activities = activities;
        this._onClose = onClose;
        this._onResize = onResize;
        this._results = [];
        this._selected = 0;
        this._claude = GLib.find_program_in_path('claude') ??
            [GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude'])]
                .find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;

        this.actor = new St.BoxLayout({
            style_class: 'dynada-expanded dynada-palette',
            orientation: Clutter.Orientation.VERTICAL,
            width,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
            opacity: 0,
            visible: false,
        });

        const bar = new St.BoxLayout({style_class: 'dynada-palette-bar dynada-chip', x_expand: true});
        bar.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'dynada-palette-search-icon'}));
        this.entry = new St.Entry({
            style_class: 'dynada-palette-entry',
            hint_text: _('Search, calculate, ? ask Claude, n take a note'),
            can_focus: true,
            x_expand: true,
        });
        bar.add_child(this.entry);
        this.actor.add_child(bar);

        this._list = new St.BoxLayout({
            style_class: 'dynada-palette-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.actor.add_child(this._list);

        this._answer = this._buildAnswer();
        this.actor.add_child(this._answer);

        const text = this.entry.clutter_text;
        text.connect('text-changed', () => this._onTextChanged());
        text.connect('activate', () => this._activate(this._selected));
        text.connect('key-press-event', (_a, event) => this._onKey(event));
    }

    destroy() {
        this._cancel();
        this.actor.destroy();
    }

    // Called when the island shows the palette.
    reset(text = '') {
        this._cancel();
        this._answer.hide();
        this._list.show();
        this.entry.text = text;
        this._onTextChanged();
    }

    focus() {
        this.entry.grab_key_focus();
        this.entry.clutter_text.set_selection(0, -1);
    }

    _cancel() {
        this._searchCancel?.cancel();
        this._searchCancel = null;
        this._claudeCancel?.cancel();
        this._claudeCancel = null;
        if (this._searchId)
            GLib.source_remove(this._searchId);
        this._searchId = 0;
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = 0;
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            if (this._answer.visible) {
                this.reset(this.entry.text);
                return Clutter.EVENT_STOP;
            }
            this._onClose();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            const n = this._results.filter(r => r.activate).length;
            if (n) {
                this._selected = (this._selected + (key === Clutter.KEY_Down ? 1 : n - 1)) % n;
                this._userMoved = true;
                this._render();
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---------- Results ----------

    _onTextChanged() {
        if (this._answer.visible) {
            this._answer.hide();
            this._list.show();
        }
        const query = this.entry.text.trim();
        this._notes = [];
        this._results = this._instantResults(query);
        this._selected = 0;
        this._userMoved = false;
        this._render();

        this._searchCancel?.cancel();
        if (this._searchId)
            GLib.source_remove(this._searchId);
        this._searchId = 0;
        if (query.length >= 3 && !/^[?n+]\s/.test(query) && this._notesFolder()) {
            this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY, () => {
                this._searchId = 0;
                this._searchNotes(query);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _instantResults(query) {
        const results = [];
        if (!query) {
            return [
                {icon: 'user-available-symbolic', title: _('? question'), subtitle: _('Ask Claude'), hint: true},
                {icon: 'document-edit-symbolic', title: _('n text'), subtitle: _('Save a quick note'), hint: true},
                {icon: 'alarm-symbolic', title: _('25 min'), subtitle: _('Start a timer'), hint: true},
                {icon: 'accessories-calculator-symbolic', title: _('12*7 or 5 km mi'), subtitle: _('Calculate and convert'), hint: true},
            ].filter(r => r.icon !== 'user-available-symbolic' || this._claude);
        }

        // Explicit prefixes win.
        const ask = /^\?\s*(.+)$/.exec(query);
        if (ask && this._claude)
            return [this._claudeResult(ask[1])];
        const note = /^(?:n|\+)\s+(.+)$/s.exec(query);
        if (note && this._inboxFolder())
            return [this._noteResult(note[1])];

        const value = calculate(query);
        if (value !== null) {
            const text = formatNumber(value);
            results.push({
                icon: 'accessories-calculator-symbolic',
                title: `= ${text}`,
                subtitle: _('Copy the result'),
                activate: () => this._copy(text),
            });
        }
        const converted = convert(query);
        if (converted) {
            const text = `${formatNumber(converted.value)} ${converted.unit}`;
            results.push({
                icon: 'accessories-calculator-symbolic',
                title: `= ${text}`,
                subtitle: _('Copy the result'),
                activate: () => this._copy(text),
            });
        }
        const timer = /^(?:timer|zamanlay[ıi]c[ıi]|saya[çc]|t)\s+(.+)$/i.exec(query);
        const seconds = parseDuration(timer ? timer[1] : query);
        if (seconds && this._activities) {
            results.push({
                icon: 'alarm-symbolic',
                title: fmt(_('Start a %s timer'), this._clock(seconds)),
                subtitle: _('Shown in the island while it runs'),
                activate: () => {
                    this._activities.Timer(seconds, '');
                    this._onClose();
                },
            });
        }

        for (const app of this._searchApps(query))
            results.push(app);

        if (this._inboxFolder())
            results.push(this._noteResult(query));
        if (this._claude)
            results.push(this._claudeResult(query));
        results.push({
            icon: 'web-browser-symbolic',
            title: fmt(_('Search the web for “%s”'), query),
            tail: true,
            activate: () => {
                const uri = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
                this._onClose();
            },
        });
        return results;
    }

    _clock(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor(seconds / 60) % 60;
        const s = seconds % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    }

    _searchApps(query) {
        let ids = [];
        try {
            ids = Shell.AppSystem.search(query).flat();
        } catch (e) {
            console.error('Dynamic Island: app search failed', e);
        }
        const system = Shell.AppSystem.get_default();
        return ids.map(id => system.lookup_app(id)).filter(Boolean).slice(0, MAX_APPS).map(app => ({
            gicon: app.get_icon(),
            title: app.get_name(),
            subtitle: app.get_description() ?? '',
            activate: () => {
                app.activate();
                this._onClose();
            },
        }));
    }

    _notesFolder() {
        const path = expandPath(this._settings.get_string('notes-folder'));
        return path && GLib.file_test(path, GLib.FileTest.IS_DIR) ? path : null;
    }

    _inboxFolder() {
        const inbox = expandPath(this._settings.get_string('inbox-folder'));
        if (inbox)
            return GLib.path_is_absolute(inbox) ? inbox : (this._notesFolder() ? GLib.build_filenamev([this._notesFolder(), inbox]) : null);
        return this._notesFolder();
    }

    // Notes whose name or text contains the query, through ripgrep (or grep).
    async _searchNotes(query) {
        const folder = this._notesFolder();
        const cancel = new Gio.Cancellable();
        this._searchCancel = cancel;
        const rg = GLib.find_program_in_path('rg');
        const argv = rg
            ? [rg, '-i', '-l', '-F', '--max-count', '1', '--glob', '*.md', '--glob', '!.obsidian', '--', query, folder]
            : ['grep', '-r', '-i', '-l', '-F', '--include=*.md', '--', query, folder];
        let files = [];
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [out] = await proc.communicate_utf8_async(null, cancel);
            files = (out ?? '').split('\n').filter(Boolean);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('Dynamic Island: notes search failed', e);
            return;
        }
        if (cancel.is_cancelled() || this.entry.text.trim() !== query)
            return;
        // Matches in the file name first, then shorter paths.
        const q = query.toLowerCase();
        const name = f => GLib.path_get_basename(f).replace(/\.md$/, '');
        files.sort((a, b) => (name(b).toLowerCase().includes(q) - name(a).toLowerCase().includes(q)) ||
            a.length - b.length);
        const notes = files.slice(0, MAX_NOTES).map(file => ({
            icon: 'text-x-generic-symbolic',
            title: name(file),
            subtitle: GLib.path_get_dirname(file).slice(folder.length + 1) || '/',
            activate: () => {
                this._openNote(folder, file);
                this._onClose();
            },
        }));
        if (!notes.length)
            return;
        // After the instant results that answer the query outright (calculator,
        // timer, apps), before note/Claude/web.
        const instant = this._results.filter(r => !r.tail);
        const tail = this._results.filter(r => r.tail);
        const selectedTitle = this._results.filter(r => r.activate)[this._selected]?.title;
        this._results = [...instant, ...notes, ...tail];
        // Keep a choice the user made with the arrows; otherwise the best match is on top.
        const index = this._results.filter(r => r.activate).findIndex(r => r.title === selectedTitle);
        this._selected = this._userMoved ? Math.max(0, index) : 0;
        this._render();
    }

    // Obsidian vaults open in Obsidian, anything else in the default app.
    _openNote(folder, file) {
        const context = global.create_app_launch_context(0, -1);
        const handler = Gio.AppInfo.get_default_for_uri_scheme('obsidian');
        if (handler && GLib.file_test(GLib.build_filenamev([folder, '.obsidian']), GLib.FileTest.IS_DIR)) {
            Gio.AppInfo.launch_default_for_uri(`obsidian://open?path=${encodeURIComponent(file)}`, context);
            return;
        }
        Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(file).get_uri(), context);
    }

    _noteResult(text) {
        return {
            icon: 'document-edit-symbolic',
            title: fmt(_('Save as a note: %s'), text.split('\n')[0]),
            subtitle: this._inboxFolder()?.replace(GLib.get_home_dir(), '~') ?? '',
            tail: true,
            activate: () => this._saveNote(text),
        };
    }

    _saveNote(text) {
        const folder = this._inboxFolder();
        try {
            GLib.mkdir_with_parents(folder, 0o755);
            let path = GLib.build_filenamev([folder, `${noteName(text)}.md`]);
            for (let i = 2; GLib.file_test(path, GLib.FileTest.EXISTS); i++)
                path = GLib.build_filenamev([folder, `${noteName(text)} ${i}.md`]);
            const body = `${text.trim()}\n\n— ${GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M')}\n`;
            GLib.file_set_contents(path, body);
            this._flash(_('Note saved'));
        } catch (e) {
            console.error('Dynamic Island: could not save the note', e);
            this._flash(_('Could not save the note'));
        }
    }

    // A short confirmation in place of the results, then close.
    _flash(text) {
        this._results = [{icon: 'object-select-symbolic', title: text}];
        this._render();
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._flashId = 0;
            this._onClose();
            return GLib.SOURCE_REMOVE;
        });
    }

    _copy(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._flash(_('Copied'));
    }

    _render() {
        this._list.destroy_all_children();
        let index = 0;
        for (const result of this._results) {
            const selectable = !!result.activate;
            const selected = selectable && index === this._selected;
            this._list.add_child(this._row(result, selected, selectable ? index : -1));
            if (selectable)
                index++;
        }
        this._list.visible = this._results.length > 0;
        this._onResize?.();
    }

    _row(result, selected, index) {
        const row = new St.BoxLayout({style_class: 'dynada-palette-row-box', x_expand: true});
        const icon = new St.Icon({
            style_class: 'dynada-palette-icon',
            icon_size: result.gicon ? 24 : 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (result.gicon)
            icon.gicon = result.gicon;
        else
            icon.icon_name = result.icon;
        const iconBin = new St.Bin({style_class: 'dynada-palette-icon-bin', child: icon});
        row.add_child(iconBin);
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = new St.Label({style_class: 'dynada-palette-title', text: result.title});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);
        if (result.subtitle) {
            const subtitle = new St.Label({style_class: 'dynada-palette-subtitle', text: result.subtitle});
            subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(subtitle);
        }
        row.add_child(text);
        if (selected)
            row.add_child(new St.Label({style_class: 'dynada-palette-enter', text: '↵', y_align: Clutter.ActorAlign.CENTER}));

        const button = new St.Button({
            style_class: result.hint ? 'dynada-palette-row dynada-palette-hint' : 'dynada-palette-row',
            reactive: !!result.activate,
            x_expand: true,
            child: row,
        });
        if (selected)
            button.add_style_pseudo_class('selected');
        if (result.activate) {
            button.connect('clicked', () => result.activate());
            button.connect('enter-event', () => {
                if (this._selected !== index) {
                    this._selected = index;
                    this._userMoved = true;
                    // Re-render later: the button under the pointer is being entered.
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._render();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        }
        return button;
    }

    _activate(index) {
        const result = this._results.filter(r => r.activate)[index];
        result?.activate();
    }

    // ---------- Claude ----------

    _claudeResult(question) {
        return {
            icon: 'user-available-symbolic',
            title: fmt(_('Ask Claude: %s'), question),
            subtitle: _('The answer appears here'),
            tail: true,
            activate: () => this._ask(question),
        };
    }

    _buildAnswer() {
        const box = new St.BoxLayout({
            style_class: 'dynada-card dynada-answer',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        this._answerText = new St.Label({style_class: 'dynada-answer-text'});
        const clutterText = this._answerText.clutter_text;
        clutterText.line_wrap = true;
        clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        clutterText.ellipsize = Pango.EllipsizeMode.NONE;
        clutterText.selectable = true;
        const inner = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        inner.add_child(this._answerText);
        this._answerScroll = new St.ScrollView({
            style_class: 'dynada-answer-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            child: inner,
        });
        box.add_child(this._answerScroll);

        const actions = new St.BoxLayout({style_class: 'dynada-answer-actions', x_align: Clutter.ActorAlign.END});
        this._copyButton = new St.Button({style_class: 'dynada-pill-button', can_focus: true, label: _('Copy')});
        this._copyButton.connect('clicked', () => this._copy(this._answerText.text));
        this._saveButton = new St.Button({style_class: 'dynada-pill-button', can_focus: true, label: _('Save as a note')});
        this._saveButton.connect('clicked', () =>
            this._saveNote(`${this._question}\n\n${this._answerText.text}`));
        actions.add_child(this._copyButton);
        actions.add_child(this._saveButton);
        box.add_child(actions);
        return box;
    }

    async _ask(question) {
        this._cancel();
        this._question = question;
        this._list.hide();
        this._answer.show();
        this._answerText.text = _('Thinking…');
        this._answerText.add_style_pseudo_class('pending');
        this._copyButton.hide();
        this._saveButton.hide();
        this._onResize?.();

        const cancel = new Gio.Cancellable();
        this._claudeCancel = cancel;
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        // From the notes folder, so a project's instructions there (CLAUDE.md) apply.
        launcher.set_cwd(this._notesFolder() ?? GLib.get_home_dir());
        let answer;
        let timeout = 0;
        try {
            const proc = launcher.spawnv([this._claude, '-p', '--append-system-prompt', CLAUDE_HINT, question]);
            timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CLAUDE_TIMEOUT, () => {
                timeout = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            const [out] = await proc.communicate_utf8_async(null, cancel);
            answer = (out ?? '').trim() || _('No answer came back.');
            if (!proc.get_successful() && !out?.trim())
                answer = _('Claude could not answer.');
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            answer = fmt(_('Claude could not be started: %s'), e.message);
        } finally {
            if (timeout)
                GLib.source_remove(timeout);
        }
        if (cancel.is_cancelled())
            return;
        this._answerText.remove_style_pseudo_class('pending');
        this._answerText.text = answer;
        this._copyButton.show();
        this._saveButton.visible = !!this._inboxFolder();
        this._onResize?.();
    }
}
