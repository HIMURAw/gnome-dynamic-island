// Harvis'in bedeni: mor neon piksel robot. İki biçimi var:
//   head    yuvarlak robot (avatar): ada, uygulama, logo
//   pointer ok biçimli robot: Harvis'in kendi faresi (ekranda bir şeye tıklarken görünen)
// Referans: Umut'un gönderdiği "Neon Mor Robot Sprite Sayfası" ve "Üç Neon Robot İmleç Durumu" (2026-10-13).
//
// Platformdan bağımsız (DOM yok, GJS yok): her karede bir piksel ızgarası üretir, kabuklar çizer.
//
//   const r = new Robot('head')            // ya da 'pointer'
//   r.setState('idle' | 'listening' | 'thinking' | 'speaking' | 'failed' | 'sleeping')
//                                          // pointer için ayrıca 'moving' ve 'click'
//   r.setLevel(0..1)  r.setMood(valence, arousal)  r.lookAt(x, y) | r.lookAt(null)
//   r.emote('joy' | 'surprise' | 'wink' | 'wave' | 'hop' | 'walk')
//   r.step(dt)
//   drawCanvas(ctx, r.frame(), {x, y, px})   // px: bir sprite pikselinin ekran pikseli
//   drawCairo(cr, r.frame(), {x, y, px})
//
// x, y çizimin sol üstü (pointer'da sıcak nokta, yani okun ucu: frame().hot).
// Kopyası: GNOME adası `gnome-dynamic-island/robot.js` (`tools/sync-avatar.sh`).
// px kesirli olabilir (1,67 ölçekli ekran): her piksel kenarı tam ekran pikseline yuvarlanır.

export const COLORS = {
    o: '#1b1638',   // kontur
    D: '#4a34ae',   // gölge moru
    P: '#5c41c4',   // ana mor
    L: '#7d62e0',   // ışık moru
    H: '#c5c1fb',   // parlama
    V: '#141522',   // vizör
    C: '#33f5ff',   // neon camgöbeği
    c: '#e6fcfe',   // neonun beyaz çekirdeği
    B: '#1c8fae',   // sönük camgöbeği
    R: '#ff4f6b',   // hata
    r: '#ffd0d8',
    s: 'rgba(8,6,24,0.55)', // yer gölgesi
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const approach = (v, t, rate, dt) => v + (t - v) * (1 - Math.exp(-rate * dt));

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------- Piksel ızgarası ----------

class Grid {
    constructor(w, h) {
        this.w = w;
        this.h = h;
        this.cells = new Array(w * h).fill(null);
        this.glows = [];
    }

    set(x, y, c) {
        x = Math.round(x);
        y = Math.round(y);
        if (x >= 0 && y >= 0 && x < this.w && y < this.h)
            this.cells[y * this.w + x] = c;
    }

    get(x, y) {
        return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.cells[y * this.w + x] : null;
    }

    rect(x, y, w, h, c) {
        for (let j = 0; j < h; j++)
            for (let i = 0; i < w; i++)
                this.set(x + i, y + j, c);
    }

    // Bir maskeyi gövde gibi boya: dış kenar kontur, üst-sol ışık, alt-sağ gölge.
    body(mask, {dx = 0, dy = 0, base = 'P', light = 'L', shade = 'D', shine = true} = {}) {
        const inside = (x, y) => mask(x, y);
        let first = null;
        for (let y = -2; y < this.h + 2; y++) {
            for (let x = -2; x < this.w + 2; x++) {
                if (!inside(x, y))
                    continue;
                const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
                let c = base;
                if (edge)
                    c = 'o';
                else if (!inside(x - 2, y) || !inside(x, y - 2))
                    c = light;
                else if (!inside(x + 2, y) || !inside(x, y + 2) || !inside(x + 1, y + 1))
                    c = shade;
                if (c === light && !first && shine)
                    first = [x, y];
                this.set(x + dx, y + dy, c);
            }
        }
        if (first && shine) {
            this.set(first[0] + dx + 1, first[1] + dy + 1, 'H');
            this.set(first[0] + dx + 2, first[1] + dy + 1, 'H');
        }
    }

    glow(x, y, r, color, a) {
        this.glows.push({x, y, r, color, a});
    }

    // Aynı renkteki yan yana pikseller tek dikdörtgen: Cairo'da kare başına birkaç yüz çağrı yeter.
    runs() {
        const out = [];
        for (let y = 0; y < this.h; y++) {
            let x = 0;
            while (x < this.w) {
                const c = this.cells[y * this.w + x];
                let n = 1;
                while (x + n < this.w && this.cells[y * this.w + x + n] === c)
                    n++;
                if (c)
                    out.push([x, y, n, c]);
                x += n;
            }
        }
        return out;
    }
}

// Yuvarlatılmış dikdörtgen maskesi (piksel merkezine göre).
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1)
        return false;
    const cx = clamp(x, x0 + r, x1 - r);
    const cy = clamp(y, y0 + r, y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.6;
};

