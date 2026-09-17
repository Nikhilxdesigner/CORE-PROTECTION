/**
 * Quality tiers and the adaptive governor.
 *
 * Tiers are data: every dial the renderer exposes (pixel ratio, render scale,
 * bloom resolution/strength, post-processing passes, distortion taps, particle
 * and debris budgets, active enemy ceiling) lives in one table, so "make the
 * frame budget" is a single lookup rather than a scatter of if-statements.
 *
 * Governor rules:
 *   - rolling window with hysteresis, so it never oscillates on noise,
 *   - a cooldown between changes, so it cannot ladder down in one bad second,
 *   - separate, stricter trigger for EMERGENCY, which favours responsiveness,
 *   - recovery escalates one tier at a time and needs more evidence than the
 *     downgrade path,
 *   - a manual selection freezes the governor entirely (EMERGENCY stays
 *     governor-only, since it is a responsiveness safeguard, and core gameplay
 *     is never disabled at any tier).
 */

export const TIER_NAMES = ['ULTRA', 'HIGH', 'MEDIUM', 'LOW', 'EMERGENCY'];
export const MANUAL_CHOICES = ['AUTO', 'ULTRA', 'HIGH', 'MEDIUM', 'LOW'];

function tier(name, config) {
    return {
        name,
        pixelRatioCap: config.pixelRatioCap,
        renderScale: config.renderScale,
        tickHz: config.tickHz ?? 60,
        bloom: {
            enabled: config.bloom !== false,
            resolution: config.bloomResolution ?? 256,
            strength: config.bloomStrength ?? 0.6,
            radius: config.bloomRadius ?? 0.5,
            threshold: config.bloomThreshold ?? 0.55
        },
        post: {
            chromatic: config.chromatic ?? 0.0016,
            distortion: config.distortion ?? 1,
            scanlines: config.scanlines ?? 0.05,
            grain: config.grain ?? 0.05,
            shockwave: config.shockwave !== false,
            wireframe: config.wireframe !== false,
            ripples: config.ripples ?? 1
        },
        particles: config.particles,
        debris: config.debris,
        maxActiveEnemies: config.maxActiveEnemies,
        hazardCap: config.hazardCap ?? 4,
        telegraphFidelity: config.telegraphFidelity ?? 1
    };
}

export const TIERS = [
    tier('ULTRA', {
        pixelRatioCap: 2, renderScale: 1, bloomResolution: 512, bloomStrength: 0.78, bloomRadius: 0.6,
        chromatic: 0.0022, distortion: 1.35, scanlines: 0.06, grain: 0.05,
        particles: 40000, debris: 260, maxActiveEnemies: 70, hazardCap: 6, telegraphFidelity: 1
    }),
    tier('HIGH', {
        pixelRatioCap: 2, renderScale: 1, bloomResolution: 384, bloomStrength: 0.7, bloomRadius: 0.55,
        chromatic: 0.0018, distortion: 1.15, scanlines: 0.05, grain: 0.045,
        particles: 26000, debris: 200, maxActiveEnemies: 60, hazardCap: 5, telegraphFidelity: 1
    }),
    tier('MEDIUM', {
        pixelRatioCap: 1.5, renderScale: 0.9, bloomResolution: 256, bloomStrength: 0.6, bloomRadius: 0.5,
        chromatic: 0.0014, distortion: 0.85, scanlines: 0.04, grain: 0.035,
        particles: 14000, debris: 130, maxActiveEnemies: 44, hazardCap: 4, telegraphFidelity: 0.8
    }),
    tier('LOW', {
        pixelRatioCap: 1.25, renderScale: 0.78, bloomResolution: 192, bloomStrength: 0.5, bloomRadius: 0.45,
        chromatic: 0.0009, distortion: 0.5, scanlines: 0.03, grain: 0.02,
        particles: 7000, debris: 70, maxActiveEnemies: 32, hazardCap: 3, telegraphFidelity: 0.6
    }),
    tier('EMERGENCY', {
        pixelRatioCap: 1, renderScale: 0.6, bloomResolution: 128, bloomStrength: 0.34, bloomRadius: 0.4,
        chromatic: 0, distortion: 0.15, scanlines: 0, grain: 0, shockwave: false, wireframe: false,
        ripples: 0, particles: 2500, debris: 24, maxActiveEnemies: 24, hazardCap: 2, telegraphFidelity: 0.5
    })
];

