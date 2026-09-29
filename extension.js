import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

// Space reserved above windows (px). Set to 0 to let the island float over windows.
const STRIP_HEIGHT = 40;
const TOP_MARGIN = 4;
const EXPANDED_WIDTH = 460;
// How long to wait after the pointer leaves before collapsing (ms).
const COLLAPSE_DELAY = 700;

const DisplayDeviceProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.Device'));

// Minimal printf for translated strings: %d and %s in order, %% for a literal percent.
function fmt(str, ...args) {
    return str.replace(/%([ds%])/g, (m, c) => (c === '%' ? '%' : String(args.shift())));
}

// Lays children out left to right and wraps to a new row when the width runs out.
// Unlike Clutter.FlowLayout every child keeps its own width, and hidden or empty
// children take no space. Rows are centered.
const WrapLayout = GObject.registerClass(
class WrapLayout extends Clutter.LayoutManager {
    _init(spacing, rowSpacing) {
        super._init();
        this._spacing = spacing;
        this._rowSpacing = rowSpacing;
    }

    _items(container) {
        const items = [];
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, w] = child.get_preferred_width(-1);
            if (w <= 0)
                continue;
            items.push({child, w});
        }
        return items;
    }

    _rows(container, forWidth) {
        const rows = [];
        let row = null;
        for (const item of this._items(container)) {
            const w = Math.min(item.w, forWidth);
            const [, h] = item.child.get_preferred_height(w);
            if (row && row.width + this._spacing + w > forWidth)
                row = null;
            if (!row) {
                row = {items: [], width: 0, height: 0};
                rows.push(row);
            } else {
                row.width += this._spacing;
            }
            row.items.push({child: item.child, x: row.width, w, h});
            row.width += w;
            row.height = Math.max(row.height, h);
        }
        return rows;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const items = this._items(container);
        const min = Math.max(0, ...items.map(i => i.w));
        const nat = items.reduce((sum, i) => sum + i.w, 0) +
            this._spacing * Math.max(0, items.length - 1);
        return [min, nat];
    }

    vfunc_get_preferred_height(container, forWidth) {
        if (forWidth < 0)
            forWidth = this.vfunc_get_preferred_width(container, -1)[1];
        const rows = this._rows(container, forWidth);
        const h = rows.reduce((sum, r) => sum + r.height, 0) +
            this._rowSpacing * Math.max(0, rows.length - 1);
        return [h, h];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const placed = new Set();
        let y = box.y1;
        for (const row of this._rows(container, width)) {
            const offset = box.x1 + Math.floor((width - row.width) / 2);
            for (const item of row.items) {
                const x = offset + item.x;
                const top = y + Math.floor((row.height - item.h) / 2);
                item.child.allocate(new Clutter.ActorBox({
                    x1: x, y1: top, x2: x + item.w, y2: top + item.h,
                }));
                placed.add(item.child);
            }
            y += row.height + this._rowSpacing;
        }
        for (const child of container.get_children()) {
            if (!placed.has(child))
                child.allocate(new Clutter.ActorBox());
        }
    }
});

