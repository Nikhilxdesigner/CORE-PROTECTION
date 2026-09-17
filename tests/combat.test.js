/**
 * Combat tests: shot resolution and the wave director.
 *
 * Both are deterministic by construction - they draw from a seeded stream and
 * never read the clock - and both are load-bearing for the feel of the game, so
 * they are exercised headlessly here: pierce, spread, crits, aim assist, budget
 * spending, boss cadence, hazards, Hyter time dilation and reproducibility.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    WEAPONS, WEAPON_LIST, combineModifiers, resolveShot, muzzlePosition, volleyLength
} from '../src/world/Weapons.js';
import { SpatialHash } from '../src/world/SpatialHash.js';
import { Rng, createStream } from '../src/core/Rng.js';
import { ARENA, insideBounds } from '../src/world/ArenaSpec.js';
import { ARCHETYPES, HAZARDS, eliteChance, waveBudget, spawnInterval, speedMultiplier } from '../src/world/archetypes.js';
import { createDirector, PHASE, DEFAULT_RULES } from '../src/world/Director.js';

/** A weapon with crits disabled, so damage assertions are exact. */
function noCrit(weapon = WEAPONS.pulse, mods = {}) {
    return combineModifiers(weapon, { ...mods, crit: -1 });
}

function targetAt(x, y, radius = 0.5) {
    return { x, y, radius, hp: 1, id: `t${x}:${y}` };
}

function hashWith(targets) {
    const hash = new SpatialHash({ cellSize: ARENA.averageEnemyRadius * 2.6 });
    for (const target of targets) hash.upsert(target, target.x, target.y, target.radius);
    return hash;
}

/* ---------------------------------------------------------------- weapons -- */

test('modifiers fold weapon data into concrete shot numbers', () => {
    const base = combineModifiers(WEAPONS.pulse, {});
    assert.equal(base.rof, WEAPONS.pulse.rof);
    assert.equal(base.cooldownTicks, Math.round(WEAPONS.pulse.rof * 60));
    assert.equal(base.projectiles, 1);
    assert.equal(base.spread, 0);
    assert.equal(base.hitRadius, 0.95);
    assert.equal(base.crit, 0.08);

    const buffed = combineModifiers(WEAPONS.pulse, {
        rof: 1.5, damage: 2, projectiles: 2, pierce: 1, crit: 0.1, hitRadius: 1.2, tickHz: 60
    });
    assert.ok(Math.abs(buffed.rof - WEAPONS.pulse.rof / 1.5) < 1e-9);
    assert.equal(buffed.projectiles, 3);
    assert.ok(buffed.spread >= 0.3, 'a multi-projectile weapon always fans out');
    assert.equal(buffed.pierce, 1);
    assert.ok(Math.abs(buffed.crit - 0.18) < 1e-9);
    assert.ok(Math.abs(buffed.hitRadius - 1.2 * 0.95) < 1e-9);

    // Floors: nothing can make a weapon fire infinitely fast or hit for zero.
    const absurd = combineModifiers(WEAPONS.lance, { rof: 0.0001, damage: 0.01 });
    assert.ok(absurd.rof <= WEAPONS.lance.rof / 0.2 + 1e-9, 'fire rate multiplier is floored');
    assert.equal(absurd.damage, 0.1, 'damage has a floor');
    assert.equal(absurd.crit, WEAPONS.lance.crit);

    assert.equal(WEAPON_LIST.length, 3);
    assert.ok(WEAPONS.scatter.unlock, 'locked weapons declare their unlock condition');

    const muzzle = muzzlePosition({ x: 100, y: 0 });
    assert.equal(muzzle.y, -ARENA.bounds.y * 0.62);
    assert.equal(muzzle.x, ARENA.bounds.x * 0.5, 'the muzzle stays inside the arena');
});

test('a shot hits the target under the crosshair and misses the one beside it', () => {
    const near = targetAt(0, 0, 0.6);
    const far = targetAt(9, 0, 0.6);
    const hash = hashWith([near, far]);

    const result = resolveShot({
        origin: muzzlePosition({ x: 0, y: 0 }),
        aim: { x: 0, y: 0 },
        hash,
        rng: new Rng(1),
        weapon: noCrit(),
        scratchCandidates: []
    });

    assert.equal(result.shots, 1);
    assert.equal(result.rays.length, 1);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].target, near);
    assert.equal(result.hits[0].damage, 1);
    assert.equal(result.hits[0].crit, false);
    assert.ok(Math.abs(result.rays[0].endX) < 0.05);
    assert.equal(result.aimError, 0);
    assert.ok(volleyLength(result.rays) > 7);
});

