/**
 * Weapons and shot resolution.
 *
 * A shot never touches Three.js. The pointer position is already a world point
 * on the combat plane (see CamMath), so firing is: rotate that point around the
 * muzzle by the spread offsets, ask the spatial hash for nearby targets, then
 * run exact distance checks on those few candidates. Multishot, piercing,
 * crits, aim assist and future weapon types are all expressed here as data plus
 * one deterministic resolution pass.
 */

import { TAU, clamp, dist } from '../util/Math.js';
import { ARENA } from './ArenaSpec.js';

/** Baseline hit radius multiplier applied to the smallest enemy in range. */
export const BASE_HIT_RADIUS = 0.95;

export const WEAPONS = Object.freeze({
    pulse: {
        id: 'pulse',
        name: 'Pulse Repeater',
        blurb: 'Reliable, fast, forgiving.',
        rof: 0.115,          // seconds between shots
        damage: 1,
        projectiles: 1,
        spread: 0,
        pierce: 0,
        crit: 0.08,
        critMult: 2,
        hitRadiusMul: 1,
        unlock: null
    },
    lance: {
        id: 'lance',
        name: 'Rail Lance',
        blurb: 'Slow, heavy, punches through a column of drones.',
        rof: 0.31,
        damage: 2.2,
        projectiles: 1,
        spread: 0,
        pierce: 3,
        crit: 0.15,
        critMult: 2.5,
        hitRadiusMul: 0.82,
        unlock: { type: 'contract', id: 'reach_wave_8', label: 'Reach wave 8' }
    },
    scatter: {
        id: 'scatter',
        name: 'Scatter Array',
        blurb: 'Wide cone. Devastating up close.',
        rof: 0.42,
        damage: 0.85,
        projectiles: 5,
        spread: 0.34,
        pierce: 0,
        crit: 0.06,
        critMult: 2,
        hitRadiusMul: 1.05,
        unlock: { type: 'contracts', count: 3, label: 'Complete 3 contracts' }
    }
});

export const WEAPON_LIST = Object.freeze(Object.values(WEAPONS));

export function weaponById(id) {
    return WEAPONS[id] || WEAPONS.pulse;
}

export function isWeaponUnlocked(weapon, unlockState) {
    if (!weapon.unlock) return true;
    if (weapon.unlock.type === 'contract') return !!unlockState.contracts?.[weapon.unlock.id];
    if (weapon.unlock.type === 'contracts') return (unlockState.contractsCompleted || 0) >= weapon.unlock.count;
    return true;
}

/**
 * Fold run modifiers + permanent Arsenal tracks into concrete shot numbers.
 * `mods` is produced by Upgrades.createRunModifiers() and augmented by
 * Progression.modifiersFromTracks().
 */
export function combineModifiers(weapon, mods = {}) {
    const projectiles = Math.max(1, Math.round(weapon.projectiles + (mods.projectiles || 0)));
    const rofMul = Math.max(0.2, mods.rof || 1);
    const damage = Math.max(0.1, weapon.damage * (mods.damage || 1) + (mods.damageFlat || 0));

    // A multi-projectile weapon always fans out, even if the base has no spread.
    let spread = weapon.spread;
    if (projectiles > 1) spread = Math.max(spread, 0.3) + (mods.spreadAdd || 0);

    return {
        id: weapon.id,
        name: weapon.name,
        rof: weapon.rof / rofMul,
        cooldownTicks: Math.max(1, Math.round((weapon.rof / rofMul) * (mods.tickHz || 60))),
        damage,
        projectiles,
        spread,
        pierce: Math.max(0, weapon.pierce + (mods.pierce || 0)),
        crit: clamp(weapon.crit + (mods.crit || 0), 0, 0.95),
        critMult: Math.max(1, weapon.critMult + (mods.critMult || 0)),
        hitRadius: weapon.hitRadiusMul * (mods.hitRadius || 1) * BASE_HIT_RADIUS,
        aimAssist: clamp((mods.aimAssist || 0) + (mods.baseAimAssist || 0), 0, 2.2)
    };
}