export const TIER_INDEX = TIER_NAMES.reduce((acc, name, index) => {
    acc[name] = index;
    return acc;
}, {});

export function tierByName(name) {
    const index = TIER_INDEX[name];
    return index === undefined ? TIERS[TIER_INDEX.HIGH] : TIERS[index];
}

export const PLATFORM_DEFAULTS = Object.freeze({
    desktop: { start: 'HIGH', ceiling: 'ULTRA' },
    mobile: { start: 'MEDIUM', ceiling: 'HIGH' }
});

/** Rolling window + EWMA frame-time stats. */
export class FrameWindow {
    constructor(size = 90) {
        this.size = size;
        this.samples = new Float32Array(size);
        this.count = 0;
        this.index = 0;
        this.ewma = 16.7;
    }

    push(frameTimeMs) {
        const value = Number.isFinite(frameTimeMs) ? Math.max(0.1, frameTimeMs) : 16.7;
        this.samples[this.index] = value;
        this.index = (this.index + 1) % this.size;
        if (this.count < this.size) this.count += 1;
        const alpha = 0.08;
        this.ewma = this.ewma + (value - this.ewma) * alpha;
        return this;
    }

    get average() {
        let total = 0;
        for (let i = 0; i < this.count; i++) total += this.samples[i];
        return this.count > 0 ? total / this.count : 16.7;
    }

    /** Frame time at the 95th percentile of the window. */
    get p95() {
        if (this.count === 0) return 16.7;
        const sorted = Array.from(this.samples.slice(0, this.count)).sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }

    get fps() {
        const avg = this.average;
        return avg > 0 ? Math.round(1000 / avg) : 0;
    }

    reset() {
        this.count = 0;
        this.index = 0;
        this.ewma = 16.7;
        return this;
    }
}

