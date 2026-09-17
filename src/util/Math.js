/**
 * Math helpers.
 *
 * Kept dependency-free and side-effect-free so the simulation modules that
 * import it stay testable in plain Node.
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
}

export function clamp01(v) {
    return clamp(v, 0, 1);
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the rate constant (higher = snappier).
 */
export function damp(current, target, lambda, dt) {
    return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
    return t * t * (3 - 2 * t);
}

export function sign(v) {
    return v < 0 ? -1 : (v > 0 ? 1 : 0);
}

export function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

export function dist2(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return dx * dx + dy * dy;
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveToward(current, target, maxDelta) {
    const diff = target - current;
    if (Math.abs(diff) <= maxDelta) return target;
    return current + sign(diff) * maxDelta;
}

export function pad2(n) {
    return n < 10 ? `0${n}` : `${n}`;
}

export function formatScore(n) {
    return Math.round(n).toLocaleString('en-US');
}

/** 1234 -> "1.2K", 2450000 -> "2.5M" */
export function shortNumber(n) {
    const abs = Math.abs(n);
    if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
    return `${Math.round(n)}`;
}

/** Seconds -> "M:SS" */
export function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** Milliseconds -> "M:SS" for countdowns. */
export function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
