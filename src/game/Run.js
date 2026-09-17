/**
 * A single run.
 *
 * Owns everything that is true for one attempt: score, combo, core integrity,
 * wave, the upgrade build, powerup effects, drones, and the run's RNG streams.
 * It drives the director, enemy/hazard/powerup managers and weapons, and reports
 * everything that happened as events - it never touches the DOM, audio, or
 * Three.js directly. That keeps the FX/UI layers decoupled and makes a run
 * reproducible from a seed.
 *
 * All timing is in fixed ticks; the only wall-clock value in the whole file is
 * none at all.
 */

import { ELITE } from '../world/archetypes.js';
import { ARENA } from '../world/ArenaSpec.js';
import { combineModifiers, muzzlePosition, resolveShot, weaponById } from '../world/Weapons.js';
import { createDirector, DEFAULT_RULES } from '../world/Director.js';
import { createStream } from '../core/Rng.js';
import { clamp, dist } from '../util/Math.js';
import {
    applyCard,
    createRunUpgrades,
    describeBuild,
    offerDraft,
    runPower
} from './Upgrades.js';
import { createHyper } from './Hyper.js';
import { POWERUPS, POWERUP_LIST } from '../world/Powerups.js';
import { stateChecksum } from './Recorder.js';

/** How much faster enemies move while Hyper is live (see enemySpeedExtra). */
const HYPER_ENEMY_PRESS = 1.08;

export const RUN_MODES = Object.freeze({ STANDARD: 'standard', DAILY: 'daily', PRACTICE: 'practice' });

