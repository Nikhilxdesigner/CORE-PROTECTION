/**
 * Deterministic run recording.
 *
 * Records the seed, the mode, and tick-stamped *decisions* - inputs, upgrade
 * picks, powerup activations, wave transitions, and the RNG draws that mattered -
 * which is exactly enough to reproduce a run without touching camera data or
 * frames. A record is JSON, capped by a ring buffer, and carries periodic state
 * checksums so a replay can prove it matches and point at the first divergent
 * tick when it does not.
 *
 * This is a debugging tool: recording is opt-in, and nothing here calls
 * Math.random or the wall clock.
 */

export const RECORD_VERSION = 1;
export const EVENT = Object.freeze({
    RUN_START: 'run-start',
    INPUT: 'input',
    INPUT_RELEASE: 'input-release',
    DRAFT_OFFER: 'draft-offer',
    DRAFT_PICK: 'draft-pick',
    RNG_DECISION: 'rng-decision',
    POWERUP_SPAWN: 'powerup-spawn',
    POWERUP_PICKUP: 'powerup-pickup',
    WAVE_START: 'wave-start',
    WAVE_END: 'wave-end',
    BOSS_START: 'boss-start',
    BOSS_DEFEATED: 'boss-defeated',
    CORE_DAMAGED: 'core-damaged',
    HYPER_START: 'hyper-start',
    HYPER_END: 'hyper-end',
    QUALITY: 'quality',
    CHECKSUM: 'checksum',
    RUN_END: 'run-end'
});