test('crits multiply damage and pierce walks through a column', () => {
    const single = targetAt(0, 0, 0.5);
    const second = targetAt(0.5, 0, 0.5);
    const third = targetAt(1.0, 0, 0.5);
    const hash = hashWith([single, second, third]);
    const origin = muzzlePosition({ x: 0, y: 0 });

    const one = resolveShot({
        origin, aim: { x: 0, y: 0 }, hash, rng: new Rng(2), weapon: noCrit(), scratchCandidates: []
    });
    assert.equal(one.hits.length, 1, 'a plain weapon stops at the first body');

    const piercing = resolveShot({
        origin,
        aim: { x: 0, y: 0 },
        hash,
        rng: new Rng(2),
        weapon: noCrit(WEAPONS.pulse, { pierce: 1 }),
        scratchCandidates: []
    });
    assert.equal(piercing.hits.length, 2, 'pierce 1 reaches one body further');
    assert.deepEqual(piercing.hits.map((hit) => hit.target), [single, second]);

    // A critical multiplies the damage and is flagged for the FX layer.
    const alwaysCrit = combineModifiers(WEAPONS.pulse, { crit: 1 });
    const crit = resolveShot({
        origin,
        aim: { x: 0, y: 0 },
        hash: hashWith([single]),
        rng: new Rng(3),
        weapon: alwaysCrit,
        scratchCandidates: []
    });
    assert.equal(crit.hits[0].crit, true);
    assert.equal(crit.hits[0].damage, alwaysCrit.damage * alwaysCrit.critMult);
});

test('a scatter volley fans out and never hits one body twice', () => {
    const targets = [targetAt(0, 0, 0.45), targetAt(0.25, 0.1, 0.45), targetAt(-0.25, -0.1, 0.45)];
    const hash = hashWith(targets);

    const scatter = noCrit(WEAPONS.scatter);
    const result = resolveShot({
        origin: muzzlePosition({ x: 0, y: 0 }),
        aim: { x: 0, y: 0 },
        hash,
        rng: new Rng(4),
        weapon: scatter,
        scratchCandidates: []
    });

    assert.equal(scatter.projectiles, 5);
    assert.equal(result.rays.length, 5);
    const span = Math.abs(result.rays[0].angle - result.rays[4].angle);
    assert.ok(Math.abs(span - scatter.spread) < 0.05, `cone span ${span} vs ${scatter.spread}`);

    const hitTargets = result.hits.map((hit) => hit.target);
    assert.equal(new Set(hitTargets).size, hitTargets.length, 'no body is damaged twice');
    assert.ok(hitTargets.length <= targets.length);
});

test('a miss produces rays and no hits, so tracers still draw', () => {
    const hash = new SpatialHash({ cellSize: 2 });
    const result = resolveShot({
        origin: muzzlePosition({ x: 0, y: 0 }),
        aim: { x: 12, y: 6 },
        hash,
        rng: new Rng(5),
        weapon: noCrit(WEAPONS.scatter),
        scratchCandidates: []
    });
    assert.equal(result.hits.length, 0);
    assert.equal(result.rays.length, 5);
    assert.ok(volleyLength(result.rays) > 10);
});

test('aim assist actually bends the volley onto the target', () => {
    const origin = muzzlePosition({ x: 0, y: 0 });
    const edge = targetAt(1.6, 0, 0.4);
    const hash = hashWith([edge]);

    const plain = resolveShot({
        origin, aim: { x: 0, y: 0 }, hash, rng: new Rng(6), weapon: noCrit(), scratchCandidates: []
    });
    assert.equal(plain.hits.length, 0, 'without assist the shot passes by the target');

    const assisted = resolveShot({
        origin,
        aim: { x: 0, y: 0 },
        hash,
        rng: new Rng(6),
        weapon: combineModifiers(WEAPONS.pulse, { baseAimAssist: 2, crit: -1 }),
        aimAssistTarget: edge,
        scratchCandidates: []
    });
    assert.equal(assisted.hits.length, 1, 'assist snaps the ray onto the target');
    assert.equal(assisted.hits[0].target, edge);
    assert.ok(assisted.aimError > 1.5, `the snap is reported as aim error (${assisted.aimError})`);
});

