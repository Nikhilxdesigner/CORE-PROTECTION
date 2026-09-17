/**
 * Hyper Mode.
 *
 * Charged by combo and kills rather than by a passive timer, so the player earns
 * it by playing well. While active the *world* slows (enemy movement, spawn
 * timers, telegraph durations) while the player's own fire rate and damage go
 * up, which is what makes it a power fantasy instead of a visual filter. In
 * exchange the director shifts the same budget toward elites and hazards, so it
 * is a risk/reward window: taking core damage cashes you out early.
 *
 * Timing is expressed in ticks so the mechanic is frame-rate independent and
 * replayable.
 */

import { clamp } from '../util/Math.js';

export const HYPER_DEFAULTS = Object.freeze({
    max: 100,
    killCharge: 4.2,
    comboChargeBonus: 0.5,      // charge multiplier per 10 combo
    hitCharge: 0.35,
    duration: 8,                // seconds
    cooldown: 4,                // seconds after Hyper ends
    worldTimeScale: 0.62,       // the world runs at 62% speed
    fireRateMul: 1.65,
    damageMul: 1.6,
    critBonus: 0.15,
    spreadMul: 0.85,            // tighter volleys while hyper
    scoreMul: 1.25,
    aggression: 1.45            // director elite bias multiplier
});

export function createHyper(config = {}) {
    const cfg = { ...HYPER_DEFAULTS, ...config };

    const state = {
        charge: 0,
        active: false,
        remaining: 0,
        cooldown: 0,
        activations: 0,
        totalActiveTime: 0,
        lastEndReason: null
    };

    return {
        config: cfg,

        get charge() { return state.charge; },
        get progress() { return clamp(state.charge / cfg.max, 0, 1); },
        get active() { return state.active; },
        get remaining() { return state.remaining; },
        get cooldown() { return state.cooldown; },
        get activations() { return state.activations; },
        get lastEndReason() { return state.lastEndReason; },
        get ready() { return !state.active && state.cooldown <= 0 && state.charge >= cfg.max; },
        get timeScale() { return state.active ? this.worldTimeScale : 1; },

        /** World time factor including Chrono Edge stacks. */
        get worldTimeScale() {
            const dilation = cfg.dilationBonus || 0;
            return clamp(cfg.worldTimeScale - dilation, 0.25, 1);
        },
        get fireRateMul() { return state.active ? cfg.fireRateMul : 1; },
        get damageMul() { return state.active ? cfg.damageMul : 1; },
        get critBonus() { return state.active ? cfg.critBonus : 0; },
        get spreadMul() { return state.active ? cfg.spreadMul : 1; },
        get scoreMul() { return state.active ? cfg.scoreMul : 1; },
        get aggression() { return state.active ? cfg.aggression : 1; },

        /** Chrono Edge and Hyper Overflow upgrades feed in here. */
        setModifiers({ dilation = 0, hyperRate = 1, duration = 0 } = {}) {
            cfg.dilationBonus = dilation;
            cfg.rateMul = hyperRate;
            cfg.durationBonus = duration;
            return cfg;
        },

        addCharge(amount, multiplier = 1) {
            if (state.active) return state.charge;
            const gain = amount * (cfg.rateMul || 1) * multiplier;
            state.charge = clamp(state.charge + gain, 0, cfg.max);
            return state.charge;
        },

        /** Kills charge Hyper, scaled by the current combo. */
        chargeFromKill(combo = 0, eliteOrBoss = false) {
            const comboMul = 1 + Math.floor(combo / 10) * cfg.comboChargeBonus;
            return this.addCharge(cfg.killCharge * (eliteOrBoss ? 2.4 : 1), comboMul);
        },

        chargeFromHit() {
            return this.addCharge(cfg.hitCharge);
        },

        activate() {
            if (state.active || state.cooldown > 0 || state.charge < cfg.max) {
                return { activated: false, reason: state.active ? 'active' : (state.cooldown > 0 ? 'cooldown' : 'uncharged') };
            }
            state.active = true;
            state.remaining = cfg.duration + (cfg.durationBonus || 0);
            state.charge = 0;
            state.activations += 1;
            return { activated: true, duration: state.remaining };
        },

        end(reason = 'timeout') {
            if (!state.active) return false;
            state.active = false;
            state.lastEndReason = reason;
            state.remaining = 0;
            state.cooldown = cfg.cooldown;
            return true;
        },

        /** Fixed-step update. */
        tick(dt) {
            if (state.active) {
                state.remaining -= dt;
                state.totalActiveTime += dt;
                if (state.remaining <= 0) {
                    this.end('timeout');
                    return 'ended';
                }
                return 'active';
            }
            if (state.cooldown > 0) {
                state.cooldown = Math.max(0, state.cooldown - dt);
                if (state.cooldown === 0) return 'ready';
            }
            return 'idle';
        },

        onCoreDamaged() {
            // Taking damage cashes out the power window: keeps Hyper honest.
            return this.end('core-damaged');
        },

        reset() {
            state.charge = 0;
            state.active = false;
            state.remaining = 0;
            state.cooldown = 0;
        },

        stats() {
            return {
                charge: Math.round(state.charge),
                progress: Math.round(this.progress * 100),
                active: state.active,
                remaining: Math.round(state.remaining * 10) / 10,
                cooldown: Math.round(state.cooldown * 10) / 10,
                timeScale: this.worldTimeScale,
                activations: state.activations,
                totalActiveTime: Math.round(state.totalActiveTime * 10) / 10,
                lastEndReason: state.lastEndReason
            };
        }
    };
}