/** Stable 32-bit checksum over nested plain data (order-insensitive for objects). */
export function checksum(value, seed = 2166136261) {
    let h = seed >>> 0;

    const mix = (number) => {
        const int = Math.round(number * 1000) | 0;
        h ^= int;
        h = Math.imul(h, 16777619);
        h ^= h >>> 13;
    };

    const walk = (node, depth = 0) => {
        if (depth > 8 || node === null || node === undefined) return;
        if (typeof node === 'number') { mix(node); return; }
        if (typeof node === 'boolean') { mix(node ? 1 : 2); return; }
        if (typeof node === 'string') {
            for (let i = 0; i < node.length; i++) {
                h ^= node.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return;
        }
        if (Array.isArray(node)) {
            mix(node.length);
            for (const item of node) walk(item, depth + 1);
            return;
        }
        if (typeof node === 'object') {
            const keys = Object.keys(node).sort();
            mix(keys.length);
            for (const key of keys) {
                for (let i = 0; i < key.length; i++) {
                    h ^= key.charCodeAt(i);
                    h = Math.imul(h, 16777619);
                }
                walk(node[key], depth + 1);
            }
        }
    };

    walk(value);
    return h >>> 0;
}

/**
 * Snapshot of gameplay-relevant state. Deliberately small and numeric: it is the
 * value replay compares at wave boundaries.
 */
export function stateChecksum(state) {
    return checksum({
        tick: state.tick,
        score: state.score,
        wave: state.wave,
        core: state.core,
        combo: state.combo,
        enemies: state.enemies,
        kills: state.kills,
        rngDraws: state.rngDraws,
        hyper: state.hyper,
        positions: (state.enemyPositions || []).map((e) => `${Math.round(e.x * 100)}:${Math.round(e.y * 100)}:${e.hp}`).sort()
    });
}

export class Recorder {
    constructor(options = {}) {
        this.max = options.max ?? 20000;
        this.version = RECORD_VERSION;
        this.meta = null;
        this.events = [];
        this.recording = false;
        this.dropped = 0;
        this.startedTick = 0;
    }

    start(meta = {}) {
        this.meta = {
            seed: meta.seed ?? null,
            mode: meta.mode || 'standard',
            profile: meta.profile || 'desktop',
            weapon: meta.weapon || 'pulse',
            rules: meta.rules?.id || meta.rules || 'standard',
            dateKey: meta.dateKey || null,
            version: this.version,
            startedTick: meta.tick ?? 0
        };
        this.startedTick = meta.tick ?? 0;
        this.events = [];
        this.dropped = 0;
        this.recording = true;
        return this.meta;
    }

    /** Record one event. Payloads must be plain, numeric/string data. */
    event(tick, type, payload = null) {
        if (!this.recording) return false;
        if (this.events.length >= this.max) {
            this.dropped += 1;
            return false;
        }
        this.events.push({ t: Math.max(0, Math.round(tick)), k: type, d: payload });
        return true;
    }

    input(tick, action) {
        return this.event(tick, action.fire ? EVENT.INPUT : EVENT.INPUT_RELEASE, {
            x: Math.round(action.x * 100) / 100,
            y: Math.round(action.y * 100) / 100,
            fire: !!action.fire,
            pointer: action.pointer || 'mouse'
        });
    }

    checksum(tick, state) {
        return this.event(tick, EVENT.CHECKSUM, { value: stateChecksum(state) });
    }

    stop(tick) {
        // Write the end marker while the recorder is still live, otherwise the
        // record simply has no terminal event.
        this.event(tick, EVENT.RUN_END, { tick });
        this.recording = false;
        return this.toRecord();
    }

    toRecord() {
        return {
            version: this.version,
            meta: this.meta,
            events: this.events,
            dropped: this.dropped,
            eventCount: this.events.length
        };
    }

    export() {
        return JSON.stringify(this.toRecord());
    }

    static parse(json) {
        const record = typeof json === 'string' ? JSON.parse(json) : json;
        if (!record || !Array.isArray(record.events)) throw new Error('Invalid run record');
        if (record.version !== RECORD_VERSION) {
            console.warn(`[recorder] record version ${record.version} != ${RECORD_VERSION}; replaying best-effort`);
        }
        return record;
    }

    stats() {
        return {
            recording: this.recording,
            events: this.events.length,
            dropped: this.dropped,
            max: this.max,
            seed: this.meta?.seed ?? null,
            mode: this.meta?.mode ?? null
        };
    }
}

/**
 * Replays a record by feeding the same tick-stamped actions back into the run.
 * The engine polls `poll(tick)` each simulation step.
 */
export class Replayer {
    constructor(record) {
        const parsed = typeof record === 'string' ? Recorder.parse(record) : record;
        this.meta = parsed.meta;
        this.events = parsed.events.slice().sort((a, b) => a.t - b.t);
        this.cursor = 0;
        this.tick = parsed.meta?.startedTick ?? 0;
        this.done = false;
        this.divergence = null;
        this.checksums = this.events.filter((e) => e.k === EVENT.CHECKSUM).map((e) => ({ tick: e.t, value: e.d.value }));
        this.checksumCursor = 0;
    }

    get totalEvents() { return this.events.length; }
    get progress() { return this.events.length === 0 ? 1 : this.cursor / this.events.length; }
    get seed() { return this.meta?.seed ?? null; }
    get mode() { return this.meta?.mode ?? 'standard'; }

    /** All events scheduled at exactly `tick`. */
    poll(tick) {
        const due = [];
        while (this.cursor < this.events.length && this.events[this.cursor].t <= tick) {
            due.push(this.events[this.cursor]);
            this.cursor += 1;
        }
        if (this.cursor >= this.events.length) this.done = true;
        return due;
    }

    /**
     * Compare a computed checksum against the recorded one for this tick.
     * @returns {{checked:boolean, match:boolean, expected?:number, actual?:number}}
     */
    verify(tick, actual) {
        const next = this.checksums[this.checksumCursor];
        if (!next || next.tick !== tick) return { checked: false, match: true };
        this.checksumCursor += 1;
        if (next.value === actual) return { checked: true, match: true, expected: next.value, actual };
        if (!this.divergence) this.divergence = { tick, expected: next.value, actual };
        return { checked: true, match: false, expected: next.value, actual };
    }

    stats() {
        return {
            events: this.events.length,
            cursor: this.cursor,
            progress: Math.round(this.progress * 100),
            done: this.done,
            divergence: this.divergence
        };
    }
}
