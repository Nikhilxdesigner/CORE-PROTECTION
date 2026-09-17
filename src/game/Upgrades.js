/**
 * In-run upgrade drafts.
 *
 * Every run offers a choice of three cards at each wave milestone, drawn from a
 * seeded stream so a seed reproduces the same offers and a replayed run sees the
 * same build. Cards are incremental: `apply(mods, ctx)` is called once per level
 * gained, which keeps stacking maths in one place and makes `max` a plain cap.
 *
 * Evolutions appear only when both prerequisite cards are maxed, and turn two
 * ordinary picks into a build-defining payoff.
 */

import { clamp } from '../util/Math.js';

export const RARITY = Object.freeze({
    common: { id: 'common', name: 'Common', weight: 60, color: '#8fd3ff' },
    rare: { id: 'rare', name: 'Rare', weight: 30, color: '#b388ff' },
    epic: { id: 'epic', name: 'Epic', weight: 12, color: '#ffb347' }
});

/** Fresh modifier bag for a run. */
export function createRunModifiers(tickHz = 60) {
    return {
        tickHz,
        damage: 1,
        damageFlat: 0,
        rof: 1,
        projectiles: 0,
        spreadAdd: 0,
        pierce: 0,
        crit: 0,
        critMult: 0,
        hitRadius: 1,
        baseAimAssist: 0,
        aimAssist: 0,
        coreMax: 0,
        shieldEvery: 0,
        shieldAmount: 1,
        dropRate: 0,
        dropDuration: 1,
        hyperRate: 1,
        hyperDuration: 0,
        dilation: 0,
        chainChance: 0,
        drones: 0,
        nukeCadence: 0,       // kills per free detonation
        eliteDamage: 0,
        bossDamage: 0,
        bulkhead: 0,          // chance to ignore core damage
        healOnKill: 0,        // chance a kill restores a core fragment
        scavenger: 0,
        scoreMul: 1,
        evolved: {}
    };
}

export function createRunUpgrades(tickHz = 60) {
    return {
        levels: {},
        mods: createRunModifiers(tickHz),
        history: []
    };
}

/* ------------------------------------------------------------------ cards -- */

