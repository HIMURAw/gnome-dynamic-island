import St from 'gi://St';

import {Glass} from './glass.js';

// Replaces the theme's solid menu background with the island's frosted glass.
// The menu itself stays untouched apart from a transparent background; a Glass
// actor sits right below it and follows its position, size and fade.
const MENU_STYLE = 'background-color: transparent; box-shadow: none; ' +
    'border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 22px;';

export class GlassMenus {
    constructor() {
        this._items = new Map();
    }

    add(menu) {
        const actor = menu?.actor;
        const box = menu?.box;
        if (!box || !actor?.get_parent() || this._items.has(menu))
            return;

        const item = {menu, glass: null, boxStyle: box.style, ids: []};
        box.style = `${box.style ?? ''} ${MENU_STYLE}`;
        box.add_style_class_name('dynada-glass-menu');

        const sync = () => this._sync(item);
        for (const [obj, signal] of [
            [actor, 'notify::visible'],
            [actor, 'notify::opacity'],
            [actor, 'notify::translation-x'],
            [actor, 'notify::translation-y'],
            [actor, 'notify::scale-y'],
            [box, 'notify::allocation'],
            [box, 'notify::opacity'],
        ])
            item.ids.push([obj, obj.connect(signal, sync)]);
        item.ids.push([actor, actor.connect('destroy', () => this.remove(menu, true))]);

        this._items.set(menu, item);
        sync();
    }

    // The glass exists only while its menu is on screen: a blurred copy of the
    // screen per menu, kept around for every panel icon, costs memory and time.
    // It is made while the menu is still fully transparent, so the frame it
    // misses before its first allocation does not show.
    _sync(item) {
        const {menu} = item;
        const actor = menu.actor;
        const box = menu.box;
        const [w, h] = box.get_transformed_size();
        if (!actor.visible || !box.mapped || !(w > 0 && h > 0)) {
            this._dropGlass(item);
            return;
        }
        if (!item.glass) {
            const parent = actor.get_parent();
            if (!parent)
                return;
            item.glass = new Glass({radius: 22, opacity: 0});
            // At shell shutdown the glass can be destroyed together with its parent first.
            item.glass.connect('destroy', () => {
                item.glass = null;
            });
            parent.insert_child_below(item.glass, actor);
        }
        const glass = item.glass;
        const [x, y] = box.get_transformed_position();
        const [px, py] = glass.get_parent().get_transformed_position();
        glass.set_position(Math.round(x - px), Math.round(y - py));
        glass.set_size(Math.round(w), Math.round(h));
        glass.opacity = Math.round(actor.opacity * box.opacity / 255);
        glass.setRadius(box.get_theme_node().get_border_radius(St.Corner.TOPLEFT));
        glass.syncBackdrop();
    }

    _dropGlass(item) {
        item.glass?.destroy();
        item.glass = null;
    }

    // destroyed: the menu is going away, so there is nothing to restore on it.
    remove(menu, destroyed = false) {
        const item = this._items.get(menu);
        if (!item)
            return;
        this._items.delete(menu);
        if (!destroyed) {
            for (const [obj, id] of item.ids)
                obj.disconnect(id);
            menu.box.style = item.boxStyle;
            menu.box.remove_style_class_name('dynada-glass-menu');
        }
        this._dropGlass(item);
    }

    destroy() {
        for (const menu of [...this._items.keys()])
            this.remove(menu);
    }
}
