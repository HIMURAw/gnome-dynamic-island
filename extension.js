import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getPointerWatcher} from 'resource:///org/gnome/shell/ui/pointerWatcher.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {Glass, RoundedMask} from './glass.js';
import {ChipLayout, TopCenterLayout} from './layouts.js';
import {MediaWatcher} from './media.js';
import {GlassMenus} from './menus.js';
import {spring, stopAllSprings} from './spring.js';

const TOP_MARGIN = 6;
const PILL_HEIGHT = 38;
const BORDER = 1;
const BUBBLE_GAP = 8;
const EXPANDED_WIDTH = 520;
const EXPANDED_RADIUS = 34;
const CONTENT_WIDTH = EXPANDED_WIDTH - 2 * BORDER;
// How long to wait after the pointer leaves before collapsing (ms).
const COLLAPSE_DELAY = 700;
// In fullscreen, hide again once the pointer is this far below the island (px).
const REVEAL_SLACK = 60;
const ART_SIZE = 72;
const NOTIFICATION_ICON = 44;
// How long a notification stays in the island (ms). Critical ones stay until dismissed.
const NOTIFICATION_DURATION = 5000;

const DisplayDeviceProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.Device'));

// Minimal printf for translated strings: %d and %s in order, %% for a literal percent.
function fmt(str, ...args) {
    return str.replace(/%([ds%])/g, (m, c) => (c === '%' ? '%' : String(args.shift())));
}

