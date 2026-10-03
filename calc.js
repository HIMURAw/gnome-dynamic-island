// Small, safe evaluators for the command palette: arithmetic, unit conversion
// and durations. No eval(); anything not understood returns null.

// Arithmetic: + - * / % ^, parentheses, decimals with . or , ("2,5 * 4").
export function calculate(text) {
    const src = text.replace(/\s+/g, '').replace(/,/g, '.').replace(/[x×]/g, '*').replace(/÷/g, '/');
    if (!/^[\d.+\-*/%^()]+$/.test(src) || !/\d/.test(src) || !/[+\-*/%^]/.test(src.replace(/^-/, '')))
        return null;
    let pos = 0;
    const peek = () => src[pos];
    const number = () => {
        const match = /^\d*\.?\d+(e[+-]?\d+)?/.exec(src.slice(pos));
        if (!match)
            throw new Error('number');
        pos += match[0].length;
        return parseFloat(match[0]);
    };
    const factor = () => {
        if (peek() === '-') {
            pos++;
            return -factor();
        }
        if (peek() === '+') {
            pos++;
            return factor();
        }
        let value;
        if (peek() === '(') {
            pos++;
            value = sum();
            if (src[pos++] !== ')')
                throw new Error('paren');
        } else {
            value = number();
        }
        if (peek() === '%') {
            pos++;
            value /= 100;
        }
        if (peek() === '^') {
            pos++;
            value **= factor();
        }
        return value;
    };
    const product = () => {
        let value = factor();
        while (peek() === '*' || peek() === '/') {
            const op = src[pos++];
            value = op === '*' ? value * factor() : value / factor();
        }
        return value;
    };
    const sum = () => {
        let value = product();
        while (peek() === '+' || peek() === '-') {
            const op = src[pos++];
            value = op === '+' ? value + product() : value - product();
        }
        return value;
    };
    try {
        const value = sum();
        return pos === src.length && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

export function formatNumber(value) {
    if (Math.abs(value) >= 1e15 || (Math.abs(value) < 1e-6 && value !== 0))
        return value.toExponential(6).replace(/\.?0+e/, 'e');
    return String(parseFloat(value.toPrecision(12)));
}

// Units, each relative to a base unit of its kind.
const UNITS = {
    length: {mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, inch: 0.0254, ft: 0.3048, feet: 0.3048,
        yd: 0.9144, mi: 1609.344, mile: 1609.344, mil: 1609.344},
    mass: {mg: 1e-6, g: 0.001, gr: 0.001, kg: 1, ton: 1000, t: 1000, oz: 0.028349523125,
        lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237},
    volume: {ml: 0.001, cl: 0.01, l: 1, lt: 1, gal: 3.785411784, gallon: 3.785411784, cup: 0.2365882365},
    data: {b: 1, byte: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3},
    speed: {'km/h': 1, kmh: 1, 'mph': 1.609344, 'm/s': 3.6, knot: 1.852},
    time: {ms: 0.001, s: 1, sn: 1, sec: 1, min: 60, dk: 60, h: 3600, sa: 3600, saat: 3600, hour: 3600,
        day: 86400, gün: 86400, gun: 86400, week: 604800, hafta: 604800},
};
const TEMPS = {c: 'c', '°c': 'c', celsius: 'c', f: 'f', '°f': 'f', fahrenheit: 'f', k: 'k', kelvin: 'k'};

function kindOf(unit) {
    for (const [kind, table] of Object.entries(UNITS)) {
        if (unit in table)
            return [kind, table[unit]];
    }
    return [null, null];
}

// "5 km to mi", "100 f in c", "2.5 gb mb", "3 saat dk"
export function convert(text) {
    const match = /^\s*(-?[\d.,]+)\s*([a-zA-Z°/ğüşıöç]+)\s+(?:to|in|=|->|>)?\s*([a-zA-Z°/ğüşıöç]+)\s*$/i.exec(text);
    if (!match)
        return null;
    const value = parseFloat(match[1].replace(',', '.'));
    const from = match[2].toLowerCase();
    const to = match[3].toLowerCase();
    if (!Number.isFinite(value))
        return null;
    if (TEMPS[from] && TEMPS[to]) {
        const toC = {c: v => v, f: v => (v - 32) * 5 / 9, k: v => v - 273.15}[TEMPS[from]](value);
        const out = {c: v => v, f: v => v * 9 / 5 + 32, k: v => v + 273.15}[TEMPS[to]](toC);
        return {value: out, unit: match[3]};
    }
    const [kindA, a] = kindOf(from);
    const [kindB, b] = kindOf(to);
    if (!kindA || kindA !== kindB)
        return null;
    return {value: value * a / b, unit: match[3]};
}

// A timer length: "25m", "25 dk", "1h30m", "90s", "10" (minutes). Returns seconds.
export function parseDuration(text) {
    const src = text.trim().toLowerCase();
    if (/^\d+(?:[.,]\d+)?$/.test(src))
        return Math.round(parseFloat(src.replace(',', '.')) * 60);
    const re = /(\d+(?:[.,]\d+)?)\s*(h|sa|saat|hour|hours|m|min|dk|dakika|minutes?|s|sn|sec|saniye|seconds?)(?![a-zğüşıöç])/g;
    let total = 0;
    let used = '';
    for (const [whole, num, unit] of src.matchAll(re)) {
        const n = parseFloat(num.replace(',', '.'));
        total += /^(h|sa|saat|hour)/.test(unit) ? n * 3600 : /^(m|min|dk|dakika)/.test(unit) ? n * 60 : n;
        used += whole;
    }
    return total > 0 && used.replace(/\s/g, '').length === src.replace(/\s/g, '').length ? Math.round(total) : null;
}