// ---------- Gözler ----------
// Her göz kendi kutusunun sol üstünden çizilir. kind: open, closed, happy, wide, wink, x, squint.

function eye(g, x, y, kind, {w = 2, h = 4, lit = 'C', core = 'c'} = {}) {
    switch (kind) {
    case 'closed':
        g.rect(x - (w > 2 ? 0 : 0), y + Math.floor(h / 2), w + 1, 1, lit);
        break;
    case 'happy':   // ^
        g.set(x, y + h - 2, lit);
        g.set(x + 1, y + h - 3, lit);
        g.set(x + 2, y + h - 3, lit);
        g.set(x + 3, y + h - 2, lit);
        break;
    case 'wink':    // <
        g.set(x + 2, y + 1, lit);
        g.set(x + 1, y + 2, lit);
        g.set(x, y + 2, lit);
        g.set(x + 2, y + 3, lit);
        break;
    case 'wide':    // O
        for (let j = 0; j < h; j++)
            for (let i = 0; i < w + 1; i++) {
                const border = i === 0 || i === w || j === 0 || j === h - 1;
                const corner = (i === 0 || i === w) && (j === 0 || j === h - 1);
                if (border && !corner)
                    g.set(x + i, y + j, lit);
            }
        break;
    case 'x':
        for (let i = 0; i < 3; i++) {
            g.set(x + i, y + 1 + i, lit);
            g.set(x + 2 - i, y + 1 + i, lit);
        }
        break;
    case 'squint':
        g.rect(x, y + 1, w, h - 2, lit);
        g.rect(x, y + 1, w, 1, core);
        break;
    default:        // open
        g.rect(x, y, w, h, lit);
        g.rect(x, y, w, 1, core);
        if (w > 1)
            g.set(x + w - 1, y + 1, core);
    }
}

// ---------- Robot ----------

const STATES = ['idle', 'listening', 'thinking', 'speaking', 'failed', 'sleeping', 'moving', 'click'];

export class Robot {
    constructor(kind = 'head', {seed = 11} = {}) {
        this.kind = kind;
        this.state = 'idle';
        this.t = 0;
        this._rand = rng(seed);
        this._level = 0;
        this._levelIn = 0;
        this._valence = 0;
        this._arousal = 0.4;
        this._look = null;
        this._eye = [0, 0];
        this._glance = [0, 0];
        this._nextGlance = 2;
        this._blinkUntil = -1;
        this._nextBlink = 1.5 + this._rand() * 3;
        this._emote = null;     // {name, until}
        this._since = 0;
        this._hop = {y: 0, v: 0};
        this.walking = false;
    }

    setState(state) {
        if (!STATES.includes(state) || state === this.state)
            return;
        const from = this.state;
        this.state = state;
        this._since = this.t;
        if (state === 'listening' || from === 'sleeping')
            this.emote('hop');
        if (state === 'click')
            this.emote('joy');
    }

    setLevel(l) {
        this._levelIn = clamp(l || 0, 0, 1);
    }

    setMood(v, a) {
        this._valence = clamp(v ?? 0, -1, 1);
        this._arousal = clamp(a ?? 0.4, 0, 1);
    }

    lookAt(x, y) {
        this._look = x == null || !Number.isFinite(x) || !Number.isFinite(y) ? null : [clamp(x, -1, 1), clamp(y, -1, 1)];
    }

    emote(name) {
        const dur = {joy: 1.4, surprise: 1.1, wink: 0.9, wave: 1.6, hop: 0.5, walk: 2.4}[name] ?? 1;
        if (name === 'hop' || name === 'joy' || name === 'surprise')
            this._hop.v = -(name === 'surprise' ? 26 : 20);
        this._emote = {name, until: this.t + dur, since: this.t};
    }

    _emoting(name) {
        return this._emote && this._emote.name === name && this.t < this._emote.until;
    }

