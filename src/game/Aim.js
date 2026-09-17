/**
 * Scope / aim readout.
 *
 * Pure logic: no Three.js, no DOM. It answers one question per frame - *what is
 * under the crosshair, and would a shot connect?* - so the reticle and the HUD
 * readout can never disagree with the hit resolution in Weapons.js.
 *
 * The important honesty rule: the ring the player sees is the real hit radius
 * (`combineModifiers().hitRadius`), not a decorative circle. If the ring covers
 * a body, a shot at that point hits it. That is what makes the scope a learning
 * tool rather than a cosmetic.
 */

import { clamp } from '../util/Math.js';

export const SCOPE_STATE = Object.freeze({
    SEARCHING: 'searching',   // nothing near the aim point
    INCOMING: 'incoming',     // a spawn telegraph: visible, not yet hittable
    NEAR: 'near',             // a live target overlaps the ring, but is off-centre
    LOCKED: 'locked',         // a live target is inside the ring at the aim point
    ASSIST: 'assist'          // aim assist will snap this volley onto the target
});

/** Widest body in the roster (a Warden); bounds the hash search radius. */
export const MAX_TARGET_RADIUS = 1.9;

/** How far a volley can be pulled onto a target by aim assist. */
export function assistRadiusFor(weapon, target) {
    const assists = weapon?.aimAssist ?? 0;
    if (assists <= 0) return 0;
    return assists * ((target?.radius || 0.6)) * 2.2;
}

/** Effective hit reach against a given body: aim radius plus the body's own. */
export function reachFor(weapon, target) {
    return (weapon?.hitRadius ?? 0.95) + (target?.radius ?? 0);
}

/**
 * Nearest target to the aim point, with the geometry of the shot.
 *
 * @param {object} input
 * @param {import('../world/SpatialHash.js').SpatialHash} input.hash
 * @param {{x:number,y:number}} input.aim world point under the crosshair
 * @param {object} input.weapon effective weapon (see combineModifiers)
 * @param {(target:any)=>boolean} [input.predicate] restrict to, say, own enemies
 * @returns {null|object}
 */
export function pickAimTarget(input) {
    const { hash, aim, weapon, predicate = null } = input;
    if (!hash || !aim) return null;

    const hitRadius = weapon?.hitRadius ?? 0.95;
    const target = hash.nearest(aim.x, aim.y, hitRadius + MAX_TARGET_RADIUS, predicate);
    if (!target) return null;

    const entry = hash.entries?.get?.(target);
    const x = entry ? entry.x : (target.x ?? 0);
    const y = entry ? entry.y : (target.y ?? 0);
    const dx = x - aim.x;
    const dy = y - aim.y;
    const distance = Math.hypot(dx, dy);
    const reach = reachFor(weapon, target);
    const assistRadius = assistRadiusFor(weapon, target);

    return {
        target,
        x,
        y,
        offsetX: dx,
        offsetY: dy,
        distance,
        reach,
        assistRadius,
        /** A shot aimed here would connect. */
        inside: distance <= reach,
        /** 1 = dead centre of the body, 0 = at the very edge of the ring. */
        edge: clamp(1 - distance / Math.max(1e-6, reach), 0, 1),
        /** False while the body is still materialising from its telegraph. */
        hittable: target.alive !== false,
        assist: assistRadius > 0 && distance <= assistRadius
    };
}

/** Presentation data for the target under the crosshair. */
export function describeTarget(view) {
    if (!view) return null;
    const maxHp = Math.max(1, Math.round(view.maxHp ?? view.hp ?? 1));
    const hp = Math.max(0, Math.round(view.hp ?? 0));
    return {
        name: String(view.archetype?.name || view.archetypeId || 'target').toUpperCase(),
        archetype: view.archetypeId || null,
        elite: !!view.elite,
        boss: !!view.boss,
        hp,
        maxHp,
        hpFrac: clamp(hp / maxHp, 0, 1),
        score: view.score ?? 0,
        radius: view.radius ?? 0
    };
}

/**
 * Fold a pick into the single state the reticle and the HUD both render.
 *
 * Precedence matters: a shot already inside the ring is LOCKED even when aim
 * assist would also cover it, because assist is only interesting when it rescues
 * a shot that would otherwise miss. Reporting ASSIST while the player is dead on
 * the body would read as "your aim needs help" at the exact moment it does not.
 * The `assist` flag survives on the target either way, so the plate can still
 * note that assist is contributing.
 */
export function scopeState(found) {
    if (!found) return SCOPE_STATE.SEARCHING;
    if (!found.hittable) return SCOPE_STATE.INCOMING;
    if (found.inside) return SCOPE_STATE.LOCKED;
    if (found.assist) return SCOPE_STATE.ASSIST;
    return SCOPE_STATE.NEAR;
}

/**
 * One frame of scope data.
 * @returns {{aim:object, hitRadius:number, weapon:object, target:object|null, state:string}}
 */
export function readScope(input) {
    const { aim, weapon } = input;
    const found = pickAimTarget(input);
    return {
        aim: { x: aim?.x ?? 0, y: aim?.y ?? 0 },
        hitRadius: weapon?.hitRadius ?? 0.95,
        weapon: weapon
            ? {
                id: weapon.id,
                name: weapon.name,
                damage: weapon.damage,
                projectiles: weapon.projectiles,
                pierce: weapon.pierce,
                crit: weapon.crit,
                critMult: weapon.critMult
            }
            : null,
        state: scopeState(found),
        target: found
            ? {
                ...describeTarget(found.target),
                distance: found.distance,
                reach: found.reach,
                assistRadius: found.assistRadius,
                offsetX: found.offsetX,
                offsetY: found.offsetY,
                edge: found.edge,
                inside: found.inside,
                hittable: found.hittable,
                assist: found.assist,
                worldX: found.x,
                worldY: found.y
            }
            : null
    };
}

/**
 * Whole volleys needed to drop a target with the current weapon, so the readout
 * can say "3 SHOTS" instead of leaving the player to guess. Crits are excluded:
 * this is the guaranteed number, not the lucky one.
 */
export function shotsToKill(target, weapon) {
    const hp = Math.max(0, target?.hp ?? 0);
    if (hp <= 0) return 0;
    const damage = Math.max(0.1, weapon?.damage ?? 1);
    return Math.ceil(hp / damage);
}