test('shot resolution is reproducible for a seed and filters via the predicate', () => {
    const targets = [targetAt(0, 0, 0.5), targetAt(0.6, 0.2, 0.5), targetAt(-0.4, 0.3, 0.5)];
    const input = () => ({
        origin: muzzlePosition({ x: 0, y: 0 }),
        aim: { x: 0, y: 0 },
        hash: hashWith(targets),
        rng: new Rng(777),
        weapon: combineModifiers(WEAPONS.scatter, { pierce: 1 }),
        scratchCandidates: []
    });

    const first = resolveShot(input());
    const second = resolveShot(input());
    const simplify = (result) => JSON.stringify({
        rays: result.rays.map((ray) => Math.round(ray.angle * 1e6)),
        hits: result.hits.map((hit) => [hit.target.id, hit.crit, Math.round(hit.damage * 1000), hit.rayIndex])
    });
    assert.equal(simplify(first), simplify(second));

    const filtered = resolveShot({ ...input(), predicate: (candidate) => candidate.x > 0 });
    assert.ok(filtered.hits.every((hit) => hit.target.x > 0));
    assert.ok(filtered.hits.length < first.hits.length);
});

/* --------------------------------------------------------------- director -- */

/** Minimal stand-in for the enemy manager: spawns die after a while. */
function createWorld(options = {}) {
    const lifespan = options.lifespanTicks ?? 90;
    const enemies = [];
    const world = {
        tick: 0,
        timeFactor: 1,
        peakActive: 0,
        spawns: [],
        hazards: [],
        waveStarts: [],
        waveEnds: [],
        bossStarts: [],
        get activeEnemies() { return enemies.length; },
        get activeHazards() { return world.hazards.length; },
        onSpawn(envelope) {
            if (options.refuseSpawns) return false;
            enemies.push({ expires: world.tick + lifespan });
            world.peakActive = Math.max(world.peakActive, enemies.length);
            world.spawns.push(envelope);
            return true;
        },
        onHazard(hazard) {
            world.hazards.push(hazard);
            return true;
        },
        onWaveStart(wave, info) { world.waveStarts.push({ wave, ...info }); },
        onWaveEnd(wave, info) { world.waveEnds.push({ wave, ...info }); },
        onBossStart(info) { world.bossStarts.push(info); },
        step() {
            world.tick += 1;
            for (let i = enemies.length - 1; i >= 0; i--) {
                if (enemies[i].expires <= world.tick) enemies.splice(i, 1);
            }
        }
    };
    return world;
}

function runDirector(seed, world, ticks = 6000, options = {}) {
    const director = createDirector({
        rng: createStream(seed, 'director'),
        // Compressed waves so a few thousand ticks cover double-digit waves, and
        // a strong Minefield-style hazard rate so hazards appear within a wave.
        rules: { budgetMul: 0.25, spawnRateMul: 4, hazardMul: 8, ...(options.rules || {}) },
        tuning: { intermission: 0.1, bossDelay: 0.15, ...(options.tuning || {}) },
        limits: options.limits
    });
    director.reset(1, world);
    for (let i = 0; i < ticks; i++) {
        director.tick(1 / 60, world);
        world.step();
    }
    return director;
}

function spawnSignature(world) {
    return world.spawns.map((envelope) => [
        envelope.wave,
        envelope.archetype.id,
        envelope.elite ? 1 : 0,
        Math.round(envelope.x * 1000),
        Math.round(envelope.y * 1000)
    ]);
}

test('director escalates waves, spends its budget, and never escapes the arena', () => {
    const world = createWorld();
    const director = runDirector(2024, world, 6000);

    assert.ok(world.spawns.length > 20, `expected a busy arena, got ${world.spawns.length}`);
    assert.ok(director.wave >= 5, `expected several waves, reached ${director.wave}`);
    assert.ok(world.waveEnds.length >= 4, 'waves are closed out');
    assert.ok(world.waveStarts.length >= world.waveEnds.length);

    for (const envelope of world.spawns) {
        assert.ok(insideBounds(envelope.x, envelope.y), `spawn ${envelope.x},${envelope.y} left the arena`);
        assert.ok(envelope.speedMul > 0);
        assert.ok(envelope.wave >= 1);
    }

    const stats = director.stats();
    assert.ok(stats.spent <= stats.budget + 1e-6, 'the budget is never overspent');
    assert.ok(stats.hazards > 0, 'hazards start once the waves get serious');
    assert.equal(director.limits.maxActiveEnemies, 60);
    assert.equal(director.rules.id, DEFAULT_RULES.id);

    // The debug path can force an elite on demand, which is what practice mode uses.
    const forced = createWorld();
    const forcedDirector = createDirector({ rng: createStream(7, 'director') });
    forcedDirector.reset(1, forced);
    assert.equal(forcedDirector.forceSpawn(forced, 'tank', true), true);
    assert.equal(forced.spawns[0].elite, true);
    assert.equal(forced.spawns[0].archetype.id, 'tank');
    assert.equal(forcedDirector.stats().elites, 1);
    assert.equal(forcedDirector.jumpTo(5, forced), 5);
    assert.equal(forcedDirector.bossPending, true, 'a boss wave announces the Warden');

    const firstBoss = world.spawns.find((envelope) => envelope.archetype.id === 'boss');
    assert.ok(firstBoss, 'a Warden appears on the boss cadence');
    assert.equal(firstBoss.wave % 5, 0);
    assert.ok(firstBoss.boss);
    assert.ok(world.bossStarts.length >= 1);
});

