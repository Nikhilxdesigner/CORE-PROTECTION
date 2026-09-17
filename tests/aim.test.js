/**
 * Scope / aim readout tests.
 *
 * The contract these guard: what the reticle ring covers is what a shot hits, and
 * the state the HUD prints (searching / incoming / near / locked / assist) is
 * derived from the same numbers Weapons.js resolves the shot with.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SCOPE_STATE, MAX_TARGET_RADIUS, pickAimTarget, describeTarget,
    scopeState, readScope, shotsToKill, reachFor, assistRadiusFor
} from '../src/game/Aim.js';
import { SpatialHash } from '../src/world/SpatialHash.js';
import { combineModifiers, WEAPONS, resolveShot, muzzlePosition } from '../src/world/Weapons.js';
import { ARENA } from '../src/world/ArenaSpec.js';
import { Rng } from '../src/core/Rng.js';

function enemy(x, y, options = {}) {
    return {
        x,
        y,
        radius: options.radius ?? 0.6,
        hp: options.hp ?? 1,
        maxHp: options.maxHp ?? options.hp ?? 1,
        alive: options.alive !== false,
        elite: !!options.elite,
        boss: !!options.boss,
        score: options.score ?? 100,
        archetypeId: options.archetypeId ?? 'basic',
        archetype: { name: options.name ?? 'Drone', color: 0xff4d3d }
    };
}

function hashWith(entities, cellSize = ARENA.averageEnemyRadius * 2.6) {
    const hash = new SpatialHash({ cellSize });
    for (const entity of entities) hash.upsert(entity, entity.x, entity.y, entity.radius);
    return hash;
}

const pulse = combineModifiers(WEAPONS.pulse, {});

test('the summary reads out the real hit reach, not a decorative one', () => {
    const target = enemy(0, 0, { radius: 0.6 });
    const hash = hashWith([target]);

    const found = pickAimTarget({ hash, aim: { x: 0, y: 0 }, weapon: pulse });
    assert.ok(found);
    assert.equal(found.target, target);
    assert.equal(found.distance, 0);
    assert.equal(found.edge, 1);
    assert.equal(found.inside, true);
    assert.equal(found.hittable, true);

    // The ring is `hitRadius` wide and the reach adds the body's own radius.
    assert.equal(pulse.hitRadius, 0.95);
    assert.equal(reachFor(pulse, target), 0.95 + 0.6);

    // Just inside the reach still connects; just outside does not.
    const inside = pickAimTarget({ hash, aim: { x: 1.5, y: 0 }, weapon: pulse });
    assert.ok(inside);
    assert.equal(inside.inside, true);

    const outside = pickAimTarget({ hash, aim: { x: 1.7, y: 0 }, weapon: pulse });
    assert.ok(outside, 'still reported so the HUD can say how close it is');
    assert.equal(outside.inside, false);
    assert.ok(outside.distance > outside.reach);
    assert.equal(outside.edge, 0);
});

test('the reported geometry is exactly what a shot resolves against', () => {
    const target = enemy(0, 0, { radius: 0.6 });
    const hash = hashWith([target]);
    const origin = muzzlePosition({ x: 0, y: 0 });

    // Sweep the aim across the target and assert the scope's verdict matches the
    // real shot every time. This is the promise that makes the reticle honest.
    for (let x = -3; x <= 3; x += 0.1) {
        const aim = { x, y: 0 };
        const scope = readScope({ hash, aim, weapon: pulse });
        const shot = resolveShot({
            origin,
            aim,
            hash,
            rng: new Rng(4),
            weapon: combineModifiers(WEAPONS.pulse, { crit: -1 }),
            scratchCandidates: []
        });
        const wouldHit = !!scope.target && scope.state === SCOPE_STATE.LOCKED;
        assert.equal(wouldHit, shot.hits.length > 0, `mismatch at aim x=${x.toFixed(2)}`);
    }
});

test('states cover searching, incoming, near, locked and assist', () => {
    const empty = readScope({ hash: new SpatialHash({ cellSize: 2 }), aim: { x: 0, y: 0 }, weapon: pulse });
    assert.equal(empty.state, SCOPE_STATE.SEARCHING);
    assert.equal(empty.target, null);

    // A spawn telegraph is visible but not yet damageable.
    const telegraphing = enemy(0, 0, { alive: false, hp: 2, maxHp: 2 });
    const incoming = readScope({
        hash: hashWith([telegraphing]), aim: { x: 0, y: 0 }, weapon: pulse,
        predicate: () => true
    });
    assert.equal(incoming.state, SCOPE_STATE.INCOMING);
    assert.equal(incoming.target.hittable, false);

    // In range of the search but outside the ring: near, not locked. The ring is
    // 0.95 wide plus the body's own 0.6, so 2.0 is overlapping-but-off-centre.
    const target = enemy(0, 0, { hp: 1 });
    const near = readScope({ hash: hashWith([target]), aim: { x: 2.0, y: 0 }, weapon: pulse });
    assert.equal(near.state, SCOPE_STATE.NEAR);
    assert.equal(near.target.inside, false);
    assert.ok(near.target.distance < pulse.hitRadius + MAX_TARGET_RADIUS);

    const locked = readScope({ hash: hashWith([target]), aim: { x: 0.2, y: 0 }, weapon: pulse });
    assert.equal(locked.state, SCOPE_STATE.LOCKED);
    assert.ok(locked.target.edge > 0.5);

    // A shot already inside the ring is LOCKED, not ASSIST, even when assist
    // would also cover it - assist is only interesting when it rescues a miss.
    const assisted = combineModifiers(WEAPONS.pulse, { baseAimAssist: 2 });
    const deadOn = readScope({ hash: hashWith([target]), aim: { x: 0.1, y: 0 }, weapon: assisted });
    assert.equal(deadOn.state, SCOPE_STATE.LOCKED);
    assert.equal(deadOn.target.inside, true);
    assert.equal(deadOn.target.assist, true, 'the flag still reports that assist is contributing');

    // Aim assist reports itself as a state only when it would actually pull the
    // volley: at 1.9 units the shot is outside the ring but inside the cone.
    const assist = readScope({ hash: hashWith([target]), aim: { x: 1.9, y: 0 }, weapon: assisted });
    assert.equal(assist.state, SCOPE_STATE.ASSIST);
    assert.equal(assist.target.assist, true);
    assert.equal(assist.target.inside, false, 'assist matters precisely when the shot would miss');
    assert.ok(assist.target.assistRadius > 1.9);
    assert.equal(assistRadiusFor(assisted, target), assisted.aimAssist * 0.6 * 2.2);

    // Without assist the same aim is just "near".
    const plain = readScope({ hash: hashWith([target]), aim: { x: 1.9, y: 0 }, weapon: pulse });
    assert.equal(plain.state, SCOPE_STATE.NEAR);
});

test('the nearest body wins, and the widest bodies are reachable', () => {
    const near = enemy(1.2, 0, { radius: 0.5, name: 'Skitter', archetypeId: 'fast' });
    const far = enemy(3.0, 0, { radius: 0.5 });
    const hash = hashWith([near, far]);
    const scope = readScope({ hash, aim: { x: 0, y: 0 }, weapon: pulse });
    assert.equal(scope.target.name, 'SKITTER');
    assert.equal(scope.target.distance, 1.2);

    // A Warden is wider than the search padding assumptions of a naive query, so
    // check the scope still reaches it at its own edge.
    const boss = enemy(0, 0, { radius: 1.85, hp: 26, maxHp: 26, boss: true, name: 'Warden' });
    const bossHash = hashWith([boss]);
    const bossScope = readScope({ hash: bossHash, aim: { x: 2.6, y: 0 }, weapon: pulse });
    assert.ok(bossScope.target, 'the Warden is found from outside the ring');
    assert.equal(bossScope.target.inside, true, 'and it is genuinely hittable there');
    assert.equal(bossScope.target.boss, true);
    assert.equal(bossScope.target.name, 'WARDEN');

    const tooFar = readScope({ hash: bossHash, aim: { x: 3.2, y: 0 }, weapon: pulse });
    assert.equal(tooFar.state, SCOPE_STATE.SEARCHING);
    assert.ok(MAX_TARGET_RADIUS >= 1.85);
});

test('describeTarget and shotsToKill report honest numbers', () => {
    const elite = enemy(0, 0, { hp: 3, maxHp: 10, elite: true, name: 'Bulwark', archetypeId: 'tank', score: 320 });
    const described = describeTarget(elite);
    assert.equal(described.name, 'BULWARK');
    assert.equal(described.elite, true);
    assert.equal(described.boss, false);
    assert.equal(described.hp, 3);
    assert.equal(described.maxHp, 10);
    assert.equal(described.hpFrac, 0.3);
    assert.equal(described.score, 320);

    assert.equal(describeTarget(null), null);
    assert.equal(shotsToKill({ hp: 4 }, { damage: 1 }), 4);
    assert.equal(shotsToKill({ hp: 4 }, { damage: 2.2 }), 2);
    assert.equal(shotsToKill({ hp: 0 }, { damage: 2 }), 0);
    assert.equal(shotsToKill({ hp: 1 }, null), 1);
    assert.equal(shotsToKill(null, pulse), 0);
});

test('the scope only reports its own enemies when a predicate says so', () => {
    const mine = enemy(0, 0, { archetypeId: 'basic' });
    const pod = { x: 0.4, y: 0, radius: 0.9, alive: true, type: { id: 'chain' }, hp: 1, __pool: 'other' };
    const hash = hashWith([pod, mine], 2);

    const unfiltered = readScope({ hash, aim: { x: 0, y: 0 }, weapon: pulse });
    assert.equal(unfiltered.target.archetype, 'basic', 'non-targets never win the lock');

    const onlyMine = readScope({
        hash,
        aim: { x: 0, y: 0 },
        weapon: pulse,
        predicate: (view) => view === mine
    });
    assert.equal(onlyMine.target.name, 'DRONE');

    // The predicate decides what may be locked, pod or not.
    const podOnly = readScope({
        hash,
        aim: { x: 0, y: 0 },
        weapon: pulse,
        predicate: (view) => view === pod
    });
    assert.equal(podOnly.state, SCOPE_STATE.LOCKED);

    const nothing = readScope({ hash, aim: { x: 0, y: 0 }, weapon: pulse, predicate: () => false });
    assert.equal(nothing.state, SCOPE_STATE.SEARCHING);
    assert.equal(nothing.target, null);
    assert.equal(scopeState(null), SCOPE_STATE.SEARCHING);
});
