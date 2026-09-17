/**
 * Lightweight event bus.
 *
 * A plain instance created by the composition root and injected into the systems
 * that emit or consume it. It is deliberately *not* a global and deliberately
 * not a state store: payloads are facts that already happened, and each system
 * continues to own its own state. That keeps the dependency graph acyclic
 * (systems talk to the bus, only main.js talks to systems).
 */

export const EVENTS = Object.freeze({
    ENEMY_SPAWN: 'ENEMY_SPAWN',
    ENEMY_HIT: 'ENEMY_HIT',
    ENEMY_KILL: 'ENEMY_KILL',
    ENEMY_DEATH: 'ENEMY_DEATH',
    WAVE_START: 'WAVE_START',
    WAVE_END: 'WAVE_END',
    BOSS_START: 'BOSS_START',
    BOSS_DEFEATED: 'BOSS_DEFEATED',
    POWERUP_SPAWN: 'POWERUP_SPAWN',
    POWERUP_PICKUP: 'POWERUP_PICKUP',
    UPGRADE_SELECTED: 'UPGRADE_SELECTED',
    CORE_DAMAGED: 'CORE_DAMAGED',
    CORE_HEALED: 'CORE_HEALED',
    COMBO_CHANGED: 'COMBO_CHANGED',
    HYPER_START: 'HYPER_START',
    HYPER_END: 'HYPER_END',
    RUN_START: 'RUN_START',
    RUN_END: 'RUN_END',

    // Support events (same bus, consumed by HUD/debug/audio).
    QUALITY_CHANGED: 'QUALITY_CHANGED',
    DRAFT_OFFERED: 'DRAFT_OFFERED',
    DRAFT_RESOLVED: 'DRAFT_RESOLVED',
    STREAK_UPDATED: 'STREAK_UPDATED',
    SHOT_FIRED: 'SHOT_FIRED',
    HAZARD_SPAWN: 'HAZARD_SPAWN',
    HAZARD_DETONATED: 'HAZARD_DETONATED',
    SCREEN_CHANGED: 'SCREEN_CHANGED',
    DEBUG_NOTE: 'DEBUG_NOTE'
});

const MAX_HISTORY = 200;

export function createEventBus(options = {}) {
    const strict = !!options.strict;         // freeze payloads (debug mode)
    const logHistory = !!options.history;    // keep a ring buffer for the debug panel
    const listeners = new Map();
    const anyListeners = new Set();
    const history = [];
    const counts = new Map();
    let emitDepth = 0;

    function addListener(set, type, fn) {
        if (typeof fn !== 'function') throw new TypeError(`EventBus.on(${type}) expects a function`);
        let set_ = listeners.get(type);
        if (!set_) { set_ = new Set(); listeners.set(type, set_); }
        set_.add(fn);
        return () => set_.delete(fn);
    }

    function removeListener(type, fn) {
        listeners.get(type)?.delete(fn);
    }

    return {
        on(type, fn) {
            return addListener(listeners, type, fn);
        },
        once(type, fn) {
            const off = this.on(type, (payload) => {
                off();
                fn(payload);
            });
            return off;
        },
        off: removeListener,
        onAny(fn) {
            anyListeners.add(fn);
            return () => anyListeners.delete(fn);
        },
        emit(type, payload) {
            counts.set(type, (counts.get(type) || 0) + 1);

            let value = payload;
            if (strict && value && typeof value === 'object') {
                try {
                    value = Object.freeze({ type, ...value });
                } catch { /* frozen-ish payloads are best-effort */ }
            }

            if (logHistory) {
                history.push({ tick: value?.tick ?? null, type, payload: value, depth: emitDepth });
                if (history.length > MAX_HISTORY) history.shift();
            }

            const set = listeners.get(type);
            if (set) {
                // Copy so a listener unsubscribing mid-emit cannot skip siblings.
                emitDepth += 1;
                for (const fn of Array.from(set)) {
                    try {
                        fn(value, type);
                    } catch (err) {
                        console.error(`[events] listener for ${type} threw:`, err);
                    }
                }
                emitDepth -= 1;
            }

            for (const fn of Array.from(anyListeners)) {
                try {
                    fn(value, type);
                } catch (err) {
                    console.error(`[events] onAny listener threw:`, err);
                }
            }
            return value;
        },
        count(type) {
            return counts.get(type) || 0;
        },
        listenerCount(type) {
            return type ? (listeners.get(type)?.size || 0) : listeners.size;
        },
        history() {
            return history.slice();
        },
        toJSON() {
            const payload = {};
            for (const [type, n] of counts) payload[type] = n;
            return payload;
        },
        clear() {
            listeners.clear();
            anyListeners.clear();
            history.length = 0;
            counts.clear();
        }
    };
}