export function createQuality(options = {}) {
    const platform = options.platform === 'mobile' ? 'mobile' : 'desktop';
    const defaults = PLATFORM_DEFAULTS[platform];
    const bus = options.bus || null;
    const window = new FrameWindow(options.windowSize ?? 90);

    const state = {
        platform,
        index: TIER_INDEX[defaults.start] ?? TIER_INDEX.HIGH,
        ceilingIndex: TIER_INDEX[defaults.ceiling] ?? TIER_INDEX.HIGH,
        manual: 'AUTO',
        frozen: false,
        reason: 'initial',
        cooldown: 0,
        slowStreak: 0,
        fastStreak: 0,
        emergencyStreak: 0,
        changes: 0,
        lastChangeAt: 0,
        history: []
    };

    const tuning = {
        // Frame-time thresholds in ms.
        slowThreshold: options.slowThreshold ?? 19.5,   // ~51 fps
        fastThreshold: options.fastThreshold ?? 13.2,   // ~76 fps: real headroom
        emergencyThreshold: options.emergencyThreshold ?? 27, // ~37 fps
        slowFrames: options.slowFrames ?? 40,
        fastFrames: options.fastFrames ?? 240,
        emergencyFrames: options.emergencyFrames ?? 18,
        cooldownSeconds: options.cooldownSeconds ?? 2.5,
        ...options.tuning
    };

    function config() {
        return TIERS[state.index];
    }

    function setIndex(index, reason) {
        const clamped = Math.max(0, Math.min(TIERS.length - 1, index));
        if (clamped === state.index) return false;
        const from = TIER_NAMES[state.index];
        state.index = clamped;
        state.reason = reason;
        state.changes += 1;
        state.lastChangeAt = Date.now();
        state.cooldown = tuning.cooldownSeconds;
        state.slowStreak = 0;
        state.fastStreak = 0;
        state.emergencyStreak = 0;
        state.history.push({ from, to: TIER_NAMES[clamped], reason });
        if (state.history.length > 24) state.history.shift();
        bus?.emit('QUALITY_CHANGED', { tick: null, from, to: TIER_NAMES[clamped], reason, manual: state.manual });
        return true;
    }

    return {
        TIERS,
        window,
        get platform() { return state.platform; },
        get name() { return TIER_NAMES[state.index]; },
        get index() { return state.index; },
        get manual() { return state.manual; },
        get reason() { return state.reason; },
        get frozen() { return state.frozen; },
        get changes() { return state.changes; },
        config,
        history() { return state.history.slice(); },
        fps() { return window.fps; },

        /**
         * Manual selection. AUTO hands control back to the governor; anything
         * else pins that tier and suppresses governor decisions.
         */
        setManual(choice, applyContext) {
            const normalized = String(choice || 'AUTO').toUpperCase();
            state.manual = MANUAL_CHOICES.includes(normalized) ? normalized : 'AUTO';
            state.frozen = state.manual !== 'AUTO';
            if (state.frozen) {
                setIndex(TIER_INDEX[state.manual], `manual:${state.manual}`);
                state.reason = `manual:${state.manual}`;
            } else {
                // Returning to AUTO re-establishes the platform starting tier and
                // lets the governor converge from there.
                window.reset();
                setIndex(TIER_INDEX[defaults.start] ?? state.index, 'auto:reset');
            }
            applyContext && this.apply(applyContext);
            return state.manual;
        },

        /** Feed one render-frame duration (ms) and let the governor decide. */
        sample(frameTimeMs, dtSeconds = 1 / 60) {
            window.push(frameTimeMs);
            if (state.frozen) return false;
            if (state.cooldown > 0) {
                state.cooldown = Math.max(0, state.cooldown - dtSeconds);
                return false;
            }

            const ewma = window.ewma;

            if (ewma >= tuning.emergencyThreshold) state.emergencyStreak += 1;
            else state.emergencyStreak = 0;

            if (ewma >= tuning.slowThreshold) { state.slowStreak += 1; state.fastStreak = 0; }
            else if (ewma <= tuning.fastThreshold) { state.fastStreak += 1; state.slowStreak = 0; }
            else { state.slowStreak = 0; state.fastStreak = 0; }

            // Hard protection: a sustained bad patch jumps straight to EMERGENCY.
            if (state.emergencyStreak >= tuning.emergencyFrames && state.index !== TIER_INDEX.EMERGENCY) {
                return setIndex(TIER_INDEX.EMERGENCY, `emergency:${Math.round(ewma)}ms`);
            }

            if (state.slowStreak >= tuning.slowFrames && state.index < TIERS.length - 1) {
                return setIndex(state.index + 1, `slow:${Math.round(ewma)}ms`);
            }

            if (state.fastStreak >= tuning.fastFrames && state.index > 0) {
                // Climb back one step at a time, never above the platform ceiling
                // (or the tier the player pinned). Indices run best-first, so the
                // next tier up is `index - 1` and the guard is a lower bound.
                const limit = state.manual === 'AUTO' ? state.ceilingIndex : TIER_INDEX[state.manual];
                if (state.index - 1 >= limit) {
                    return setIndex(state.index - 1, `headroom:${Math.round(ewma)}ms`);
                }
                state.fastStreak = 0;
            }

            return false;
        },

        /**
         * Push the current tier into the renderer.
         * `ctx` is the Engine's render-side adapter, so the governor itself stays
         * free of Three.js and remains unit-testable.
         */
        apply(ctx) {
            const cfg = config();
            ctx.setPixelRatioCap?.(cfg.pixelRatioCap);
            ctx.setRenderScale?.(cfg.renderScale);
            ctx.setBloom?.(cfg.bloom);
            ctx.setPost?.(cfg.post);
            ctx.setBudget?.('particles', cfg.particles);
            ctx.setBudget?.('debris', cfg.debris);
            ctx.setMaxActiveEnemies?.(cfg.maxActiveEnemies);
            ctx.setHazardCap?.(cfg.hazardCap);
            return cfg;
        },

        /** Compact snapshot for the debug overlay. */
        stats() {
            return {
                tier: TIER_NAMES[state.index],
                manual: state.manual,
                reason: state.reason,
                fps: window.fps,
                avg: Math.round(window.average * 100) / 100,
                p95: Math.round(window.p95 * 100) / 100,
                ewma: Math.round(window.ewma * 100) / 100,
                changes: state.changes,
                cooldown: Math.round(state.cooldown * 100) / 100
            };
        }
    };
}

/** Cheap heuristic used to pick the starting profile. */
export function detectPlatform(nav = typeof navigator !== 'undefined' ? navigator : null, win = typeof window !== 'undefined' ? window : null) {
    if (!nav || !win) return 'desktop';
    const ua = nav.userAgent || '';
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);
    const coarse = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
    const narrow = win.innerWidth > 0 && win.innerWidth <= 900;
    const touch = (nav.maxTouchPoints || 0) > 0;
    return (mobileUA || (coarse && narrow && touch)) ? 'mobile' : 'desktop';
}