    step(dt) {
        dt = clamp(dt, 0, 0.1);
        this.t += dt;
        const t = this.t;
        this._level = approach(this._level, this._levelIn, this._levelIn > this._level ? 25 : 8, dt);
        // Zıplama: basit yerçekimi, yere değince durur.
        const h = this._hop;
        h.v += 120 * dt;
        h.y = Math.min(0, h.y + h.v * dt);
        if (h.y === 0)
            h.v = 0;
        if (t > this._nextBlink && this.state !== 'sleeping') {
            this._blinkUntil = t + 0.13;
            this._nextBlink = t + (this._rand() < 0.2 ? 0.3 : 2.2 + this._rand() * 3.8);
        }
        let look;
        if (this.state === 'thinking')
            look = [Math.sin(t * 2.2) > 0 ? 1 : -1, -1];    // vizörde iki yana tarama
        else if (this._look)
            look = this._look;
        else {
            if (t > this._nextGlance) {
                this._glance = this._rand() < 0.5 ? [0, 0] : [Math.round(this._rand() * 2 - 1), this._rand() < 0.3 ? -1 : 0];
                this._nextGlance = t + 1.5 + this._rand() * 3.5;
            }
            look = this._glance;
        }
        this._eye = look;
    }

    // Gözlerin hali, öncelik sırasıyla.
    _eyeKind() {
        const s = this.state;
        if (s === 'failed')
            return 'x';
        if (s === 'sleeping')
            return 'closed';
        if (this._emoting('surprise'))
            return 'wide';
        if (this._emoting('joy') || this._emoting('wave') || s === 'click')
            return 'happy';
        if (s === 'moving')
            return 'closed';    // süzülürken gözler kısık: "— —"
        if (this.t < this._blinkUntil)
            return 'closed';
        if (s === 'thinking')
            return 'squint';
        if (s === 'idle' && this._valence > 0.6)
            return 'happy';
        return 'open';
    }

    frame() {
        return this.kind === 'pointer' ? this._pointer() : this._head();
    }

