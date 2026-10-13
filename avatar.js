// Harvis'in karakteri: Claude yıldızı ailesinden turuncu bir kıvılcım. Ortada bir gövde, çevresinde
// düzensiz boylu ışınlar, gövdede iki göz ve konuşurken açılan bir ağız. Işınlar onun kolları ve
// saçı gibi: nefes alırken uzayıp kısalıyor, düşünürken fırıldak gibi dönüyor, dinlerken sese
// göre titreşiyor, hata olunca sarkıyor.
//
// Bu dosya hiçbir platforma bağlı değil (DOM yok, GJS yok): şekli birim koordinatlarda üretir
// (merkez 0,0; en uzun ışın ~1). Çizim kabuklara kalır: tarayıcıda Canvas, GNOME'da Cairo,
// imleç temasında Python + Cairo. Böylece karakter tek yerde yaşar.
//
//   const a = new Avatar({ compact: true })
//   a.setState('idle' | 'listening' | 'thinking' | 'speaking' | 'failed' | 'sleeping')
//   a.setLevel(0..1)                     // ses yüksekliği (dinlerken Umut'un, konuşurken Harvis'in)
//   a.setMood(valence -1..1, arousal 0..1)
//   a.lookAt(x, y) / a.lookAt(null)      // bakış yönü, birim; null → kendi kendine etrafa bakar
//   a.emote('surprise' | 'joy' | 'nod')
//   a.step(dt)                           // saniye
//   a.shapes()                           // → çizilecek parçalar
//   drawCanvas(ctx, a.shapes(), {x, y, size}) / drawCairo(cr, a.shapes(), {x, y, size})
//
// Kopyaları: GNOME adası `gnome-dynamic-island/avatar.js` (aynı dosya, `tools/sync-avatar.sh`).

export const PALETTE = {
    body: [0.871, 0.467, 0.341],    // #DE7757, Claude turuncusu ailesi
    warm: [0.957, 0.588, 0.384],    // keyifliyken
    blue: [0.639, 0.471, 0.757],    // mahcupken hafif mora kayar
    failed: [0.886, 0.306, 0.278],
    dim: [0.52, 0.4, 0.36],
    face: [0.188, 0.082, 0.047],
    outline: [1, 1, 1],
};

const TAU = Math.PI * 2;
// Işınlar bilerek düzensiz: eşit boylu bir yıldız güneş gibi durur, bu bir el çizimi gibi.
const RAY_LEN = [1.0, 0.8, 0.94, 0.76, 0.98, 0.84, 0.97, 0.79, 0.91, 0.86];
const RAY_JIT = [0, 0.11, -0.07, 0.09, -0.1, 0.06, -0.04, 0.12, -0.08, 0.05];
const RAY_PH = [0, 1.7, 3.1, 4.4, 0.9, 2.6, 5.2, 3.8, 1.2, 4.9];

const STATES = {
    //          uzanma  dönüş  dalga  dalga hızı  göz   sarkma kıvrılma  renk
    idle:      {reach: 1.0, spin: 0.06, wave: 0.035, waveSpeed: 1.4, eye: 1.0, droop: 0, curl: 0, tint: 0},
    listening: {reach: 1.08, spin: 0, wave: 0.03, waveSpeed: 2.2, eye: 1.18, droop: 0, curl: 0, tint: 0},
    thinking:  {reach: 0.96, spin: 1.5, wave: 0.12, waveSpeed: 5.5, eye: 0.62, droop: 0, curl: 0.38, tint: 0},
    speaking:  {reach: 1.02, spin: 0.15, wave: 0.05, waveSpeed: 3, eye: 0.92, droop: 0, curl: 0, tint: 0},
    failed:    {reach: 0.78, spin: 0, wave: 0.02, waveSpeed: 1, eye: 0.7, droop: 0.55, curl: 0, tint: 1},
    sleeping:  {reach: 0.6, spin: 0.015, wave: 0.02, waveSpeed: 0.6, eye: 0, droop: 0.25, curl: 0, tint: 0},
};

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

