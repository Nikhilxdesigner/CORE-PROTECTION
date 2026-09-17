/**
 * Generic object pool.
 *
 * Every frequently created gameplay object (enemies, telegraphs, tracers,
 * particles, debris, powerups, transient FX) is pooled through here so that no
 * geometry, material, or Gameplay object is constructed during play.
 *
 * Lifecycle contract for pooled objects:
 *   activate(...args)   - called on acquire, must fully configure the object
 *   deactivate()        - called on release, must detach/reset all state
 *
 * When the pool is at capacity, `acquire` recycles the oldest active object
 * (FIFO) rather than growing without bound, so a particle storm degrades the
 * oldest visuals instead of the frame rate.
 */

export class Pool {
    /**
     * @param {object} options
     * @param {string} options.name
     * @param {() => object} options.create factory; object must expose activate/deactivate
     * @param {number} [options.maxSize] hard ceiling on allocated objects
     * @param {number} [options.prewarm] objects to allocate up front
     * @param {(obj: object) => void} [options.onAcquire]
     * @param {(obj: object) => void} [options.onRelease]
     * @param {boolean} [options.recycleOldest] FIFO-recycle when saturated (default true)
     */
    constructor(options) {
        if (!options || typeof options.create !== 'function') {
            throw new TypeError('Pool requires a create() factory');
        }
        this.name = options.name || 'pool';
        this.create = options.create;
        this.maxSize = options.maxSize ?? 1024;
        this.recycleOldest = options.recycleOldest !== false;
        this.onAcquire = options.onAcquire;
        this.onRelease = options.onRelease;

        this.free = [];
        this.active = [];
        this.allocated = 0;
        this.recycled = 0;
        this.expansions = 0;
        this.peakActive = 0;

        const prewarm = options.prewarm ?? 0;
        if (prewarm > 0) this.prewarm(prewarm);
    }

    /** Create `count` objects ahead of time so the first spawn pays no cost. */
    prewarm(count) {
        for (let i = 0; i < count; i++) {
            if (this.allocated >= this.maxSize) break;
            const obj = this._construct();
            if (obj && typeof obj.deactivate === 'function') obj.deactivate();
            this.free.push(obj);
        }
        return this;
    }

    _construct() {
        const obj = this.create();
        this.allocated += 1;
        return obj;
    }

    acquire(...args) {
        let obj = this.free.pop();

        if (!obj) {
            if (this.allocated < this.maxSize) {
                obj = this._construct();
                this.expansions += 1;
            } else if (this.recycleOldest && this.active.length > 0) {
                // Saturated: steal the oldest active object.
                obj = this.active.shift();
                this.recycled += 1;
                if (typeof obj.deactivate === 'function') obj.deactivate();
                this.onRelease?.(obj);
            } else {
                return null;
            }
        }

        obj.__pool = this;
        if (typeof obj.activate === 'function') obj.activate(...args);
        this.active.push(obj);
        if (this.active.length > this.peakActive) this.peakActive = this.active.length;
        this.onAcquire?.(obj);
        return obj;
    }

    release(obj) {
        if (!obj || obj.__pool !== this) return false;
        const index = this.active.indexOf(obj);
        if (index === -1) return false;
        this.active.splice(index, 1);
        if (typeof obj.deactivate === 'function') obj.deactivate();
        this.onRelease?.(obj);
        obj.__pool = null;
        this.free.push(obj);
        return true;
    }

    /** Release every active object (end of run, mode change, teardown). */
    releaseAll() {
        for (let i = this.active.length - 1; i >= 0; i--) {
            this.release(this.active[i]);
        }
        return this;
    }

    /**
     * Resize the ceiling at runtime (quality governor). Shrinking immediately
     * releases the objects that no longer fit.
     */
    setMaxSize(maxSize) {
        this.maxSize = Math.max(0, Math.floor(maxSize));
        while (this.allocated > this.maxSize) {
            const obj = this.free.pop();
            if (!obj) break;
            this.allocated -= 1;
            obj.dispose?.();
        }
        while (this.active.length > this.maxSize) {
            this.release(this.active[0]);
        }
        return this;
    }

    /** Drop everything: releases actives and discards allocations. */
    clear(dispose = false) {
        this.releaseAll();
        if (dispose) {
            for (const obj of this.free) obj.dispose?.();
        }
        this.free.length = 0;
        this.allocated = dispose ? 0 : this.free.length;
        return this;
    }

    forEachActive(fn) {
        for (let i = 0; i < this.active.length; i++) fn(this.active[i], i);
    }

    get activeCount() {
        return this.active.length;
    }

    get freeCount() {
        return this.free.length;
    }

    stats() {
        return {
            name: this.name,
            active: this.active.length,
            free: this.free.length,
            allocated: this.allocated,
            peakActive: this.peakActive,
            recycled: this.recycled,
            expansions: this.expansions,
            maxSize: this.maxSize
        };
    }
}