    // Yuvarlak robot, 32 x 32: 2 piksel kenar payı (kıvılcım, z, el için), robot 28 x 25.
    _head() {
        const g = new Grid(32, 32);
        const t = this.t;
        const s = this.state;
        const lvl = this._level;
        const failed = s === 'failed';
        const asleep = s === 'sleeping';
        const lit = failed ? 'R' : asleep ? 'B' : 'C';
        const core = failed ? 'r' : asleep ? 'B' : 'c';
        const X = 2;
        const Y = 4;
        // Nefes: gövde 1 piksel iner kalkar (bacaklar yerinde); uykuda ve hatada daha alçak.
        const breath = Math.sin(t * (2.2 + 1.5 * this._arousal)) > 0.3 ? 1 : 0;
        const sink = (asleep || failed ? 1 : 0) + breath;
        const hop = Math.round(this._hop.y);
        const by = Y + sink + hop;

        // Bacaklar: yürürken sırayla kalkar.
        const walk = this.walking || this._emoting('walk');
        const stepA = walk && Math.sin(t * 12) > 0 ? -1 : 0;
        const stepB = walk && Math.sin(t * 12) <= 0 ? -1 : 0;
        const legY = Y + 19 + hop;
        g.body(roundRect(0, 0, 4, 4, 1), {dx: X + 7, dy: legY + stepA, shine: false});
        g.body(roundRect(0, 0, 4, 4, 1), {dx: X + 16, dy: legY + stepB, shine: false});
        g.rect(X + 9, legY + 3 + stepA, 1, 2, 'o');   // ayakta küçük çentik
        g.rect(X + 18, legY + 3 + stepB, 1, 2, 'o');

        // Kulaklar (ışıklar dinlerken sesle parlar).
        const earLit = s === 'listening' ? (lvl > 0.15 || Math.sin(t * 8) > 0 ? 'c' : 'C') : lit;
        for (const ex of [0, 24]) {
            g.body(roundRect(0, 0, 3, 7, 1), {dx: X + ex, dy: by + 7, shine: false, base: 'L', light: 'L'});
            g.rect(X + ex + 1, by + 8, 2, 5, earLit);
            g.rect(X + ex + (ex ? 2 : 1), by + 9, 1, 2, core);
            g.glow(X + ex + 2, by + 10.5, 5 + (s === 'listening' ? 3 * lvl : 0), lit, s === 'listening' ? 0.5 : 0.25);
        }
        // El sallama: sağ kulağın yanından kalkan küçük bir el.
        if (this._emoting('wave')) {
            const up = Math.sin(t * 14) > 0 ? -1 : 0;
            g.body(roundRect(0, 0, 3, 4, 1), {dx: X + 27, dy: by + 3 + up, shine: false});
        }

        // Kafa.
        g.body(roundRect(3, 0, 24, 19, 7), {dx: X, dy: by});
        // Anten ışığı: tepede, karanlık yuvasında; düşünürken hızlı yanıp söner.
        g.rect(X + 12, by - 1, 4, 5, 'o');
        const blinkRate = s === 'thinking' ? 9 : 2.2;
        const ant = failed ? (Math.sin(t * 10) > 0 ? 'R' : 'o') : Math.sin(t * blinkRate) > -0.6 ? lit : 'B';
        g.rect(X + 13, by - 1, 2, 4, ant);
        if (ant !== 'B' && ant !== 'o')
            g.set(X + 13, by - 1, core);
        g.glow(X + 14, by + 1, 6, lit, ant === 'B' ? 0.1 : 0.35);

        // Vizör.
        g.body(roundRect(0, 0, 15, 9, 3), {dx: X + 6, dy: by + 5, base: 'V', light: 'V', shade: 'V', shine: false});
        for (let y = 0; y <= 9; y++)
            for (let x = 0; x <= 15; x++)
                if (g.get(X + 6 + x, by + 5 + y) === 'o')
                    g.set(X + 6 + x, by + 5 + y, 'D');
        // Gözler.
        const kind = this._eyeKind();
        const [lx, ly] = this._eye;
        const ex = Math.round(lx);
        const ey = Math.round(ly);
        const eyeY = by + 7 + (kind === 'open' || kind === 'squint' ? ey : 0);
        const left = X + 9 + (kind === 'open' || kind === 'squint' ? ex : 0);
        const right = X + 16 + (kind === 'open' || kind === 'squint' ? ex : 0);
        if (this._emoting('wink')) {
            eye(g, left, eyeY, 'open', {lit, core});
            eye(g, right, eyeY, 'wink', {lit, core});
        } else {
            const opt = {lit, core, w: kind === 'wide' ? 2 : 2, h: kind === 'wide' ? 4 : 4};
            eye(g, left - (kind === 'happy' || kind === 'x' ? 1 : 0), eyeY, kind, opt);
            eye(g, right - (kind === 'happy' || kind === 'x' ? 0 : 0), eyeY, kind, opt);
        }
        g.glow(X + 14, by + 9, 9, lit, kind === 'closed' ? 0.12 : 0.22);
        // Ağız: konuşurken sesle açılır, şaşırınca küçük "o".
        if (s === 'speaking') {
            const w = 2 + Math.round(lvl * 2) * 2 / 2;
            const h = lvl > 0.45 ? 2 : 1;
            g.rect(X + 14 - Math.floor(w / 2), by + 12, w, h, lit);
        } else if (this._emoting('surprise')) {
            g.rect(X + 13, by + 12, 2, 1, lit);
        }

        // Göğüs ışığı: konuşurken sesle, yoksa yavaş nabız.
        g.rect(X + 12, by + 15, 4, 3, 'o');
        const chest = s === 'speaking' ? (lvl > 0.3 ? 'c' : lit) : Math.sin(t * 1.6) > -0.2 ? lit : 'B';
        g.rect(X + 13, by + 16, 2, 1, chest);
        g.glow(X + 14, by + 16.5, 4, lit, chest === 'B' ? 0.08 : 0.3);

        // Yer gölgesi (zıplarken küçülür).
        const sw = hop < -2 ? 14 : 18;
        g.rect(X + 14 - sw / 2, Y + 24, sw, 1, 's');

        // Efektler: kıvılcım (sevinç/şaşkınlık/dinleme), z (uyku), soru işareti yerine nokta nokta (düşünme).
        if (this._emoting('joy') || this._emoting('surprise') || (s === 'listening' && lvl > 0.25)) {
            const k = Math.floor((t - (this._emote?.since ?? 0)) * 8) % 2;
            for (const [x, y] of [[X + 22, by - 2], [X + 25, by], [X + 20, by - 3 - k]])
                g.set(x, y, 'C');
            g.set(X + 26, by + 1 - k, 'C');
        }
        if (asleep) {
            const z = Math.floor(t * 1.5) % 3;
            const zx = X + 23 + z;
            const zy = by - 1 - z * 1;
            for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 0], [2, 1], [1, 2], [0, 3], [1, 3], [2, 3], [3, 3]])
                g.set(zx + x, zy - 2 + y, 'B');
        }
        if (s === 'thinking') {
            const n = Math.floor(t * 3) % 4;
            for (let i = 0; i < n; i++)
                g.set(X + 22 + i * 2, by - 2, 'C');
        }
        return {grid: g, hot: [0, 0], w: g.w, h: g.h};
    }

    // Ok robot, 22 x 24 (referanstan örneklenen biçim). Ucu (sıcak nokta) frame().hot'ta. Biçim referanstan satır satır alındı.
    _pointer() {
        const g = new Grid(22, 24);
        const t = this.t;
        const s = this.state;
        const failed = s === 'failed';
        const lit = failed ? 'R' : 'C';
        const core = failed ? 'r' : 'c';
        // Tıklarken bir an basılır (1 piksel aşağı-sağa); boştayken kuyruk hafifçe oynar.
        const press = s === 'click' && t - this._since < 0.18 ? 1 : 0;
        const X = 1 + press;
        const Y = 1 + press;
        const wag = s === 'idle' && Math.sin(t * 2.4) > 0.5 ? 1 : 0;
        const at = (x, y, c) => g.set(X + x, Y + y, c);
        const rect = (x, y, w, h, c) => g.rect(X + x, Y + y, w, h, c);

        // Kuyruk (bacak): gövdenin altından sağ alta.
        const TAIL = {16: [7, 11], 17: [7, 12], 18: [8, 12], 19: [9, 12], 20: [9, 12]};
        g.body((x, y) => TAIL[y] && x >= TAIL[y][0] && x <= TAIL[y][1], {dx: X, dy: Y + wag, shine: false});
        rect(9, 17 + wag, 3, 3, 'o');
        at(10, 18 + wag, s === 'moving' || s === 'click' ? 'c' : lit);
        g.glow(X + 10.5, Y + 18.5 + wag, 4, lit, 0.3);
        // Gövde: kalın ok üçgeni; uç 3 piksel geniş, sağ köşe 12. satırda.
        const BODY = (x, y) => {
            if (y < 0 || y > 16 || x < 3)
                return false;
            const right = y <= 12 ? 5 + y : y === 13 ? 16 : 11;
            return x <= right;
        };
        g.body(BODY, {dx: X, dy: Y});
        // Kulak: sol yanda, gövdenin kenarına yapışık.
        g.body(roundRect(0, 0, 3, 6, 1), {dx: X, dy: Y + 7, shine: false, base: 'L', light: 'L'});
        rect(1, 8, 1, 4, lit);
        at(1, 8, core);
        g.glow(X + 1.5, Y + 10, 4, lit, 0.3);
        // Anten ışığı: üst kenar boyunca çapraz bir çubuk.
        const ant = Math.sin(t * (s === 'moving' ? 10 : 2.2)) > -0.5 ? lit : 'B';
        for (const [x, y] of [[5, 2], [6, 3], [7, 4], [8, 5]]) {
            at(x, y, ant);
            at(x + 1, y, ant === 'B' ? 'B' : y < 4 ? core : ant);
            at(x - 1, y + 1, 'o');
        }
        g.glow(X + 7, Y + 3.5, 4, lit, ant === 'B' ? 0.1 : 0.3);
        // Vizör: sağ kenarı gövdenin eğimini izler, köşeleri yuvarlak.
        const VISOR = {7: [6, 10], 8: [5, 11], 9: [5, 12], 10: [5, 13], 11: [5, 13], 12: [6, 13]};
        for (const [y, [x0, x1]] of Object.entries(VISOR))
            for (let x = x0; x <= x1; x++)
                at(x, +y, 'V');
        // Gözler.
        let kind = this._eyeKind();
        if (s === 'thinking' || kind === 'squint' || kind === 'wide')
            kind = 'open';
        const ox = kind === 'open' ? Math.round(this._eye[0] * 0.6) : 0;
        if (kind === 'happy') {
            for (const ex of [6, 10]) {
                at(ex, 10, lit);
                at(ex + 1, 9, lit);
                at(ex + 2, 10, lit);
            }
        } else if (kind === 'closed') {
            rect(6, 10, 3, 1, lit);
            rect(10, 10, 3, 1, lit);
        } else if (kind === 'x') {
            for (const ex of [6, 10]) {
                at(ex, 9, lit); at(ex + 1, 10, lit); at(ex, 11, lit); at(ex + 1, 9, null); at(ex + 2, 9, lit); at(ex + 2, 11, lit);
            }
        } else {
            for (const ex of [6, 10]) {
                rect(ex + ox, 9, 2, 3, lit);
                at(ex + ox, 9, core);
                at(ex + ox + 1, 9, core);
            }
        }
        g.glow(X + 9, Y + 10, 6, lit, 0.2);
        // Göğüs ışığı.
        rect(5, 13, 3, 3, 'o');
        at(6, 14, s === 'click' ? 'c' : lit);
        g.glow(X + 6.5, Y + 14.5, 3, lit, 0.25);
        // Efektler: tıklayınca uçta kıvılcım, süzülürken arkada toz.
        if (s === 'click' && t - this._since < 0.7) {
            const k = t - this._since < 0.25 ? 0 : 1;
            for (const [x, y] of [[8, 0], [10, 1], [11, 3]])
                at(x + k, y - k, 'C');
        }
        if (s === 'moving') {
            const k = Math.floor(t * 10) % 3;
            at(15 + k, 20, 'B');
            at(16, 16 + (k % 2), 'C');
            at(17, 17 - (k % 2), 'C');
            at(13 - k, 21, 'B');
        }
        return {grid: g, hot: [X + 3, Y], w: g.w, h: g.h};
    }
}

