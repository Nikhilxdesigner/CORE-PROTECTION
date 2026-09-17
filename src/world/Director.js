/**
 * Wave director.
 *
 * Difficulty is expressed as a *spendable budget* rather than a spawn count, so
 * a wave can be made more intense without ever putting hundreds of objects on
 * screen: composition gets more expensive, elites appear, hazards accumulate,
 * speed climbs, and the boss cadence tightens. When the active-enemy cap is
 * reached the surplus budget is redirected into elites, hazards and
 * reinforcement pulses instead of more bodies.
 *
 * All timers run on the fixed simulation step and are scaled by the world time
 * factor (so Hyper Mode genuinely slows incoming pressure).
 */

import {
    ARCHETYPES,
    SPAWNABLE,
    DIRECTOR_TUNING,
    HAZARDS,
    eliteChance,
    spawnInterval,
    speedMultiplier,
    waveBudget
} from './archetypes.js';
import { spawnPoint, spawnRing } from './ArenaSpec.js';
import { ELITE } from './archetypes.js';

export const PHASE = Object.freeze({
    INTERMISSION: 'intermission',
    SPAWNING: 'spawning',
    CLEARING: 'clearing'
});

export const DEFAULT_RULES = Object.freeze({
    id: 'standard',
    name: 'Standard Assault',
    budgetMul: 1,
    spawnRateMul: 1,
    eliteBias: 1,
    hazardMul: 1,
    speedMul: 1,
    bossEvery: DIRECTOR_TUNING.bossEvery,
    eliteFromWave: DIRECTOR_TUNING.eliteFromWave,
    hazardFromWave: DIRECTOR_TUNING.hazardFromWave,
    scoreMul: 1
});

