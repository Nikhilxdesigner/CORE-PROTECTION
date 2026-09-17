/**
 * Permanent progression.
 *
 * Cores earned during a run buy Arsenal track levels; contracts unlock weapons
 * and arena skins; each weapon tracks mastery XP. All of it is written through
 * a Storage instance, and practice/debug runs are explicitly barred from writing
 * (they return the same summary shape with `practice: true` so the UI can say
 * "practice run - no rewards" without special-casing).
 *
 * No Date.now() in here: timestamps arrive as arguments so the module stays
 * deterministic and testable.
 */

import { clamp } from '../util/Math.js';
import { WEAPONS, WEAPON_LIST } from '../world/Weapons.js';

export const TRACKS = [
    {
        id: 'damage',
        name: 'Kinetic Amplifier',
        desc: '+5% weapon damage',
        max: 10,
        base: 70,
        apply: (mods, level) => { mods.damage += 0.05 * level; }
    },
    {
        id: 'rof',
        name: 'Cycle Servo',
        desc: '+4% fire rate',
        max: 10,
        base: 75,
        apply: (mods, level) => { mods.rof *= Math.pow(1.04, level); }
    },
    {
        id: 'multishot',
        name: 'Split Barrel',
        desc: '+1 projectile',
        max: 2,
        base: 900,
        apply: (mods, level) => { mods.projectiles += level; }
    },
    {
        id: 'core',
        name: 'Core Lattice',
        desc: '+1 core integrity',
        max: 3,
        base: 420,
        apply: (mods, level) => { mods.coreMax += level; }
    },
    {
        id: 'shield',
        name: 'Aegis Loop',
        desc: 'Core self-repairs every 30s (-4s per level)',
        max: 4,
        base: 320,
        apply: (mods, level) => { if (level > 0) mods.shieldEvery = Math.max(14, 30 - 4 * level); }
    },
    {
        id: 'hyper',
        name: 'Flux Capacitor',
        desc: '+20% Hyper charge rate',
        max: 5,
        base: 240,
        apply: (mods, level) => { mods.hyperRate += 0.2 * level; }
    },
    {
        id: 'crit',
        name: 'Targeting Matrix',
        desc: '+3% crit chance',
        max: 8,
        base: 190,
        apply: (mods, level) => { mods.crit += 0.03 * level; }
    },
    {
        id: 'drop',
        name: 'Salvage Rig',
        desc: '+6% powerup drop rate',
        max: 5,
        base: 170,
        apply: (mods, level) => { mods.dropRate += 0.06 * level; }
    }
];

export const TRACK_INDEX = TRACKS.reduce((acc, track) => {
    acc[track.id] = track;
    return acc;
}, {});

export function trackCost(track, level) {
    return Math.round(track.base * Math.pow(level + 1, 1.55));
}

const LIFETIME_METRICS = {
    runs: (s) => s.runs,
    kills: (s) => s.lifetimeKills,
    tankKills: (s) => s.tankKills,
    bossKills: (s) => s.bossKills,
    eliteKills: (s) => s.eliteKills,
    hazardKills: (s) => s.hazardKills,
    hyperKills: (s) => s.hyperKills,
    bestWave: (s) => s.bestWave,
    bestCombo: (s) => s.bestCombo,
    bestScore: (s) => s.bestScore,
    totalTime: (s) => s.totalTime,
    dailyCompleted: (s) => s.dailyCompleted
};

