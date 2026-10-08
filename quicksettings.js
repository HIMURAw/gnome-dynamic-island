import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

// Toggles that belong on the connectivity card, by class name (GNOME's network,
// Bluetooth and airplane-mode toggles, and extensions that replace them).
const CONNECTIVITY = /^(NM|Bluetooth|Rfkill|Hotspot|Airplane)/;

// Takes GNOME's quick settings items out of the hidden quick settings menu and
// puts each one where the island wants it: the system buttons, the sliders, the
// connectivity toggles, the other toggles. Items that extensions add later are
// picked up too. A toggle's own menu (Wi-Fi networks, power options) moves to the
// island's detail page while it is open. destroy() puts everything back in order.
export class QuickSettingsAdopter {
    // containers: {system, sliders, connectivity, tiles, extra} actors.
    // detail: the actor a toggle menu moves into while open.
    // onMenuOpened(menu), onMenuClosed(menu), onChanged(): callbacks.
    constructor({containers, detail, onMenuOpened, onMenuClosed, onChanged}) {
        this._containers = containers;
        this._detail = detail;
        this._onMenuOpened = onMenuOpened;
        this._onMenuClosed = onMenuClosed;
        this._records = new Map();
        this._order = 0;
        this.openMenu = null;

        // At shell shutdown the island goes before the items in it; after that
        // there is nothing left to update.
        this._gone = false;
        const changed = onChanged;
        this._onChanged = () => !this._gone && changed();
        for (const box of Object.values(containers))
            box.connect('destroy', () => (this._gone = true));

        this.menu = Main.panel.statusArea.quickSettings?.menu ?? null;
        this._grid = this.menu?._grid ?? null;
        this.available = !!(this._grid && this.menu.insertItemBefore);
        if (!this.available)
            return;

        // New items are inserted next to one of GNOME's own, which now live in the
        // island; put them at the end of the grid instead, where we pick them up.
        const menu = this.menu;
        const grid = this._grid;
        const insert = menu.insertItemBefore;
        menu.insertItemBefore = (item, sibling, colSpan) =>
            insert.call(menu, item, sibling?.get_parent() === grid ? sibling : null, colSpan);
        this._childAddedId = grid.connect('child-added', () => this._queueAdopt());

        // Original positions, so destroy() can restore the exact order.
        const children = grid.get_children();
        for (const child of children)
            this._adopt(child, children.indexOf(child));
        this._onChanged();
    }