export function createRun(deps) {
    const bus = deps.bus;
    const hash = deps.hash;
    const enemies = deps.enemies;
    const hazards = deps.hazards;
    const powerups = deps.powerups;
    const tickHz = deps.tickHz ?? 60;
    const seed = deps.seed ?? 1;
    const mode = deps.mode || RUN_MODES.STANDARD;
    const weaponId = deps.weaponId || 'pulse';
    const practice = !!deps.practice;
    const debug = deps.debug || {};
    const rules = { ...DEFAULT_RULES, ...(deps.rules || {}) };

    // Independent deterministic streams: adding a consumer cannot shift another.
    const streams = {
        director: createStream(seed, 'director'),
        draft: createStream(seed, 'draft'),
        combat: createStream(seed, 'combat'),
        drops: createStream(seed, 'drops'),
        effects: createStream(seed, 'effects')
    };

    const weapon = weaponById(weaponId);
    const upgrades = createRunUpgrades(tickHz);
    const baseMods = deps.mods || {};   // permanent Arsenal tracks + mastery
    const hyper = createHyper();

    const director = createDirector({
        rng: streams.director,
        rules,
        limits: { maxActiveEnemies: deps.limits?.maxActiveEnemies ?? 60, hazardCap: deps.limits?.hazardCap ?? 4 }
    });

    const state = {
        tick: 0,
        running: false,
        finished: false,
        finishReason: null,
        score: 0,
        combo: 0,
        maxCombo: 0,
        comboTimer: 0,
        comboWindow: 4.2,          // seconds without a kill before the combo drops
        core: deps.core ?? 3,
        coreMax: deps.core ?? 3,
        timeSurvived: 0,
        shots: 0,
        hits: 0,
        kills: 0,
        tankKills: 0,
        bossKills: 0,
        eliteKills: 0,
        hazardKills: 0,
        hyperKills: 0,
        flawless: true,
        wave: 1,
        nextFireTick: 0,
        drafting: false,
        draftOffer: [],
        draftIndex: 0,
        killsSinceNuke: 0,
        shieldTimer: 0,
        effects: {},
        drones: [],
        aim: { x: 0, y: ARENA.core.y },
        input: { fireHeld: false, pointerType: 'mouse' },
        unlimitedCore: !!debug.infiniteLives,
        debugDamageMul: debug.damageMul ?? 1,
        debugFireRateMul: debug.fireRateMul ?? 1,
        debugFreeze: !!debug.freeze
    };

    /* --------------------------------------------------------------- helpers -- */

    function note(msg) {
        bus?.emit('DEBUG_NOTE', { tick: state.tick, scope: 'run', message: msg });
    }

    function scaledMods() {
        const mods = { ...upgrades.mods };
        mods.baseAimAssist = deps.aimAssist ?? 0;

        // Permanent progress stacks on top of the in-run build.
        mods.damage *= baseMods.damage || 1;
        mods.rof *= baseMods.rof || 1;
        mods.projectiles += baseMods.projectiles || 0;
        mods.crit += baseMods.crit || 0;
        mods.hitRadius *= baseMods.hitRadius || 1;
        mods.dropRate += baseMods.dropRate || 0;
        mods.hyperRate += (baseMods.hyperRate || 1) - 1;
        mods.coreMax += baseMods.coreMax || 0;
        if (baseMods.shieldEvery) mods.shieldEvery = Math.min(mods.shieldEvery || Infinity, baseMods.shieldEvery);

        // Hyper + temporary effects.
        mods.damage *= hyper.damageMul;
        mods.rof *= hyper.fireRateMul;
        mods.crit += hyper.critBonus;
        mods.spreadAdd += (1 - hyper.spreadMul) * 0.12;

        const overcharge = state.effects.overcharge;
        if (overcharge > 0) {
            mods.rof *= POWERUPS.overcharge.rofMul;
            mods.damage *= POWERUPS.overcharge.damageMul;
        }

        mods.tickHz = tickHz;
        mods.damage *= state.debugDamageMul;
        mods.rof *= state.debugFireRateMul;

        return mods;
    }

    function effectiveWeapon() {
        return combineModifiers(weapon, scaledMods());
    }

    /**
     * World time factor: Hyper, Cryo, drafts and debug all slow the world.
     *
     * `hyper.timeScale` is 1 while Hyper is idle and the dilated value only while
     * it is live. Using `hyper.worldTimeScale` here instead would run the whole
     * game at the Hyper speed permanently - enemies, spawn timers and hazards all
     * at 62% -, which makes the mechanic a no-op on top of a sluggish arena.
     */
    function worldTimeFactor() {
        let factor = hyper.timeScale;
        if (state.effects.freeze > 0) factor *= POWERUPS.freeze.worldTimeScale;
        if (state.drafting) factor *= 0.1;
        if (state.debugFreeze) factor *= 0.25;
        return clamp(factor, 0.05, 1.5);
    }

    function comboMultiplier() {
        return 1 + Math.floor(state.combo / 8) * 0.12;
    }

    /**
     * Slight extra pressure while Hyper is live: the world is slower than the
     * player, but not by the full amount, so Hyper is a power window rather than
     * a free ride.
     */
    function enemySpeedExtra() {
        return hyper.active ? HYPER_ENEMY_PRESS : 1;
    }

    function pushScore(amount, tick) {
        const value = Math.round(amount);
        state.score += value;
        bus?.emit('SCORE_CHANGED', { tick, score: state.score, delta: value });
        return value;
    }

    function healCore(amount, tick) {
        const before = state.core;
        state.core = Math.min(state.coreMax, state.core + amount);
        if (state.core > before) {
            bus?.emit('CORE_HEALED', { tick, core: state.core, coreMax: state.coreMax, amount: state.core - before });
        }
        return state.core;
    }

    function damageCore(amount, tick, reason = 'breach') {
        if (state.unlimitedCore) {
            bus?.emit('CORE_DAMAGED', { tick, core: state.core, coreMax: state.coreMax, amount: 0, reason, shielded: true });
            return state.core;
        }
        // Bulkhead: chance to shrug the hit off entirely.
        if (upgrades.mods.bulkhead > 0 && streams.effects.chance(upgrades.mods.bulkhead)) {
            bus?.emit('CORE_DAMAGED', { tick, core: state.core, coreMax: state.coreMax, amount: 0, reason, shielded: true });
            return state.core;
        }

        state.core -= amount;
        state.combo = 0;
        state.flawless = false;
        state.comboTimer = 0;
        bus?.emit('COMBO_CHANGED', { tick, combo: 0, maxCombo: state.maxCombo, broken: true });
        bus?.emit('CORE_DAMAGED', { tick, core: state.core, coreMax: state.coreMax, amount, reason });

        // Taking a hit cashes out Hyper and any Cryo field.
        if (hyper.onCoreDamaged()) bus?.emit('HYPER_END', { tick, reason: 'core-damaged' });
        state.effects.freeze = 0;

        if (state.core <= 0) endRun('core-destroyed', tick);
        return state.core;
    }

    function registerKill(view, tick, { crit = false } = {}) {
        state.kills += 1;
        if (view.archetypeId === 'tank') state.tankKills += 1;
        if (view.elite) state.eliteKills += 1;
        if (view.boss) state.bossKills += 1;
        if (hyper.active) state.hyperKills += 1;

        state.combo += 1;
        state.comboTimer = state.comboWindow;
        if (state.combo > state.maxCombo) state.maxCombo = state.combo;

        bus?.emit('COMBO_CHANGED', { tick, combo: state.combo, maxCombo: state.maxCombo });

        const gain = view.score * comboMultiplier() * (rules.scoreMul || 1) * hyper.scoreMul;
        const awarded = pushScore(gain, tick);
        bus?.emit('SCORE_POPUP', { tick, x: view.x, y: view.y, value: awarded, crit, boss: view.boss, elite: view.elite });

        hyper.chargeFromKill(state.combo, view.elite || view.boss);

        if (view.boss) bus?.emit('BOSS_DEFEATED', { tick, id: view.id, x: view.x, y: view.y });
        director.notifyKill(view.elite, view.boss);

        // Killswitch: periodic free detonation.
        if (upgrades.mods.nukeCadence > 0) {
            state.killsSinceNuke += 1;
            if (state.killsSinceNuke >= upgrades.mods.nukeCadence) {
                state.killsSinceNuke = 0;
                detonate(view.x, view.y, 9, 2.5, 'killswitch');
            }
        }

        if (upgrades.mods.healOnKill > 0 && streams.effects.chance(upgrades.mods.healOnKill)) {
            healCore(1, tick);
        }

        // Chain lightning arcs to neighbours.
        if (state.effects.chain > 0) {
            const targets = [];
            enemies.within(view.x, view.y, POWERUPS.chain.chainRange, (other) => other !== view, targets);
            const limited = targets.slice(0, POWERUPS.chain.chainTargets);
            for (const target of limited) {
                bus?.emit('CHAIN_ARC', { tick, fromX: view.x, fromY: view.y, toX: target.x, toY: target.y });
                const result = enemies.applyDamage(target, 1, { tick, crit: false, chain: true });
                if (result.killed) {
                    // Chain kills count, but cannot recursively chain forever.
                    state.kills += 1;
                    pushScore(target.score * 0.6 * hyper.scoreMul, tick);
                }
            }
        }

        // Drops.
        const dropChance = (view.archetype.dropChance + upgrades.mods.dropRate) * (view.elite ? ELITE.dropChanceMul : 1) * (rules.dropMul ?? 1);
        if (view.boss || streams.drops.chance(dropChance)) {
            const type = view.boss ? POWERUPS.nuke : (streams.drops.pick(POWERUP_LIST) || POWERUPS.freeze);
            powerups.spawn({ type, x: view.x, y: view.y }, { tick });
        }
    }

    /** Radial burst damage used by nukes and Killswitch. */
    function detonate(x, y, radius, damage, source, tick = state.tick) {
        const targets = [];
        enemies.within(x, y, radius, null, targets);
        for (const target of targets) {
            const result = enemies.applyDamage(target, damage, { tick, crit: false, source });
            if (result.killed) {
                state.kills += 1;
                if (target.boss) state.bossKills += 1;
                state.combo += 1;
                if (state.combo > state.maxCombo) state.maxCombo = state.combo;
                pushScore(target.score * 0.75 * hyper.scoreMul, tick);
                bus?.emit('COMBO_CHANGED', { tick, combo: state.combo, maxCombo: state.maxCombo });
            }
        }
        bus?.emit('NUKE_PULSE', { tick, x, y, radius, source });
        return targets.length;
    }

    function collectPowerup(view, tick) {
        const type = powerups.collect(view, { tick });
        if (!type) return null;

        const duration = type.duration * (1 + (upgrades.mods.dropDuration - 1));
        switch (type.id) {
            case 'freeze':
                state.effects.freeze = duration;
                break;
            case 'chain':
                state.effects.chain = duration;
                break;
            case 'overcharge':
                state.effects.overcharge = duration;
                break;
            case 'nuke':
                detonate(view.x, view.y, type.radius, type.damage, 'nuke', tick);
                break;
            case 'drone': {
                state.drones.push({ remaining: duration, cooldown: 0, phase: Math.random() * Math.PI * 2 });
                break;
            }
            default:
                break;
        }
        return type;
    }

    /* ------------------------------------------------------------- firing ----- */

    function fire(tick) {
        if (!state.running || state.finished) return null;
        if (tick < state.nextFireTick) return null;

        const weaponNow = effectiveWeapon();
        state.nextFireTick = tick + weaponNow.cooldownTicks;

        const aim = state.aim;
        const origin = muzzlePosition(aim);

        const result = resolveShot({
            origin,
            aim,
            hash,
            rng: streams.combat,
            weapon: weaponNow,
            scratchCandidates: [],
            aimAssistTarget: state.input.pointerType === 'touch' ? enemies.nearest(aim.x, aim.y, 3.2) : null
        });

        state.shots += result.shots;
        bus?.emit('SHOT_FIRED', {
            tick,
            origin,
            aim: { x: aim.x, y: aim.y },
            rays: result.rays.map((ray) => ({ angle: ray.angle, endX: ray.endX, endY: ray.endY, length: ray.length })),
            weapon: weaponNow.id,
            hyper: hyper.active,
            source: 'player'
        });

        if (result.hits.length === 0 && result.shots > 0) {
            bus?.emit('SHOT_MISS', { tick, aim: { x: aim.x, y: aim.y } });
        }

        for (const hit of result.hits) {
            const target = hit.target;

            // Powerup pods are collected by shooting them.
            if (target && target.type && POWERUPS[target.type.id]) {
                collectPowerup(target, tick);
                state.hits += 1;
                continue;
            }

            // Hazards are defused rather than killed.
            if (target && target.fuse !== undefined && hazards.pool.active.includes(target)) {
                const outcome = hazards.applyDamage(target, hit.damage, { tick, crit: hit.crit });
                state.hits += 1;
                if (outcome.destroyed) {
                    state.hazardKills += 1;
                    pushScore(outcome.score * comboMultiplier(), tick);
                    bus?.emit('SCORE_POPUP', { tick, x: target.x, y: target.y, value: outcome.score, crit: hit.crit, hazard: true });
                }
                continue;
            }

            state.hits += 1;
            hyper.chargeFromHit();

            const outcome = enemies.applyDamage(target, hit.damage, {
                tick,
                crit: hit.crit,
                eliteBonus: upgrades.mods.eliteDamage,
                bossBonus: upgrades.mods.bossDamage
            });

            if (outcome.killed) registerKill(target, tick, { crit: hit.crit });
        }

        return result;
    }

    /* ----------------------------------------------------------- director ----- */

    const directorWorld = {
        get activeEnemies() { return enemies.activeCount; },
        get activeHazards() { return hazards.activeCount; },
        timeFactor: 1,
        onSpawn(envelope) {
            const view = enemies.spawn(envelope, { tick: state.tick, telegraphSeconds: envelope.boss ? 0.9 : 0.45 });
            if (!view) return false;
            if (envelope.boss) {
                bus?.emit('BOSS_START', { tick: state.tick, x: view.x, y: view.y, hp: view.hp, wave: state.wave });
            }
            return true;
        },
        onHazard(envelope) {
            return !!hazards.spawn(envelope, { tick: state.tick });
        },
        onWaveStart(wave, info) {
            state.wave = wave;
            bus?.emit('WAVE_START', { tick: state.tick, wave, ...info });
            bus?.emit('SCORE_POPUP', { tick: state.tick, x: ARENA.core.x, y: ARENA.core.y, value: 0, wave: true });
        },
        onWaveEnd(wave, info) {
            const bonus = pushScore(wave * 60 * (rules.scoreMul || 1), state.tick);
            bus?.emit('WAVE_END', { tick: state.tick, wave, bonus, ...info });
            openDraft();
        },
        onBossStart() { /* BOSS_START is emitted at spawn time with live hp */ }
    };

    /* -------------------------------------------------------------- drafts ---- */

    function openDraft() {
        if (!state.running || state.finished) return null;
        const rolled = offerDraft(streams.draft, upgrades, 3);
        if (rolled.length === 0) return null;

        // The card definitions are static data and carry no level, so decorate
        // each one with the level the player actually holds. Without this the
        // draft screen renders `Lv NaN/max`, because it reads card.level.
        const offer = rolled.map((card) => ({ ...card, level: upgrades.levels[card.id] || 0 }));

        state.drafting = true;
        state.draftOffer = offer;
        state.draftIndex += 1;
        bus?.emit('DRAFT_OFFERED', {
            tick: state.tick,
            wave: state.wave,
            offer: offer.map((card) => ({
                id: card.id,
                name: card.name,
                rarity: card.rarity,
                max: card.max,
                level: card.level,
                desc: card.desc,
                evolved: !!card.evolved
            }))
        });
        return offer;
    }

    function pickDraft(index) {
        if (!state.drafting) return null;
        const card = state.draftOffer[index];
        if (!card) return null;

        const outcome = applyCard(upgrades, card, {
            healCore: (amount) => healCore(amount, state.tick)
        });

        state.drafting = false;
        state.draftOffer = [];
        state.coreMax = (deps.core ?? 3) + upgrades.mods.coreMax;
        state.core = Math.min(state.core, state.coreMax);

        hyper.setModifiers({
            dilation: upgrades.mods.dilation,
            hyperRate: upgrades.mods.hyperRate,
            duration: upgrades.mods.hyperDuration
        });

        bus?.emit('UPGRADE_SELECTED', {
            tick: state.tick,
            id: card.id,
            name: card.name,
            level: outcome.level,
            max: card.max,
            evolved: outcome.evolved,
            evolutionsReady: outcome.evolutionsReady || []
        });

        return outcome;
    }

    /* -------------------------------------------------------------- effects --- */

    function tickEffects(dt) {
        const scaled = dt;
        if (state.effects.freeze > 0) state.effects.freeze = Math.max(0, state.effects.freeze - scaled);
        if (state.effects.chain > 0) state.effects.chain = Math.max(0, state.effects.chain - scaled);
        if (state.effects.overcharge > 0) state.effects.overcharge = Math.max(0, state.effects.overcharge - scaled);

        for (let i = state.drones.length - 1; i >= 0; i--) {
            state.drones[i].remaining -= scaled;
            if (state.drones[i].remaining <= 0) state.drones.splice(i, 1);
        }

        // Aegis: core self-repair.
        if (upgrades.mods.shieldEvery > 0) {
            state.shieldTimer += scaled;
            if (state.shieldTimer >= upgrades.mods.shieldEvery) {
                state.shieldTimer = 0;
                if (state.core < state.coreMax) healCore(1, state.tick);
            }
        }
    }

    function tickDrones() {
        if (state.drones.length === 0) return;
        const weaponNow = effectiveWeapon();
        for (const drone of state.drones) {
            drone.cooldown -= 1;
            if (drone.cooldown > 0) continue;

            const target = enemies.nearest(ARENA.core.x, ARENA.core.y, 22, null);
            if (!target) continue;
            drone.cooldown = Math.max(12, Math.round(weaponNow.cooldownTicks * 1.6));

            const droneAim = { x: target.x, y: target.y };
            const result = resolveShot({
                origin: { x: ARENA.core.x + Math.cos(drone.phase) * 2.1, y: ARENA.core.y + Math.sin(drone.phase) * 1.2 },
                aim: droneAim,
                hash,
                rng: streams.combat,
                weapon: { ...weaponNow, projectiles: 1, pierce: 0, aimAssist: 0 },
                scratchCandidates: []
            });

            bus?.emit('SHOT_FIRED', {
                tick: state.tick,
                origin: { x: ARENA.core.x + Math.cos(drone.phase) * 2.1, y: ARENA.core.y + Math.sin(drone.phase) * 1.2 },
                aim: droneAim,
                rays: result.rays.map((ray) => ({ angle: ray.angle, endX: ray.endX, endY: ray.endY, length: ray.length })),
                weapon: 'drone',
                source: 'drone',
                hyper: hyper.active
            });

            for (const hit of result.hits) {
                const outcome = enemies.applyDamage(hit.target, hit.damage, { tick: state.tick, crit: hit.crit, source: 'drone' });
                if (outcome.killed) registerKill(hit.target, state.tick, { crit: hit.crit });
            }
        }
    }

    /* ------------------------------------------------------------- lifecycle -- */

    function start(tick = 0) {
        state.tick = tick;
        state.running = true;
        state.finished = false;
        state.finishReason = null;
        state.coreMax = (deps.core ?? 3) + upgrades.mods.coreMax;
        state.core = state.coreMax;

        director.reset(1, directorWorld);
        hyper.reset();
        hyper.setModifiers({ dilation: 0, hyperRate: upgrades.mods.hyperRate, duration: 0 });

        bus?.emit('RUN_START', {
            tick,
            seed,
            mode,
            weapon: weapon.id,
            rules: rules.id,
            core: state.core,
            practice
        });

        return state;
    }

    function endRun(reason, tick = state.tick) {
        if (state.finished) return null;
        state.finished = true;
        state.running = false;
        // Recorded so the results screen can say "Core destroyed" instead of a
        // generic "run ended" - the engine reads it after the run stops.
        state.finishReason = reason;

        if (hyper.active) {
            hyper.end(reason);
            bus?.emit('HYPER_END', { tick, reason });
        }

        const stats = runStats(reason);
        bus?.emit('RUN_END', { tick, ...stats });
        return stats;
    }

    function runStats(reason = state.finishReason || 'stopped') {
        return {
            tick: state.tick,
            seed,
            mode,
            reason,
            score: Math.round(state.score),
            wave: state.wave,
            core: state.core,
            coreMax: state.coreMax,
            kills: state.kills,
            tankKills: state.tankKills,
            bossKills: state.bossKills,
            eliteKills: state.eliteKills,
            hazardKills: state.hazardKills,
            hyperKills: state.hyperKills,
            maxCombo: state.maxCombo,
            timeSurvived: state.timeSurvived,
            shots: state.shots,
            hits: state.hits,
            accuracy: state.shots > 0 ? Math.round((state.hits / state.shots) * 100) : 0,
            flawless: state.flawless,
            weapon: weapon.id,
            upgraded: describeBuild(upgrades),
            hyperActivations: hyper.stats().activations,
            practice
        };
    }

    /** One fixed simulation step. */
    function tick(dt) {
        if (state.finished) return null;

        const timeFactor = worldTimeFactor();
        directorWorld.timeFactor = timeFactor;
        director.setLimits({
            maxActiveEnemies: deps.limits?.maxActiveEnemies ?? enemies.maxActive,
            hazardCap: deps.limits?.hazardCap ?? hazards.cap
        });

        state.timeSurvived += dt;

        // Combo decay.
        if (state.combo > 0) {
            state.comboTimer -= dt;
            if (state.comboTimer <= 0) {
                state.combo = 0;
                bus?.emit('COMBO_CHANGED', { tick: state.tick, combo: 0, maxCombo: state.maxCombo, expired: true });
            }
        }

        // Hyper charge/cooldown.
        const hyperState = hyper.tick(dt);
        if (hyperState === 'ready' || hyper.ready) {
            const activation = hyper.activate();
            if (activation.activated) {
                bus?.emit('HYPER_START', { tick: state.tick, duration: activation.duration, chargeMul: upgrades.mods.hyperRate });
            }
        } else if (hyperState === 'ended') {
            bus?.emit('HYPER_END', { tick: state.tick, reason: 'timeout' });
        }

        // Hyper charges passively only a trickle; kills and hits are the driver.
        if (!hyper.active && hyper.cooldown <= 0) {
            hyper.addCharge(dt * 1.2);
            if (hyper.ready) {
                const activation = hyper.activate();
                if (activation.activated) {
                    bus?.emit('HYPER_START', { tick: state.tick, duration: activation.duration, chargeMul: upgrades.mods.hyperRate });
                }
            }
        }

        tickEffects(dt);

        // Player firing (held input).
        if (state.input.fireHeld) fire(state.tick);

        director.tick(dt, directorWorld);

        enemies.update(dt, {
            tick: state.tick,
            timeFactor,
            coreX: ARENA.core.x,
            coreY: ARENA.core.y,
            onReachCore(view) {
                const point = { x: view.x, y: view.y };
                enemies.release(view);
                bus?.emit('CORE_BREACHED', { tick: state.tick, x: point.x, y: point.y, archetype: view.archetypeId, boss: view.boss });
                damageCore(view.boss ? 3 : 1, state.tick, 'breach');
            }
        });

        hazards.update(dt, {
            tick: state.tick,
            timeFactor,
            onDetonate(view) {
                const x = view.x;
                const y = view.y;
                const knockback = view.type.knockback;

                // Shove nearby enemies outward: ignoring a mine reshapes the field.
                const neighbours = [];
                enemies.within(x, y, 5.5, null, neighbours);
                for (const neighbour of neighbours) {
                    const dx = neighbour.x - x;
                    const dy = neighbour.y - y;
                    const len = Math.hypot(dx, dy) || 0.0001;
                    neighbour.x += (dx / len) * knockback;
                    neighbour.y += (dy / len) * knockback;
                    hash.update(neighbour, neighbour.x, neighbour.y, neighbour.radius);
                }
                hazards.pool.release(view);
                damageCore(view.type.coreDamage, state.tick, 'mine');
            }
        });

        powerups.update(dt, { tick: state.tick, timeFactor });
        tickDrones();

        state.tick += 1;
        return state;
    }

    return {
        get state() { return state; },
        get weapon() { return weapon; },
        get upgrades() { return upgrades; },
        get hyper() { return hyper; },
        get director() { return director; },
        get rules() { return rules; },
        get seed() { return seed; },
        get mode() { return mode; },
        get practice() { return practice; },
        get finished() { return state.finished; },
        get running() { return state.running; },
        get drafting() { return state.drafting; },
        get draftOffer() { return state.draftOffer; },
        get score() { return Math.round(state.score); },
        get combo() { return state.combo; },
        get maxCombo() { return state.maxCombo; },
        get core() { return state.core; },
        get coreMax() { return state.coreMax; },
        get wave() { return state.wave; },
        get effects() { return state.effects; },
        get drones() { return state.drones; },
        get tickCount() { return state.tick; },

        start,
        tick,
        fire,
        openDraft,
        pickDraft,
        endRun,
        runStats,
        detonate,
        collectPowerup,
        worldTimeFactor,
        effectiveWeapon,
        comboMultiplier,

        setAim(x, y) {
            state.aim.x = x;
            state.aim.y = y;
        },
        setFireHeld(held, pointerType = state.input.pointerType) {
            state.input.fireHeld = !!held;
            state.input.pointerType = pointerType;
        },
        setLimits(limits) {
            deps.limits = { ...(deps.limits || {}), ...limits };
            director.setLimits({
                maxActiveEnemies: limits.maxActiveEnemies ?? enemies.maxActive,
                hazardCap: limits.hazardCap ?? hazards.cap
            });
        },
        setDebug(patch) {
            Object.assign(state, patch);
            return state;
        },
        debugState() {
            return {
                infiniteLives: state.unlimitedCore,
                damageMul: state.debugDamageMul,
                fireRateMul: state.debugFireRateMul,
                freeze: state.debugFreeze
            };
        },

        /** Freeze the world for practice inspection. */
        setDebugFreeze(value) {
            state.debugFreeze = !!value;
            return state.debugFreeze;
        },

        power: () => runPower(upgrades),
        build: () => describeBuild(upgrades),

        /** Snapshot for replay verification. */
        checksum() {
            return stateChecksum({
                tick: state.tick,
                score: Math.round(state.score),
                wave: state.wave,
                core: state.core,
                combo: state.combo,
                enemies: enemies.activeCount,
                kills: state.kills,
                rngDraws: streams.director.draws + streams.combat.draws + streams.draft.draws + streams.drops.draws,
                hyper: Math.round(hyper.charge),
                enemyPositions: enemies.checksumData()
            });
        },

        debugSnapshot() {
            return {
                seed,
                mode: deps.mode,
                tick: state.tick,
                score: Math.round(state.score),
                combo: state.combo,
                maxCombo: state.maxCombo,
                core: state.core,
                coreMax: state.coreMax,
                wave: state.wave,
                kills: state.kills,
                accuracy: state.shots > 0 ? Math.round((state.hits / state.shots) * 100) : 0,
                shots: state.shots,
                hits: state.hits,
                drafting: state.drafting,
                effects: { ...state.effects },
                drones: state.drones.length,
                hyper: hyper.stats(),
                director: director.stats(),
                power: runPower(upgrades),
                dist: Math.round(dist(ARENA.core.x, ARENA.core.y, state.aim.x, state.aim.y) * 10) / 10,
                worldTimeFactor: Math.round(worldTimeFactor() * 100) / 100
            };
        }
    };
}