const approach = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));
const mix = (a, b, k) => a.map((x, i) => x + (b[i] - x) * k);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Avatar {
    // compact: küçük boyutlar için (ada, imleç) gövde ve gözler büyür, ışınlar kısalır — 20 piksellik
    //          bir yıldızda göz 1 piksel kalmasın.
    // pointer: imleç; bir ışın sol üste uzanıp sivri uçla biter (tıklama noktası), gözler oraya bakar.
    constructor({compact = false, pointer = false, seed = 7} = {}) {
        this.compact = compact;
        this.pointer = pointer;
        this.state = 'idle';
        this.t = 0;
        this._rand = rng(seed);
        this._level = 0;
        this._levelIn = 0;
        this._valence = 0;
        this._arousal = 0.4;
        this._look = null;
        const s = STATES.idle;
        this.p = {...s, spinPhase: 0, lookX: 0, lookY: 0, mouth: 0, happy: 0, sad: 0, sleep: 0};
        this._pop = {x: 0, v: 0};   // anlık sıçrama (yay)
        this._bob = {x: 0, v: 0};   // aşağı-yukarı (yay)
        this._shake = 0;
        this._blink = 0;
        this._nextBlink = 1.5 + this._rand() * 3;
        this._glance = [0, 0];
        this._nextGlance = 2 + this._rand() * 3;
        this._joyUntil = -1;
        this._surpriseUntil = -1;
    }

    setState(state) {
        if (!STATES[state] || state === this.state)
            return;
        const from = this.state;
        this.state = state;
        // Her geçiş tek bir hareket gibi okunsun: küçük bir sıçrama.
        if (state === 'failed') {
            this._shake = 1;
            this._pop.v -= 2.5;
        } else if (state === 'listening') {
            this._pop.v += 5;   // "efendim?" diye kulak kabartır
            this._blink = 0;
        } else if (from === 'sleeping') {
            this._pop.v += 6;
        } else if (state !== 'sleeping') {
            this._pop.v += 2.5;
        }
    }

    setLevel(level) {
        this._levelIn = clamp(level || 0, 0, 1);
    }

    setMood(valence, arousal) {
        this._valence = clamp(valence ?? 0, -1, 1);
        this._arousal = clamp(arousal ?? 0.4, 0, 1);
    }

    lookAt(x, y) {
        if (x == null || !Number.isFinite(x) || !Number.isFinite(y)) {
            this._look = null;
            return;
        }
        const d = Math.hypot(x, y);
        this._look = d > 1 ? [x / d, y / d] : [x, y];
    }

    emote(name) {
        if (name === 'joy') {
            this._joyUntil = this.t + 1.6;
            this._bob.v -= 4;
        } else if (name === 'surprise') {
            this._surpriseUntil = this.t + 0.9;
            this._pop.v += 9;
        } else if (name === 'nod') {
            this._bob.v += 3.5;
        }
    }

    step(dt) {
        dt = clamp(dt, 0, 0.1);
        this.t += dt;
        const t = this.t;
        const p = this.p;
        const st = STATES[this.state];
        const energy = 0.75 + 0.6 * this._arousal;

        // Ses: hızlı yükselir, yavaş söner — konuşma gibi görünsün, titreme gibi değil.
        this._level = approach(this._level, this._levelIn, this._levelIn > this._level ? 25 : 7, dt);

        for (const k of ['reach', 'wave', 'eye', 'droop', 'curl', 'tint'])
            p[k] = approach(p[k], st[k], k === 'eye' ? 14 : 5, dt);
        p.waveSpeed = approach(p.waveSpeed, st.waveSpeed * energy, 3, dt);
        p.spin = approach(p.spin, st.spin * energy, 2.5, dt);
        p.spinPhase += p.spin * dt;
        p.sleep = approach(p.sleep, this.state === 'sleeping' ? 1 : 0, 3, dt);

        const happyTarget = t < this._joyUntil ? 1
            : this.state === 'idle' && this._valence > 0.55 ? 0.8 : 0;
        p.happy = approach(p.happy, happyTarget, 9, dt);
        p.sad = approach(p.sad, this.state === 'failed' ? 1 : clamp(-this._valence - 0.3, 0, 0.6), 5, dt);
        const speaking = this.state === 'speaking';
        p.mouth = approach(p.mouth, speaking ? 0.15 + 0.85 * this._level : 0, speaking ? 22 : 8, dt);

        // Yaylar: sıçrama ışınları uzatır, bob gövdeyi oynatır.
        for (const [s, k, c] of [[this._pop, 120, 11], [this._bob, 90, 9]]) {
            s.v += (-k * s.x - c * s.v) * dt;
            s.x += s.v * dt;
        }
        if (speaking)
            this._bob.v -= this._level * 14 * dt;   // vurguda hafif kalkar
        this._shake = approach(this._shake, 0, 4, dt);

        // Göz kırpma: 2-6 saniyede bir, bazen iki kere.
        if (this.state !== 'sleeping' && t > this._nextBlink) {
            this._blink = 1;
            this._nextBlink = t + (this._rand() < 0.2 ? 0.28 : 2 + this._rand() * 4);
        }
        this._blink = Math.max(0, this._blink - dt / 0.17);

        // Bakış: imleci (ya da verilen yönü) izler; yoksa ara sıra etrafa göz atar.
        let look;
        if (this.pointer) {
            look = [-0.72, -0.72];
        } else if (this.state === 'thinking') {
            look = [0.55 + 0.25 * Math.sin(t * 1.3), -0.7];   // düşünürken yukarı, yana
        } else if (this._look) {
            look = this._look;
        } else {
            if (t > this._nextGlance) {
                const r = this._rand();
                this._glance = r < 0.45 ? [0, 0] : [(this._rand() - 0.5) * 1.6, (this._rand() - 0.5) * 0.9];
                this._nextGlance = t + 1.5 + this._rand() * 4;
            }
            look = this._glance;
        }
        p.lookX = approach(p.lookX, look[0], 10, dt);
        p.lookY = approach(p.lookY, look[1], 10, dt);
    }

    // Göz açıklığı 0..1+ (kırpma, uyku ve şaşkınlık dahil).
    _eyeOpen() {
        const blink = Math.sin(Math.PI * (1 - this._blink)) ** 0.5;
        const k = this._blink > 0 ? 1 - blink : 1;
        const surprise = this.t < this._surpriseUntil ? 0.35 : 0;
        return Math.max(0, (this.p.eye + surprise) * k * (1 - this.p.sleep));
    }

    shapes() {
        const p = this.p;
        const t = this.t;
        const lvl = this._level;
        const compact = this.compact;
        const core = compact ? 0.54 : 0.36;
        const lenK = compact ? 0.96 : 1;
        const thick = compact ? 1.45 : 1.15;
        const breath = Math.sin(t * (1.1 + 0.6 * this._arousal)) * 0.5 + 0.5;
        const shakeX = Math.sin(t * 48) * 0.08 * this._shake;
        const cx = shakeX;
        const cy = this._bob.x * 0.06 + p.sleep * 0.04;

        let color = mix(PALETTE.body, PALETTE.warm, clamp(this._valence, 0, 1) * 0.5 + p.happy * 0.2);
        color = mix(color, PALETTE.blue, clamp(-this._valence, 0, 1) * 0.35);
        color = mix(color, PALETTE.failed, p.tint);
        color = mix(color, PALETTE.dim, p.sleep * 0.55);   // uyurken soluk; saydamlık üst üste binmeleri gösterirdi
        const alpha = 1;
        const body = [...color, alpha];
        const out = [];

        // Işınlar.
        // Küçük boyda 8 ışın: 10 tanesi 20 pikselde birbirine karışıyor.
        const rays = compact ? [0, 1, 2, 4, 5, 6, 8, 9] : RAY_LEN.map((_, i) => i);
        const n = rays.length;
        const listening = this.state === 'listening';
        const speaking = this.state === 'speaking';
        for (let j = 0; j < n; j++) {
            const i = rays[j];
            let a = (j / n) * TAU + RAY_JIT[i] - Math.PI / 2 + p.spinPhase;
            a += 0.045 * Math.sin(t * 0.9 + RAY_PH[i]);
            let len = RAY_LEN[i] * lenK;
            let tipW = 0.11 * thick;
            let baseW = 0.085 * thick;
            if (this.pointer) {
                // İmleç: biri uzun ve sivri (sol üst), diğerleri kısa.
                if (i === 0) {
                    a = -0.75 * Math.PI;
                    len = 1.3;
                    tipW = 0.03;
                    baseW = 0.34;
                } else {
                    len = core + 0.12 + 0.1 * RAY_LEN[i];
                }
            }
            let k = p.reach * (1 + this._pop.x * 0.18);
            k *= 1 + p.wave * Math.sin(a * 3 - t * p.waveSpeed + RAY_PH[i] * 0.6);
            k *= 1 + 0.03 * breath;
            if (listening || speaking)
                k *= 1 + lvl * (0.16 + 0.12 * Math.sin(t * 17 + RAY_PH[i] * 2.1));
            const L = core * 0.6 + (len - core * 0.6) * k;
            const bend = p.curl + p.droop * Math.cos(a) * 0.9;
            out.push({k: 'poly', body: true, fill: body, pts: ray(cx, cy, a, core * 0.55, L, bend, baseW, tipW)});
        }

        // Gövde.
        out.push({k: 'ellipse', body: true, fill: body, x: cx, y: cy, rx: core, ry: core * (1 - 0.03 * breath)});

        // Yüz.
        const face = [...PALETTE.face, alpha];
        const ex = compact ? 0.2 : 0.14;
        const erx = compact ? 0.1 : 0.065;
        const ery = compact ? 0.16 : 0.1;
        const lx = p.lookX * (compact ? 0.075 : 0.06);
        const ly = p.lookY * (compact ? 0.06 : 0.05) - (compact ? 0.03 : 0.02);
        const open = this._eyeOpen();
        const lw = compact ? 0.07 : 0.04;
        for (const side of [-1, 1]) {
            const x = cx + side * ex + lx;
            const y = cy + ly;
            if (p.happy > 0.5 && open > 0.2) {
                // Gülen göz: ∩
                out.push({k: 'line', stroke: face, width: lw, pts: arc(x, y + ery * 0.35, erx * 1.15, Math.PI, TAU)});
            } else if (open < 0.18) {
                // Kapalı göz: uyurken ∪, kırparken düz çizgi.
                const pts = p.sleep > 0.5
                    ? arc(x, y - ery * 0.15, erx * 1.1, 0.15, Math.PI - 0.15)
                    : [x - erx, y, x + erx, y];
                out.push({k: 'line', stroke: face, width: lw * 0.9, pts});
            } else {
                out.push({k: 'ellipse', fill: face, x, y, rx: erx, ry: ery * open});
            }
            // Üzgün/hata: içe doğru düşen kaşlar.
            if (p.sad > 0.15 && open > 0.18) {
                const by = y - ery * open - (compact ? 0.06 : 0.045);
                const d = 0.05 * p.sad;
                out.push({k: 'line', stroke: face, width: lw * 0.8,
                    pts: [x - side * erx * 1.2, by + d, x + side * erx * 1.1, by - d]});
            }
        }
        // Ağız: konuşurken sesle açılır; keyifliyken küçük bir gülümseme.
        const my = cy + (compact ? 0.24 : 0.16) + ly * 0.5;
        if (p.mouth > 0.04) {
            const m = p.mouth;
            out.push({k: 'ellipse', fill: face, x: cx + lx * 0.6, y: my,
                rx: (compact ? 0.09 : 0.055) * (0.7 + 0.5 * m), ry: (compact ? 0.1 : 0.065) * m});
        } else if (p.happy > 0.3 || this._valence > 0.4) {
            out.push({k: 'line', stroke: face, width: lw * 0.8,
                pts: arc(cx + lx * 0.6, my - 0.04, compact ? 0.07 : 0.05, 0.35, Math.PI - 0.35)});
        }
        if (p.sleep > 0.6 && !compact) {
            // Uykuda "z"
            const z = (t * 0.4) % 1;
            const s = 0.06 + 0.04 * z;
            const zx = cx + 0.45 + z * 0.25;
            const zy = cy - 0.45 - z * 0.35;
            out.push({k: 'line', stroke: [...color, (1 - z) * 0.9], width: 0.03,
                pts: [zx - s, zy - s, zx + s, zy - s, zx - s, zy + s, zx + s, zy + s]});
        }
        return out;
    }
}

