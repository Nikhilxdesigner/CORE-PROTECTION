/**
 * Seeded pseudo-random number generation.
 *
 * The whole simulation draws from these streams and never from Math.random,
 * which is what makes `?seed=` and recorded replays reproducible. Streams are
 * forked by label so that adding a new consumer (say, a new FX system) cannot
 * shift the numbers another consumer sees.
 */

/** FNV-1a style string hash -> uint32. */
export function hashString(str, seed = 0x811c9dc5) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

export function hashNumber(n, seed = 0x811c9dc5) {
    return hashString(String(n), seed);
}

/** mulberry32: small, fast, good enough distribution for gameplay. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class Rng {
    constructor(seed = 1) {
        this.seed = (typeof seed === 'number' ? seed : hashString(String(seed))) >>> 0;
        this._next = mulberry32(this.seed);
        this.draws = 0;
        this.label = 'root';
    }

    /** [0, 1) */
    float() {
        this.draws += 1;
        return this._next();
    }

    /** [min, max) */
    range(min, max) {
        return min + this.float() * (max - min);
    }

    /** Integer in [min, max] inclusive. */
    int(min, max) {
        if (max < min) [min, max] = [max, min];
        return Math.floor(min + this.float() * (max - min + 1));
    }

    /** True with probability p. */
    chance(p) {
        return this.float() < p;
    }

    pick(items) {
        if (!items || items.length === 0) return undefined;
        return items[this.int(0, items.length - 1)];
    }

    /** Weighted pick; `weightOf` defaults to item.weight. */
    weighted(items, weightOf = (item) => item.weight ?? 1) {
        if (!items || items.length === 0) return undefined;
        let total = 0;
        for (const item of items) total += Math.max(0, weightOf(item));
        if (total <= 0) return this.pick(items);
        let roll = this.float() * total;
        for (const item of items) {
            roll -= Math.max(0, weightOf(item));
            if (roll <= 0) return item;
        }
        return items[items.length - 1];
    }

    /** In-place Fisher-Yates using this stream. */
    shuffle(items) {
        for (let i = items.length - 1; i > 0; i--) {
            const j = this.int(0, i);
            [items[i], items[j]] = [items[j], items[i]];
        }
        return items;
    }

    /** Sample `count` distinct items (or fewer if the source is short). */
    sample(items, count) {
        const copy = items.slice();
        this.shuffle(copy);
        return copy.slice(0, Math.min(count, copy.length));
    }

    /** Deterministic child stream. */
    fork(label) {
        const child = new Rng(hashString(`${this.label}:${label}`, this.seed));
        child.label = `${this.label}:${label}`;
        return child;
    }

    /** Serialisable state, for replay diagnostics. */
    snapshot() {
        return { seed: this.seed, draws: this.draws, label: this.label };
    }

    clone() {
        const copy = new Rng(this.seed);
        copy.label = this.label;
        copy.draws = this.draws;
        // Fast-forward to the same draw position.
        for (let i = 0; i < this.draws; i++) copy._next();
        return copy;
    }
}

/** Convenience: a stream seeded from a seed value plus a label. */
export function createStream(seed, label) {
    const root = new Rng(typeof seed === 'number' ? seed : hashString(String(seed)));
    root.label = 'root';
    const stream = root.fork(label);
    return stream;
}
