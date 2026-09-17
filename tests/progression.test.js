/**
 * Progression tests: draft cards and evolutions, Hyper Mode, the UTC daily +
 * streak machine, and the persistent profile with its practice-mode fences.
 *
 * These are the systems that decide whether a player comes back tomorrow, and
 * they are all deterministic, so they are pinned down here rather than checked
 * by hand in the browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CARDS, EVOLUTIONS, RARITY, cardById, cardLevel, availableCards, availableEvolutions,
    createRunUpgrades, createRunModifiers, offerDraft, applyCard, describeBuild, runPower, isMaxed
} from '../src/game/Upgrades.js';
import { createHyper, HYPER_DEFAULTS } from '../src/game/Hyper.js';
import {
    utcDateKey, utcDayIndex, utcDayIndexFromKey, dailySeed, dailySeedForKey,
    dailyRulesForSeed, dailyConfig, msUntilNextUtcMidnight, createStreak,
    streakBonusMultiplier, nextMilestone, STREAK_MILESTONES, MAX_STREAK_BONUS
} from '../src/game/Daily.js';
import {
    createProgression, emptyProfile, TRACKS, CONTRACTS, trackCost, masteryLevelFor
} from '../src/game/Progression.js';
import { Storage, createMemoryBackend } from '../src/util/Storage.js';
import { Rng } from '../src/core/Rng.js';
import { WEAPONS } from '../src/world/Weapons.js';

/* -------------------------------------------------------------- upgrades -- */

test('draft offers are distinct, seeded, and never include a maxed card', () => {
    const run = createRunUpgrades(60);
    assert.equal(run.mods.tickHz, 60);
    assert.equal(run.mods.damage, 1);
    assert.deepEqual(run.levels, {});

    const first = offerDraft(new Rng(1000), run, 3);
    assert.equal(first.length, 3);
    assert.equal(new Set(first.map((card) => card.id)).size, 3, 'no duplicate offers');
    for (const card of first) assert.ok(CARDS.includes(card));

    const again = offerDraft(new Rng(1000), run, 3);
    assert.deepEqual(again.map((c) => c.id), first.map((c) => c.id), 'same seed -> same offer');
    const different = offerDraft(new Rng(1001), run, 3);
    assert.notDeepEqual(different.map((c) => c.id), first.map((c) => c.id));

    // Max out one card and it disappears from the pool.
    const overclock = cardById('overclock');
    for (let i = 0; i < overclock.max; i++) applyCard(run, overclock);
    assert.equal(isMaxed(run, overclock), true);
    assert.equal(availableCards(run).includes(overclock), false);
    for (let i = 0; i < 40; i++) {
        assert.ok(!offerDraft(new Rng(5000 + i), run, 3).includes(overclock));
    }
});

test('applying a card compounds its effect and caps at max', () => {
    const run = createRunUpgrades(60);
    const overclock = cardById('overclock');

    const first = applyCard(run, overclock);
    assert.equal(first.ok, true);
    assert.equal(first.level, 1);
    assert.equal(first.maxed, false);
    assert.ok(Math.abs(run.mods.rof - 1.12) < 1e-9);

    applyCard(run, overclock);
    assert.ok(Math.abs(run.mods.rof - 1.12 * 1.12) < 1e-9, 'effects compound per level');

    for (let i = 0; i < 3; i++) applyCard(run, overclock);
    assert.equal(cardLevel(run, 'overclock'), 5);
    const overflow = applyCard(run, overclock);
    assert.equal(overflow.ok, false);
    assert.equal(overflow.maxed, true);
    assert.ok(Math.abs(run.mods.rof - Math.pow(1.12, 5)) < 1e-9, 'a maxed card cannot be applied again');

    assert.equal(run.history.length, 5);
    assert.equal(applyCard(run, null).ok, false);
});