    _queueAdopt() {
        if (this._idle)
            return;
        // After GNOME has finished adding the item (column span, menu layer).
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idle = 0;
            for (const child of this._grid.get_children())
                this._adopt(child, 1000 + this._order++);
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    _containerFor(item) {
        const c = this._containers;
        if (item.has_style_class_name('quick-settings-system-item'))
            return c.system;
        if (item.has_style_class_name('quick-slider'))
            return c.sliders;
        if (item.has_style_class_name('background-apps-quick-toggle'))
            return c.extra;
        if (CONNECTIVITY.test(item.constructor.name))
            return c.connectivity;
        return c.tiles;
    }

    _adopt(item, index) {
        // The grid also holds a bare placeholder for GNOME's menu layer.
        if (!(item instanceof St.Widget) || this._records.has(item))
            return;
        const grid = this._grid;
        const record = {
            item,
            index,
            span: grid.layout_manager.get_child_meta(grid, item)?.columnSpan ?? 1,
            ids: [],
            pivot: item.pivot_point,
        };
        this._records.set(item, record);

        // Moving an actor shows it; keep hidden items hidden.
        const visible = item.visible;
        grid.remove_child(item);
        this._containerFor(item).add_child(item);
        item.visible = visible;

        record.ids.push([item, item.connect('notify::visible', () => this._onChanged())]);
        record.ids.push([item, item.connect('destroy', () => {
            this._records.delete(item);
            if (this.openMenu === item.menu)
                this.openMenu = null;
            this._onChanged();
        })]);

        this._setupPress(record);
        this._setupMenu(record);

        // The header shows the battery, so GNOME's battery button stays hidden.
        const power = item.powerToggle;
        if (power) {
            record.power = power;
            record.ids.push([power, power.connect('notify::visible', () => power.visible && power.hide())]);
            power.hide();
        }
    }

    // Toggles sink in a little while pressed.
    _setupPress(record) {
        const {item} = record;
        let target = null;
        if (item.has_style_class_name('quick-toggle-has-menu'))
            target = item.get_child()?.get_first_child();
        else if (item.has_style_class_name('quick-toggle'))
            target = item;
        if (!(target instanceof St.Button))
            return;
        item.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        record.ids.push([target, target.connect('notify::pressed', () => {
            const scale = target.pressed ? 0.95 : 1;
            item.ease({
                scale_x: scale,
                scale_y: scale,
                duration: target.pressed ? 90 : 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        })]);
    }

    _setupMenu(record) {
        const menu = record.item.menu;
        if (!menu?.actor || typeof menu.open !== 'function')
            return;
        record.menu = menu;
        const open = Object.getPrototypeOf(menu).open;
        // The island animates the page itself, so the menu opens at full height
        // straight away and the island knows how tall to grow.
        menu.open = () => {
            this._toDetail(record);
            open.call(menu, PopupAnimation.NONE);
            // GNOME 50's QuickToggleMenu hides its box (opacity 0) and fades it in only when its own
            // height animation completes; moved onto the island's page that never happens and the
            // page showed an empty panel. The island animates the page itself: show the menu now.
            menu.actor.remove_all_transitions();
            menu.actor.height = -1;
            if (menu.box) {
                menu.box.remove_all_transitions();
                menu.box.opacity = 255;
            }
        };
        record.menuIds = [
            menu.connect('open-state-changed', (_m, isOpen) => {
                if (isOpen) {
                    this.openMenu = menu;
                    this._onMenuOpened(menu);
                } else if (this.openMenu === menu) {
                    this.openMenu = null;
                    this._onMenuClosed(menu);
                }
            }),
            menu.connect('menu-closed', () => this._fromDetail(record)),
        ];
    }

    // The menu normally hangs under its toggle in GNOME's menu layer; on the
    // detail page it simply stacks below the back button.
    _toDetail(record) {
        const actor = record.menu.actor;
        if (actor.get_parent() === this._detail)
            return;
        record.layer = actor.get_parent();
        record.constraints = actor.get_constraints().filter(c =>
            c instanceof Clutter.BindConstraint && c.coordinate === Clutter.BindCoordinate.Y);
        record.constraints.forEach(c => actor.remove_constraint(c));
        record.layer?.remove_child(actor);
        this._detail.add_child(actor);
    }

    _fromDetail(record) {
        const actor = record.menu?.actor;
        if (!actor || actor.get_parent() !== this._detail || !record.layer)
            return;
        const visible = actor.visible;
        this._detail.remove_child(actor);
        record.layer.add_child(actor);
        actor.visible = visible;
        record.constraints.forEach(c => actor.add_constraint(c));
        record.layer = null;
    }

    closeMenu(animate = PopupAnimation.FULL) {
        this.openMenu?.close(animate);
    }

    destroy() {
        if (!this.available)
            return;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        this.closeMenu(PopupAnimation.NONE);
        this._grid.disconnect(this._childAddedId);
        delete this.menu.insertItemBefore;

        const records = [...this._records.values()].sort((a, b) => a.index - b.index);
        for (const record of records) {
            const {item} = record;
            for (const [obj, id] of record.ids)
                obj.disconnect(id);
            if (record.menu) {
                record.menuIds.forEach(id => record.menu.disconnect(id));
                delete record.menu.open;
                this._fromDetail(record);
            }
            record.power?._sync?.();
            item.remove_all_transitions();
            item.set_scale(1, 1);
            item.pivot_point = record.pivot;

            const visible = item.visible;
            item.get_parent()?.remove_child(item);
            this._grid.insert_child_at_index(item, Math.min(record.index, this._grid.get_n_children()));
            item.visible = visible;
            this._grid.layout_manager.child_set_property(this._grid, item, 'column-span', record.span);
        }
        this._records.clear();
    }
}
