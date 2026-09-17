/**
 * Uniform spatial hash for hit queries.
 *
 * Enemies are bucketed into square cells and re-bucketed only when they cross a
 * cell boundary, so a shot costs one cell lookup plus eight neighbours instead
 * of a scan over every enemy (and never a Three.js raycast per target). The
 * same structure serves chain lightning, nuke radius, hazard proximity and the
 * aim-assist search.
 *
 * Cell keys are packed into a single integer to avoid string allocation in the
 * hot path.
 */

const CELL_OFFSET = 32768;

function packCell(cx, cy) {
    return (cx + CELL_OFFSET) * 65536 + (cy + CELL_OFFSET);
}

export class SpatialHash {
    /**
     * @param {object} [options]
     * @param {number} [options.cellSize] world units per cell
     */
    constructor(options = {}) {
        this.cellSize = options.cellSize ?? 2.4;
        this.invCell = 1 / this.cellSize;
        this.cells = new Map();
        this.entries = new Map();      // object -> entry
        this._queryStamp = 0;
        /**
         * Largest radius currently tracked. Queries pad their cell range by it,
         * so a target whose body is bigger than a cell (a Warden is) still
         * overlaps a query whose centre sits in a neighbouring cell. Without
         * this, exactly the biggest enemies could be missed at their edges.
         */
        this.maxEntryRadius = 0;
        this.stats = { inserts: 0, moves: 0, queries: 0, candidates: 0 };
    }

    clear() {
        this.cells.clear();
        this.entries.clear();
        this.maxEntryRadius = 0;
        return this;
    }

    /** Recompute the tracked maximum radius after the largest body leaves. */
    _recomputeMaxRadius() {
        let max = 0;
        for (const entry of this.entries.values()) {
            if (entry.radius > max) max = entry.radius;
        }
        this.maxEntryRadius = max;
        return max;
    }

    get size() {
        return this.entries.size;
    }

    cellCoord(value) {
        return Math.floor(value * this.invCell);
    }

    _cellArray(cx, cy, create = false) {
        const key = packCell(cx, cy);
        let bucket = this.cells.get(key);
        if (!bucket && create) {
            bucket = [];
            this.cells.set(key, bucket);
        }
        return bucket;
    }

    /** Insert (or move) an object at (x, y). `radius` feeds candidate filtering. */
    upsert(obj, x, y, radius = 0) {
        const cx = this.cellCoord(x);
        const cy = this.cellCoord(y);
        const existing = this.entries.get(obj);
        if (radius > this.maxEntryRadius) this.maxEntryRadius = radius;

        if (existing) {
            if (existing.cx === cx && existing.cy === cy) {
                existing.x = x;
                existing.y = y;
                existing.radius = radius;
                return existing;
            }
            const bucket = this._cellArray(existing.cx, existing.cy);
            if (bucket) {
                const index = bucket.indexOf(existing);
                if (index !== -1) bucket.splice(index, 1);
                if (bucket.length === 0) this.cells.delete(packCell(existing.cx, existing.cy));
            }
            existing.cx = cx;
            existing.cy = cy;
            existing.x = x;
            existing.y = y;
            existing.radius = radius;
            this._cellArray(cx, cy, true).push(existing);
            this.stats.moves += 1;
            return existing;
        }

        const entry = { obj, cx, cy, x, y, radius };
        this.entries.set(obj, entry);
        this._cellArray(cx, cy, true).push(entry);
        this.stats.inserts += 1;
        return entry;
    }

    insert(obj, x, y, radius = 0) {
        return this.upsert(obj, x, y, radius);
    }

    update(obj, x, y, radius) {
        return this.upsert(obj, x, y, radius);
    }

    remove(obj) {
        const entry = this.entries.get(obj);
        if (!entry) return false;
        const bucket = this._cellArray(entry.cx, entry.cy);
        if (bucket) {
            const index = bucket.indexOf(entry);
            if (index !== -1) bucket.splice(index, 1);
            if (bucket.length === 0) this.cells.delete(packCell(entry.cx, entry.cy));
        }
        this.entries.delete(obj);
        if (entry.radius >= this.maxEntryRadius) this._recomputeMaxRadius();
        return true;
    }

    /**
     * Candidates whose circle overlaps (x, y, radius).
     * @param {Array} [out] reused array to avoid per-shot allocation
     */
    queryCircle(x, y, radius, out = []) {
        out.length = 0;
        this.stats.queries += 1;

        // Pad the cell range by the biggest tracked body so no overlap can hide
        // in an unscanned cell.
        const padding = radius + this.maxEntryRadius;
        const minX = this.cellCoord(x - padding);
        const maxX = this.cellCoord(x + padding);
        const minY = this.cellCoord(y - padding);
        const maxY = this.cellCoord(y + padding);

        for (let cx = minX; cx <= maxX; cx++) {
            for (let cy = minY; cy <= maxY; cy++) {
                const bucket = this._cellArray(cx, cy);
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    const entry = bucket[i];
                    const dx = entry.x - x;
                    const dy = entry.y - y;
                    const reach = radius + entry.radius;
                    if (dx * dx + dy * dy <= reach * reach) out.push(entry.obj);
                }
            }
        }

        this.stats.candidates += out.length;
        return out;
    }

    /** Candidates within an annulus (used by shockwaves and nukes). */
    queryRing(x, y, innerRadius, outerRadius, out = []) {
        const candidates = this.queryCircle(x, y, outerRadius, out);
        if (innerRadius <= 0) return candidates;
        const innerSq = innerRadius * innerRadius;
        for (let i = candidates.length - 1; i >= 0; i--) {
            const entry = this.entries.get(candidates[i]);
            if (!entry) { candidates.splice(i, 1); continue; }
            const dx = entry.x - x;
            const dy = entry.y - y;
            if (dx * dx + dy * dy < innerSq) candidates.splice(i, 1);
        }
        return candidates;
    }

    /**
     * Nearest candidate to (x, y) within maxRadius, or null.
     * Used by aim assist and chain lightning.
     */
    nearest(x, y, maxRadius, predicate = null) {
        const candidates = this.queryCircle(x, y, maxRadius, []);
        let best = null;
        let bestDistSq = maxRadius * maxRadius;
        for (const obj of candidates) {
            if (predicate && !predicate(obj)) continue;
            const entry = this.entries.get(obj);
            if (!entry) continue;
            const dx = entry.x - x;
            const dy = entry.y - y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= bestDistSq) {
                bestDistSq = d2;
                best = obj;
            }
        }
        return best;
    }

    /** All candidates within radius that satisfy a predicate (nuke, chain). */
    collect(x, y, radius, predicate = null, out = []) {
        const candidates = this.queryCircle(x, y, radius, []);
        out.length = 0;
        for (const obj of candidates) {
            if (!predicate || predicate(obj)) out.push(obj);
        }
        return out;
    }

    forEach(fn) {
        for (const entry of this.entries.values()) fn(entry.obj, entry.x, entry.y, entry.radius);
    }

    /** Average candidates per query: the number that proves the hash is working. */
    efficiency() {
        return {
            queries: this.stats.queries,
            averageCandidates: this.stats.queries > 0 ? Math.round((this.stats.candidates / this.stats.queries) * 10) / 10 : 0,
            cells: this.cells.size,
            tracked: this.entries.size
        };
    }
}