test('two maxed cards fuse into an evolution that pays off big', () => {
    const run = createRunUpgrades(60);
    run.levels.split_barrel = 3;
    run.levels.piercing_rounds = 2;
    assert.deepEqual(availableEvolutions(run), [], 'one requirement is still short');

    // Taking the last level of the second prerequisite announces the evolution.
    const piercing = applyCard(run, cardById('piercing_rounds'));
    assert.equal(piercing.level, 3);
    assert.deepEqual(piercing.evolutionsReady, ['RAILGUN']);
    assert.deepEqual(availableEvolutions(run).map((evo) => evo.id), ['railgun']);

    const pierceBefore = run.mods.pierce;
    const projectilesBefore = run.mods.projectiles;
    const damageBefore = run.mods.damage;
    const railgun = applyCard(run, cardById('railgun'));

    assert.equal(railgun.ok, true);
    assert.equal(railgun.evolved, true);
    assert.equal(railgun.summary, 'RAILGUN online');
    assert.equal(run.mods.evolved.railgun, true);
    assert.equal(run.mods.pierce, pierceBefore + 2);
    assert.equal(run.mods.projectiles, projectilesBefore + 1);
    assert.ok(Math.abs(run.mods.damage - (damageBefore + 0.35)) < 1e-9);

    // Evolutions are one-shot.
    assert.equal(applyCard(run, cardById('railgun')).ok, false);
    assert.equal(availableEvolutions(run).length, 0);
    assert.ok(EVOLUTIONS.every((evo) => evo.evolved && evo.requires));
});

test('cards can reach into run context (repairs) and the build reads back out', () => {
    const run = createRunUpgrades(60);
    const heals = [];
    applyCard(run, cardById('nano_repair'), { healCore: (amount) => heals.push(amount) });
    assert.deepEqual(heals, [1]);

    applyCard(run, cardById('core_plating'), { healCore: (amount) => heals.push(amount) });
    assert.equal(run.mods.coreMax, 1);
    assert.deepEqual(heals, [1, 1]);

    applyCard(run, cardById('swarm_doctrine'));
    applyCard(run, cardById('swarm_doctrine'));
    assert.equal(run.mods.drones, 2);

    const build = describeBuild(run);
    assert.deepEqual(build.map((entry) => entry.id).sort(), ['core_plating', 'nano_repair', 'swarm_doctrine']);
    for (const entry of build) {
        assert.ok(entry.level > 0);
        assert.ok(entry.max >= entry.level);
    }

    const power = runPower(run);
    assert.equal(power.projectiles, run.mods.projectiles + 1, 'the HUD counts the free first shot');
    assert.ok(power.crit >= 0 && power.crit <= 1);
    assert.equal(power.calls, run.history.length);

    assert.equal(RARITY.common.weight + RARITY.rare.weight + RARITY.epic.weight, 102);
    assert.equal(createRunModifiers(60).scoreMul, 1);
});

/* ------------------------------------------------------------------ hyper -- */

