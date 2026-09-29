import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// Centers `center` horizontally `margin` px below the top and keeps `left` and
// `right` beside it at `gap` px. Recomputed on every relayout, so the side
// bubbles glide outward as the island grows.
export const TopCenterLayout = GObject.registerClass(
class TopCenterLayout extends Clutter.LayoutManager {
    _init(margin, gap) {
        super._init();
        this._margin = margin;
        this._gap = gap;
        this.center = null;
        this.left = null;
        this.right = null;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        if (!this.center)
            return;
        const size = actor => {
            const [, w] = actor.get_preferred_width(-1);
            const [, h] = actor.get_preferred_height(w);
            return [w, h];
        };
        const [cw, ch] = size(this.center);
        const cx = box.x1 + Math.round((box.get_width() - cw) / 2);
        const y = box.y1 + this._margin;
        this.center.allocate(new Clutter.ActorBox({x1: cx, y1: y, x2: cx + cw, y2: y + ch}));

        for (const side of [this.left, this.right]) {
            if (!side)
                continue;
            const [w, h] = size(side);
            const x = side === this.left ? cx - this._gap - w : cx + cw + this._gap;
            side.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
        }
    }
});

// Lays children out as rows of equal-height chips. Each chip is at least
// `minWidth` wide, rows wrap when the width runs out and are centered. Hidden or
// empty children take no space.
export const ChipLayout = GObject.registerClass(
class ChipLayout extends Clutter.LayoutManager {
    _init(minWidth, height, gap) {
        super._init();
        this._minWidth = minWidth;
        this._height = height;
        this._gap = gap;
    }

    _items(container) {
        const items = [];
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, w] = child.get_preferred_width(-1);
            if (w > 0)
                items.push({child, w: Math.max(this._minWidth, Math.ceil(w))});
        }
        return items;
    }

    _rows(container, forWidth) {
        const rows = [];
        let row = null;
        for (const item of this._items(container)) {
            const w = Math.min(item.w, forWidth);
            if (row && row.width + this._gap + w > forWidth)
                row = null;
            if (!row) {
                row = {items: [], width: 0};
                rows.push(row);
            } else {
                row.width += this._gap;
            }
            row.items.push({child: item.child, x: row.width, w});
            row.width += w;
        }
        return rows;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const items = this._items(container);
        const min = Math.max(0, ...items.map(i => i.w));
        const nat = items.reduce((sum, i) => sum + i.w, 0) +
            this._gap * Math.max(0, items.length - 1);
        return [min, nat];
    }

    vfunc_get_preferred_height(container, forWidth) {
        if (forWidth < 0)
            forWidth = this.vfunc_get_preferred_width(container, -1)[1];
        const n = this._rows(container, forWidth).length;
        const h = Math.max(0, n * (this._height + this._gap) - this._gap);
        return [h, h];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const placed = new Set();
        let y = box.y1;
        for (const row of this._rows(container, width)) {
            const x0 = box.x1 + Math.floor((width - row.width) / 2);
            for (const item of row.items) {
                const x = x0 + item.x;
                item.child.allocate(new Clutter.ActorBox({
                    x1: x, y1: y, x2: x + item.w, y2: y + this._height,
                }));
                placed.add(item.child);
            }
            y += this._height + this._gap;
        }
        for (const child of container.get_children()) {
            if (!placed.has(child))
                child.allocate(new Clutter.ActorBox());
        }
    }
});