export const CONTRACTS = [
    { id: 'first_blood', name: 'First Blood', desc: 'Complete a run', metric: 'runs', target: 1, cores: 40 },
    { id: 'reach_wave_5', name: 'Holding Pattern', desc: 'Reach wave 5', metric: 'bestWave', target: 5, cores: 80 },
    { id: 'reach_wave_8', name: 'Hard Line', desc: 'Reach wave 8', metric: 'bestWave', target: 8, cores: 150 },
    { id: 'reach_wave_12', name: 'Overrun', desc: 'Reach wave 12', metric: 'bestWave', target: 12, cores: 260 },
    { id: 'reach_wave_20', name: 'Impossible Shift', desc: 'Reach wave 20', metric: 'bestWave', target: 20, cores: 520 },
    { id: 'centurion', name: 'Centurion', desc: 'Destroy 100 enemies', metric: 'kills', target: 100, cores: 90 },
    { id: 'thousand', name: 'Thousand Cuts', desc: 'Destroy 1,000 enemies', metric: 'kills', target: 1000, cores: 300 },
    { id: 'hive_breaker', name: 'Hive Breaker', desc: 'Destroy 5,000 enemies', metric: 'kills', target: 5000, cores: 900 },
    { id: 'bulwark_50', name: 'Bulwark Breaker', desc: 'Destroy 50 Bulwarks', metric: 'tankKills', target: 50, cores: 200 },
    { id: 'elite_100', name: 'Elite Hunter', desc: 'Destroy 100 elites', metric: 'eliteKills', target: 100, cores: 280 },
    { id: 'warden_slayer', name: 'Warden Slayer', desc: 'Defeat 5 Wardens', metric: 'bossKills', target: 5, cores: 320 },
    { id: 'combo_25', name: 'Chain Fighter', desc: 'Reach a 25 kill combo', metric: 'bestCombo', target: 25, cores: 180 },
    { id: 'combo_60', name: 'Unbroken', desc: 'Reach a 60 kill combo', metric: 'bestCombo', target: 60, cores: 420 },
    { id: 'dailies_3', name: 'Regular', desc: 'Complete 3 daily challenges', metric: 'dailyCompleted', target: 3, cores: 150 },
    { id: 'dailies_10', name: 'Devoted', desc: 'Complete 10 daily challenges', metric: 'dailyCompleted', target: 10, cores: 400 },
    { id: 'survivor_300', name: 'Long Watch', desc: 'Survive 5 minutes total', metric: 'totalTime', target: 300, cores: 200 },
    { id: 'hyper_hunter', name: 'Overdrive Addict', desc: 'Destroy 100 enemies during Hyper', metric: 'hyperKills', target: 100, cores: 240 },
    { id: 'mine_sweeper', name: 'Mine Sweeper', desc: 'Destroy 60 Void Mines', metric: 'hazardKills', target: 60, cores: 200 }
];

export const SKINS = [
    { id: 'overdrive', name: 'Overdrive', unlock: null, grid: 0x00f0ff, fog: 0x050814, accent: 0xff00e6 },
    { id: 'magma', name: 'Magma Grid', unlock: { type: 'cores', amount: 600 }, grid: 0xff7a18, fog: 0x140505, accent: 0xffcc33 },
    { id: 'arctic', name: 'Arctic Relay', unlock: { type: 'contract', id: 'reach_wave_12' }, grid: 0x8fe3ff, fog: 0x040a14, accent: 0x66ffcc },
    { id: 'void', name: 'Void Bloom', unlock: { type: 'contract', id: 'warden_slayer' }, grid: 0xb066ff, fog: 0x0a0414, accent: 0xff2fd0 }
];

export const SKIN_INDEX = SKINS.reduce((acc, skin) => {
    acc[skin.id] = skin;
    return acc;
}, {});

export function emptyProfile() {
    return {
        cores: 0,
        tracks: {},
        contracts: {},
        mastery: {},
        stats: {
            runs: 0, lifetimeKills: 0, tankKills: 0, bossKills: 0, eliteKills: 0,
            hazardKills: 0, hyperKills: 0, bestWave: 0, bestCombo: 0, bestScore: 0,
            totalTime: 0, dailyCompleted: 0
        },
        unlockedWeapons: ['pulse'],
        skin: 'overdrive',
        lastRun: null
    };
}

function masteryLevelFor(xp) {
    return Math.floor(Math.sqrt(Math.max(0, xp) / 60));
}