test('hyper charges from play, activates only when full, and cashes out on damage', () => {
    const hyper = createHyper();

    assert.equal(hyper.active, false);
    assert.equal(hyper.ready, false);
    assert.equal(hyper.activate().activated, false);
    assert.equal(hyper.activate().reason, 'uncharged');

    hyper.chargeFromKill(0);
    const afterOneKill = hyper.charge;
    assert.ok(Math.abs(afterOneKill - HYPER_DEFAULTS.killCharge) < 1e-9);

    // Combo scales the charge, so a good streak is what earns the power window.
    hyper.reset();
    hyper.chargeFromKill(30);
    assert.ok(hyper.charge > HYPER_DEFAULTS.killCharge, 'a 30 combo charges faster');

    hyper.reset();
    hyper.chargeFromHit();
    assert.ok(Math.abs(hyper.charge - HYPER_DEFAULTS.hitCharge) < 1e-9);

    for (let i = 0; i < 60; i++) hyper.chargeFromKill(0);
    assert.equal(hyper.charge, HYPER_DEFAULTS.max, 'charge is capped at max');
    assert.equal(hyper.ready, true);

    // Charging while active is ignored, so the meter cannot bank a second window.
    const activation = hyper.activate();
    assert.equal(activation.activated, true);
    assert.equal(activation.duration, HYPER_DEFAULTS.duration);
    assert.equal(hyper.active, true);
    assert.equal(hyper.charge, 0);
    assert.equal(hyper.addCharge(50), 0);

    assert.equal(hyper.fireRateMul, HYPER_DEFAULTS.fireRateMul);
    assert.equal(hyper.damageMul, HYPER_DEFAULTS.damageMul);
    assert.equal(hyper.scoreMul, HYPER_DEFAULTS.scoreMul);
    assert.equal(hyper.critBonus, HYPER_DEFAULTS.critBonus);
    assert.equal(hyper.aggression, HYPER_DEFAULTS.aggression);
    assert.ok(hyper.worldTimeScale < 1, 'the world slows while hyper');

    let ended = null;
    for (let i = 0; i < 60 * 10 && hyper.active; i++) ended = hyper.tick(1 / 60);
    assert.equal(ended, 'ended');
    assert.equal(hyper.lastEndReason, 'timeout');
    assert.equal(hyper.stats().lastEndReason, 'timeout');
    assert.equal(hyper.active, false);
    assert.equal(hyper.fireRateMul, 1, 'modifiers reset outside hyper');
    assert.ok(hyper.cooldown > 0);
    assert.equal(hyper.activate().reason, 'cooldown');

    for (let i = 0; i < 60 * 5; i++) hyper.tick(1 / 60);
    assert.equal(hyper.cooldown, 0);
    assert.equal(hyper.activations, 1);
    assert.ok(hyper.stats().totalActiveTime > 7);
});

test('core damage ends a hyper window early, and upgrades tune it', () => {
    const hyper = createHyper();
    hyper.addCharge(100, 100);
    hyper.activate();
    assert.equal(hyper.onCoreDamaged(), true);
    assert.equal(hyper.lastEndReason, 'core-damaged');
    assert.equal(hyper.onCoreDamaged(), false, 'idempotent when already over');

    const tuned = createHyper();
    tuned.setModifiers({ dilation: 0.1, hyperRate: 2, duration: 3 });
    tuned.chargeFromKill(0);
    assert.ok(Math.abs(tuned.charge - HYPER_DEFAULTS.killCharge * 2) < 1e-9, 'rate modifier applies');
    assert.ok(tuned.worldTimeScale < HYPER_DEFAULTS.worldTimeScale, 'Chrono Edge slows the world further');

    for (let i = 0; i < 100; i++) tuned.chargeFromKill(0);
    assert.equal(tuned.activate().duration, HYPER_DEFAULTS.duration + 3);
    assert.ok(tuned.worldTimeScale >= 0.25, 'dilation never collapses world time');
});

/* ------------------------------------------------------------ daily/streak -- */

function storage() {
    return new Storage({ backend: createMemoryBackend() });
}

test('the daily seed comes from the UTC calendar, not the local one', () => {
    const date = new Date(Date.UTC(2026, 0, 5, 23, 30, 0));
    assert.equal(utcDateKey(date), '2026-01-05');
    assert.equal(utcDateKey(new Date(Date.UTC(2026, 10, 9, 0, 0, 0))), '2026-11-09');

    assert.equal(utcDayIndexFromKey('2026-01-05'), utcDayIndex(date));
    assert.equal(utcDayIndexFromKey('nonsense'), null);
    assert.equal(utcDayIndexFromKey('2026-01-06'), utcDayIndex(date) + 1);

    assert.equal(dailySeedForKey('2026-01-05'), dailySeedForKey('2026-01-05'));
    assert.notEqual(dailySeedForKey('2026-01-05'), dailySeedForKey('2026-01-06'));
    assert.equal(dailySeed(date), dailySeedForKey('2026-01-05'));
    assert.ok(Number.isInteger(dailySeedForKey('2026-01-05')));
});

