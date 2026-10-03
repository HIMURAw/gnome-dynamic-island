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
        // Further bubbles after `right`, in order; hidden ones take no room.
        this.extraRight = [];
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

        if (this.left) {
            const [w, h] = size(this.left);
            const x = cx - this._gap - w;
            this.left.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
        }
        let x = cx + cw + this._gap;
        for (const side of [this.right, ...this.extraRight]) {
            if (!side)
                continue;
            const [w, h] = size(side);
            side.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
            if (side.visible)
                x += w + this._gap;
        }
    }
});

// A grid of `columns` equal columns and rows of equal height. Each child spans as
// many columns as its natural width needs. Wide children are placed first, gaps
// are filled first-fit, and the spare columns in a row are shared out so every row
// ends flush with both edges. A short last row is centered instead of stretched.
// Hidden or empty children take no space.
export const TileGridLayout = GObject.registerClass(
class TileGridLayout extends Clutter.LayoutManager {
    _init(columns, rowHeight, gap) {
        super._init();
        this._columns = columns;
        this._rowHeight = rowHeight;
        this._gap = gap;
    }

    _cell(width) {
        return (width - this._gap * (this._columns - 1)) / this._columns;
    }

    _rows(container, width) {
        const cols = this._columns;
        const cell = this._cell(width);
        const items = [];
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, w] = child.get_preferred_width(-1);
            if (w <= 0)
                continue;
            const span = Math.min(cols, Math.max(1, Math.ceil((w + this._gap) / (cell + this._gap))));
            items.push({child, span, order: items.length});
        }
        items.sort((a, b) => b.span - a.span || a.order - b.order);

        const rows = [];
        for (const item of items) {
            let row = rows.find(r => r.used + item.span <= cols);
            if (!row) {
                row = {items: [], used: 0};
                rows.push(row);
            }
            row.items.push(item);
            row.used += item.span;
        }
        for (const row of rows) {
            row.items.sort((a, b) => a.order - b.order);
            row.centered = row === rows[rows.length - 1] && rows.length > 1 && row.used * 2 <= cols;
            if (row.centered)
                continue;
            // Spare columns go to the narrowest items first, so icons grow evenly.
            let spare = cols - row.used;
            const bySpan = [...row.items].sort((a, b) => a.span - b.span);
            for (let i = 0; spare > 0; i = (i + 1) % bySpan.length, spare--)
                bySpan[i].span++;
        }
        return rows;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(container, forWidth) {
        if (forWidth < 0)
            return [0, 0];
        const n = this._rows(container, forWidth).length;
        const h = Math.max(0, n * (this._rowHeight + this._gap) - this._gap);
        return [h, h];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const cell = this._cell(width);
        const placed = new Set();
        let y = box.y1;
        for (const row of this._rows(container, width)) {
            const span = row.items.reduce((sum, i) => sum + i.span, 0);
            let x = box.x1;
            if (row.centered)
                x += Math.floor((width - (span * cell + (span - 1) * this._gap)) / 2);
            for (const item of row.items) {
                const w = item.span * cell + (item.span - 1) * this._gap;
                item.child.allocate(new Clutter.ActorBox({
                    x1: Math.round(x), y1: y, x2: Math.round(x + w), y2: y + this._rowHeight,
                }));
                placed.add(item.child);
                x += w + this._gap;
            }
            y += this._rowHeight + this._gap;
        }
        for (const child of container.get_children()) {
            if (!placed.has(child))
                child.allocate(new Clutter.ActorBox());
        }
    }
});
