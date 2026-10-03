import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

// asusd (asusctl) owns the charge limit on ASUS laptops and lets the logged-in
// user change it. Without it the toggle stays hidden.
const BUS_NAME = 'xyz.ljones.Asusd';
const OBJECT_PATH = '/xyz/ljones';
const PlatformProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="xyz.ljones.Platform">
    <method name="OneShotFullCharge"/>
    <property name="ChargeControlEndThreshold" type="y" access="readwrite"/>
  </interface>
</node>`);

const LIMITS = [60, 80];
const BATTERY = '/sys/class/power_supply/BAT0';

function readNumber(name) {
    try {
        const [, bytes] = GLib.file_get_contents(`${BATTERY}/${name}`);
        const value = parseInt(new TextDecoder().decode(bytes), 10);
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

// Translated strings carry {n} where the number goes, so a language can put
// the percent sign on either side.
const fmt = (str, n) => str.replace('{n}', String(n));

// "Charge Limit": on stops charging at 60 or 80 %, off charges to 100 %.
// The menu picks the limit, charges to full once (for a trip) and shows
// the battery's health.
const ChargeToggle = GObject.registerClass(
class DynadaChargeToggle extends QuickMenuToggle {
    _init(settings) {
        super._init({
            title: _('Charge Limit'),
            iconName: 'battery-level-80-charging-symbolic',
            menuButtonAccessibleName: _('Open charge limit menu'),
            visible: false,
        });
        this._settings = settings;

        this.menu.setHeader('battery-level-80-charging-symbolic', _('Charge Limit'),
            _('Charging stops early to keep the battery healthy'));

        this._items = new Map();
        for (const limit of LIMITS) {
            const item = new PopupMenu.PopupMenuItem(fmt(_('Stop at {n}%'), limit));
            item.connect('activate', () => this._setLimit(limit));
            this._items.set(limit, item);
            this.menu.addMenuItem(item);
        }
        const full = new PopupMenu.PopupMenuItem(_('Charge to 100% once'));
        full.connect('activate', () => this._proxy?.OneShotFullChargeAsync().catch(logError));
        this.menu.addMenuItem(full);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._health = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._health);
        this.menu.connect('open-state-changed', (_m, open) => open && this._syncHealth());

        this.connect('clicked', () => this._setLimit(this.checked ? 100 : this._settings.get_int('charge-limit')));

        this._proxy = null;
        new PlatformProxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error || this._destroyed)
                return;
            this._proxy = proxy;
            this._proxyId = proxy.connect('g-properties-changed', () => this._sync());
            this._sync();
        }, null, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
    }

    _setLimit(limit) {
        if (!this._proxy)
            return;
        if (limit < 100)
            this._settings.set_int('charge-limit', limit);
        this._proxy.ChargeControlEndThreshold = limit;
    }

    _sync() {
        const limit = this._proxy?.ChargeControlEndThreshold;
        this.visible = !!this._proxy?.g_name_owner && typeof limit === 'number' && limit > 0;
        if (!this.visible)
            return;
        this.checked = limit < 100;
        this.subtitle = this.checked ? fmt(_('{n}%'), limit) : _('Off');
        for (const [value, item] of this._items)
            item.setOrnament(value === limit ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    _syncHealth() {
        const full = readNumber('energy_full') ?? readNumber('charge_full');
        const design = readNumber('energy_full_design') ?? readNumber('charge_full_design');
        const cycles = readNumber('cycle_count');
        const parts = [];
        if (full && design)
            parts.push(fmt(_('Health {n}%'), Math.min(100, Math.round(full / design * 100))));
        if (cycles !== null)
            parts.push(fmt(_('{n} cycles'), cycles));
        this._health.label.text = parts.join(' · ');
        this._health.visible = parts.length > 0;
    }

    destroy() {
        this._destroyed = true;
        if (this._proxyId)
            this._proxy.disconnect(this._proxyId);
        this._proxy = null;
        super.destroy();
    }
});

export const ChargeIndicator = GObject.registerClass(
class DynadaChargeIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        this.quickSettingsItems.push(new ChargeToggle(settings));
        Main.panel.statusArea.quickSettings.addExternalIndicator(this);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});