test('a day picks one or two modifiers deterministically, world-wide', () => {
    const config = dailyConfig(new Date(Date.UTC(2026, 6, 14)));
    assert.equal(config.dateKey, '2026-07-14');
    assert.equal(config.seed, dailySeedForKey('2026-07-14'));
    assert.ok(config.modifiers.length >= 1 && config.modifiers.length <= 2);
    assert.ok(config.label.length > 0);
    assert.equal(config.rules.id, 'daily');

    const again = dailyConfig(new Date(Date.UTC(2026, 6, 14)));
    assert.deepEqual(again.modifiers, config.modifiers);

    // Every modifier must be a real, describable rules patch.
    for (let i = 0; i < 400; i++) {
        const rules = dailyRulesForSeed(i * 7919, 'key');
        assert.ok(rules.modifiers.length >= 1);
        assert.ok(rules.rules.id === 'daily');
        for (const modifier of rules.modifiers) {
            assert.equal(typeof modifier.name, 'string');
            assert.equal(typeof modifier.desc, 'string');
        }
    }

    const now = new Date(Date.UTC(2026, 0, 5, 13, 30, 0));
    assert.equal(msUntilNextUtcMidnight(now), 10.5 * 3600 * 1000);
    assert.ok(msUntilNextUtcMidnight() > 0 && msUntilNextUtcMidnight() <= 86400000);
});

test('the streak credits consecutive days, tolerates a replay, and forgives a miss', () => {
    const store = storage();
    const streak = createStreak(store);

    const first = streak.completeRun('2026-03-01', 1000);
    assert.equal(first.credited, true);
    assert.equal(first.current, 1);
    assert.equal(streak.longest, 1);
    assert.equal(streak.totalDailies, 1);
    assert.equal(store.get('streak').lastCompletedUtcDate, '2026-03-01', 'state is persisted');
    assert.equal(streak.completedToday('2026-03-01'), true);

    // Same UTC day: the better score counts, the streak does not move.
    const replay = streak.completeRun('2026-03-01', 5000);
    assert.equal(replay.credited, false);
    assert.equal(replay.reason, 'same-day');
    assert.equal(replay.current, 1);
    assert.equal(streak.bestDailyScore, 5000);

    assert.equal(streak.completeRun('2026-03-02').current, 2);
    assert.equal(streak.nextMilestone, 3, 'milestones guide the player');

    const milestone = streak.completeRun('2026-03-03');
    assert.equal(milestone.current, 3);
    assert.equal(milestone.milestone, 3, 'milestone runs are announced');
    assert.equal(milestone.bonusMultiplier, streakBonusMultiplier(3));

    // A missed day resets to one, without losing the record.
    const afterGap = streak.completeRun('2026-03-10');
    assert.equal(afterGap.current, 1);
    assert.equal(streak.longest, 3, 'the record survives a broken streak');
    assert.equal(streak.totalDailies, 4);

    // A backwards system clock can never manufacture progress.
    streak.set({ current: 4, lastCompletedUtcDate: '2026-03-20' });
    const backwards = streak.completeRun('2026-03-19');
    assert.equal(backwards.credited, false);
    assert.equal(backwards.reason, 'clock-backwards');
    assert.equal(streak.current, 4);
    assert.equal(streak.completedToday('2026-03-19'), false);

    // Corrupt stored dates start clean rather than corrupting the streak.
    streak.set({ lastCompletedUtcDate: 'oops' });
    assert.equal(streak.completeRun('2026-03-25').current, 1);

    assert.equal(streak.reset().current, 0);
    assert.equal(streakBonusMultiplier(0), 1);
    assert.equal(streakBonusMultiplier(5), 1.2);
    assert.equal(streakBonusMultiplier(500), MAX_STREAK_BONUS, 'the bonus is deliberately capped');
    assert.equal(nextMilestone(2), STREAK_MILESTONES[0]);
    assert.equal(nextMilestone(1000), null);
});