export function createProgression(options = {}) {
    const storage = options.storage;
    if (!storage) throw new Error('Progression requires a Storage instance');
    const bus = options.bus || null;

    // Merge with defaults so a save from an older schema cannot leave holes.
    const stored = storage.get('profile', null) || {};
    const profile = { ...emptyProfile(), ...stored };
    profile.stats = { ...emptyProfile().stats, ...(stored.stats || {}) };
    profile.tracks = { ...(stored.tracks || {}) };
    profile.contracts = { ...(stored.contracts || {}) };
    profile.mastery = { ...(stored.mastery || {}) };
    profile.unlockedWeapons = Array.isArray(stored.unlockedWeapons) && stored.unlockedWeapons.length
        ? stored.unlockedWeapons
        : ['pulse'];
    if (!SKIN_INDEX[profile.skin]) profile.skin = 'overdrive';

    let practice = !!options.practice;

    const persist = () => {
        if (practice) return false;
        return storage.set('profile', profile);
    };

    function trackLevel(id) {
        return profile.tracks[id] || 0;
    }

    function contractsState() {
        return CONTRACTS.map((contract) => {
            const read = LIFETIME_METRICS[contract.metric] || (() => 0);
            const progress = clamp(read(profile.stats), 0, contract.target);
            return {
                ...contract,
                progress,
                target: contract.target,
                done: !!profile.contracts[contract.id],
                complete: progress >= contract.target
            };
        });
    }

    function contractsCompletedCount() {
        return Object.keys(profile.contracts).length;
    }

    function weaponsUnlocked() {
        const map = {};
        for (const weapon of WEAPON_LIST) {
            map[weapon.id] = profile.unlockedWeapons.includes(weapon.id);
        }
        return map;
    }

    function skinUnlocked(id) {
        const skin = SKIN_INDEX[id];
        if (!skin || !skin.unlock) return true;
        if (skin.unlock.type === 'cores') return profile.cores >= skin.unlock.amount || profile.stats.bestScore >= skin.unlock.amount;
        if (skin.unlock.type === 'contract') return !!profile.contracts[skin.unlock.id];
        return false;
    }

    /** Fold permanent track levels into a run's modifier bag. */
    function modifiersFromTracks(mods) {
        for (const track of TRACKS) {
            const level = trackLevel(track.id);
            if (level > 0) track.apply(mods, level);
        }
        return mods;
    }

    function weaponDamageBonus(weaponId) {
        const xp = profile.mastery[weaponId]?.xp || 0;
        return masteryLevelFor(xp) * 0.02;
    }

    /**
     * Record a finished run and settle rewards.
     * @param {object} runStats
     * @param {boolean} [options.practice]
     */
    function recordRun(runStats, options_ = {}) {
        const isPractice = practice || !!options_.practice;
        const stats = profile.stats;

        const weaponId = runStats.weapon || 'pulse';
        const streakBonus = clamp(runStats.streakBonus ?? 1, 1, 1.25);
        const rawCores = Math.floor(
            runStats.score / 450
            + runStats.wave * 2.2
            + (runStats.bossKills || 0) * 6
            + (runStats.mode === 'daily' ? 40 : 0)
        );
        const coresEarned = Math.max(0, Math.round(rawCores * streakBonus));

        const beforeUnlocks = {
            weapons: weaponsUnlocked(),
            contracts: contractsCompletedCount()
        };

        // Lifetime stats accumulate even in practice? No: practice never writes.
        const nextStats = {
            runs: stats.runs + 1,
            lifetimeKills: stats.lifetimeKills + (runStats.kills || 0),
            tankKills: stats.tankKills + (runStats.tankKills || 0),
            bossKills: stats.bossKills + (runStats.bossKills || 0),
            eliteKills: stats.eliteKills + (runStats.eliteKills || 0),
            hazardKills: stats.hazardKills + (runStats.hazardKills || 0),
            hyperKills: stats.hyperKills + (runStats.hyperKills || 0),
            bestWave: Math.max(stats.bestWave, runStats.wave || 0),
            bestCombo: Math.max(stats.bestCombo, runStats.maxCombo || 0),
            bestScore: Math.max(stats.bestScore, runStats.score || 0),
            totalTime: stats.totalTime + (runStats.timeSurvived || 0),
            dailyCompleted: stats.dailyCompleted + (runStats.mode === 'daily' && (runStats.score || 0) > 0 ? 1 : 0)
        };

        const completedNow = [];
        for (const contract of CONTRACTS) {
            if (profile.contracts[contract.id]) continue;
            const read = LIFETIME_METRICS[contract.metric] || (() => 0);
            if (read(nextStats) >= contract.target) completedNow.push(contract);
        }

        const bonusCores = completedNow.reduce((sum, c) => sum + c.cores, 0);
        const previousBest = stats.bestScore;

        const summary = {
            practice: isPractice,
            coresEarned: isPractice ? 0 : coresEarned + bonusCores,
            baseCores: isPractice ? 0 : coresEarned,
            contractCores: isPractice ? 0 : bonusCores,
            contractsCompleted: isPractice ? [] : completedNow.map((c) => ({ id: c.id, name: c.name, cores: c.cores })),
            newBest: !isPractice && (runStats.score || 0) > previousBest,
            previousBest,
            streakBonus,
            mastery: null,
            unlocked: []
        };

        if (isPractice) {
            return summary;
        }

        profile.cores += summary.coresEarned;
        profile.stats = nextStats;
        for (const contract of completedNow) profile.contracts[contract.id] = true;

        // Mastery XP for the weapon used.
        const mastery = profile.mastery[weaponId] || { xp: 0 };
        const beforeLevel = masteryLevelFor(mastery.xp);
        mastery.xp += (runStats.kills || 0) * 3 + (runStats.bossKills || 0) * 40;
        const afterLevel = masteryLevelFor(mastery.xp);
        profile.mastery[weaponId] = mastery;
        summary.mastery = {
            weapon: weaponId,
            xp: mastery.xp,
            level: afterLevel,
            leveledUp: afterLevel > beforeLevel
        };

        // Weapon unlocks.
        for (const weapon of WEAPON_LIST) {
            if (profile.unlockedWeapons.includes(weapon.id) || !weapon.unlock) continue;
            const unlocked = weapon.unlock.type === 'contract'
                ? !!profile.contracts[weapon.unlock.id]
                : contractsCompletedCount() >= weapon.unlock.count;
            if (unlocked) {
                profile.unlockedWeapons.push(weapon.id);
                summary.unlocked.push({ type: 'weapon', id: weapon.id, name: weapon.name });
            }
        }

        // Skin unlocks.
        for (const skin of SKINS) {
            if (skin.unlock?.type === 'contract' && profile.contracts[skin.unlock.id] && !profile.unlockedSkins?.includes(skin.id)) {
                profile.unlockedSkins = [...(profile.unlockedSkins || []), skin.id];
                summary.unlocked.push({ type: 'skin', id: skin.id, name: skin.name });
            }
        }

        profile.lastRun = {
            score: runStats.score || 0,
            wave: runStats.wave || 0,
            cores: summary.coresEarned,
            mode: runStats.mode || 'standard'
        };

        persist();

        bus?.emit('PROGRESSION_UPDATED', {
            tick: null,
            cores: profile.cores,
            contractsCompleted: summary.contractsCompleted.length,
            before: beforeUnlocks
        });

        return summary;
    }

    function buyTrack(id, atTick = null) {
        const track = TRACK_INDEX[id];
        if (!track) return { ok: false, reason: 'unknown-track' };
        const level = trackLevel(id);
        if (level >= track.max) return { ok: false, reason: 'maxed', level, cost: 0 };

        const cost = trackCost(track, level);
        if (profile.cores < cost) return { ok: false, reason: 'insufficient', level, cost, cores: profile.cores };

        if (practice) {
            return { ok: false, reason: 'practice', level, cost };
        }

        profile.cores -= cost;
        profile.tracks[id] = level + 1;
        persist();
        bus?.emit('ARSENAL_PURCHASE', { tick: atTick, track: id, level: level + 1, cost });
        return { ok: true, level: level + 1, cost, cores: profile.cores };
    }

    /** Progress toward the next locked thing, for the "nearly there" nudges. */
    function nearUnlocks(limit = 3) {
        const candidates = [];

        for (const weapon of WEAPON_LIST) {
            if (profile.unlockedWeapons.includes(weapon.id) || !weapon.unlock) continue;
            if (weapon.unlock.type === 'contract') {
                const contract = CONTRACTS.find((c) => c.id === weapon.unlock.id);
                if (contract) {
                    const read = LIFETIME_METRICS[contract.metric] || (() => 0);
                    candidates.push({
                        kind: 'weapon',
                        label: weapon.name,
                        hint: contract.desc,
                        progress: clamp(read(profile.stats), 0, contract.target),
                        target: contract.target
                    });
                }
            } else if (weapon.unlock.type === 'contracts') {
                candidates.push({
                    kind: 'weapon',
                    label: weapon.name,
                    hint: `Complete ${weapon.unlock.count} contracts`,
                    progress: Math.min(contractsCompletedCount(), weapon.unlock.count),
                    target: weapon.unlock.count
                });
            }
        }

        for (const contract of contractsState()) {
            if (contract.done || contract.progress >= contract.target) continue;
            const ratio = contract.progress / contract.target;
            if (ratio >= 0.55) {
                candidates.push({
                    kind: 'contract',
                    label: contract.name,
                    hint: contract.desc,
                    progress: contract.progress,
                    target: contract.target,
                    cores: contract.cores
                });
            }
        }

        for (const skin of SKINS) {
            if (!skin.unlock || skin.unlock.type !== 'cores') continue;
            const have = Math.max(profile.cores, profile.stats.bestScore);
            if (have >= skin.unlock.amount) continue;
            const ratio = have / skin.unlock.amount;
            if (ratio >= 0.5) {
                candidates.push({
                    kind: 'skin',
                    label: skin.name,
                    hint: 'Arena skin',
                    progress: have,
                    target: skin.unlock.amount
                });
            }
        }

        const affordableTracks = TRACKS
            .filter((track) => trackLevel(track.id) < track.max && profile.cores >= trackCost(track, trackLevel(track.id)))
            .map((track) => ({
                kind: 'track',
                label: `${track.name} ${trackLevel(track.id) + 1}`,
                hint: `${track.desc} - ${trackCost(track, trackLevel(track.id))} cores`,
                progress: trackCost(track, trackLevel(track.id)),
                target: trackCost(track, trackLevel(track.id)),
                affordable: true
            }));

        return [...affordableTracks, ...candidates]
            .sort((a, b) => (b.progress / b.target) - (a.progress / a.target))
            .slice(0, limit);
    }

    return {
        get profile() { return profile; },
        get cores() { return profile.cores; },
        get practice() { return practice; },
        get skin() { return SKIN_INDEX[profile.skin] || SKINS[0]; },

        setPractice(value) {
            practice = !!value;
            return practice;
        },

        TRACKS,
        CONTRACTS,
        SKINS,
        trackLevel,
        trackCost: (id) => {
            const track = TRACK_INDEX[id];
            return track ? trackCost(track, trackLevel(id)) : Infinity;
        },
        trackMaxed: (id) => {
            const track = TRACK_INDEX[id];
            return track ? trackLevel(id) >= track.max : true;
        },

        modifyModifiers: modifiersFromTracks,
        modifiersFromTracks,
        weaponDamageBonus,
        weaponsUnlocked,
        contractsState,
        contractsCompletedCount,
        skinUnlocked,
        unlockedSkins() {
            return SKINS.filter((skin) => skinUnlocked(skin.id)).map((skin) => skin.id);
        },
        setSkin(id) {
            if (!SKIN_INDEX[id] || !skinUnlocked(id) || practice) return false;
            profile.skin = id;
            persist();
            return true;
        },
        addCores(amount) {
            if (practice) return profile.cores;
            profile.cores += Math.max(0, Math.round(amount));
            persist();
            return profile.cores;
        },
        buyTrack,
        recordRun,
        nearUnlocks,
        masteryFor(weaponId) {
            const mastery = profile.mastery[weaponId] || { xp: 0 };
            const level = masteryLevelFor(mastery.xp);
            const nextThreshold = Math.pow(level + 1, 2) * 60;
            return {
                xp: mastery.xp,
                level,
                next: nextThreshold,
                progress: clamp(mastery.xp / nextThreshold, 0, 1)
            };
        },
        save: persist,
        reset() {
            Object.assign(profile, emptyProfile());
            persist();
        },
        /** Compact view for the menu screen. */
        summary() {
            const s = profile.stats;
            return {
                cores: profile.cores,
                bestScore: s.bestScore,
                bestWave: s.bestWave,
                bestCombo: s.bestCombo,
                runs: s.runs,
                kills: s.lifetimeKills,
                contracts: `${contractsCompletedCount()}/${CONTRACTS.length}`,
                weapons: weaponsUnlocked(),
                skin: profile.skin
            };
        }
    };
}

export { LIFETIME_METRICS, masteryLevelFor };