// Places each child horizontally centered, TOP_MARGIN below the top, at its preferred
// size. The child may be taller than the container (the expanded island overflows the
// strip), and it stays centered while its width animates.
const TopCenterLayout = GObject.registerClass(
class TopCenterLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        for (const child of container.get_children()) {
            const [, w] = child.get_preferred_width(-1);
            const [, h] = child.get_preferred_height(w);
            const x = box.x1 + Math.round((box.get_width() - w) / 2);
            const y = box.y1 + TOP_MARGIN;
            child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
        }
    }
});

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._signals = [];
        this._slots = [];
        this._expanded = false;

        this._buildIsland();
        this._setupClock();
        this._setupBattery();
        this._setupVolume();
        this._adoptPanel();
    }

    disable() {
        for (const id of [this._collapseTimeout, this._adoptIdle, this._panelIdle]) {
            if (id)
                GLib.source_remove(id);
        }
        this._collapseTimeout = this._adoptIdle = this._panelIdle = 0;

        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._unbindSink();

        this._releasePanel();

        this._strip.destroy();
        this._strip = this._island = null;

        this._power = null;
        this._clock = null;
        this._interfaceSettings = null;
    }

    _connect(obj, signal, handler) {
        this._signals.push([obj, obj.connect(signal, handler)]);
    }

    // ---------- Island ----------

    _buildIsland() {
        // Full-width transparent strip placed inside the panel box. Its fixed height
        // is the space windows keep free at the top of the screen.
        this._strip = new St.Widget({
            layout_manager: new TopCenterLayout(),
            height: STRIP_HEIGHT,
            x_expand: true,
        });

        this._island = new St.Widget({
            style_class: 'dynada-island',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            layout_manager: new Clutter.BinLayout(),
        });

        this._compact = this._buildCompact();
        this._full = this._buildExpanded();
        this._island.add_child(this._compact);
        this._island.add_child(this._full);

        this._strip.add_child(this._island);

        // The collapsed pill and the expanded header are separate buttons, so clicks
        // on tray icons never toggle the island.
        this._connect(this._compact, 'clicked', () => this._expand());
        this._connect(this._header, 'clicked', () => this._collapse());
        this._connect(this._compact, 'notify::pressed', () => {
            this._island.ease({
                scale_x: this._compact.pressed ? 0.96 : 1,
                scale_y: this._compact.pressed ? 0.96 : 1,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
        this._connect(this._island, 'notify::hover', () => {
            if (this._expanded && !this._island.hover)
                this._scheduleCollapse();
        });

        Main.layoutManager.panelBox.add_child(this._strip);
    }

    _buildCompact() {
        const box = new St.BoxLayout({style_class: 'dynada-compact-row'});
        const button = new St.Button({
            style_class: 'dynada-compact',
            can_focus: true,
            accessible_name: _('Open Dynamic Island'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
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

    _buildExpanded() {
        const box = new St.BoxLayout({
            style_class: 'dynada-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            width: EXPANDED_WIDTH,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
            visible: false,
        });

        // Header: big time + date on the left, battery on the right. Clicking it collapses.
        const header = new St.BoxLayout({x_expand: true});
        this._header = new St.Button({
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
        box.add_child(this._header);

        // Volume
        this._volumeRow = new St.BoxLayout({style_class: 'dynada-volume', x_expand: true});
        this._muteButton = new St.Button({
            style_class: 'dynada-volume-button',
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
        box.add_child(this._volumeRow);

        // Panel indicators, including other extensions', are moved here.
        this._tray = new St.Widget({
            style_class: 'dynada-tray',
            x_expand: true,
            layout_manager: new WrapLayout(2, 4),
        });
        box.add_child(this._tray);

        return box;
    }

    _expand() {
        if (this._expanded)
            return;
        this._expanded = true;

        const [w, h] = this._island.get_size();
        this._island.set_size(w, h);
        this._island.add_style_pseudo_class('expanded');

        this._full.show();
        const [, targetH] = this._full.get_preferred_height(EXPANDED_WIDTH);

        this._compact.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._expanded)
                    this._compact.hide();
            },
        });
        this._island.ease({
            width: EXPANDED_WIDTH,
            height: targetH,
            duration: 520,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                // Fall back to natural size so the island follows icons being added or removed.
                if (this._expanded)
                    this._island.set_size(-1, -1);
            },
        });
        this._full.ease({
            opacity: 255,
            delay: 140,
            duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _collapse() {
        if (!this._expanded)
            return;
        this._expanded = false;
        this._stopCollapseTimer();

        const [w, h] = this._island.get_size();
        this._island.set_size(w, h);

        this._compact.show();
        const [, cw] = this._compact.get_preferred_width(-1);
        const [, ch] = this._compact.get_preferred_height(cw);

        this._full.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._island.ease({
            width: cw,
            height: ch,
            duration: 380,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            onComplete: () => {
                if (this._expanded)
                    return;
                this._full.hide();
                this._island.remove_style_pseudo_class('expanded');
                this._island.set_size(-1, -1);
            },
        });
        this._compact.ease({
            opacity: 255,
            delay: 160,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _anyMenuOpen() {
        return Object.values(Main.panel.statusArea).some(i => i?.menu?.isOpen);
    }

    _scheduleCollapse() {
        if (this._collapseTimeout)
            return;
        // Collapse once the pointer is outside and no menu is open.
        // While a menu is open keep waiting and check again when it closes.
        this._collapseTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COLLAPSE_DELAY, () => {
            if (!this._expanded) {
                this._collapseTimeout = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._island.hover || this._anyMenuOpen())
                return GLib.SOURCE_CONTINUE;
            this._collapseTimeout = 0;
            this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopCollapseTimer() {
        if (this._collapseTimeout)
            GLib.source_remove(this._collapseTimeout);
        this._collapseTimeout = 0;
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

    // ---------- Panel indicators ----------

    _panelBoxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    }

    _adoptPanel() {
        Main.panel.hide();
        // If another extension shows the panel again, hide it again.
        this._connect(Main.panel, 'notify::visible', () => {
            if (!Main.panel.visible && this._panelIdle)
                return;
            if (Main.panel.visible && !this._panelIdle) {
                this._panelIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._panelIdle = 0;
                    Main.panel.hide();
                    return GLib.SOURCE_REMOVE;
                });
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
            this._adoptIdle = 0;
            for (const box of this._panelBoxes()) {
                for (const child of box.get_children())
                    this._adopt(child, box, box.get_children().indexOf(child));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // index: position in the panel box, used to put it back in order on disable.
    _adopt(container, box, index) {
        // Adding an actor to a new parent shows it; keep hidden indicators hidden.
        const visible = container.visible;
        box.remove_child(container);

        // Naming the slot "panel" keeps the theme's #panel .panel-button styles.
        const slot = new St.Bin({
            name: 'panel',
            style: 'background-color: transparent; box-shadow: none; border: none;',
            child: container,
        });
        container.visible = visible;
        const record = {container, box, index, slot};
        this._slots.push(record);
        this._tray.add_child(slot);

        if (container === Main.panel.statusArea.dateMenu?.container)
            this._shrinkDateMenu(record);

        // Drop the empty slot if the indicator is moved elsewhere or destroyed.
        record.removedId = slot.connect('child-removed', () => {
            if (this._releasing)
                return;
            this._slots = this._slots.filter(r => r !== record);
            slot.destroy();
        });
    }

    // The island already shows the time, so the calendar button shows an icon instead.
    _shrinkDateMenu(record) {
        const clock = Main.panel.statusArea.dateMenu._clockDisplay;
        if (!clock)
            return;
        const icon = new St.Icon({
            icon_name: 'x-office-calendar-symbolic',
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
            r.restore?.();
            const visible = r.container.visible;
            r.slot.set_child(null);
            const index = Math.min(r.index, r.box.get_n_children());
            r.box.insert_child_at_index(r.container, index);
            r.container.visible = visible;
        }
        this._slots = [];
        this._releasing = false;
        Main.panel.show();
    }
}