/* ------------------------------------------------------------- progression -- */

function createProfile(practice = false) {
    const store = storage();
    return { store, progression: createProgression({ storage: store, practice }) };
}

function runStats(overrides = {}) {
    return {
        score: 900,
        wave: 5,
        kills: 40,
        maxCombo: 12,
        timeSurvived: 60,
        bossKills: 0,
        tankKills: 3,
        eliteKills: 2,
        hazardKills: 1,
        hyperKills: 4,
        mode: 'standard',
        weapon: 'pulse',
        practice: false,
        ...overrides
    };
}

test('a fresh profile starts empty and a run pays out cores and contracts', () => {
    const { progression } = createProfile();
    const fresh = progression.summary();
    assert.deepEqual(fresh.cores, 0);
    assert.equal(fresh.bestScore, 0);
    assert.equal(fresh.contracts, `0/${CONTRACTS.length}`);
    assert.deepEqual(emptyProfile().unlockedWeapons, ['pulse']);

    const summary = progression.recordRun(runStats(), {});

    assert.equal(summary.practice, false);
    assert.ok(summary.coresEarned > 0);
    assert.equal(summary.newBest, true);
    assert.equal(summary.previousBest, 0);
    assert.equal(progression.cores, summary.coresEarned);
    assert.equal(progression.profile.stats.runs, 1);
    assert.equal(progression.profile.stats.lifetimeKills, 40);
    assert.equal(progression.profile.stats.bestWave, 5);
    assert.equal(progression.profile.stats.totalTime, 60);

    const completed = summary.contractsCompleted.map((contract) => contract.id);
    assert.ok(completed.includes('first_blood'), 'finishing a run completes First Blood');
    assert.ok(completed.includes('reach_wave_5'));
    assert.ok(summary.contractCores > 0);

    // Mastery tracks the weapon actually used.
    assert.equal(summary.mastery.weapon, 'pulse');
    assert.equal(summary.mastery.level, masteryLevelFor(40 * 3));
    assert.equal(progression.masteryFor('pulse').xp, 40 * 3);
    assert.equal(progression.weaponDamageBonus('pulse'), masteryLevelFor(120) * 0.02);

    // A second, worse run keeps the best score.
    const second = progression.recordRun(runStats({ score: 100, wave: 2 }), {});
    assert.equal(second.newBest, false);
    assert.equal(second.previousBest, 900);
    assert.equal(progression.profile.stats.bestWave, 5);
    assert.equal(progression.contractsState().find((c) => c.id === 'first_blood').done, true);
});

test('practice runs and practice purchases never touch the saved profile', () => {
    const { store, progression } = createProfile();
    progression.addCores(500);
    const before = JSON.stringify(store.get('profile'));

    progression.setPractice(true);
    const summary = progression.recordRun(runStats({ score: 100000, wave: 30 }), {});

    assert.equal(progression.practice, true);
    assert.equal(summary.practice, true);
    assert.equal(summary.coresEarned, 0);
    assert.equal(summary.contractCores, 0);
    assert.deepEqual(summary.contractsCompleted, []);
    assert.equal(summary.newBest, false);
    assert.equal(JSON.stringify(store.get('profile')), before, 'a practice run writes nothing at all');

    assert.equal(progression.buyTrack('damage').reason, 'practice');
    assert.equal(progression.setSkin('magma'), false);
    assert.equal(progression.contractsState().every((contract) => !contract.done), true);
    assert.equal(progression.contractsState().every((contract) => contract.progress === 0), true);
    assert.equal(progression.contractsCompletedCount(), 0);

    progression.setPractice(false);
    assert.equal(progression.cores, 500, 'the pre-practice balance is intact');
});