/**
 * Resolve one trigger pull.
 *
 * @param {object} input
 * @param {{x:number,y:number}} input.origin muzzle position on the combat plane
 * @param {{x:number,y:number}} input.aim world point the player aimed at
 * @param {SpatialHash} input.hash
 * @param {Rng} input.rng deterministic stream for crit + jitter
 * @param {object} input.weapon effective weapon (see combineModifiers)
 * @param {(target:any)=>boolean} [input.predicate] damageable filter
 * @param {Array} [input.scratchCandidates] reused array
 * @returns {{hits:Array, rays:Array, shots:number, aimError:number}}
 */
export function resolveShot(input) {
    const {
        origin,
        aim,
        hash,
        rng,
        weapon,
        predicate = null,
        scratchCandidates = [],
        aimAssistTarget = null
    } = input;

    const hits = [];
    const rays = [];
    const hitObjects = new Set();

    // Aim assist snaps the volley onto the nearest valid target inside a cone,
    // which is what makes touch play feel fair without making mouse play aimbot.
    // The snap is resolved *before* the ray maths, so the shot actually goes
    // where the assist pulled it - and `aimError` reports how far that was.
    let aimX = aim.x;
    let aimY = aim.y;
    if (aimAssistTarget && weapon.aimAssist > 0) {
        const assistRadius = weapon.aimAssist * (aimAssistTarget.radius || 0.6) * 2.2;
        if (dist(aimX, aimY, aimAssistTarget.x, aimAssistTarget.y) <= assistRadius) {
            aimX = aimAssistTarget.x;
            aimY = aimAssistTarget.y;
        }
    }

    const baseAngle = Math.atan2(aimY - origin.y, aimX - origin.x);
    const baseDistance = Math.max(1.5, dist(origin.x, origin.y, aimX, aimY));
    const count = weapon.projectiles;
    const spread = weapon.spread;

    for (let i = 0; i < count; i++) {
        let angleOffset = 0;
        if (count > 1) {
            angleOffset = (i / (count - 1) - 0.5) * spread;
        }
        // Tiny deterministic jitter so repeated volleys never look stamped.
        const jitter = count > 1 ? rng.range(-0.012, 0.012) : rng.range(-0.004, 0.004);
        const angle = baseAngle + angleOffset + jitter;

        const rayLength = baseDistance;
        const pointX = origin.x + Math.cos(angle) * rayLength;
        const pointY = origin.y + Math.sin(angle) * rayLength;

        const candidates = hash.queryCircle(pointX, pointY, weapon.hitRadius, scratchCandidates);
        const sorted = candidates
            .filter((target) => !hitObjects.has(target) && (!predicate || predicate(target)))
            .map((target) => ({ target, d: dist(pointX, pointY, target.x, target.y) }))
            .sort((a, b) => a.d - b.d);

        const maxTargets = 1 + weapon.pierce;
        let collected = 0;

        for (const candidate of sorted) {
            if (collected >= maxTargets) break;
            const target = candidate.target;
            const crit = rng.chance(weapon.crit);
            const damage = weapon.damage * (crit ? weapon.critMult : 1);
            hits.push({
                target,
                rayIndex: i,
                x: target.x,
                y: target.y,
                distance: candidate.d,
                crit,
                damage
            });
            hitObjects.add(target);
            collected += 1;
        }

        rays.push({ index: i, angle, endX: pointX, endY: pointY, length: rayLength });
    }

    return {
        hits,
        rays,
        shots: count,
        aimError: dist(aim.x, aim.y, aimX, aimY)
    };
}

/** Muzzle position for a given aim direction (bottom of the arena, pulled back). */
export function muzzlePosition(aim) {
    return {
        x: clamp(aim.x * 0.18, -ARENA.bounds.x * 0.5, ARENA.bounds.x * 0.5),
        y: -ARENA.bounds.y * 0.62
    };
}

/** Convenience for FX: longest tracer this volley produced. */
export function volleyLength(rays) {
    let max = 0;
    for (const ray of rays) if (ray.length > max) max = ray.length;
    return max;
}

export function spreadAngleFor(index, count, spread) {
    if (count <= 1) return 0;
    return (index / (count - 1) - 0.5) * spread;
}

export { TAU };
