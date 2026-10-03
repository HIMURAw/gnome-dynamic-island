import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getPointerWatcher} from 'resource:///org/gnome/shell/ui/pointerWatcher.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {Activities, ActivitiesCard} from './activities.js';
import {AppsCard} from './apps.js';
import {ChargeIndicator} from './charge.js';
import {Glass, RoundedMask, setBlurEnabled} from './glass.js';
import {NotificationCenter, bellIcon} from './center.js';
import {TileGridLayout, TopCenterLayout} from './layouts.js';
import {MediaWatcher} from './media.js';
import {Palette} from './palette.js';
import {GlassMenus} from './menus.js';
import {QuickSettingsAdopter} from './quicksettings.js';
import {spring, stopAllSprings, stopSpring} from './spring.js';

const TOP_MARGIN = 6;
const PILL_HEIGHT = 38;
const BORDER = 1;
const BUBBLE_GAP = 8;
const EXPANDED_RADIUS = 34;
// How long to wait after the pointer leaves before collapsing (ms).
const COLLAPSE_DELAY = 700;
// In fullscreen, hide again once the pointer is this far below the island (px).
const REVEAL_SLACK = 60;
const ART_SIZE = 72;
// Height of a toggle tile in the control center.
const TILE_HEIGHT = 58;
// How far pages slide when moving to and from a toggle's menu (px).
const PAGE_SLIDE = 48;
const NOTIFICATION_ICON = 44;
// How long a notification stays in the island (ms). Critical ones stay until dismissed.
const NOTIFICATION_DURATION = 5000;
// Panel indicators that are not moved into the island: GNOME's calendar menu is
// replaced by the island's own notification center, and media controls would
// only repeat the right bubble.
const SKIPPED_ROLES = ['dateMenu', 'media-controls'];
// Auto-hide: how long the pointer rests on the top edge before the island comes
// back (ms), and how far outside the island it may go before it hides again (px).
const REVEAL_DELAY = 180;
// Desktop Icons NG (and forks) let other extensions reserve room on the desktop
// through an object tagged with this id, the same way Dash to Dock does.
const DESKTOP_ICONS_ID = '130cbc66-235c-4bd6-8571-98d2d8bba5e2';

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
        this._settings = this.getSettings();
        this._activities = new Activities({onChanged: () => this._syncActivities()});
        // Any change rebuilds the island: disable() puts everything back, so
        // building again with the new settings is the simplest safe way.
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            // Remembered values that change nothing on screen.
            if (key === 'charge-limit' || this._rebuildId)
                return;
            this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._rebuildId = 0;
                this._teardown();
                this._start();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._start();
    }

    // If even the core cannot be built, undo what was done and leave GNOME's
    // own top bar in place rather than half an island.
    _start() {
        try {
            this._build();
        } catch (e) {
            console.error('Dynamic Island: could not start, keeping the normal top bar', e);
            this._teardown();
        }
    }

    disable() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        this._settings.disconnect(this._settingsId);
        this._teardown();
        this._activities.destroy();
        this._activities = null;
        this._settings = null;
    }

    // Also used after a failed start, so everything here copes with parts
    // that were never set up.

    // Each part is set up on its own: GNOME's internals change between
    // versions, and one part failing should not take the island down with it.
    _safely(what, fn) {
        try {
            fn();
        } catch (e) {
            console.error(`Dynamic Island: ${what} failed, carrying on without it`, e);
        }
    }

    _build() {
        this._signals = [];
        this._slots = [];
        this._timeouts = new Set();
        this._mode = null;
        this._hidden = false;
        this._expandedWidth = this._settings.get_int('expanded-width');
        this._contentWidth = this._expandedWidth - 2 * BORDER;
        setBlurEnabled(this._settings.get_boolean('blur'));

        this._buildUi();
        this._setupClock();
        this._safely('battery', () => this._setupBattery());
        this._safely('volume', () => this._setupVolume());
        this._safely('media', () => this._setupMedia());
        this._glassMenus = new GlassMenus();
        this._safely('charge limit', () => (this._charge = new ChargeIndicator(this._settings)));
        this._safely('quick settings', () => this._adoptQuickSettings());
        this._safely('panel icons', () => this._adoptPanel());
        this._safely('calendar menu', () => this._takeOverDateMenu());
        this._safely('notifications', () => this._setupNotifications());
        this._safely('auto-hide', () => this._setupAutoHide());
        this._safely('desktop icons', () => this._setupDesktopIcons());
        this._safely('palette shortcut', () => this._setupPaletteShortcut());
        this._syncModules();
        this._syncActivities();
    }

    _teardown() {
        stopAllSprings();
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._collapseTimeout = this._adoptIdle = this._panelIdle = this._positionTimeout = 0;
        this._notificationTimeout = this._revealTimeout = this._overlapIdle = 0;
        this._centerIdle = 0;

        this._safely('releasing palette', () => this._releasePalette());
        this._safely('releasing desktop icons', () => this._releaseDesktopIcons());
        this._safely('releasing auto-hide', () => this._releaseAutoHide());
        this._safely('releasing calendar menu', () => this._releaseDateMenu());
        this._safely('releasing notifications', () => this._releaseNotifications());
        this._safely('releasing quick settings', () => this._releaseQuickSettings());
        this._safely('releasing charge limit', () => this._charge?.destroy());
        this._charge = null;

        this._pointerWatch?.remove();
        this._pointerWatch = null;

        for (const [obj, id] of this._signals ?? [])
            obj.disconnect(id);
        this._signals = [];
        this._unbindSink();

        this._media?.destroy();
        this._media = null;
        this._apps?.destroy();
        this._apps = null;
        this._center?.destroy();
        this._center = null;
        this._palette?.destroy();
        this._palette = null;
        this._activitiesCard = null;

        this._glassMenus?.destroy();
        this._glassMenus = null;
        this._safely('releasing panel icons', () => this._releasePanel());

        if (this._strip) {
            Main.layoutManager.removeChrome(this._strip);
            this._strip.destroy();
        }
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
        this._stripGone = false;
        this._strip.connect('destroy', () => (this._stripGone = true));
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
        this._detail = this._buildDetail();
        this._mediaView = this._buildMediaView();
        this._notificationView = this._buildNotificationView();
        this._center = new NotificationCenter({
            width: this._contentWidth,
            dir: this.dir,
            onActivated: () => this._close(),
        });
        this._palette = new Palette({
            settings: this._settings,
            activities: this._activities,
            width: this._contentWidth,
            onClose: () => this._close(),
        });
        for (const view of [this._compact, this._controls, this._detail, this._mediaView, this._notificationView, this._center.actor, this._palette.actor])
            this._island.add_child(view);

        this._left = this._buildCenterBubble();
        this._right = this._buildMediaBubble();

        this._left.visible = this._settings.get_boolean('show-notification-bubble');
        this._right.visible = this._settings.get_boolean('show-media-bubble');
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

    // The monitor chosen in the settings, or the primary one.
    _monitorIndex() {
        const index = this._settings.get_int('monitor');
        return Main.layoutManager.monitors[index] ? index : Main.layoutManager.primaryIndex;
    }

    _monitor() {
        return Main.layoutManager.monitors[this._monitorIndex()] ?? Main.layoutManager.primaryMonitor;
    }

    _syncStripGeometry() {
        const monitor = this._monitor();
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

        this._compactActivity = new St.BoxLayout({
            style_class: 'dynada-compact-activity',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._compactActivityIcon = new St.Icon({style_class: 'dynada-compact-activity-icon'});
        this._compactActivityLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._compactActivity.add_child(this._compactActivityIcon);
        this._compactActivity.add_child(this._compactActivityLabel);

        box.add_child(this._compactActivity);
        box.add_child(this._compactTime);
        box.add_child(this._compactDate);
        box.add_child(this._compactBattery);
        return button;
    }

    _expandedView() {
        return new St.BoxLayout({
            style_class: 'dynada-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            width: this._contentWidth,
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

        this._activitiesCard = new ActivitiesCard(this._activities);
        view.add_child(this._activitiesCard.actor);

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

        // Control center: GNOME's quick settings, sorted into modules (see
        // _adoptQuickSettings). Connectivity and what is playing share the top row.
        this._ccTop = new St.BoxLayout({style_class: 'dynada-cc-top', x_expand: true});
        this._ccTop.layout_manager.homogeneous = true;
        this._ccConnect = new St.BoxLayout({
            style_class: 'dynada-card dynada-cc-connect',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        this._ccTop.add_child(this._ccConnect);
        this._apps = new AppsCard({onActivated: () => this._close()});
        this._ccTop.add_child(this._apps.actor);
        view.add_child(this._ccTop);

        this._ccSliders = new St.BoxLayout({
            style_class: 'dynada-cc-sliders',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        view.add_child(this._ccSliders);

        this._ccTiles = new St.Widget({
            style_class: 'dynada-cc-tiles',
            x_expand: true,
            layout_manager: new TileGridLayout(2, TILE_HEIGHT, 10),
            visible: false,
        });
        view.add_child(this._ccTiles);

        // Panel indicators, including other extensions', are moved here.
        this._tray = new St.Widget({
            style_class: 'dynada-tray',
            x_expand: true,
            layout_manager: new TileGridLayout(6, 44, 8),
            visible: false,
        });
        view.add_child(this._tray);

        // GNOME's background apps list is left out; it only holds its place so it
        // goes back to GNOME on disable.
        this._ccExtra = new St.BoxLayout({
            style_class: 'dynada-cc-extra',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        view.add_child(this._ccExtra);

        this._ccSystem = new St.BoxLayout({style_class: 'dynada-cc-system', x_expand: true, visible: false});
        view.add_child(this._ccSystem);

        return view;
    }

    // A toggle's menu (Wi-Fi networks, power options) gets a page of its own,
    // with a way back to the control center.
    _buildDetail() {
        const view = this._expandedView();
        view.add_style_class_name('dynada-detail');
        const content = new St.BoxLayout({style_class: 'dynada-back-content'});
        content.add_child(new St.Icon({icon_name: 'go-previous-symbolic', style_class: 'dynada-back-icon'}));
        content.add_child(new St.Label({text: _('Back'), y_align: Clutter.ActorAlign.CENTER}));
        this._backButton = new St.Button({
            style_class: 'dynada-back',
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            child: content,
        });
        view.add_child(this._backButton);
        this._detailBox = new St.BoxLayout({
            style_class: 'dynada-detail-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        view.add_child(this._detailBox);

        this._connect(this._backButton, 'clicked', () => this._qsAdopter?.closeMenu());
        // A menu left open would pop up again next time.
        this._connect(view, 'hide', () => this._qsAdopter?.closeMenu(PopupAnimation.NONE));
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
            width: this._contentWidth,
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

    _bubble() {
        return new Glass({
            style_class: 'dynada-bubble',
            radius: PILL_HEIGHT / 2,
            reactive: true,
            track_hover: true,
            width: PILL_HEIGHT,
            height: PILL_HEIGHT,
        });
    }

    // Left bubble: a bell that opens the notification center, with a dot for
    // notifications not seen yet.
    _buildCenterBubble() {
        const bubble = this._bubble();
        // Placed by hand: BinLayout centres its children whatever their alignment.
        const size = PILL_HEIGHT - 2 * BORDER;
        const content = new St.Widget({width: size, height: size});
        this._bellIcon = new St.Icon({gicon: bellIcon(this.dir), icon_size: 16});
        this._bellIcon.set_position((size - 16) / 2, (size - 16) / 2);
        this._badge = new St.Widget({style_class: 'dynada-badge', visible: false});
        this._badge.set_position(size - 7 - 10, 9);
        content.add_child(this._bellIcon);
        content.add_child(this._badge);
        const button = new St.Button({
            style_class: 'dynada-bubble-button',
            can_focus: true,
            accessible_name: _('Notifications'),
            x_expand: true,
            y_expand: true,
            child: content,
        });
        bubble.add_child(button);
        this._connect(button, 'clicked', () => this._toggleCenter());
        this._center.onDndChanged = () => this._syncBell();
        return bubble;
    }

    _toggleCenter() {
        if (this._mode === 'center')
            this._close();
        else
            this._open('center');
    }

    _syncBell() {
        if (!this._bellIcon)
            return;
        const dnd = this._center.dndActive;
        this._bellIcon.gicon = bellIcon(this.dir, dnd);
        this._badge.visible = !dnd && NotificationCenter.notifications().some(n => !n.acknowledged);
    }

    _buildMediaBubble() {
        const bubble = this._bubble();
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
        case 'detail':
            return this._detail;
        case 'media':
            return this._mediaView;
        case 'notification':
            return this._notificationView;
        case 'center':
            return this._center.actor;
        case 'palette':
            return this._palette.actor;
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
        if (previous === 'palette')
            this._releaseKeyboard();
        if (mode === 'controls')
            this._activitiesCard?.sync();
        if (previous === 'notification')
            this._finishNotification();

        const view = this._viewFor(mode);
        const outgoing = previous ? this._viewFor(previous) : this._compact;
        // A view still fading out from an earlier close would keep its height.
        for (const other of [this._controls, this._detail, this._mediaView, this._notificationView,
            this._center.actor, this._palette.actor]) {
            if (other !== view && other !== outgoing)
                other.hide();
        }

        if (mode === 'media') {
            this._syncMedia();
            this._startPositionPolling();
        } else {
            this._positionTimeout = this._clearTimeout(this._positionTimeout);
        }
        if (mode === 'center') {
            this._center.refresh();
            this._center.acknowledgeAll();
            this._syncBell();
        }

        this._freezeSize();
        this._island.add_style_pseudo_class('expanded');

        // Into a toggle's menu the pages slide sideways, like going one level
        // deeper; everything else zooms in place.
        const nav = mode === 'detail' ? 1 : previous === 'detail' ? -1 : 0;
        const scale = nav ? 1 : 0.94;
        outgoing.ease({
            opacity: 0,
            scale_x: scale,
            scale_y: scale,
            translation_x: -nav * PAGE_SLIDE,
            duration: nav ? 200 : 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                outgoing.translation_x = 0;
                if (outgoing !== this._currentView())
                    outgoing.hide();
            },
        });

        view.show();
        view.opacity = 0;
        view.set_scale(scale, scale);
        view.translation_x = nav * PAGE_SLIDE;
        const [, height] = view.get_preferred_height(this._contentWidth);

        spring(this._island, {
            width: this._expandedWidth,
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
            translation_x: 0,
            delay: nav ? 60 : 90,
            duration: nav ? 340 : 320,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        // The control center's modules drift up one after another.
        if (mode === 'controls' && !nav) {
            this._controls.get_children().filter(c => c.visible).forEach((child, i) => {
                child.opacity = 0;
                child.translation_y = 14;
                child.ease({
                    opacity: 255,
                    translation_y: 0,
                    delay: 80 + i * 45,
                    duration: 420,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            });
        }
    }

    _close() {
        if (!this._mode)
            return;
        const view = this._viewFor(this._mode);
        if (this._mode === 'notification')
            this._finishNotification();
        if (this._mode === 'palette')
            this._releaseKeyboard();
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
                this._maybeHide();
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
        return !!this._qsAdopter?.openMenu || Object.values(Main.panel.statusArea).some(i => i?.menu?.isOpen);
    }

    _scheduleCollapse() {
        // The palette stays until Escape or a click elsewhere.
        if (this._collapseTimeout || this._mode === 'palette')
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

    // ---------- Command palette ----------

    _setupPaletteShortcut() {
        Main.wm.addKeybinding('palette-shortcut', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._togglePalette());
        this._paletteBound = true;
    }

    _releasePalette() {
        this._releaseKeyboard();
        if (this._paletteBound)
            Main.wm.removeKeybinding('palette-shortcut');
        this._paletteBound = false;
    }

    _togglePalette() {
        if (this._mode === 'palette') {
            this._close();
            return;
        }
        if (Main.overview.visible)
            Main.overview.hide();
        if (this._hidden)
            this._setHidden(false);
        this._palette.reset();
        this._open('palette');
        this._grabKeyboard();
        this._palette.focus();
    }

    // While the palette is open, keys go to it, and a click anywhere else closes it.
    _grabKeyboard() {
        if (this._grab)
            return;
        this._grab = Main.pushModal(this._island, {actionMode: Shell.ActionMode.POPUP});
        this._stageEventId = global.stage.connect('captured-event', (_stage, event) => {
            const type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            const source = global.stage.get_event_actor(event);
            if (source && this._island.contains(source))
                return Clutter.EVENT_PROPAGATE;
            this._close();
            return Clutter.EVENT_STOP;
        });
    }

    _releaseKeyboard() {
        if (this._stageEventId)
            global.stage.disconnect(this._stageEventId);
        this._stageEventId = 0;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
    }

    // ---------- Live activities ----------

    // The first activity shows in the collapsed island; all of them on the
    // control center's card.
    _syncActivities() {
        // Also called by the activities' clock, which outlives a torn-down island.
        if (!this._compactActivity || this._stripGone)
            return;
        const [first] = this._activities.items;
        this._compactActivity.visible = !!first;
        if (first) {
            this._compactActivityIcon.icon_name = first.icon;
            this._compactActivityLabel.text = Activities.short(first);
            if (first.timer)
                this._compactActivity.add_style_class_name('dynada-timer');
            else
                this._compactActivity.remove_style_class_name('dynada-timer');
        }
        if (this._mode === 'controls')
            this._activitiesCard?.sync();
    }

    // ---------- Notifications ----------

    // GNOME's own banners are switched off and every notification that would have
    // shown one appears in the island instead, with the same rules: Do Not Disturb,
    // per-app banner settings, low urgency and critical urgency all behave as before.
    _setupNotifications() {
        const tray = Main.messageTray;
        this._sourceIds = new Map();
        tray.getSources().forEach(source => this._watchSource(source));
        this._connect(tray, 'source-added', (_tray, source) => this._watchSource(source));
        this._connect(tray, 'source-removed', (_tray, source) => {
            this._unwatchSource(source);
            this._queueCenterSync();
        });
        this._syncBell();

        if (this._settings.get_boolean('notifications'))
            this._takeOverBanners();
    }

    _takeOverBanners() {
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
    }

    _watchSource(source) {
        if (this._sourceIds.has(source))
            return;
        this._sourceIds.set(source, [
            source.connect('notification-request-banner',
                (_source, notification) => this._onBannerRequest(notification)),
            // Emitted when a notification is added, removed or seen.
            source.connect('notify::count', () => this._queueCenterSync()),
        ]);
        this._queueCenterSync();
    }

    _unwatchSource(source) {
        this._sourceIds.get(source)?.forEach(id => source.disconnect(id));
        this._sourceIds.delete(source);
    }

    // Several notifications often change at once (Clear, an app closing), so the
    // cards and the bell are updated once afterwards.
    _queueCenterSync() {
        if (this._centerIdle || !this._center)
            return;
        this._centerIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._timeouts.delete(this._centerIdle);
            this._centerIdle = 0;
            if (this._mode === 'center') {
                this._center.refresh();
                this._center.acknowledgeAll();
            }
            this._syncBell();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(this._centerIdle);
    }

    // GNOME's calendar menu stays in the hidden panel. Anything that opens it
    // (Super+V, other extensions) opens the island's notification center instead.
    _takeOverDateMenu() {
        const menu = Main.panel.statusArea.dateMenu?.menu;
        if (!menu)
            return;
        this._dateMenu = menu;
        menu.open = () => {
            if (this._hidden)
                this._setHidden(false);
            this._open('center');
        };
        menu.toggle = () => this._toggleCenter();
    }

    _releaseDateMenu() {
        if (!this._dateMenu)
            return;
        delete this._dateMenu.open;
        delete this._dateMenu.toggle;
        this._dateMenu = null;
    }

    _releaseNotifications() {
        for (const source of [...(this._sourceIds?.keys() ?? [])])
            this._unwatchSource(source);
        if (!this._bannerSetter)
            return;
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
        // GNOME shows its own banners.
        if (!this._bannerSetter)
            return;
        if (notification.acknowledged || notification.urgency === Urgency.LOW)
            return;
        const critical = notification.urgency === Urgency.CRITICAL;
        if (!notification.source.policy.showBanners && !critical)
            return;
        // Not while the island is hidden in fullscreen, or while the person is
        // using the island for something else.
        if (this._bannerRequested || (this._hidden && this._fullscreen && !critical))
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

    // ---------- Auto-hide ----------

    // The island slides up out of the way when it would cover something: a
    // fullscreen window, or any window reaching up under it. Resting the pointer
    // on the top edge brings it back; moving away hides it again.
    _setupAutoHide() {
        this._autoHide = false;
        this._fullscreen = false;
        this._windowIds = new Map();
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);

        const queue = () => this._queueOverlapCheck();
        this._connect(global.display, 'window-created', (_d, window) => {
            this._watchWindow(window);
            queue();
        });
        this._connect(global.display, 'restacked', queue);
        this._connect(global.display, 'in-fullscreen-changed', queue);
        this._connect(global.workspace_manager, 'active-workspace-changed', queue);
        this._connect(Main.overview, 'showing', queue);
        this._connect(Main.overview, 'hidden', queue);
        this._checkOverlap();
    }

    _releaseAutoHide() {
        for (const [window, ids] of this._windowIds)
            ids.forEach(id => window.disconnect(id));
        this._windowIds.clear();
        this._pointerWatch?.remove();
        this._pointerWatch = null;
    }

    _watchWindow(window) {
        if (!window || this._windowIds.has(window))
            return;
        const queue = () => this._queueOverlapCheck();
        const ids = ['position-changed', 'size-changed', 'notify::minimized', 'workspace-changed']
            .map(signal => window.connect(signal, queue));
        ids.push(window.connect('unmanaged', () => {
            this._windowIds.get(window)?.forEach(id => window.disconnect(id));
            this._windowIds.delete(window);
            queue();
        }));
        this._windowIds.set(window, ids);
    }

    // Window moves come in bursts while dragging; check once per burst.
    _queueOverlapCheck() {
        if (this._overlapIdle)
            return;
        this._overlapIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._timeouts.delete(this._overlapIdle);
            this._overlapIdle = 0;
            this._checkOverlap();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(this._overlapIdle);
    }

    // Where the collapsed island and its bubbles sit, in screen coordinates.
    _restingRect() {
        const monitor = this._monitor();
        const [, compact] = this._compact.get_preferred_width(-1);
        const bubbles = [this._left, this._right].filter(b => b.visible).length;
        const width = compact + 2 * BORDER + bubbles * (BUBBLE_GAP + PILL_HEIGHT);
        const x = monitor.x + Math.round((monitor.width - width) / 2);
        return {x, y: monitor.y, width, height: TOP_MARGIN + PILL_HEIGHT + 4};
    }

    _checkOverlap() {
        const monitor = this._monitor();
        if (!monitor || !this._island)
            return;
        const mode = this._settings.get_string('auto-hide');
        if (mode === 'never') {
            this._setAutoHide(false, false);
            return;
        }
        const fullscreen = !!monitor.inFullscreen;
        let covered = false;
        if (mode === 'smart' && !Main.overview.visible && !fullscreen) {
            const rect = this._restingRect();
            const workspace = global.workspace_manager.get_active_workspace();
            const types = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
                Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];
            covered = global.get_window_actors().some(actor => {
                const w = actor.meta_window;
                if (!w || w.minimized || !types.includes(w.get_window_type()) ||
                    w.is_skip_taskbar() || !w.located_on_workspace(workspace) ||
                    !w.showing_on_its_workspace())
                    return false;
                const f = w.get_frame_rect();
                return f.x < rect.x + rect.width && f.x + f.width > rect.x &&
                    f.y < rect.y + rect.height && f.y + f.height > rect.y;
            });
        }
        this._setAutoHide(fullscreen || covered, fullscreen);
    }

    _setAutoHide(on, fullscreen) {
        const wasFullscreen = this._fullscreen;
        this._fullscreen = fullscreen;
        if (on && !this._pointerWatch)
            this._pointerWatch = getPointerWatcher().addWatch(100, (x, y) => this._onPointerMove(x, y));
        else if (!on && this._pointerWatch) {
            this._pointerWatch.remove();
            this._pointerWatch = null;
        }
        const changed = this._autoHide !== on;
        this._autoHide = on;
        if (!on) {
            this._revealTimeout = this._clearTimeout(this._revealTimeout);
            this._setHidden(false);
        } else if (fullscreen && !wasFullscreen) {
            // Fullscreen (a video, a game) takes the island away straight away.
            this._setHidden(true);
        } else if (changed) {
            this._maybeHide();
        }
    }

    _pointerNear(x, y) {
        const rect = this._restingRect();
        const [, islandHeight] = this._island.get_size();
        const slack = REVEAL_SLACK / 2;
        return x >= rect.x - slack && x <= rect.x + rect.width + slack &&
            y <= rect.y + TOP_MARGIN + Math.max(islandHeight, PILL_HEIGHT) + slack;
    }

    // Hide unless the island is in use: open, a menu from it is open, or the
    // pointer is on or near it.
    _maybeHide() {
        if (!this._autoHide || this._hidden || this._mode || this._anyMenuOpen())
            return;
        const [x, y] = global.get_pointer();
        if (!this._pointerNear(x, y))
            this._setHidden(true);
    }

    _onPointerMove(x, y) {
        const monitor = this._monitor();
        if (!monitor || x < monitor.x || x >= monitor.x + monitor.width)
            return;
        if (!this._hidden) {
            this._maybeHide();
            return;
        }
        // Only a rest on the top edge reveals it, so flicking the pointer up to a
        // browser tab does not bring the island down over it.
        if (y > monitor.y + 1) {
            this._revealTimeout = this._clearTimeout(this._revealTimeout);
            return;
        }
        if (this._revealTimeout)
            return;
        this._revealTimeout = this._timeout(REVEAL_DELAY, () => {
            this._revealTimeout = 0;
            const [, py] = global.get_pointer();
            if (this._hidden && py <= monitor.y + 1)
                this._setHidden(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setHidden(hidden) {
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        if (hidden)
            this._close();
        const offset = -(TOP_MARGIN + PILL_HEIGHT + 12);
        // The showing spring may still be running when the island has to go
        // again (the pointer leaves right after revealing it); stop it, or it
        // pulls the island back down.
        stopSpring(this._strip);
        if (hidden) {
            this._strip.ease({
                translation_y: offset,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                // Out of sight it is not drawn at all: the glass costs nothing.
                onComplete: () => {
                    if (this._hidden)
                        this._strip.hide();
                },
            });
        } else {
            this._strip.show();
            spring(this._strip, {translation_y: 0}, {response: 0.45, damping: 0.72});
        }
    }

    // ---------- Desktop icons ----------

    // Windows may pass under the island, but desktop icons should not hide
    // behind it: ask the desktop icons extension to keep the top row free.
    _setupDesktopIcons() {
        this._desktopAreas = new Set();
        this._syncDesktopIcons();
        this._connect(Main.extensionManager, 'extension-state-changed', () => this._syncDesktopIcons());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._syncDesktopIcons(true));
    }

    _syncDesktopIcons(force = false) {
        const top = TOP_MARGIN + PILL_HEIGHT + 4;
        for (const uuid of Main.extensionManager.getUuids()) {
            const area = Main.extensionManager.lookup(uuid)?.stateObj?.DesktopIconsUsableArea;
            if (area?._extensionUUID !== DESKTOP_ICONS_ID || (this._desktopAreas.has(area) && !force))
                continue;
            // Keyed by monitor index. Some versions also accept -1 for the
            // primary monitor, but not all of them.
            area.setMarginsForExtension(this.uuid, {
                [this._monitorIndex()]: {top, bottom: 0, left: 0, right: 0},
            });
            this._desktopAreas.add(area);
        }
    }

    _releaseDesktopIcons() {
        for (const area of this._desktopAreas ?? [])
            area.setMarginsForExtension(this.uuid, null);
        this._desktopAreas = null;
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
        // Quick settings bring their own volume slider.
        this._volumeRow.visible = !!this._sink && !this._qsAdopter;
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
        if (!this._island || !this._media)
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

        // Rows fade instead of hiding, so the view keeps one height whatever is
        // playing and the island does not resize when the track changes.
        const show = (actor, visible) => {
            actor.opacity = visible ? 255 : 0;
            actor.reactive = visible;
        };
        this._mediaTitle.text = info ? info.title || info.appName : _('Nothing is playing');
        this._mediaArtist.text = info?.artist || ' ';
        this._mediaApp.text = (info && info.title && info.appName) || ' ';

        // Nothing to control: the buttons stay, dimmed, so the view keeps its shape.
        this._transport.opacity = info ? 255 : 90;
        this._transport.reactive = !!info;
        this._prevButton.reactive = !!info?.canPrevious;
        this._nextButton.reactive = !!info?.canNext;
        this._prevButton.opacity = info?.canPrevious ? 255 : 90;
        this._nextButton.opacity = info?.canNext ? 255 : 90;
        this._playButton.child.icon_name = info?.playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';

        show(this._progressRow, this._mediaLength > 0);
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
                this._progressRow.opacity = 0;
                return;
            }
            this._progress.value = Math.min(1, position / this._mediaLength);
            this._elapsed.text = formatTime(position);
            this._remaining.text = `-${formatTime(this._mediaLength - position)}`;
        });
    }

    // ---------- Quick settings ----------

    // GNOME's quick settings become the island's control center: every item
    // (GNOME's and other extensions') is sorted into a module, and a toggle's
    // menu opens as a page of its own. See quicksettings.js.
    _adoptQuickSettings() {
        const adopter = new QuickSettingsAdopter({
            containers: {
                system: this._ccSystem,
                sliders: this._ccSliders,
                connectivity: this._ccConnect,
                tiles: this._ccTiles,
                extra: this._ccExtra,
            },
            detail: this._detailBox,
            onMenuOpened: () => {
                if (this._hidden)
                    this._setHidden(false);
                this._open('detail');
            },
            onMenuClosed: () => {
                if (this._mode !== 'detail')
                    return;
                this._open('controls');
                if (!this._anyHover())
                    this._scheduleCollapse();
            },
            onChanged: () => this._syncModules(),
        });
        if (!adopter.available)
            return;
        this._qsAdopter = adopter;
        this._volumeRow.hide();

        // Anything that opens or closes quick settings (Super+S, the settings
        // and lock buttons) opens or closes the island instead. The indicator
        // stays in the hidden panel, so the panel's own calls would do nothing.
        const menu = adopter.menu;
        const open = () => {
            if (this._hidden)
                this._setHidden(false);
            this._open('controls');
        };
        menu.open = open;
        menu.toggle = () => (this._mode === 'controls' || this._mode === 'detail' ? this._close() : open());
        menu.close = animate => {
            adopter.closeMenu(animate);
            if (this._mode === 'controls' || this._mode === 'detail')
                this._close();
        };
        Main.panel.toggleQuickSettings = () => menu.toggle();
        Main.panel.closeQuickSettings = () => menu.close();
    }

    // Empty modules take no room.
    _syncModules() {
        const on = key => this._settings.get_boolean(key);
        const used = box => box.get_children().some(c => c.visible);
        this._ccConnect.visible = on('show-connectivity') && used(this._ccConnect);
        this._ccSliders.visible = on('show-sliders') && used(this._ccSliders);
        this._ccTiles.visible = on('show-tiles') && used(this._ccTiles);
        this._ccSystem.visible = used(this._ccSystem);
        this._apps.actor.visible = on('show-apps');
        this._ccTop.visible = this._ccConnect.visible || this._apps.actor.visible;
    }

    _releaseQuickSettings() {
        const adopter = this._qsAdopter;
        if (!adopter)
            return;
        this._qsAdopter = null;
        adopter.destroy();
        delete adopter.menu.open;
        delete adopter.menu.toggle;
        delete adopter.menu.close;
        delete Main.panel.toggleQuickSettings;
        delete Main.panel.closeQuickSettings;
    }

    // ---------- Panel indicators ----------

    _panelBoxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    }

    _adoptPanel() {
        this._panelAdopted = true;
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
        const [role, indicator] = Object.entries(Main.panel.statusArea)
            .find(([, i]) => i?.container === container) ?? [];
        if (SKIPPED_ROLES.includes(role) || (role === 'quickSettings' && this._qsAdopter))
            return;

        // Adding an actor to a new parent shows it; keep hidden indicators hidden.
        const visible = container.visible;
        box.remove_child(container);

        // Naming the slot "panel" keeps the theme's #panel .panel-button icon and
        // label styles. The tile look (background, hover, open menu) is the slot's;
        // the button's own theme background is switched off with an inline style,
        // which beats every theme rule, hover included.
        const slot = new St.Bin({name: 'panel', style_class: 'dynada-slot', child: container});
        container.visible = visible;
        const record = {container, box, index, slot, ids: []};
        this._slots.push(record);
        this._tray.add_child(slot);
        record.ids.push([container, container.connect('notify::visible', () => this._syncTray())]);
        this._syncTray();

        const button = indicator ?? container.get_child?.();
        if (button instanceof St.Widget) {
            record.button = button;
            record.buttonStyle = button.style;
            button.style = `${button.style ?? ''} background-color: transparent; box-shadow: none; ` +
                'border: none; border-radius: 14px; transition-duration: 0;';
            const syncHover = () => {
                if (button.hover)
                    slot.add_style_pseudo_class('hover');
                else
                    slot.remove_style_pseudo_class('hover');
            };
            record.ids.push([button, button.connect('notify::hover', syncHover)]);
        }

        // Its menu, and any menu it swaps in later, gets the glass look, and the
        // tile stays lit while the menu is open.
        if (indicator) {
            const watchMenu = () => {
                const menu = indicator.menu;
                if (!menu?.connect)
                    return;
                this._glassMenus?.add(menu);
                record.menu?.disconnect(record.menuOpenId);
                record.menu = menu;
                record.menuOpenId = menu.connect('open-state-changed', (_m, open) => {
                    if (open)
                        slot.add_style_pseudo_class('active');
                    else
                        slot.remove_style_pseudo_class('active');
                });
            };
            watchMenu();
            record.indicator = indicator;
            record.menuSetId = indicator.connect('menu-set', watchMenu);
            record.indicatorDestroyId = indicator.connect('destroy', () => {
                record.indicator = null;
                record.button = null;
                record.menu = null;
            });
        }

        // Drop the empty slot if the indicator is moved elsewhere or destroyed.
        record.removedId = slot.connect('child-removed', () => {
            // At shell shutdown the island is destroyed with the indicators in
            // it; they are gone too, so there is nothing to disconnect.
            if (this._releasing || this._stripGone)
                return;
            this._disconnectSlot(record);
            this._slots = this._slots.filter(r => r !== record);
            slot.destroy();
            this._syncTray();
        });
    }

    // An empty tray would still leave a gap in the view.
    _syncTray() {
        this._tray.visible = this._settings.get_boolean('show-tray') &&
            this._slots.some(r => r.container.visible);
    }

    _disconnectSlot(record) {
        for (const [obj, id] of record.ids)
            obj.disconnect(id);
        record.ids = [];
        if (record.button)
            record.button.style = record.buttonStyle;
        if (record.menu) {
            record.menu.disconnect(record.menuOpenId);
            record.menu = null;
        }
        if (record.indicator) {
            record.indicator.disconnect(record.menuSetId);
            record.indicator.disconnect(record.indicatorDestroyId);
            record.indicator = null;
        }
    }

    _releasePanel() {
        if (!this._panelAdopted)
            return;
        this._panelAdopted = false;
        this._releasing = true;
        for (const r of this._slots) {
            r.slot.disconnect(r.removedId);
            this._disconnectSlot(r);
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
