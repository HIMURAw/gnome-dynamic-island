import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const AUTO_HIDE = ['never', 'fullscreen', 'smart'];

// Extensions that also rearrange or hide the top bar, and what to do about them.
const CONFLICTS = {
    'dash-to-panel@jderose9.github.com': () =>
        _('Dash to Panel moves the top bar into its own panel. Use one or the other.'),
    'just-perfection-desktop@just-perfection': () =>
        _('Just Perfection can hide or restyle the top bar. Leave its panel options at their defaults.'),
    'hidetopbar@mathieu.bidon.ca': () =>
        _('Hide Top Bar hides the same bar the island replaces. Turn it off.'),
    'openbar@neuromorph': () =>
        _('Open Bar restyles the top bar. Turn it off.'),
    'blur-my-shell@aunetx': () =>
        _('Blur my Shell: turn off its panel blur, or a strip can stay at the top of the screen.'),
};

export default class DynamicIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const switchRow = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        // Behaviour
        const behaviour = new Adw.PreferencesGroup({title: _('Behaviour')});
        page.add(behaviour);

        const autoHide = new Adw.ComboRow({
            title: _('Slide out of the way'),
            subtitle: _('Rest the pointer on the top edge to bring it back'),
            model: Gtk.StringList.new([
                _('Never'),
                _('In fullscreen'),
                _('When a window reaches under it'),
            ]),
        });
        autoHide.selected = Math.max(0, AUTO_HIDE.indexOf(settings.get_string('auto-hide')));
        autoHide.connect('notify::selected', () =>
            settings.set_string('auto-hide', AUTO_HIDE[autoHide.selected]));
        behaviour.add(autoHide);

        behaviour.add(switchRow('notifications', _('Notifications in the island'),
            _("In place of GNOME's banners")));

        // Appearance
        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(appearance);
        appearance.add(switchRow('blur', _('Frosted glass'),
            _('Turn off for a plain dark island on slower graphics')));

        const width = new Adw.SpinRow({
            title: _('Width of the open island'),
            adjustment: new Gtk.Adjustment({lower: 480, upper: 760, step_increment: 20, page_increment: 40}),
        });
        settings.bind('expanded-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearance.add(width);

        const monitors = Gdk.Display.get_default()?.get_monitors();
        const count = monitors?.get_n_items() ?? 1;
        if (count > 1) {
            const names = [_('Primary monitor')];
            for (let i = 0; i < count; i++) {
                const monitor = monitors.get_item(i);
                // Translators: a monitor in the list, e.g. "Monitor 2 (DELL U2720Q)".
                names.push(`${_('Monitor')} ${i + 1}${monitor.model ? ` (${monitor.model})` : ''}`);
            }
            const monitorRow = new Adw.ComboRow({title: _('Monitor'), model: Gtk.StringList.new(names)});
            monitorRow.selected = settings.get_int('monitor') + 1;
            monitorRow.connect('notify::selected', () =>
                settings.set_int('monitor', monitorRow.selected - 1));
            appearance.add(monitorRow);
        }

        // Parts of the island
        const parts = new Adw.PreferencesGroup({
            title: _('Island'),
            description: _('What the island shows'),
        });
        page.add(parts);
        parts.add(switchRow('show-notification-bubble', _('Notification center'),
            _('The bell on the left')));
        parts.add(switchRow('show-media-bubble', _('Now playing'),
            _('The bubble on the right')));
        parts.add(switchRow('show-connectivity', _('Connectivity'),
            _('Wi-Fi, Bluetooth, tethering, VPN')));
        parts.add(switchRow('show-apps', _('Open apps')));
        parts.add(switchRow('show-sliders', _('Sliders'),
            _('Volume, microphone, brightness')));
        parts.add(switchRow('show-tiles', _('Toggles'),
            _('Power mode, dark style, Do Not Disturb and toggles from other extensions')));
        parts.add(switchRow('show-tray', _("Other extensions' icons")));

        const palette = new Adw.PreferencesGroup({
            title: _('Command palette'),
            description: _('Super+Space: apps, calculator, timers, notes, Claude. Type ? to ask Claude, n to take a note.'),
        });
        page.add(palette);
        const notes = new Adw.EntryRow({title: _('Notes folder (searched, empty for none)')});
        settings.bind('notes-folder', notes, 'text', Gio.SettingsBindFlags.DEFAULT);
        palette.add(notes);
        const inbox = new Adw.EntryRow({title: _('Quick notes go to (a path, or a folder inside the notes folder)')});
        settings.bind('inbox-folder', inbox, 'text', Gio.SettingsBindFlags.DEFAULT);
        palette.add(inbox);

        this._addCompatibility(page);
        this._addAbout(page);
    }

    // Warns about extensions that fight over the top bar, only when one is on.
    _addCompatibility(page) {
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const enabled = shell.get_strv('enabled-extensions');
        const found = Object.keys(CONFLICTS).filter(uuid => enabled.includes(uuid));
        if (!found.length)
            return;
        const group = new Adw.PreferencesGroup({
            title: _('Compatibility'),
            description: _('These extensions also change the top bar'),
        });
        page.add(group);
        for (const uuid of found) {
            group.add(new Adw.ActionRow({
                title: uuid.split('@')[0],
                subtitle: CONFLICTS[uuid](),
                subtitle_lines: 3,
                icon_name: 'dialog-warning-symbolic',
            }));
        }
    }

    _addAbout(page) {
        const group = new Adw.PreferencesGroup({title: _('About')});
        page.add(group);
        const url = this.metadata.url;
        const row = new Adw.ActionRow({
            title: _('Report a problem or suggest an idea'),
            subtitle: url,
            activatable: true,
        });
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () =>
            Gtk.UriLauncher.new(`${url}/issues`).launch(row.get_root(), null, null));
        group.add(row);
    }
}