test('a seed fully determines the wave, and a different seed diverges', () => {
    const worldA = createWorld();
    const worldB = createWorld();
    const worldC = createWorld();
    runDirector(424242, worldA, 4000);
    runDirector(424242, worldB, 4000);
    runDirector(9, worldC, 4000);

    assert.deepEqual(spawnSignature(worldA), spawnSignature(worldB), 'same seed -> same run');
    assert.notDeepEqual(spawnSignature(worldA), spawnSignature(worldC), 'different seed -> different run');
});

test('Hyper Mode dilation slows incoming pressure, not just the visuals', () => {
    const normal = createWorld();
    const slowed = createWorld();
    const directorFast = createDirector({
        rng: createStream(555, 'director'),
        rules: { budgetMul: 0.25, spawnRateMul: 4 },
        tuning: { intermission: 0.1, bossDelay: 0.15 }
    });
    const directorSlow = createDirector({
        rng: createStream(555, 'director'),
        rules: { budgetMul: 0.25, spawnRateMul: 4 },
        tuning: { intermission: 0.1, bossDelay: 0.15 }
    });
    directorFast.reset(1, normal);
    directorSlow.reset(1, slowed);

    normal.timeFactor = 1;
    slowed.timeFactor = 0.62;
    for (let i = 0; i < 1800; i++) {
        directorFast.tick(1 / 60, normal);
        normal.step();
        directorSlow.tick(1 / 60, slowed);
        slowed.step();
    }

    assert.ok(normal.spawns.length > 0);
    assert.ok(
        slowed.spawns.length < normal.spawns.length,
        `slowed director spawned ${slowed.spawns.length} vs ${normal.spawns.length}`
    );
    assert.ok(directorSlow.stats().elapsed < directorFast.stats().elapsed, 'world time really is dilated');
});

test('director refuses to overfill the active cap and keeps the budget for later', () => {
    const world = createWorld();
    const director = createDirector({
        rng: createStream(31337, 'director'),
        rules: { budgetMul: 0.25, spawnRateMul: 4 },
        tuning: { intermission: 0.1, bossDelay: 0.15 },
        limits: { maxActiveEnemies: 2 }
    });
    director.reset(1, world);

    for (let i = 0; i < 3000; i++) {
        director.tick(1 / 60, world);
        world.step();
    }

    const stats = director.stats();
    assert.ok(stats.heldBack > 0, 'surplus budget is banked when the arena is full');
    assert.ok(stats.spent <= stats.budget);
    assert.ok(
        world.peakActive <= 3,
        `the active cap is respected within a tick (peak ${world.peakActive}, cap 2 + boss)`
    );

    // A refusing spawn callback (pool exhausted) must not consume budget either.
    const refusing = createWorld({ refuseSpawns: true });
    const stubborn = createDirector({ rng: createStream(1, 'director') });
    stubborn.reset(1, refusing);
    for (let i = 0; i < 600; i++) stubborn.tick(1 / 60, refusing);
    assert.equal(refusing.spawns.length, 0);
    assert.equal(stubborn.stats().spent, 0, 'budget is only spent when a body really spawns');
    assert.ok(stubborn.stats().pending > 0);

    assert.throws(() => createDirector({}), /seeded rng/);
});

test('wave pacing helpers stay monotonic and within their clamps', () => {
    assert.ok(waveBudget(2) > waveBudget(1));
    assert.ok(waveBudget(20) > waveBudget(10));
    assert.ok(spawnInterval(10) < spawnInterval(1), 'later waves spawn faster');
    assert.ok(spawnInterval(50) >= 0.26, 'interval never collapses to zero');
    assert.ok(speedMultiplier(50) <= 2.35, 'enemy speed is capped');
    assert.equal(eliteChance(1), 0, 'no elites in wave 1');
    assert.ok(eliteChance(10) > 0);
    assert.ok(eliteChance(60) <= 0.45, 'elite chance is capped');

    assert.equal(ARCHETYPES.boss.boss, true);
    assert.equal(ARCHETYPES.boss.cost, 0, 'a boss never consumes spawn budget');
    assert.equal(HAZARDS.mine.coreDamage, 1);
    assert.equal(PHASE.INTERMISSION, 'intermission');
});