// Tek bir ışın: merkezden dışa, bükülebilen, uca doğru hafifçe genişleyen, yuvarlak (ya da sivri) uçlu.
function ray(cx, cy, a, r0, r1, bend, w0, w1) {
    const N = 7;
    const left = [];
    const right = [];
    let ang = a;
    let px = 0;
    let py = 0;
    for (let j = 0; j <= N; j++) {
        const s = j / N;
        const r = r0 + (r1 - r0) * s;
        ang = a + bend * s * s;
        px = cx + Math.cos(ang) * r;
        py = cy + Math.sin(ang) * r;
        const w = w0 + (w1 - w0) * s;
        const nx = -Math.sin(ang);
        const ny = Math.cos(ang);
        left.push(px + nx * w, py + ny * w);
        right.push(px - nx * w, py - ny * w);
    }
    const tip = [];
    for (let j = 1; j < 6; j++) {
        const q = ang + Math.PI / 2 - (j / 6) * Math.PI;
        tip.push(px + Math.cos(q) * w1, py + Math.sin(q) * w1);
    }
    const back = [];
    for (let j = right.length - 2; j >= 0; j -= 2)
        back.push(right[j], right[j + 1]);
    return [...left, ...tip, ...back];
}

function arc(x, y, r, a0, a1, n = 8) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * (i / n);
        pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    return pts;
}

