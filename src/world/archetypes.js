/**
 * Enemy and hazard archetypes.
 *
 * Pure data: geometry kind, stats, cost in wave budget points, and the visual
 * palette. The renderer turns `shape` into a procedural mesh; the director uses
 * `cost`, `minWave` and `elite` to build waves; scoring and drops read the rest.
 */

export const ARCHETYPES = Object.freeze({
    fast: {
        id: 'fast',
        name: 'Skitter',
        shape: 'tetra',
        hp: 1,
        speed: 3.2,
        radius: 0.5,
        score: 150,
        cost: 4,
        minWave: 1,
        color: 0xffcc33,
        glow: 0xffa000,
        dropChance: 0.05,
        elite: true,
        horn: 0.55
    },
    basic: {
        id: 'basic',
        name: 'Drone',
        shape: 'icosa',
        hp: 1,
        speed: 1.55,
        radius: 0.62,
        score: 100,
        cost: 6,
        minWave: 1,
        color: 0xff4d3d,
        glow: 0xff2b1c,
        dropChance: 0.06,
        elite: true,
        horn: 0.75
    },
    tank: {
        id: 'tank',
        name: 'Bulwark',
        shape: 'box',
        hp: 4,
        speed: 0.85,
        radius: 0.95,
        score: 320,
        cost: 12,
        minWave: 2,
        color: 0xff8c1a,
        glow: 0xff6a00,
        dropChance: 0.22,
        elite: true,
        horn: 1.05
    },
    boss: {
        id: 'boss',
        name: 'Warden',
        shape: 'dodeca',
        hp: 26,
        speed: 0.52,
        radius: 1.85,
        score: 1500,
        cost: 0,
        minWave: 5,
        boss: true,
        color: 0xb066ff,
        glow: 0x8a2be2,
        dropChance: 1,
        elite: false,
        horn: 1.4
    }
});

export const ARCHETYPE_LIST = Object.freeze(Object.values(ARCHETYPES));
export const SPAWNABLE = Object.freeze(ARCHETYPE_LIST.filter((a) => !a.boss));

/** Elite variants cost more, are visibly bigger, and are worth more points. */
export const ELITE = Object.freeze({
    hpMul: 3.2,
    speedMul: 1.1,
    radiusMul: 1.35,
    scoreMul: 3,
    costMul: 2.4,
    colorShift: 0.35,
    dropChanceMul: 2
});

export const HAZARDS = Object.freeze({
    mine: {
        id: 'mine',
        name: 'Void Mine',
        shape: 'octa',
        hp: 1,
        radius: 0.85,
        score: 60,
        cost: 3,
        fuse: 7.5,          // seconds until it detonates on its own
        coreDamage: 1,
        knockback: 2.2,     // impulse applied to nearby enemies on detonation
        color: 0xff2fd0,
        glow: 0xff006e
    }
});

/** Per-wave pressure tuning for the director. */
export const DIRECTOR_TUNING = Object.freeze({
    baseBudget: 44,
    budgetPerWave: 19,
    budgetGrowth: 1.06,             // compounding pressure in later waves
    baseInterval: 1.15,
    intervalPerWave: 0.05,
    minInterval: 0.26,
    intervalJitter: 0.25,
    eliteFromWave: 3,
    eliteChanceBase: 0.08,
    eliteChancePerWave: 0.035,
    eliteChanceMax: 0.45,
    speedPerWave: 0.045,
    speedMax: 2.35,
    intermission: 2.4,
    maxWaveDuration: 95,
    bossEvery: 5,
    bossDelay: 2.5,
    hazardFromWave: 3,
    hazardInterval: 6.5,
    hazardIntervalMin: 3.2
});

export function archetypeById(id) {
    return ARCHETYPES[id] || ARCHETYPES.basic;
}

export function waveBudget(wave) {
    const t = DIRECTOR_TUNING;
    const linear = t.baseBudget + t.budgetPerWave * (wave - 1);
    return Math.round(linear * Math.pow(t.budgetGrowth, Math.min(wave, 30) / 6));
}

export function spawnInterval(wave, rateMul = 1) {
    const t = DIRECTOR_TUNING;
    const value = Math.max(t.minInterval, t.baseInterval - t.intervalPerWave * (wave - 1));
    return value / Math.max(0.25, rateMul);
}

export function speedMultiplier(wave, extra = 1) {
    const t = DIRECTOR_TUNING;
    return Math.min(t.speedMax, 1 + t.speedPerWave * (wave - 1)) * extra;
}

export function eliteChance(wave) {
    const t = DIRECTOR_TUNING;
    if (wave < t.eliteFromWave) return 0;
    return Math.min(t.eliteChanceMax, t.eliteChanceBase + t.eliteChancePerWave * (wave - t.eliteFromWave));
}