export const CARDS = [
    {
        id: 'overclock',
        name: 'Overclock',
        rarity: 'common',
        max: 5,
        desc: 'Fire rate +12%',
        apply: (mods) => { mods.rof *= 1.12; }
    },
    {
        id: 'heavy_slug',
        name: 'Heavy Slug',
        rarity: 'common',
        max: 5,
        desc: 'Damage +20%',
        apply: (mods) => { mods.damage += 0.2; }
    },
    {
        id: 'focus_lens',
        name: 'Focus Lens',
        rarity: 'common',
        max: 5,
        desc: 'Crit chance +6%',
        apply: (mods) => { mods.crit += 0.06; }
    },
    {
        id: 'wide_spectrum',
        name: 'Wide Spectrum',
        rarity: 'common',
        max: 3,
        desc: 'Hit radius +22%, easier to connect',
        apply: (mods) => { mods.hitRadius += 0.22; }
    },
    {
        id: 'hyper_cell',
        name: 'Hyper Cell',
        rarity: 'common',
        max: 3,
        desc: 'Hyper charge +35% faster',
        apply: (mods) => { mods.hyperRate += 0.35; }
    },
    {
        id: 'magnet_field',
        name: 'Magnet Field',
        rarity: 'common',
        max: 3,
        desc: 'Powerup drop rate +12%',
        apply: (mods) => { mods.dropRate += 0.12; }
    },
    {
        id: 'scavenger',
        name: 'Scavenger',
        rarity: 'common',
        max: 3,
        desc: 'Powerup duration +25%',
        apply: (mods) => { mods.dropDuration += 0.25; }
    },
    {
        id: 'nano_repair',
        name: 'Nano Repair',
        rarity: 'common',
        max: 5,
        desc: 'Repair 1 core integrity now',
        apply: (mods, ctx) => { ctx?.healCore?.(1); }
    },
    {
        id: 'reflex_boost',
        name: 'Reflex Boost',
        rarity: 'common',
        max: 2,
        desc: 'Aim assist +25%',
        apply: (mods) => { mods.aimAssist += 0.25; }
    },
    {
        id: 'split_barrel',
        name: 'Split Barrel',
        rarity: 'rare',
        max: 3,
        desc: '+1 projectile per volley',
        apply: (mods) => { mods.projectiles += 1; }
    },
    {
        id: 'piercing_rounds',
        name: 'Piercing Rounds',
        rarity: 'rare',
        max: 3,
        desc: 'Shots pierce 1 extra target',
        apply: (mods) => { mods.pierce += 1; }
    },
    {
        id: 'executioner',
        name: 'Executioner',
        rarity: 'rare',
        max: 3,
        desc: 'Crit damage +40%',
        apply: (mods) => { mods.critMult += 0.4; }
    },
    {
        id: 'core_plating',
        name: 'Core Plating',
        rarity: 'rare',
        max: 3,
        desc: '+1 max core integrity, and repair it',
        apply: (mods, ctx) => { mods.coreMax += 1; ctx?.healCore?.(1); }
    },
    {
        id: 'aegis',
        name: 'Aegis Loop',
        rarity: 'rare',
        max: 2,
        desc: 'Core self-repairs every 30s (then 20s)',
        apply: (mods) => { mods.shieldEvery = mods.shieldEvery === 0 ? 30 : Math.max(12, mods.shieldEvery - 10); }
    },
    {
        id: 'chain_reaction',
        name: 'Chain Reaction',
        rarity: 'rare',
        max: 3,
        desc: '14% chance a kill detonates a blast',
        apply: (mods) => { mods.chainChance += 0.14; }
    },
    {
        id: 'hunter_mark',
        name: 'Hunter Mark',
        rarity: 'rare',
        max: 2,
        desc: 'Elites take +30% damage',
        apply: (mods) => { mods.eliteDamage += 0.3; }
    },
    {
        id: 'boss_slayer',
        name: 'Boss Slayer',
        rarity: 'rare',
        max: 2,
        desc: 'Bosses take +25% damage',
        apply: (mods) => { mods.bossDamage += 0.25; }
    },
    {
        id: 'chrono_edge',
        name: 'Chrono Edge',
        rarity: 'epic',
        max: 3,
        desc: 'Hyper Mode slows the world a further 4%',
        apply: (mods) => { mods.dilation += 0.04; }
    },
    {
        id: 'swarm_doctrine',
        name: 'Swarm Doctrine',
        rarity: 'epic',
        max: 2,
        desc: 'A drone ally fights for you',
        apply: (mods) => { mods.drones += 1; }
    },
    {
        id: 'thermal_lance',
        name: 'Thermal Lance',
        rarity: 'epic',
        max: 2,
        desc: 'Damage +50%, fire rate -10%',
        apply: (mods) => { mods.damage += 0.5; mods.rof *= 0.9; }
    },
    {
        id: 'killswitch',
        name: 'Killswitch',
        rarity: 'epic',
        max: 1,
        desc: 'Every 25th kill detonates the arena',
        apply: (mods) => { mods.nukeCadence = 25; }
    },
    {
        id: 'bulkhead',
        name: 'Bulkhead',
        rarity: 'rare',
        max: 2,
        desc: '15% chance to shrug off core damage',
        apply: (mods) => { mods.bulkhead += 0.15; }
    },
    {
        id: 'field_medic',
        name: 'Field Medic',
        rarity: 'rare',
        max: 2,
        desc: '4% chance a kill repairs a core',
        apply: (mods) => { mods.healOnKill += 0.04; }
    },
    {
        id: 'hyper_overflow',
        name: 'Hyper Overflow',
        rarity: 'epic',
        max: 1,
        desc: 'Hyper Mode lasts 3s longer',
        apply: (mods) => { mods.hyperDuration += 3; }
    }
];

/** Evolutions: the payoff for maxing two cards that belong together. */
export const EVOLUTIONS = [
    {
        id: 'railgun',
        name: 'RAILGUN',
        rarity: 'epic',
        max: 1,
        evolved: true,
        desc: 'Split Barrel + Piercing Rounds fuse: +2 pierce, +1 projectile, +35% damage',
        requires: { split_barrel: 3, piercing_rounds: 3 },
        apply: (mods) => {
            mods.pierce += 2;
            mods.projectiles += 1;
            mods.damage += 0.35;
            mods.evolved.railgun = true;
        }
    },
    {
        id: 'deadeye',
        name: 'DEADEYE',
        rarity: 'epic',
        max: 1,
        evolved: true,
        desc: 'Focus Lens + Executioner fuse: +15% crit, +60% crit damage',
        requires: { focus_lens: 5, executioner: 3 },
        apply: (mods) => {
            mods.crit += 0.15;
            mods.critMult += 0.6;
            mods.evolved.deadeye = true;
        }
    },
    {
        id: 'drone_swarm',
        name: 'DRONE SWARM',
        rarity: 'epic',
        max: 1,
        evolved: true,
        desc: 'Swarm Doctrine + Overclock fuse: +1 drone, +10% fire rate',
        requires: { swarm_doctrine: 2, overclock: 5 },
        apply: (mods) => {
            mods.drones += 1;
            mods.rof *= 1.1;
            mods.evolved.drone_swarm = true;
        }
    }
];

