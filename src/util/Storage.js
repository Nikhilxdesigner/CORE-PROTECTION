/**
 * Versioned storage with migrations.
 *
 * Persistence lives in a single JSON blob so that a schema change is atomic:
 * either the whole save migrates or none of it does. Practice-mode writes go to
 * a separate sandbox namespace so debug runs can never contaminate progression.
 */

export const STORAGE_VERSION = 2;
export const DEFAULT_PREFIX = 'cd3d_';
export const PRACTICE_PREFIX = 'cd3d_practice_';

/** In-memory backend used by tests and by browsers where localStorage throws. */
export function createMemoryBackend(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        keys: () => Array.from(map.keys()),
        get size() { return map.size; }
    };
}

function localStorageBackend() {
    try {
        const probe = '__cd3d_probe__';
        window.localStorage.setItem(probe, '1');
        window.localStorage.removeItem(probe);
        return window.localStorage;
    } catch (err) {
        console.warn('[storage] localStorage unavailable, falling back to memory:', err?.name || err);
        return createMemoryBackend();
    }
}

/**
 * Migrations map: { [fromVersion]: (data) => data }
 * v1 -> v2 seeds the fields that v2 introduced.
 */
const DEFAULT_MIGRATIONS = {
    1: (data) => ({
        ...data,
        streak: data.streak ?? { current: 0, longest: 0, lastCompletedUtcDate: null, totalDailies: 0 },
        mastery: data.mastery ?? {},
        dailyBest: data.dailyBest ?? null
    })
};

export class Storage {
    /**
     * @param {object} [options]
     * @param {string} [options.prefix]
     * @param {number} [options.version]
     * @param {object} [options.migrations]
     * @param {object} [options.backend] injectable (tests)
     * @param {boolean} [options.sandbox] practice namespace
     */
    constructor(options = {}) {
        this.sandbox = !!options.sandbox;
        this.prefix = options.prefix || (this.sandbox ? PRACTICE_PREFIX : DEFAULT_PREFIX);
        this.version = options.version ?? STORAGE_VERSION;
        this.migrations = options.migrations || DEFAULT_MIGRATIONS;
        this.backend = options.backend || (typeof window !== 'undefined' ? localStorageBackend() : createMemoryBackend());
        this.blobKey = `${this.prefix}state`;
        this.data = null;
        this.lastMigration = null;
        this.load();
    }

    load() {
        let raw = null;
        try {
            raw = this.backend.getItem(this.blobKey);
        } catch (err) {
            console.warn('[storage] read failed:', err);
        }

        if (!raw) {
            this.data = {};
            this.writtenVersion = this.version;
            return this.data;
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            // Corrupt payload: start over rather than crash the game on boot.
            console.warn('[storage] corrupt payload, resetting:', err);
            this.data = {};
            this.writtenVersion = this.version;
            return this.data;
        }

        let { version, data } = parsed;
        if (typeof version !== 'number') version = 1;
        if (!data || typeof data !== 'object') data = {};

        const from = version;
        while (version < this.version) {
            const migrate = this.migrations[version];
            data = migrate ? migrate(data) : data;
            version += 1;
        }

        this.data = data;
        this.writtenVersion = version;
        this.lastMigration = from === version ? null : { from, to: version };
        if (this.lastMigration) this.save();
        return this.data;
    }

    save() {
        try {
            this.backend.setItem(this.blobKey, JSON.stringify({ version: this.writtenVersion ?? this.version, data: this.data }));
            this.writtenVersion = this.version;
            return true;
        } catch (err) {
            console.warn('[storage] write failed:', err);
            return false;
        }
    }

    get(key, fallback = null) {
        const value = this.data[key];
        return value === undefined ? fallback : value;
    }

    set(key, value) {
        this.data[key] = value;
        return this.save();
    }

    update(patch) {
        Object.assign(this.data, patch);
        return this.save();
    }

    increment(key, amount = 1, fallback = 0) {
        const next = (typeof this.data[key] === 'number' ? this.data[key] : fallback) + amount;
        this.data[key] = next;
        this.save();
        return next;
    }

    remove(key) {
        delete this.data[key];
        return this.save();
    }

    clear() {
        this.data = {};
        try {
            this.backend.removeItem(this.blobKey);
        } catch (err) {
            console.warn('[storage] clear failed:', err);
        }
        return true;
    }

    exportData() {
        return JSON.parse(JSON.stringify({ version: this.version, data: this.data }));
    }

    importData(payload) {
        if (!payload || typeof payload !== 'object' || typeof payload.data !== 'object') return false;
        this.data = payload.data;
        this.writtenVersion = typeof payload.version === 'number' ? payload.version : this.version;
        return this.save();
    }
}

/** Browser storage for the real player profile. */
export function createPlayerStorage(options = {}) {
    return new Storage(options);
}

/** Sandboxed storage used while practice/debug mode is active. */
export function createPracticeStorage(options = {}) {
    return new Storage({ ...options, sandbox: true });
}
