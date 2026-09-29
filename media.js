import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.DBus'));
const MprisProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.mpris.MediaPlayer2'));
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.mpris.MediaPlayer2.Player'));

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';

// Follows every MPRIS player on the session bus (Spotify, browsers playing video,
// Rhythmbox, mpv...) and picks the one to show: the most recently playing one,
// otherwise the most recently active paused one.
export class MediaWatcher {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._players = new Map();
        this._destroyed = false;

        this._dbus = new DBusProxy(Gio.DBus.session, 'org.freedesktop.DBus',
            '/org/freedesktop/DBus', (proxy, error) => {
                if (error || this._destroyed)
                    return;
                proxy.ListNamesRemote((result, err) => {
                    if (err || this._destroyed)
                        return;
                    result[0].filter(n => n.startsWith(PREFIX)).forEach(n => this._add(n));
                });
                this._ownerId = proxy.connectSignal('NameOwnerChanged',
                    (_p, _sender, [name, oldOwner, newOwner]) => {
                        if (!name.startsWith(PREFIX))
                            return;
                        if (oldOwner)
                            this._remove(name);
                        if (newOwner)
                            this._add(name);
                    });
            });
    }

    destroy() {
        this._destroyed = true;
        if (this._ownerId)
            this._dbus.disconnectSignal(this._ownerId);
        for (const name of [...this._players.keys()])
            this._remove(name, false);
        this._dbus = null;
    }

    _add(name) {
        if (this._players.has(name))
            return;
        const entry = {name, stamp: 0, ready: false};
        this._players.set(name, entry);

        entry.player = new PlayerProxy(Gio.DBus.session, name, OBJECT_PATH, (proxy, error) => {
            if (error || this._destroyed || !this._players.has(name))
                return;
            entry.ready = true;
            if (proxy.PlaybackStatus === 'Playing')
                entry.stamp = Date.now();
            entry.changedId = proxy.connect('g-properties-changed', () => {
                if (proxy.PlaybackStatus === 'Playing')
                    entry.stamp = Date.now();
                this._onChanged();
            });
            this._onChanged();
        });
        entry.mpris = new MprisProxy(Gio.DBus.session, name, OBJECT_PATH, (_proxy, error) => {
            if (!error && !this._destroyed)
                this._onChanged();
        });
    }

    _remove(name, notify = true) {
        const entry = this._players.get(name);
        if (!entry)
            return;
        if (entry.changedId)
            entry.player.disconnect(entry.changedId);
        this._players.delete(name);
        if (notify)
            this._onChanged();
    }

    current() {
        const ready = [...this._players.values()].filter(e => e.ready && e.player.g_name_owner);
        ready.sort((a, b) => b.stamp - a.stamp);
        return ready.find(e => e.player.PlaybackStatus === 'Playing') ?? ready[0] ?? null;
    }

    info(entry) {
        const metadata = entry.player.Metadata ?? {};
        const get = key => metadata[key]?.deepUnpack?.();
        const artists = get('xesam:artist');

        let app = null;
        const desktopEntry = entry.mpris?.DesktopEntry;
        if (desktopEntry)
            app = Shell.AppSystem.get_default().lookup_app(`${desktopEntry}.desktop`);

        return {
            title: get('xesam:title') ?? '',
            artist: Array.isArray(artists) ? artists.join(', ') : (artists ?? ''),
            artUrl: get('mpris:artUrl') ?? '',
            length: Number(get('mpris:length') ?? 0),
            playing: entry.player.PlaybackStatus === 'Playing',
            canNext: !!entry.player.CanGoNext,
            canPrevious: !!entry.player.CanGoPrevious,
            app,
            appName: app?.get_name() ?? entry.mpris?.Identity ?? '',
        };
    }

    playPause(entry) {
        entry.player.PlayPauseRemote();
    }

    next(entry) {
        entry.player.NextRemote();
    }

    previous(entry) {
        entry.player.PreviousRemote();
    }

    raise(entry) {
        if (entry.mpris?.CanRaise)
            entry.mpris.RaiseRemote();
    }

    // Position is not announced through property changes, so it is read on demand.
    // Calls back with microseconds, or -1 when the player does not report it.
    position(entry, callback) {
        Gio.DBus.session.call(entry.name, OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 500, null,
            (conn, res) => {
                try {
                    const [value] = conn.call_finish(res).recursiveUnpack();
                    callback(Number(value));
                } catch {
                    callback(-1);
                }
            });
    }
}