export const CARD_INDEX = [...CARDS, ...EVOLUTIONS].reduce((acc, card) => {
    acc[card.id] = card;
    return acc;
}, {});

export function cardById(id) {
    return CARD_INDEX[id] || null;
}

export function cardLevel(run, id) {
    return run.levels[id] || 0;
}

export function isMaxed(run, card) {
    return cardLevel(run, card.id) >= card.max;
}

/** Evolutions unlocked by the current card levels and not yet taken. */
export function availableEvolutions(run) {
    return EVOLUTIONS.filter((evo) => {
        if (cardLevel(run, evo.id) > 0) return false;
        return Object.entries(evo.requires).every(([id, level]) => cardLevel(run, id) >= level);
    });
}

/** Cards that can still be offered, evolutions included. */
export function availableCards(run) {
    const base = CARDS.filter((card) => !isMaxed(run, card));
    return [...base, ...availableEvolutions(run)];
}

/**
 * Offer `count` distinct cards, weighted by rarity, from the seeded stream.
 * Returns a fresh array so the UI can hold it while the player decides.
 */
export function offerDraft(rng, run, count = 3) {
    const pool = availableCards(run);
    const offered = [];

    for (let i = 0; i < count && pool.length > 0; i++) {
        const card = rng.weighted(pool, (c) => RARITY[c.rarity]?.weight ?? 10);
        if (!card) break;
        offered.push(card);
        pool.splice(pool.indexOf(card), 1);
    }

    return offered;
}

/**
 * Apply a card.
 * @param {object} run createRunUpgrades() result
 * @param {object} card
 * @param {object} [ctx] { healCore(amount) }
 * @returns {{ok:boolean, level:number, maxed:boolean, evolved:boolean, summary:string}}
 */
export function applyCard(run, card, ctx = {}) {
    // Every return path has the same shape, so callers never have to guard.
    if (!card) return { ok: false, level: 0, maxed: false, evolved: false, summary: '', evolutionsReady: [] };
    const level = cardLevel(run, card.id);
    if (level >= card.max) {
        return { ok: false, level, maxed: true, evolved: !!card.evolved, summary: '', evolutionsReady: [] };
    }

    run.levels[card.id] = level + 1;
    card.apply(run.mods, ctx);
    run.history.push({ id: card.id, level: level + 1 });

    const newlyAvailable = availableEvolutions(run).filter((evo) => !run.history.some((entry) => entry.id === evo.id));

    return {
        ok: true,
        level: level + 1,
        maxed: run.levels[card.id] >= card.max,
        evolved: !!card.evolved,
        summary: card.evolved ? `${card.name} online` : `${card.name} ${level + 1}/${card.max}`,
        evolutionsReady: newlyAvailable.map((e) => e.name)
    };
}

/** Human-readable list of what the run currently has (results screen). */
export function describeBuild(run) {
    const entries = Object.entries(run.levels)
        .filter(([, level]) => level > 0)
        .map(([id, level]) => {
            const card = cardById(id);
            return {
                id,
                name: card?.name || id,
                level,
                max: card?.max || 1,
                rarity: card?.rarity || 'common',
                evolved: !!card?.evolved
            };
        });
    return entries.sort((a, b) => (b.evolved ? 1 : 0) - (a.evolved ? 1 : 0) || a.name.localeCompare(b.name));
}

/** Aggregate numbers for the HUD summary. */
export function runPower(run) {
    const m = run.mods;
    return {
        damage: Math.round(m.damage * 100) / 100,
        rof: Math.round((1 / Math.max(0.05, m.rof)) * 100) / 100,
        projectiles: m.projectiles + 1,
        pierce: m.pierce,
        crit: clamp(m.crit, 0, 1),
        calls: run.history.length
    };
}