export function createDirector(options = {}) {
    const rng = options.rng;
    if (!rng) throw new Error('Director requires a seeded rng stream');

    const tuning = { ...DIRECTOR_TUNING, ...(options.tuning || {}) };
    let limits = { maxActiveEnemies: 60, hazardCap: 4, ...(options.limits || {}) };
    let rules = { ...DEFAULT_RULES, ...(options.rules || {}) };

    const state = {
        wave: 0,
        phase: PHASE.INTERMISSION,
        pending: 0,
        budget: 0,
        spent: 0,
        elapsed: 0,
        waveElapsed: 0,
        spawnTimer: 0,
        hazardTimer: 0,
        hazardsSpawnedThisWave: 0,
        bossSpawned: false,
        bossPending: false,
        intermissionTimer: 0,
        anglePool: [],
        waveKills: 0,
        totalSpawned: 0,
        totalElites: 0,
        totalBosses: 0,
        totalHazards: 0,
        heldBackBudget: 0
    };

    function refillAngles() {
        state.anglePool = rng.shuffle(spawnRing(16));
    }

    function nextSpawnPoint() {
        if (state.anglePool.length === 0) refillAngles();
        const angle = state.anglePool.pop();
        // Radius and jitter are drawn from the seeded stream so a seed fully
        // determines the spawn ring.
        const unitRadius = 0.94 + rng.range(0, 0.12);
        return spawnPoint(angle, unitRadius, rng.float(), rng.float());
    }

    function affordableCandidates(budget) {
        const list = SPAWNABLE.filter((a) => a.minWave <= state.wave && a.cost <= budget);
        return list.length > 0 ? list : [];
    }

    function pickArchetype() {
        const candidates = affordableCandidates(state.pending);
        if (candidates.length === 0) return null;

        // Cheap enemies dominate early; later waves shift weight toward tanks.
        const tankWeight = Math.min(1.6, 0.25 + state.wave * 0.09);
        const weights = candidates.map((a) => {
            if (a.id === 'tank') return tankWeight;
            if (a.id === 'fast') return 1.35;
            return 1;
        });

        let total = 0;
        for (const w of weights) total += w;
        let roll = rng.float() * total;
        for (let i = 0; i < candidates.length; i++) {
            roll -= weights[i];
            if (roll <= 0) return candidates[i];
        }
        return candidates[candidates.length - 1];
    }

    function spawnEnemy(world, archetype, forceElite = false) {
        const eliteAllowed = state.wave >= rules.eliteFromWave && archetype.elite;
        const eliteRoll = eliteAllowed ? eliteChance(state.wave) * rules.eliteBias : 0;
        let elite = forceElite || (eliteAllowed && rng.chance(eliteRoll));

        let cost = archetype.cost * (elite ? ELITE.costMul : 1);
        if (cost > state.pending) {
            if (archetype.cost > state.pending) return false;   // cannot afford base cost
            elite = false;                                      // downgrade rather than skip
            cost = archetype.cost;
        }

        const point = nextSpawnPoint();
        const envelope = {
            archetype,
            x: point.x,
            y: point.y,
            elite,
            wave: state.wave,
            speedMul: speedMultiplier(state.wave, rules.speedMul),
            scoreMul: rules.scoreMul * (elite ? ELITE.scoreMul : 1)
        };

        const spawned = world.onSpawn?.(envelope);
        if (spawned === false) return false;                     // pool exhausted: keep budget

        state.pending -= cost;
        state.spent += cost;
        state.totalSpawned += 1;
        if (elite) state.totalElites += 1;
        return true;
    }

    function spawnHazard(world) {
        if (state.hazardsSpawnedThisWave >= limits.hazardCap) return false;
        const point = nextSpawnPoint();
        const spawned = world.onHazard?.({ type: HAZARDS.mine, x: point.x, y: point.y, wave: state.wave });
        if (spawned === false) return false;
        state.hazardsSpawnedThisWave += 1;
        state.totalHazards += 1;
        return true;
    }

    function startWave(wave, world) {
        state.wave = wave;
        state.phase = PHASE.SPAWNING;
        state.budget = Math.round(waveBudget(wave) * rules.budgetMul);
        state.pending = state.budget;
        state.spent = 0;
        state.waveElapsed = 0;
        state.hazardsSpawnedThisWave = 0;
        state.bossSpawned = false;
        state.bossPending = rules.bossEvery > 0 && wave % rules.bossEvery === 0;
        state.spawnTimer = spawnInterval(wave, rules.spawnRateMul) * 0.5;
        state.hazardTimer = tuning.hazardInterval / Math.max(0.4, rules.hazardMul);
        refillAngles();
        world.onWaveStart?.(wave, {
            budget: state.budget,
            bossPending: state.bossPending,
            rules: rules.id,
            name: rules.name
        });
    }

    return {
        PHASE,

        get wave() { return state.wave; },
        get phase() { return state.phase; },
        get pending() { return state.pending; },
        get budget() { return state.budget; },
        get spent() { return state.spent; },
        get elapsed() { return state.elapsed; },
        get waveElapsed() { return state.waveElapsed; },
        get bossPending() { return state.bossPending && !state.bossSpawned; },
        get limits() { return { ...limits }; },
        get rules() { return { ...rules }; },

        setRules(next) {
            rules = { ...rules, ...(next || {}) };
            return rules;
        },

        setLimits(next) {
            limits = { ...limits, ...(next || {}) };
            return limits;
        },

        /** Begin a fresh run at `wave` (1 by default). */
        reset(wave = 1, world = {}) {
            state.elapsed = 0;
            state.waveKills = 0;
            state.totalSpawned = 0;
            state.totalElites = 0;
            state.totalBosses = 0;
            state.totalHazards = 0;
            state.spent = 0;
            startWave(wave, world);
            return state.wave;
        },

        /** Debug helper: jump straight to a wave. */
        jumpTo(wave, world = {}) {
            startWave(Math.max(1, wave), world);
            return state.wave;
        },

        /** Debug helper: force a single spawn. */
        forceSpawn(world, archetypeId, elite = false) {
            const archetype = ARCHETYPES[archetypeId] || ARCHETYPES.basic;
            const previousPending = state.pending;
            state.pending = Math.max(state.pending, archetype.cost * (elite ? ELITE.costMul : 1));
            const ok = spawnEnemy(world, archetype, elite);
            if (!ok) state.pending = previousPending;
            return ok;
        },

        /** Debug helper: force a boss. */
        forceBoss(world) {
            state.bossPending = true;
            state.bossSpawned = false;
            state.bossDelayOverride = 0;
            return true;
        },

        /**
         * One fixed simulation step.
         * @param {number} dt fixed delta in seconds
         * @param {object} world
         * @param {number} world.activeEnemies current live enemy count
         * @param {number} world.activeHazards current live hazard count
         * @param {number} [world.timeFactor] world time scale (Hyper Mode)
         * @param {Function} [world.onSpawn]
         * @param {Function} [world.onHazard]
         * @param {Function} [world.onWaveStart]
         * @param {Function} [world.onWaveEnd]
         * @param {Function} [world.onBossStart]
         * @param {Function} [world.onWaveClearSummary]
         */
        tick(dt, world) {
            const timeFactor = Math.max(0.05, world.timeFactor ?? 1);
            const scaled = dt * timeFactor;
            state.elapsed += scaled;
            state.waveElapsed += scaled;

            // Tracks live bodies, including the ones spawned earlier in this same
            // tick, so the active cap holds even when the spawn loop runs several
            // times in one step.
            let active = world.activeEnemies ?? 0;

            switch (state.phase) {
                case PHASE.INTERMISSION: {
                    state.intermissionTimer -= scaled;
                    if (state.intermissionTimer <= 0) startWave(state.wave + 1, world);
                    break;
                }

                case PHASE.SPAWNING: {
                    // Boss arrives early in boss waves so it anchors the fight.
                    if (state.bossPending && !state.bossSpawned && state.waveElapsed >= (state.bossDelayOverride ?? tuning.bossDelay)) {
                        state.bossDelayOverride = null;
                        const bossArchetype = ARCHETYPES.boss;
                        const point = nextSpawnPoint();
                        const spawned = world.onSpawn?.({
                            archetype: bossArchetype,
                            x: point.x,
                            y: point.y,
                            elite: false,
                            boss: true,
                            wave: state.wave,
                            speedMul: speedMultiplier(state.wave, rules.speedMul),
                            scoreMul: rules.scoreMul
                        });
                        if (spawned !== false) {
                            state.bossSpawned = true;
                            state.totalBosses += 1;
                            world.onBossStart?.({ wave: state.wave, hp: bossArchetype.hp });
                        }
                    }

                    // Hazards are pressure that does not consume enemy slots.
                    if (state.wave >= rules.hazardFromWave && limits.hazardCap > 0) {
                        state.hazardTimer -= scaled;
                        if (state.hazardTimer <= 0 && (world.activeHazards ?? 0) < limits.hazardCap) {
                            spawnHazard(world);
                            const interval = Math.max(tuning.hazardIntervalMin, tuning.hazardInterval - state.wave * 0.25);
                            state.hazardTimer = interval / Math.max(0.4, rules.hazardMul) * rng.range(0.85, 1.2);
                        }
                    }

                    if (state.pending > 0) {
                        state.spawnTimer -= scaled;
                        const interval = spawnInterval(state.wave, rules.spawnRateMul);
                        let guard = 0;
                        while (state.pending > 0 && state.spawnTimer <= 0 && guard < 4) {
                            guard += 1;
                            if (active >= limits.maxActiveEnemies) {
                                // At the cap: bank the budget as pressure for later
                                // instead of spawning more objects now.
                                state.heldBackBudget += state.pending;
                                state.spawnTimer = 1.0;
                                break;
                            }
                            const archetype = pickArchetype();
                            if (!archetype) { state.pending = 0; break; }
                            const ok = spawnEnemy(world, archetype);
                            if (!ok) break;
                            active += 1;
                            state.spawnTimer += interval * rng.range(1 - tuning.intervalJitter, 1 + tuning.intervalJitter);
                        }
                    }

                    const timeUp = state.waveElapsed > tuning.maxWaveDuration;
                    if (timeUp && state.pending > 0) state.pending = 0;

                    // A wave is clear once the budget is spent and the arena is
                    // empty; a live boss keeps the wave open simply by being alive.
                    if (state.pending <= 0 && active === 0 && !world.keepWaveOpen) {
                        state.phase = PHASE.CLEARING;
                        state.intermissionTimer = tuning.intermission;
                        world.onWaveEnd?.(state.wave, {
                            kills: state.waveKills,
                            spent: state.spent,
                            budget: state.budget,
                            duration: state.waveElapsed
                        });
                    }
                    break;
                }

                case PHASE.CLEARING: {
                    state.intermissionTimer -= scaled;
                    if (state.intermissionTimer <= 0) startWave(state.wave + 1, world);
                    break;
                }
            }

            return state.phase;
        },

        /** Called by the enemy manager on each kill so pacing can adapt. */
        notifyKill(elite = false, boss = false) {
            state.waveKills += 1;
            if (boss) state.bossSpawned = true;
            if (elite) state.eliteKills = (state.eliteKills || 0) + 1;
        },

        /** Live pressure numbers shown in the debug overlay. */
        stats() {
            return {
                wave: state.wave,
                phase: state.phase,
                budget: state.budget,
                spent: state.spent,
                pending: state.pending,
                heldBack: state.heldBackBudget,
                spawned: state.totalSpawned,
                elites: state.totalElites,
                bosses: state.totalBosses,
                hazards: state.totalHazards,
                elapsed: Math.round(state.elapsed * 10) / 10,
                waveElapsed: Math.round(state.waveElapsed * 10) / 10,
                caps: { ...limits }
            };
        }
    };
}
