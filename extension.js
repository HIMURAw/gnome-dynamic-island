import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

// Pencerelerin üstte bırakacağı boşluk (px). 0 yapılırsa ada pencerelerin üstünde yüzer.
const STRIP_HEIGHT = 40;
const TOP_MARGIN = 4;
const EXPANDED_WIDTH = 460;
// İmleç adadan çıktıktan sonra kapanmadan önce beklenen süre (ms).
const COLLAPSE_DELAY = 700;

const DisplayDeviceProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.Device'));

export default class DinamikAdaExtension extends Extension {
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

        Main.layoutManager.untrackChrome(this._island);
        this._strip.destroy();
        this._strip = this._island = null;

        this._power = null;
        this._clock = null;
        this._interfaceSettings = null;
    }

    _connect(obj, signal, handler) {
        this._signals.push([obj, obj.connect(signal, handler)]);
    }

    // ---------- Ada ----------

    _buildIsland() {
        // Üst paneli taşıyan kutunun içine koyulan, tam genişlikte şeffaf şerit.
        // Yüksekliği sabit: pencerelerin ayırdığı alan = bu şerit.
        this._strip = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            height: STRIP_HEIGHT,
            x_expand: true,
        });

        this._island = new St.Widget({
            style_class: 'dynada-island',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            y: TOP_MARGIN,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            layout_manager: new Clutter.BinLayout(),
        });

        this._compact = this._buildCompact();
        this._full = this._buildExpanded();
        this._island.add_child(this._compact);
        this._island.add_child(this._full);

        this._strip.add_child(this._island);

        this._connect(this._island, 'notify::width', () => this._center());
        this._connect(this._strip, 'notify::width', () => this._center());
        // Kapalı hap ve açık haldeki başlık ayrı düğmeler: tepsideki simgelere
        // tıklamak adayı kapatmasın.
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
        Main.layoutManager.trackChrome(this._island, {affectsInputRegion: true});
    }

    _buildCompact() {
        const box = new St.BoxLayout({style_class: 'dynada-compact-row'});
        const button = new St.Button({
            style_class: 'dynada-compact',
            can_focus: true,
            accessible_name: 'Dinamik Adayı aç',
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

        // Başlık: büyük saat + tarih solda, şarj sağda. Tıklanınca ada kapanır.
        const header = new St.BoxLayout({x_expand: true});
        this._header = new St.Button({
            style_class: 'dynada-header',
            can_focus: true,
            accessible_name: 'Dinamik Adayı kapat',
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

        // Ses
        this._volumeRow = new St.BoxLayout({style_class: 'dynada-volume', x_expand: true});
        this._muteButton = new St.Button({
            style_class: 'dynada-volume-button',
            can_focus: true,
            accessible_name: 'Sesi kapat/aç',
            child: new St.Icon({style_class: 'dynada-volume-icon', icon_name: 'audio-volume-high-symbolic'}),
        });
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.accessible_name = 'Ses düzeyi';
        this._volumeLabel = new St.Label({style_class: 'dynada-volume-label', y_align: Clutter.ActorAlign.CENTER});
        this._volumeRow.add_child(this._muteButton);
        this._volumeRow.add_child(this._slider);
        this._volumeRow.add_child(this._volumeLabel);
        box.add_child(this._volumeRow);

        // Diğer eklentilerin simgeleri buraya taşınır.
        this._tray = new St.Widget({
            style_class: 'dynada-tray',
            x_expand: true,
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_spacing: 2,
                row_spacing: 2,
            }),
        });
        box.add_child(this._tray);

        return box;
    }

    _center() {
        if (!this._island)
            return;
        this._island.x = Math.round((this._strip.width - this._island.width) / 2);
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
                // Açıldıktan sonra doğal boyuta bırak: simge eklenip çıkarsa ada kendini ayarlar.
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
        // İmleç dışarıdayken ve hiçbir menü açık değilken kapan.
        // Menü açıkken beklemeye devam et; menü kapanınca tekrar bak.
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

    // ---------- Saat ----------

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

    // ---------- Şarj ----------

    _setupBattery() {
        this._compactBattery.hide();
        this._batteryColumn.hide();
        this._power = new DisplayDeviceProxy(
            Gio.DBus.system,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (error) {
                    console.error(`Dinamik Ada: UPower'a bağlanılamadı: ${error.message}`);
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
        this._compactBatteryLabel.text = `%${pct}`;
        this._bigBattery.text = `%${pct}`;

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
            return 'Dolu';
        if (charging) {
            return p.TimeToFull > 0
                ? `Şarj oluyor, ${this._formatDuration(p.TimeToFull)} sonra dolu`
                : 'Şarj oluyor';
        }
        if (p.State === UPower.DeviceState.PENDING_CHARGE)
            return 'Takılı, şarj beklemede';
        return p.TimeToEmpty > 0
            ? `${this._formatDuration(p.TimeToEmpty)} kaldı`
            : 'Pilde';
    }

    _formatDuration(seconds) {
        const minutes = Math.round(seconds / 60);
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h === 0)
            return `${m} dk`;
        return m === 0 ? `${h} sa` : `${h} sa ${m} dk`;
    }

    // ---------- Ses ----------

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

    // ---------- Panel simgeleri ----------

    _panelBoxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    }

    _adoptPanel() {
        Main.panel.hide();
        // Başka bir eklenti paneli geri açarsa tekrar gizle.
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
            // Bizden sonra açılan eklentiler de adaya gelsin.
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

    // index: simgenin kutudaki yeri; kapatırken aynı sırayla geri konur.
    _adopt(container, box, index) {
        box.remove_child(container);

        // "panel" adı temanın panel düğmesi stillerini (yükseklik, dolgu, renk) korur.
        const slot = new St.Bin({
            name: 'panel',
            style: 'background-color: transparent; box-shadow: none; border: none;',
            child: container,
        });
        const record = {container, box, index, slot};
        this._slots.push(record);
        this._tray.add_child(slot);

        if (container === Main.panel.statusArea.dateMenu?.container)
            this._shrinkDateMenu(record);

        // Simge başka yere taşınırsa ya da yok olursa boş yuvayı temizle.
        record.removedId = slot.connect('child-removed', () => {
            if (this._releasing)
                return;
            this._slots = this._slots.filter(r => r !== record);
            slot.destroy();
        });
    }

    // Saat zaten adada; takvim düğmesi tepside saat yerine simge göstersin.
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
            r.slot.set_child(null);
            const index = Math.min(r.index, r.box.get_n_children());
            r.box.insert_child_at_index(r.container, index);
        }
        this._slots = [];
        this._releasing = false;
        Main.panel.show();
    }
}