// ---------- Kabuklar ----------

function rgb(hex) {
    if (hex.startsWith('rgba')) {
        const [r, g, b, a] = hex.slice(5, -1).split(',').map(Number);
        return [r / 255, g / 255, b / 255, a];
    }
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}
const RGB = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, rgb(v)]));

// glow: neon ışığın etrafına yumuşak hale (0 kapatır).
export function drawCanvas(ctx, frame, {x = 0, y = 0, px = 4, glow = 1} = {}) {
    const g = frame.grid;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    if (glow) {
        for (const q of g.glows) {
            const [r, gg, b] = RGB[q.color];
            const grad = ctx.createRadialGradient(q.x * px, q.y * px, 0, q.x * px, q.y * px, q.r * px);
            const c = a => `rgba(${r * 255 | 0},${gg * 255 | 0},${b * 255 | 0},${a})`;
            grad.addColorStop(0, c(q.a * glow));
            grad.addColorStop(1, c(0));
            ctx.fillStyle = grad;
            ctx.fillRect((q.x - q.r) * px, (q.y - q.r) * px, q.r * 2 * px, q.r * 2 * px);
        }
    }
    // Kesirli ölçekte her kenar tam piksele oturur (bulanık kenar yok).
    for (const [cx, cy, n, c] of g.runs()) {
        ctx.fillStyle = COLORS[c];
        const x0 = Math.round(cx * px);
        const y0 = Math.round(cy * px);
        ctx.fillRect(x0, y0, Math.round((cx + n) * px) - x0, Math.round((cy + 1) * px) - y0);
    }
    ctx.restore();
}

export function drawCairo(cr, frame, {x = 0, y = 0, px = 1, glow = 1, Cairo = null} = {}) {
    const g = frame.grid;
    cr.save();
    cr.translate(Math.round(x), Math.round(y));
    if (glow && Cairo) {
        for (const q of g.glows) {
            const [r, gg, b] = RGB[q.color];
            const pat = new Cairo.RadialGradient(q.x * px, q.y * px, 0, q.x * px, q.y * px, q.r * px);
            pat.addColorStopRGBA(0, r, gg, b, q.a * glow);
            pat.addColorStopRGBA(1, r, gg, b, 0);
            cr.setSource(pat);
            cr.rectangle((q.x - q.r) * px, (q.y - q.r) * px, q.r * 2 * px, q.r * 2 * px);
            cr.fill();
        }
    }
    cr.setAntialias(1); // NONE: piksel sanat keskin kalsın
    for (const [cx, cy, n, c] of g.runs()) {
        cr.setSourceRGBA(...RGB[c]);
        const x0 = Math.round(cx * px);
        const y0 = Math.round(cy * px);
        cr.rectangle(x0, y0, Math.round((cx + n) * px) - x0, Math.round((cy + 1) * px) - y0);
        cr.fill();
    }
    cr.restore();
}