function formatTime(microseconds) {
    const total = Math.max(0, Math.floor(microseconds / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._signals = [];
        this._slots = [];
        this._timeouts = new Set();
        this._mode = null;
        this._hidden = false;

        this._buildUi();
        this._setupClock();
        this._setupBattery();
        this._setupVolume();
        this._setupMedia();
        this._glassMenus = new GlassMenus();
        this._adoptPanel();
        this._setupFullscreen();
        this._setupNotifications();
    }

    disable() {
        stopAllSprings();
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._collapseTimeout = this._adoptIdle = this._panelIdle = this._positionTimeout = 0;
        this._notificationTimeout = 0;

        this._releaseNotifications();

        this._pointerWatch?.remove();
        this._pointerWatch = null;

        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._unbindSink();

        this._media.destroy();
        this._media = null;

        this._glassMenus.destroy();
        this._glassMenus = null;
        this._releasePanel();

        Main.layoutManager.removeChrome(this._strip);
        this._strip.destroy();
        this._strip = this._island = this._left = this._right = null;

        this._power = null;
        this._clock = null;
        this._interfaceSettings = null;
    }

    _connect(obj, signal, handler) {
        this._signals.push([obj, obj.connect(signal, handler)]);
    }

    _timeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const result = callback();
            if (result !== GLib.SOURCE_CONTINUE)
                this._timeouts.delete(id);
            return result;
        });
        this._timeouts.add(id);
        return id;
    }

    _clearTimeout(id) {
        if (id && this._timeouts.delete(id))
            GLib.source_remove(id);
        return 0;
    }

    // ---------- Layout ----------

    _buildUi() {
        // Full-monitor, non-reactive layer: clicks fall through to the windows below
        // except on the island and its bubbles. It reserves no screen space.
        this._layout = new TopCenterLayout(TOP_MARGIN, BUBBLE_GAP);
        this._strip = new St.Widget({layout_manager: this._layout});
        Main.layoutManager.addChrome(this._strip, {affectsStruts: false, trackFullscreen: false});
        // Below the panel menus, so menus opened from the island are not covered by it.
        Main.layoutManager.uiGroup.set_child_above_sibling(this._strip, Main.layoutManager.panelBox);
        this._syncStripGeometry();
        this._connect(Main.layoutManager, 'monitors-changed', () => this._syncStripGeometry());

        this._island = new Glass({
            style_class: 'dynada-island',
            radius: EXPANDED_RADIUS,
            reactive: true,
            track_hover: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._compact = this._buildCompact();
        this._controls = this._buildControls();
        this._mediaView = this._buildMediaView();
        this._notificationView = this._buildNotificationView();
        for (const view of [this._compact, this._controls, this._mediaView, this._notificationView])
            this._island.add_child(view);

        this._left = new Glass({
            style_class: 'dynada-bubble',
            radius: PILL_HEIGHT / 2,
            reactive: true,
            track_hover: true,
            width: PILL_HEIGHT,
            height: PILL_HEIGHT,
        });
        this._right = this._buildMediaBubble();

        this._strip.add_child(this._left);
        this._strip.add_child(this._island);
        this._strip.add_child(this._right);
        this._layout.left = this._left;
        this._layout.center = this._island;
        this._layout.right = this._right;

        this._connect(this._compact, 'clicked', () => this._open('controls'));
        this._connect(this._controlsHeader, 'clicked', () => this._close());
        this._connect(this._notificationView, 'clicked', () => this._activateNotification());
        this._connect(this._compact, 'notify::pressed', () => {
            const scale = this._compact.pressed ? 0.95 : 1;
            this._island.ease({
                scale_x: scale,
                scale_y: scale,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
        for (const actor of [this._island, this._left, this._right]) {
            this._connect(actor, 'notify::hover', () => {
                if (this._mode && !this._anyHover())
                    this._scheduleCollapse();
            });
        }
        // The blur behind the glass follows layout; moving the whole layer needs a nudge.
        this._connect(this._strip, 'notify::translation-y', () => {
            for (const glass of [this._island, this._left, this._right])
                glass.syncBackdrop();
        });
    }

    _syncStripGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._strip.set_position(monitor.x, monitor.y);
        this._strip.set_size(monitor.width, monitor.height);
    }

    _buildCompact() {
        const box = new St.BoxLayout({style_class: 'dynada-compact-row', y_align: Clutter.ActorAlign.CENTER});
        const button = new St.Button({
            style_class: 'dynada-compact',
            can_focus: true,
            accessible_name: _('Open Dynamic Island'),
            height: PILL_HEIGHT - 2 * BORDER,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            child: box,
        });
        this._compactTime = new St.Label({style_class: 'dynada-compact-time', y_align: Clutter.ActorAlign.CENTER});
        this._compactDate = new St.Label({style_class: 'dynada-compact-date', y_align: Clutter.ActorAlign.CENTER});

        this._compactBattery = new St.BoxLayout({style_class: 'dynada-battery', y_align: Clutter.ActorAlign.CENTER});
        this._compactBatteryIcon = new St.Icon({style_class: 'dynada-battery-icon'});
        this._compactBatteryLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._compactBattery.add_child(this._compactBatteryIcon);
        this._compactBattery.add_child(this._compactBatteryLabel);

        box.add_child(this._compactTime);
        box.add_child(this._compactDate);
        box.add_child(this._compactBattery);
        return button;
    }

    _expandedView() {
        return new St.BoxLayout({
            style_class: 'dynada-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            width: CONTENT_WIDTH,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
            opacity: 0,
            visible: false,
        });
    }

    _buildControls() {
        const view = this._expandedView();

        // Header: big time and date on the left, battery on the right. Clicking it collapses.
        const header = new St.BoxLayout({x_expand: true});
        this._controlsHeader = new St.Button({
            style_class: 'dynada-header',
            can_focus: true,
            accessible_name: _('Close Dynamic Island'),
            x_expand: true,
            child: header,
        });
        const left = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._bigTime = new St.Label({style_class: 'dynada-big-time'});
        this._longDate = new St.Label({style_class: 'dynada-long-date'});
        left.add_child(this._bigTime);
        left.add_child(this._longDate);

        this._batteryColumn = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bigBattery = new St.Label({style_class: 'dynada-big-battery', x_align: Clutter.ActorAlign.END});
        this._batteryState = new St.Label({style_class: 'dynada-battery-state', x_align: Clutter.ActorAlign.END});
        this._batteryColumn.add_child(this._bigBattery);
        this._batteryColumn.add_child(this._batteryState);

        header.add_child(left);
        header.add_child(this._batteryColumn);
        view.add_child(this._controlsHeader);

        // Volume
        this._volumeRow = new St.BoxLayout({style_class: 'dynada-volume dynada-chip', x_expand: true});
        this._muteButton = new St.Button({
            style_class: 'dynada-round-button',
            can_focus: true,
            accessible_name: _('Mute or unmute'),
            child: new St.Icon({style_class: 'dynada-volume-icon', icon_name: 'audio-volume-high-symbolic'}),
        });
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.accessible_name = _('Volume');
        this._volumeLabel = new St.Label({style_class: 'dynada-volume-label', y_align: Clutter.ActorAlign.CENTER});
        this._volumeRow.add_child(this._muteButton);
        this._volumeRow.add_child(this._slider);
        this._volumeRow.add_child(this._volumeLabel);
        view.add_child(this._volumeRow);

        // Panel indicators, including other extensions', are moved here.
        this._tray = new St.Widget({
            style_class: 'dynada-tray',
            x_expand: true,
            layout_manager: new ChipLayout(52, 40, 8),
        });
        view.add_child(this._tray);

        return view;
    }

    _buildMediaView() {
        const view = this._expandedView();

        const top = new St.BoxLayout({style_class: 'dynada-media-top', x_expand: true});
        this._artButton = new St.Button({
            style_class: 'dynada-art-button',
            can_focus: true,
            width: ART_SIZE,
            height: ART_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const artMask = new RoundedMask();
        artMask.setGeometry(ART_SIZE, ART_SIZE, 14);
        this._artButton.add_effect(artMask);
        this._art = new St.Icon({style_class: 'dynada-art', icon_size: ART_SIZE});
        this._artButton.set_child(this._art);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaTitle = new St.Label({style_class: 'dynada-media-title'});
        this._mediaArtist = new St.Label({style_class: 'dynada-media-artist'});
        this._mediaApp = new St.Label({style_class: 'dynada-media-app'});
        text.add_child(this._mediaTitle);
        text.add_child(this._mediaArtist);
        text.add_child(this._mediaApp);

        top.add_child(this._artButton);
        top.add_child(text);
        view.add_child(top);

        this._progressRow = new St.BoxLayout({style_class: 'dynada-progress-row', x_expand: true});
        this._elapsed = new St.Label({style_class: 'dynada-time-label', y_align: Clutter.ActorAlign.CENTER});
        this._progress = new BarLevel({style_class: 'dynada-progress', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._remaining = new St.Label({style_class: 'dynada-time-label', y_align: Clutter.ActorAlign.CENTER});
        this._progressRow.add_child(this._elapsed);
        this._progressRow.add_child(this._progress);
        this._progressRow.add_child(this._remaining);
        view.add_child(this._progressRow);

        this._transport = new St.BoxLayout({style_class: 'dynada-transport', x_align: Clutter.ActorAlign.CENTER});
        const button = (icon, name, big = false) => new St.Button({
            style_class: big ? 'dynada-round-button dynada-play' : 'dynada-round-button',
            can_focus: true,
            accessible_name: name,
            child: new St.Icon({icon_name: icon, style_class: big ? 'dynada-play-icon' : 'dynada-transport-icon'}),
        });
        this._prevButton = button('media-skip-backward-symbolic', _('Previous'));
        this._playButton = button('media-playback-start-symbolic', _('Play or pause'), true);
        this._nextButton = button('media-skip-forward-symbolic', _('Next'));
        this._transport.add_child(this._prevButton);
        this._transport.add_child(this._playButton);
        this._transport.add_child(this._nextButton);
        view.add_child(this._transport);

        return view;
    }

    _buildNotificationView() {
        const row = new St.BoxLayout({style_class: 'dynada-notification-row', x_expand: true});
        const button = new St.Button({
            style_class: 'dynada-notification',
            can_focus: true,
            accessible_name: _('Open notification'),
            width: CONTENT_WIDTH,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
            opacity: 0,
            visible: false,
            child: row,
        });

        const iconBin = new St.Bin({
            style_class: 'dynada-notification-icon-bin',
            width: NOTIFICATION_ICON,
            height: NOTIFICATION_ICON,
            y_align: Clutter.ActorAlign.START,
        });
        const iconMask = new RoundedMask();
        iconMask.setGeometry(NOTIFICATION_ICON, NOTIFICATION_ICON, 11);
        iconBin.add_effect(iconMask);
        this._notificationIcon = new St.Icon({icon_size: NOTIFICATION_ICON});
        iconBin.set_child(this._notificationIcon);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notificationApp = new St.Label({style_class: 'dynada-notification-app'});
        this._notificationTitle = new St.Label({style_class: 'dynada-notification-title'});
        this._notificationBody = new St.Label({style_class: 'dynada-notification-body'});
        this._notificationBody.clutter_text.line_wrap = true;
        text.add_child(this._notificationApp);
        text.add_child(this._notificationTitle);
        text.add_child(this._notificationBody);

        row.add_child(iconBin);
        row.add_child(text);
        return button;
    }

    _buildMediaBubble() {
        const bubble = new Glass({
            style_class: 'dynada-bubble',
            radius: PILL_HEIGHT / 2,
            reactive: true,
            track_hover: true,
            width: PILL_HEIGHT,
            height: PILL_HEIGHT,
        });
        this._bubbleIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 16});
        this._bubbleButton = new St.Button({
            style_class: 'dynada-bubble-button',
            can_focus: true,
            accessible_name: _('Now playing'),
            x_expand: true,
            y_expand: true,
            child: this._bubbleIcon,
        });
        bubble.add_child(this._bubbleButton);
        this._connect(this._bubbleButton, 'clicked', () => {
            if (this._mode === 'media')
                this._close();
            else
                this._open('media');
        });
        return bubble;
    }

    // ---------- Open / close ----------

    _viewFor(mode) {
        switch (mode) {
        case 'media':
            return this._mediaView;
        case 'notification':
            return this._notificationView;
        default:
            return this._controls;
        }
    }

    _freezeSize() {
        const [w, h] = this._island.get_size();
        this._island.set_size(w, h);
    }

    _open(mode) {
        if (this._mode === mode)
            return;
        const previous = this._mode;
        this._mode = mode;
        this._collapseTimeout = this._clearTimeout(this._collapseTimeout);
        if (previous === 'notification')
            this._finishNotification();

        const view = this._viewFor(mode);
        const outgoing = previous ? this._viewFor(previous) : this._compact;

        if (mode === 'media') {
            this._syncMedia();
            this._startPositionPolling();
        } else {
            this._positionTimeout = this._clearTimeout(this._positionTimeout);
        }

        this._freezeSize();
        this._island.add_style_pseudo_class('expanded');

        outgoing.ease({
            opacity: 0,
            scale_x: 0.94,
            scale_y: 0.94,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (outgoing !== this._currentView())
                    outgoing.hide();
            },
        });

        view.show();
        view.opacity = 0;
        view.set_scale(0.94, 0.94);
        const [, height] = view.get_preferred_height(CONTENT_WIDTH);

        spring(this._island, {
            width: EXPANDED_WIDTH,
            height: height + 2 * BORDER,
        }, {
            response: 0.5,
            damping: 0.76,
            onComplete: () => {
                // Natural size from here on, so the island follows content changes.
                if (this._mode === mode)
                    this._island.set_size(-1, -1);
            },
        });
        view.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            delay: 90,
            duration: 320,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _close() {
        if (!this._mode)
            return;
        const view = this._viewFor(this._mode);
        if (this._mode === 'notification')
            this._finishNotification();
        this._mode = null;
        this._collapseTimeout = this._clearTimeout(this._collapseTimeout);
        this._positionTimeout = this._clearTimeout(this._positionTimeout);

        this._freezeSize();
        this._compact.show();
        const [, width] = this._compact.get_preferred_width(-1);

        view.ease({
            opacity: 0,
            scale_x: 0.94,
            scale_y: 0.94,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        spring(this._island, {
            width: width + 2 * BORDER,
            height: PILL_HEIGHT,
        }, {
            response: 0.42,
            damping: 0.86,
            onComplete: () => {
                if (this._mode)
                    return;
                view.hide();
                this._island.remove_style_pseudo_class('expanded');
                this._island.set_size(-1, -1);
            },
        });
        this._compact.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            delay: 100,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _currentView() {
        return this._mode ? this._viewFor(this._mode) : this._compact;
    }

    _anyHover() {
        return [this._island, this._left, this._right].some(a => a.hover);
    }

    _anyMenuOpen() {
        return Object.values(Main.panel.statusArea).some(i => i?.menu?.isOpen);
    }

    _scheduleCollapse() {
        if (this._collapseTimeout)
            return;
        // Collapse once the pointer is outside and no menu is open.
        // While a menu is open keep waiting and check again when it closes.
        this._collapseTimeout = this._timeout(COLLAPSE_DELAY, () => {
            if (!this._mode) {
                this._collapseTimeout = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._anyHover() || this._anyMenuOpen())
                return GLib.SOURCE_CONTINUE;
            this._collapseTimeout = 0;
            this._close();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Notifications ----------

    // GNOME's own banners are switched off and every notification that would have
    // shown one appears in the island instead, with the same rules: Do Not Disturb,
    // per-app banner settings, low urgency and critical urgency all behave as before.
    _setupNotifications() {
        const tray = Main.messageTray;
        let proto = Object.getPrototypeOf(tray);
        let desc = null;
        while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'bannerBlocked')))
            proto = Object.getPrototypeOf(proto);
        this._bannerSetter = desc?.set;
        if (!this._bannerSetter)
            return;

        // The shell blocks banners itself while the notification list is open;
        // remember what it asks for and keep the real flag on.
        this._bannerRequested = tray._bannerBlocked ?? false;
        this._bannerSetter.call(tray, true);
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get: () => this._bannerRequested,
            set: value => {
                this._bannerRequested = value;
            },
        });

        this._sourceIds = new Map();
        tray.getSources().forEach(source => this._watchSource(source));
        this._connect(tray, 'source-added', (_tray, source) => this._watchSource(source));
        this._connect(tray, 'source-removed', (_tray, source) => this._unwatchSource(source));
    }

    _watchSource(source) {
        if (this._sourceIds.has(source))
            return;
        this._sourceIds.set(source, source.connect('notification-request-banner',
            (_source, notification) => this._onBannerRequest(notification)));
    }

    _unwatchSource(source) {
        const id = this._sourceIds.get(source);
        if (id)
            source.disconnect(id);
        this._sourceIds.delete(source);
    }

    _releaseNotifications() {
        if (!this._bannerSetter)
            return;
        for (const source of [...this._sourceIds.keys()])
            this._unwatchSource(source);
        const tray = Main.messageTray;
        delete tray.bannerBlocked;
        // Drop banners that queued up while we had them blocked, so they do not all
        // pop up at once when GNOME takes over again.
        if (Array.isArray(tray._notificationQueue) && tray._notificationQueue.length) {
            tray._notificationQueue.splice(0);
            tray.emit('queue-changed');
        }
        this._bannerSetter.call(tray, this._bannerRequested);
        this._bannerSetter = null;
    }

    _onBannerRequest(notification) {
        if (notification.acknowledged || notification.urgency === Urgency.LOW)
            return;
        const critical = notification.urgency === Urgency.CRITICAL;
        if (!notification.source.policy.showBanners && !critical)
            return;
        // Not while the notification list is open, while the island is hidden in
        // fullscreen, or while the person is using the island for something else.
        if (this._bannerRequested || (this._hidden && !critical))
            return;
        if (this._mode && this._mode !== 'notification')
            return;
        this._showNotification(notification);
    }

    _showNotification(notification) {
        if (this._notification && this._notification !== notification)
            this._finishNotification();
        this._notification = notification;
        this._notificationDestroyId = notification.connect('destroy', () => {
            this._notificationDestroyId = 0;
            if (this._notification === notification && this._mode === 'notification')
                this._close();
        });

        const plain = text => (text ?? '').replace(/<[^>]*>/g, '').trim();
        const gicon = notification.gicon ?? notification.source.icon ??
            new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
        // App icons fill the tile; single-colour symbolic icons sit smaller on it.
        const symbolic = gicon instanceof Gio.ThemedIcon &&
            gicon.get_names().some(n => n.endsWith('-symbolic'));
        this._notificationIcon.gicon = gicon;
        this._notificationIcon.icon_size = symbolic ? 24 : NOTIFICATION_ICON;
        this._notificationApp.text = plain(notification.source.title);
        this._notificationTitle.text = plain(notification.title);
        this._notificationBody.text = plain(notification.body);
        this._notificationBody.visible = !!this._notificationBody.text;
        notification.playSound?.();

        if (this._hidden)
            this._setHidden(false);
        this._open('notification');

        this._notificationTimeout = this._clearTimeout(this._notificationTimeout);
        if (notification.urgency !== Urgency.CRITICAL) {
            this._notificationTimeout = this._timeout(NOTIFICATION_DURATION, () => {
                this._notificationTimeout = 0;
                // If the pointer is on it, leaving will close it.
                if (this._mode === 'notification' && !this._anyHover())
                    this._close();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Called when the notification leaves the island, whatever the reason.
    _finishNotification() {
        this._notificationTimeout = this._clearTimeout(this._notificationTimeout);
        const notification = this._notification;
        this._notification = null;
        if (!notification)
            return;
        if (this._notificationDestroyId) {
            notification.disconnect(this._notificationDestroyId);
            this._notificationDestroyId = 0;
            // Seen it, like when a GNOME banner times out. It stays in the list.
            notification.acknowledged = true;
        }
    }

    _activateNotification() {
        const notification = this._notification;
        if (!notification)
            return;
        this._close();
        notification.activate();
    }

    // ---------- Fullscreen ----------

    _setupFullscreen() {
        this._connect(global.display, 'in-fullscreen-changed', () => this._syncFullscreen());
        this._syncFullscreen();
    }

    _syncFullscreen() {
        const fullscreen = !!Main.layoutManager.primaryMonitor?.inFullscreen;
        if (fullscreen && !this._pointerWatch) {
            this._pointerWatch = getPointerWatcher().addWatch(100, (x, y) => this._onPointerMove(x, y));
            this._setHidden(true);
        } else if (!fullscreen && this._pointerWatch) {
            this._pointerWatch.remove();
            this._pointerWatch = null;
            this._setHidden(false);
        }
    }

    // In fullscreen the island waits above the screen and slides in when the
    // pointer touches the top edge.
    _onPointerMove(x, y) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || x < monitor.x || x >= monitor.x + monitor.width)
            return;
        if (this._hidden) {
            if (y <= monitor.y + 1)
                this._setHidden(false);
        } else if (!this._mode && !this._anyMenuOpen() &&
                   y > monitor.y + TOP_MARGIN + this._island.height + REVEAL_SLACK) {
            this._setHidden(true);
        }
    }

    _setHidden(hidden) {
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        if (hidden)
            this._close();
        const offset = -(TOP_MARGIN + PILL_HEIGHT + 12);
        if (hidden) {
            this._strip.ease({
                translation_y: offset,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            });
        } else {
            spring(this._strip, {translation_y: 0}, {response: 0.45, damping: 0.72});
        }
    }

    // ---------- Clock ----------

    _setupClock() {
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._clock = new GnomeDesktop.WallClock();
        this._connect(this._clock, 'notify::clock', () => this._syncClock());
        this._connect(this._interfaceSettings, 'changed::clock-format', () => this._syncClock());
        this._syncClock();
    }

    _syncClock() {
        const now = GLib.DateTime.new_now_local();
        const is12h = this._interfaceSettings.get_string('clock-format') === '12h';
        const time = now.format(is12h ? '%-l:%M %p' : '%H:%M');
        this._compactTime.text = time;
        this._bigTime.text = time;
        this._compactDate.text = now.format('%a %-d %b');
        this._longDate.text = now.format('%A, %-d %B');
    }

    // ---------- Battery ----------

    _setupBattery() {
        this._compactBattery.hide();
        this._batteryColumn.hide();
        this._power = new DisplayDeviceProxy(
            Gio.DBus.system,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (error) {
                    console.error(`Dynamic Island: could not connect to UPower: ${error.message}`);
                    return;
                }
                if (!this._island)
                    return;
                this._connect(proxy, 'g-properties-changed', () => this._syncBattery());
                this._syncBattery();
            });
    }

    _syncBattery() {
        const p = this._power;
        if (!p || !this._island)
            return;

        const present = p.IsPresent && p.Type === UPower.DeviceKind.BATTERY;
        this._compactBattery.visible = present;
        this._batteryColumn.visible = present;
        if (!present)
            return;

        const pct = Math.round(p.Percentage);
        const charging = p.State === UPower.DeviceState.CHARGING;
        const full = p.State === UPower.DeviceState.FULLY_CHARGED ||
            (charging && pct === 100);
        const low = !charging && !full && pct <= 20;

        const level = Math.min(100, 10 * Math.floor(pct / 10));
        let suffix = '';
        if (full)
            suffix = '-charged';
        else if (charging)
            suffix = '-charging';
        this._compactBatteryIcon.icon_name = `battery-level-${full ? 100 : level}${suffix}-symbolic`;
        // Translators: battery percentage, e.g. "78%". Use %% for the percent sign.
        const pctText = fmt(_('%d%%'), pct);
        this._compactBatteryLabel.text = pctText;
        this._bigBattery.text = pctText;

        for (const actor of [this._compactBattery, this._bigBattery]) {
            actor.remove_style_class_name('dynada-low');
            actor.remove_style_class_name('dynada-charging');
            if (low)
                actor.add_style_class_name('dynada-low');
            else if (charging)
                actor.add_style_class_name('dynada-charging');
        }

        this._batteryState.text = this._batteryStateText(p, charging, full);
    }

    _batteryStateText(p, charging, full) {
        if (full)
            return _('Fully charged');
        if (charging) {
            return p.TimeToFull > 0
                ? fmt(_('Charging, full in %s'), this._formatDuration(p.TimeToFull))
                : _('Charging');
        }
        if (p.State === UPower.DeviceState.PENDING_CHARGE)
            return _('Plugged in, not charging');
        return p.TimeToEmpty > 0
            ? fmt(_('%s left'), this._formatDuration(p.TimeToEmpty))
            : _('On battery');
    }

    _formatDuration(seconds) {
        const minutes = Math.round(seconds / 60);
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h === 0)
            return fmt(_('%d min'), m);
        return m === 0 ? fmt(_('%d h'), h) : fmt(_('%d h %d min'), h, m);
    }

    // ---------- Volume ----------

    _setupVolume() {
        this._control = getMixerControl();
        this._connect(this._control, 'default-sink-changed', () => this._bindSink());
        this._connect(this._control, 'state-changed', () => this._bindSink());
        this._connect(this._slider, 'notify::value', () => this._onSliderChanged());
        this._connect(this._muteButton, 'clicked', () => {
            if (this._sink)
                this._sink.change_is_muted(!this._sink.is_muted);
        });
        this._bindSink();
    }

    _bindSink() {
        this._unbindSink();
        this._sink = this._control.get_default_sink();
        this._volumeRow.visible = !!this._sink;
        if (!this._sink)
            return;
        this._sinkIds = [
            this._sink.connect('notify::volume', () => this._syncVolume()),
            this._sink.connect('notify::is-muted', () => this._syncVolume()),
        ];
        this._syncVolume();
    }

    _unbindSink() {
        if (this._sink && this._sinkIds)
            this._sinkIds.forEach(id => this._sink.disconnect(id));
        this._sink = null;
        this._sinkIds = null;
    }

    _syncVolume() {
        const max = this._control.get_vol_max_norm();
        const value = this._sink.is_muted ? 0 : Math.min(1, this._sink.volume / max);

        this._syncingVolume = true;
        this._slider.value = value;
        this._syncingVolume = false;

        let icon = 'audio-volume-muted-symbolic';
        if (value > 0.66)
            icon = 'audio-volume-high-symbolic';
        else if (value > 0.33)
            icon = 'audio-volume-medium-symbolic';
        else if (value > 0)
            icon = 'audio-volume-low-symbolic';
        this._muteButton.child.icon_name = icon;
        this._volumeLabel.text = `${Math.round(value * 100)}`;
    }

    _onSliderChanged() {
        if (this._syncingVolume || !this._sink)
            return;
        const volume = this._slider.value * this._control.get_vol_max_norm();
        this._sink.volume = volume;
        if (volume < 1) {
            if (!this._sink.is_muted)
                this._sink.change_is_muted(true);
        } else if (this._sink.is_muted) {
            this._sink.change_is_muted(false);
        }
        this._sink.push_volume();
    }

    // ---------- Media ----------

    _setupMedia() {
        this._media = new MediaWatcher(() => this._syncMedia());
        const withPlayer = action => () => {
            const entry = this._media.current();
            if (entry)
                action(entry);
        };
        this._connect(this._playButton, 'clicked', withPlayer(e => this._media.playPause(e)));
        this._connect(this._nextButton, 'clicked', withPlayer(e => this._media.next(e)));
        this._connect(this._prevButton, 'clicked', withPlayer(e => this._media.previous(e)));
        this._connect(this._artButton, 'clicked', withPlayer(e => this._media.raise(e)));
        this._syncMedia();
    }

    _syncMedia() {
        if (!this._island)
            return;
        const entry = this._media.current();
        const info = entry ? this._media.info(entry) : null;
        this._mediaEntry = entry;
        this._mediaLength = info?.length ?? 0;

        const artIcon = info?.artUrl
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(info.artUrl)})
            : null;

        // Side bubble: cover art filling the circle, else the app icon, else a note.
        if (artIcon) {
            this._bubbleIcon.gicon = artIcon;
            this._bubbleIcon.icon_size = PILL_HEIGHT - 2 * BORDER;
        } else if (info?.app) {
            this._bubbleIcon.gicon = info.app.get_icon();
            this._bubbleIcon.icon_size = 20;
        } else {
            this._bubbleIcon.gicon = null;
            this._bubbleIcon.icon_name = 'audio-x-generic-symbolic';
            this._bubbleIcon.icon_size = 16;
        }
        if (info?.playing)
            this._right.add_style_pseudo_class('playing');
        else
            this._right.remove_style_pseudo_class('playing');

        // Media view: cover art fills the square; otherwise a smaller icon on a tile.
        if (artIcon)
            this._art.gicon = artIcon;
        else if (info?.app)
            this._art.gicon = info.app.get_icon();
        else
            this._art.gicon = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        this._art.icon_size = artIcon ? ART_SIZE : 36;
        if (artIcon)
            this._artButton.remove_style_class_name('dynada-art-empty');
        else
            this._artButton.add_style_class_name('dynada-art-empty');

        this._mediaTitle.text = info ? info.title || info.appName : _('Nothing is playing');
        this._mediaArtist.text = info?.artist ?? '';
        this._mediaArtist.visible = !!info?.artist;
        this._mediaApp.text = info && info.title ? info.appName : '';
        this._mediaApp.visible = !!this._mediaApp.text;

        this._transport.visible = !!info;
        this._prevButton.reactive = !!info?.canPrevious;
        this._nextButton.reactive = !!info?.canNext;
        this._prevButton.opacity = info?.canPrevious ? 255 : 90;
        this._nextButton.opacity = info?.canNext ? 255 : 90;
        this._playButton.child.icon_name = info?.playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        this._progressRow.visible = this._mediaLength > 0;
        this._syncPosition();
    }

    _startPositionPolling() {
        if (this._positionTimeout)
            return;
        this._positionTimeout = this._timeout(1000, () => {
            this._syncPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncPosition() {
        const entry = this._mediaEntry;
        if (!entry || this._mediaLength <= 0 || this._mode !== 'media')
            return;
        this._media.position(entry, position => {
            if (!this._island || entry !== this._mediaEntry)
                return;
            if (position < 0) {
                this._progressRow.hide();
                return;
            }
            this._progress.value = Math.min(1, position / this._mediaLength);
            this._elapsed.text = formatTime(position);
            this._remaining.text = `-${formatTime(this._mediaLength - position)}`;
        });
    }

    // ---------- Panel indicators ----------

    _panelBoxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    }

    _adoptPanel() {
        Main.panel.hide();
        // Other extensions (e.g. Blur my Shell) put their own actors in the panel box.
        // Collapse it to zero height and clip it, so nothing is left on screen and no
        // space is reserved at the top.
        const panelBox = Main.layoutManager.panelBox;
        this._panelBoxClip = panelBox.clip_to_allocation;
        panelBox.clip_to_allocation = true;
        panelBox.height = 0;
        // The layout manager resets the panel box size when monitors change.
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            panelBox.height = 0;
        });
        // If another extension shows the panel again, hide it again.
        this._connect(Main.panel, 'notify::visible', () => {
            if (Main.panel.visible && !this._panelIdle) {
                this._panelIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._timeouts.delete(this._panelIdle);
                    this._panelIdle = 0;
                    Main.panel.hide();
                    return GLib.SOURCE_REMOVE;
                });
                this._timeouts.add(this._panelIdle);
            }
        });

        for (const box of this._panelBoxes()) {
            box.get_children().forEach((child, i) => this._adopt(child, box, i));
            // Extensions enabled after us land in the island too.
            this._connect(box, 'child-added', () => this._queueAdopt());
        }
    }

    _queueAdopt() {
        if (this._adoptIdle)
            return;
        this._adoptIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._timeouts.delete(this._adoptIdle);
            this._adoptIdle = 0;
            for (const box of this._panelBoxes()) {
                for (const child of box.get_children())
                    this._adopt(child, box, box.get_children().indexOf(child));
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(this._adoptIdle);
    }

    // index: position in the panel box, used to put it back in order on disable.
    _adopt(container, box, index) {
        // Adding an actor to a new parent shows it; keep hidden indicators hidden.
        const visible = container.visible;
        box.remove_child(container);

        // The calendar and notifications button becomes the left bubble;
        // everything else goes into the island's grid.
        const isDateMenu = container === Main.panel.statusArea.dateMenu?.container;

        // Naming the slot "panel" keeps the theme's #panel .panel-button styles.
        const slot = new St.Bin({
            name: 'panel',
            style_class: isDateMenu ? 'dynada-bubble-slot' : 'dynada-slot',
            // Inline style beats the theme's #panel background.
            style: isDateMenu
                ? 'background-color: transparent; box-shadow: none; border: none;'
                : 'background-color: rgba(255, 255, 255, 0.07); border-radius: 14px; box-shadow: none; border: none;',
            x_expand: isDateMenu,
            y_expand: isDateMenu,
            child: container,
        });
        container.visible = visible;
        const record = {container, box, index, slot};
        this._slots.push(record);
        (isDateMenu ? this._left : this._tray).add_child(slot);

        if (isDateMenu)
            this._shrinkDateMenu(record);

        // Its menu, and any menu it swaps in later, gets the glass look.
        const indicator = Object.values(Main.panel.statusArea).find(i => i?.container === container);
        if (indicator) {
            if (indicator.menu)
                this._glassMenus.add(indicator.menu);
            record.indicator = indicator;
            record.menuSetId = indicator.connect('menu-set', () => {
                if (indicator.menu)
                    this._glassMenus?.add(indicator.menu);
            });
            record.indicatorDestroyId = indicator.connect('destroy', () => {
                record.indicator = null;
            });
        }

        // Drop the empty slot if the indicator is moved elsewhere or destroyed.
        record.removedId = slot.connect('child-removed', () => {
            if (this._releasing)
                return;
            this._slots = this._slots.filter(r => r !== record);
            slot.destroy();
        });
    }

    // The island already shows the time, so the calendar button shows a bell instead.
    _shrinkDateMenu(record) {
        const clock = Main.panel.statusArea.dateMenu._clockDisplay;
        if (!clock)
            return;
        const icon = new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            style_class: 'system-status-icon',
        });
        clock.get_parent().insert_child_above(icon, clock);
        clock.hide();
        record.restore = () => {
            icon.destroy();
            clock.show();
        };
    }

    _releasePanel() {
        this._releasing = true;
        for (const r of this._slots) {
            r.slot.disconnect(r.removedId);
            if (r.indicator) {
                r.indicator.disconnect(r.menuSetId);
                r.indicator.disconnect(r.indicatorDestroyId);
            }
            r.restore?.();
            const visible = r.container.visible;
            r.slot.set_child(null);
            const index = Math.min(r.index, r.box.get_n_children());
            r.box.insert_child_at_index(r.container, index);
            r.container.visible = visible;
        }
        this._slots = [];
        this._releasing = false;
        const panelBox = Main.layoutManager.panelBox;
        panelBox.height = -1;
        panelBox.clip_to_allocation = this._panelBoxClip;
        Main.panel.show();
    }
}