test('cores buy arsenal tracks, and tracks fold into run modifiers', () => {
    const { progression } = createProfile();
    const damage = TRACKS.find((track) => track.id === 'damage');

    assert.equal(progression.buyTrack('nope').reason, 'unknown-track');
    assert.equal(progression.buyTrack('damage').reason, 'insufficient');

    progression.addCores(5000);
    const first = progression.buyTrack('damage', 120);
    assert.equal(first.ok, true);
    assert.equal(first.level, 1);
    assert.equal(first.cost, trackCost(damage, 0));
    assert.equal(progression.trackLevel('damage'), 1);
    assert.equal(progression.trackCost('damage'), trackCost(damage, 1));
    assert.ok(progression.trackCost('damage') > first.cost, 'each level costs more');

    const mods = { damage: 1, rof: 1, projectiles: 0, crit: 0, coreMax: 0, hyperRate: 1, dropRate: 0, shieldEvery: 0 };
    progression.buyTrack('rof');
    progression.modifiersFromTracks(mods);
    assert.ok(Math.abs(mods.damage - 1.05) < 1e-9, 'track levels fold into the run');
    assert.ok(mods.rof > 1);
    assert.equal(mods.coreMax, 0, 'untouched tracks stay at their defaults');

    // Max a track out and further purchases are refused.
    progression.addCores(500000);
    for (let i = 0; i < damage.max; i++) progression.buyTrack('damage');
    assert.equal(progression.trackMaxed('damage'), true);
    assert.equal(progression.buyTrack('damage').reason, 'maxed');
    assert.equal(progression.buyTrack('damage').cost, 0);
});

test('contracts unlock weapons and skins, and nearUnlocks nudges the next one', () => {
    const { progression } = createProfile();
    assert.equal(progression.weaponsUnlocked().lance, false);
    assert.equal(progression.skinUnlocked('overdrive'), true);
    assert.equal(progression.skinUnlocked('arctic'), false);
    assert.equal(progression.setSkin('arctic'), false, 'locked skins cannot be equipped');
    assert.equal(progression.setSkin('overdrive'), true);

    const summary = progression.recordRun(runStats({ wave: 12, score: 4000, weapon: 'pulse' }), {});
    const unlockedIds = summary.unlocked.map((entry) => entry.id);

    assert.ok(unlockedIds.includes('lance'), 'wave 8 unlocks the Rail Lance');
    assert.equal(progression.weaponsUnlocked().lance, true);
    assert.ok(
        progression.contractsCompletedCount() >= 3,
        'this run completes at least three contracts'
    );
    assert.equal(progression.weaponsUnlocked().scatter, true, 'three contracts unlock the Scatter Array');

    assert.ok(unlockedIds.includes('arctic'), 'wave 12 unlocks the Arctic skin');
    assert.equal(progression.skinUnlocked('arctic'), true);
    assert.equal(progression.setSkin('arctic'), true);
    assert.equal(progression.skin.id, 'arctic');
    assert.equal(progression.setSkin('does-not-exist'), false);

    const near = progression.nearUnlocks(3);
    assert.ok(near.length <= 3);
    for (const item of near) {
        assert.ok(item.progress <= item.target);
        assert.equal(typeof item.label, 'string');
    }

    const contracts = progression.contractsState();
    assert.equal(contracts.length, CONTRACTS.length);
    for (const contract of contracts) {
        assert.ok(contract.progress <= contract.target, 'progress is clamped to the target');
        if (contract.done) assert.ok(contract.complete);
    }

    progression.reset();
    assert.equal(progression.cores, 0);
    assert.equal(progression.trackLevel('damage'), 0);
    assert.equal(progression.contractsCompletedCount(), 0);
    assert.equal(WEAPONS.lance.unlock.id, 'reach_wave_8');
});