// ---------- Kabuklar ----------
// size: en uzun ışından ışına çap (piksel). outline: gövdenin çevresine kontur (imleç için).

function rgba([r, g, b, a = 1]) {
    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

export function drawCanvas(ctx, shapes, {x, y, size, outline = null, outlineWidth = 0.09}) {
    const s = size / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const path = sh => {
        ctx.beginPath();
        if (sh.k === 'ellipse') {
            ctx.ellipse(sh.x, sh.y, Math.max(sh.rx, 1e-4), Math.max(sh.ry, 1e-4), 0, 0, TAU);
            return;
        }
        ctx.moveTo(sh.pts[0], sh.pts[1]);
        for (let i = 2; i < sh.pts.length; i += 2)
            ctx.lineTo(sh.pts[i], sh.pts[i + 1]);
        if (sh.k === 'poly')
            ctx.closePath();
    };
    if (outline) {
        ctx.strokeStyle = rgba(outline);
        ctx.lineWidth = outlineWidth * 2;
        for (const sh of shapes.filter(q => q.body)) {
            path(sh);
            ctx.stroke();
        }
    }
    for (const sh of shapes) {
        path(sh);
        if (sh.k === 'line') {
            ctx.strokeStyle = rgba(sh.stroke);
            ctx.lineWidth = sh.width;
            ctx.stroke();
        } else {
            ctx.fillStyle = rgba(sh.fill);
            ctx.fill();
        }
    }
    ctx.restore();
}

export function drawCairo(cr, shapes, {x, y, size, outline = null, outlineWidth = 0.09}) {
    const s = size / 2;
    cr.save();
    cr.translate(x, y);
    cr.scale(s, s);
    cr.setLineCap(1);   // Cairo.LineCap.ROUND
    cr.setLineJoin(1);  // Cairo.LineJoin.ROUND
    const path = sh => {
        cr.newPath();
        if (sh.k === 'ellipse') {
            cr.save();
            cr.translate(sh.x, sh.y);
            cr.scale(Math.max(sh.rx, 1e-4), Math.max(sh.ry, 1e-4));
            cr.arc(0, 0, 1, 0, TAU);
            cr.restore();
            return;
        }
        cr.moveTo(sh.pts[0], sh.pts[1]);
        for (let i = 2; i < sh.pts.length; i += 2)
            cr.lineTo(sh.pts[i], sh.pts[i + 1]);
        if (sh.k === 'poly')
            cr.closePath();
    };
    if (outline) {
        cr.setSourceRGBA(...outline, 1);
        cr.setLineWidth(outlineWidth * 2);
        for (const sh of shapes.filter(q => q.body)) {
            path(sh);
            cr.stroke();
        }
    }
    for (const sh of shapes) {
        path(sh);
        if (sh.k === 'line') {
            cr.setSourceRGBA(...sh.stroke);
            cr.setLineWidth(sh.width);
            cr.stroke();
        } else {
            cr.setSourceRGBA(...sh.fill);
            cr.fill();
        }
    }
    cr.restore();
}
