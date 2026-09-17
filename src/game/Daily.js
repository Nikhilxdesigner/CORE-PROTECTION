/**
 * Daily challenge.
 *
 * The canonical seed comes from the *UTC* calendar date, never the local one, so
 * every player on Earth gets the same spawn sequence and the same draft offers on
 * a given day. Local time is only ever used for display (countdowns, "tomorrow").
 *
 * Streak design is deliberately capped: a small multiplier (max +20%) plus
 * cosmetics, so a long streak feels rewarding without making ordinary runs
 * pointless or a missed day catastrophic.
 */

import { hashString } from '../core/Rng.js';
import { clamp } from '../util/Math.js';

export const DAILY_PREFIX = 'camera-defense-daily-';
export const MAX_STREAK_BONUS = 1.2;
export const STREAK_MILESTONES = [3, 7, 14, 30, 60];

/** 'YYYY-MM-DD' in UTC. Zero-padded, so string comparisons are chronological. */
export function utcDateKey(date = new Date()) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return `${year}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

/** Whole days since the Unix epoch, in UTC. Used for streak arithmetic. */
export function utcDayIndex(date = new Date()) {
    return Math.floor(date.getTime() / 86400000);
}

export function parseUtcDateKey(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Deterministic seed for a UTC date key. */
export function dailySeedForKey(dateKey) {
    return hashString(DAILY_PREFIX + dateKey);
}

export function dailySeed(date = new Date()) {
    return dailySeedForKey(utcDateKey(date));
}

/**
 * Challenge modifiers. `rules` feed the Director; `label` shows in the HUD.
 * A day's modifiers are chosen deterministically from its seed.
 */
export const DAILY_MODIFIERS = [
    {
        id: 'swarm',
        name: 'Swarm Protocol',
        desc: 'Spawn rate +40%, but everything is worth +10% score',
        rules: { spawnRateMul: 1.4, scoreMul: 1.1 }
    },
    {
        id: 'elites',
        name: 'Elite Vanguard',
        desc: 'Elites appear far more often',
        rules: { eliteBias: 2.2, eliteFromWave: 1 }
    },
    {
        id: 'hazards',
        name: 'Minefield',
        desc: 'Void Mines everywhere',
        rules: { hazardMul: 2.4, hazardFromWave: 1 }
    },
    {
        id: 'heavy',
        name: 'Heavy Metal',
        desc: 'Everything is tougher and slower, worth +25% score',
        rules: { budgetMul: 0.85, speedMul: 0.9, scoreMul: 1.25 }
    },
    {
        id: 'sprint',
        name: 'Sprint',
        desc: 'Faster enemies, faster waves',
        rules: { speedMul: 1.25, spawnRateMul: 1.2 }
    },
    {
        id: 'scarcity',
        name: 'Scarcity',
        desc: 'Fewer powerup drops, +30% score',
        rules: { dropMul: 0.4, scoreMul: 1.3 }
    },
    {
        id: 'overload',
        name: 'Overload',
        desc: 'Bigger waves, +25% score',
        rules: { budgetMul: 1.3, scoreMul: 1.25 }
    }
];

export const DAILY_MODIFIER_INDEX = DAILY_MODIFIERS.reduce((acc, modifier) => {
    acc[modifier.id] = modifier;
    return acc;
}, {});

/**
 * Daily configuration for a seed: one mandatory modifier plus, on some days, a
 * second twist. Deterministic, so the world shares the same challenge.
 */
export function dailyRulesForSeed(seed, dateKey = null) {
    // Independent draw streams derived from the same seed.
    const pickA = hashString('daily-a', seed) % DAILY_MODIFIERS.length;
    const rollB = hashString('daily-b', seed) % 100;
    const pickB = hashString('daily-c', seed) % DAILY_MODIFIERS.length;

    const chosen = [DAILY_MODIFIERS[pickA]];
    if (rollB < 45) {
        const second = DAILY_MODIFIERS[pickB];
        if (second && second.id !== chosen[0].id) chosen.push(second);
    }

    const rules = { id: 'daily', name: 'Daily Challenge' };
    for (const modifier of chosen) Object.assign(rules, modifier.rules);

    return {
        seed,
        dateKey: dateKey || null,
        modifiers: chosen.map((modifier) => ({ id: modifier.id, name: modifier.name, desc: modifier.desc })),
        rules,
        label: chosen.map((modifier) => modifier.name).join(' + ')
    };
}

export function dailyConfig(date = new Date()) {
    const dateKey = utcDateKey(date);
    const seed = dailySeedForKey(dateKey);
    return dailyRulesForSeed(seed, dateKey);
}

/** Milliseconds until the next UTC midnight - display only. */
export function msUntilNextUtcMidnight(now = new Date()) {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
    return Math.max(0, next - now.getTime());
}

/** True when the given date is the same UTC day as `now`. */
export function isSameUtcDay(a, b) {
    return utcDateKey(a) === utcDateKey(b);
}

export function streakBonusMultiplier(streak) {
    return clamp(1 + Math.min(Math.max(0, streak), 5) * 0.04, 1, MAX_STREAK_BONUS);
}

export function nextMilestone(streak) {
    for (const milestone of STREAK_MILESTONES) {
        if (streak < milestone) return milestone;
    }
    return null;
}

/**
 * Streak state machine.
 *
 * Persisted fields: current, longest, lastCompletedUtcDate, totalDailies,
 * bestDailyScore. Handles first-ever daily, same-day replay, a missed day, and
 * a backwards system clock (which must not manufacture progress).
 */
export function createStreak(storage) {
    const defaults = { current: 0, longest: 0, lastCompletedUtcDate: null, totalDailies: 0, bestDailyScore: 0 };
    let state = { ...defaults, ...(storage.get('streak', {}) || {}) };
    let bonus = storage.get('dailyBonusSeen', 0) || 0;

    function persist() {
        storage.set('streak', state);
        return state;
    }

    function completeRun(todayKey, runScore = 0) {
        const last = state.lastCompletedUtcDate;
        const todayIndex = utcDayIndexFromKey(todayKey);

        if (last && last === todayKey) {
            // Same-day replay: the day's best score counts, the streak does not move.
            if (runScore > state.bestDailyScore) {
                state.bestDailyScore = runScore;
                persist();
            }
            return {
                credited: false,
                reason: 'same-day',
                previousStreak: state.current,
                current: state.current,
                longest: state.longest,
                bonusMultiplier: streakBonusMultiplier(state.current),
                milestone: null
            };
        }

        if (last) {
            const lastIndex = utcDayIndexFromKey(last);
            if (todayIndex === null || lastIndex === null) {
                // Unparseable stored date: start clean rather than corrupt the streak.
                state.current = 1;
            } else if (todayIndex < lastIndex) {
                // System clock moved backwards: never grant progress for it.
                return {
                    credited: false,
                    reason: 'clock-backwards',
                    previousStreak: state.current,
                    current: state.current,
                    longest: state.longest,
                    bonusMultiplier: streakBonusMultiplier(state.current),
                    milestone: null
                };
            } else if (todayIndex - lastIndex === 1) {
                state.current += 1;
            } else {
                state.current = 1;
            }
        } else {
            state.current = 1;
        }

        const wasCurrent = state.current;
        state.longest = Math.max(state.longest, wasCurrent);
        state.lastCompletedUtcDate = todayKey;
        state.totalDailies += 1;
        state.bestDailyScore = Math.max(state.bestDailyScore, runScore);
        persist();

        const milestone = STREAK_MILESTONES.includes(wasCurrent) ? wasCurrent : null;
        if (milestone) bonus = milestone;

        return {
            credited: true,
            reason: 'credited',
            previousStreak: wasCurrent - 1,
            current: wasCurrent,
            longest: state.longest,
            totalDailies: state.totalDailies,
            bonusMultiplier: streakBonusMultiplier(wasCurrent),
            milestone
        };
    }

    return {
        get state() { return { ...state }; },
        get current() { return state.current; },
        get longest() { return state.longest; },
        get totalDailies() { return state.totalDailies; },
        get bonusMultiplier() { return streakBonusMultiplier(state.current); },
        get bonusPercent() { return Math.round((streakBonusMultiplier(state.current) - 1) * 100); },
        get lastCompleted() { return state.lastCompletedUtcDate; },
        get bestDailyScore() { return state.bestDailyScore; },
        get nextMilestone() { return nextMilestone(state.current); },

        /** Whether today's daily has already been credited. */
        completedToday(todayKey) {
            return state.lastCompletedUtcDate === todayKey;
        },

        completeRun,

        /** Debug/testing helper: hard-set the streak. */
        set(values) {
            state = { ...state, ...values };
            persist();
            return { ...state };
        },
        reset() {
            state = { ...defaults };
            persist();
            return { ...state };
        },
        stats() {
            return {
                ...state,
                bonusMultiplier: streakBonusMultiplier(state.current),
                bonusPercent: Math.round((streakBonusMultiplier(state.current) - 1) * 100),
                nextMilestone: nextMilestone(state.current)
            };
        }
    };
}

/** Parse 'YYYY-MM-DD' back to a UTC day index without constructing a Date. */
export function utcDayIndexFromKey(key) {
    const parsed = parseUtcDateKey(key);
    if (!parsed) return null;
    return Math.floor(Date.UTC(parsed.year, parsed.month - 1, parsed.day) / 86400000);
}
