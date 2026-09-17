/**
 * Arena specification.
 *
 * Plain data shared by the renderer (which builds geometry from it) and the
 * simulation (which spawns and moves enemies inside it). Keeping it out of the
 * Three.js modules is what lets Director/Weapons/SpatialHash be unit-tested in
 * plain Node.
 */

import { TAU } from '../util/Math.js';

export const ARENA = Object.freeze({
    /** Combat plane: every enemy and hit lives on this z. */
    planeZ: 0,
    /** Core crystal the player defends. */
    core: Object.freeze({ x: 0, y: 0.55, z: 0, radius: 1.15, hitRadius: 1.05 }),
    /** Enemies hover slightly above the plane for depth readability. */
    enemyHoverY: 0.75,
    /** Spawn ellipse just outside the comfortable view. */
    spawn: Object.freeze({ radiusX: 15.5, radiusY: 9.2, jitter: 1.6, minAngleSpread: 0.35 }),
    /** Hard arena bounds used to clamp wandering enemies. */
    bounds: Object.freeze({ x: 22, y: 13 }),
    /** Ground grid extent (visual only). */
    grid: Object.freeze({ size: 60, divisions: 30 }),
    /** Enemies that reach this distance damage the core. */
    coreHitDistance: 1.55,
    /** Baseline enemy radius used to size the spatial hash cells. */
    averageEnemyRadius: 0.8
});

export const CAMERA_RIG = Object.freeze({
    position: Object.freeze({ x: 0, y: 4.6, z: 13.5 }),
    /** Look-at target; converted to yaw/pitch by the renderer. */
    lookAt: Object.freeze({ x: 0, y: 0.35, z: -1.5 }),
    fovDeg: 55,
    near: 0.1,
    far: 220,
    /** Subtle rig motion, in metres / radians. */
    swayAmount: 0.22,
    swaySpeed: 0.35,
    shakeDecay: 6.5,
    recoilAmount: 0.09,
    recoilRecovery: 9
});

export const RENDER_LAYERS = Object.freeze({
    BACKDROP: 0,
    ARENA: 1,
    ENEMIES: 2,
    FX: 3
});

/** Angles around the spawn ellipse; deterministic, so waves spread evenly. */
export function spawnRing(count = 16) {
    const step = TAU / count;
    const angles = [];
    for (let i = 0; i < count; i++) angles.push(i * step);
    return angles;
}

/**
 * Point on the spawn ellipse for a given angle (radians).
 * `unit` values are the caller's seeded random numbers in [0, 1).
 */
export function spawnPoint(angle, unitRadius = 1, unitJitterA = 0.5, unitJitterB = 0.5) {
    const jitter = (unitJitterA - 0.5) * 2 * ARENA.spawn.jitter;
    const rx = ARENA.spawn.radiusX * unitRadius + jitter + unitJitterB * 0.5;
    const ry = ARENA.spawn.radiusY * unitRadius + jitter * 0.6;
    return {
        x: Math.cos(angle) * rx,
        y: ARENA.enemyHoverY + Math.sin(angle) * ry
    };
}

/** True when a point is inside the arena bounds. */
export function insideBounds(x, y, margin = 0) {
    return Math.abs(x) <= ARENA.bounds.x + margin && Math.abs(y) <= ARENA.bounds.y + margin;
}
