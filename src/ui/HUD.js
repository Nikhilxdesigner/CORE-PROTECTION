/**
 * HUD.
 *
 * Pure presentation: it listens to gameplay events and reads snapshot data from
 * the run, and never drives gameplay. The debug readout is the fastest way to
 * see whether the fixed step, the pools and the quality governor are behaving.
 */

import { formatScore } from '../util/Math.js';
import { EVENTS } from '../core/Events.js';
import { SCOPE_STATE } from '../game/Aim.js';

/**
 * What each scope state says to the player. The wording is the whole point of the
 * feature: "LOCKED" means a shot at the crosshair connects right now, "OFF
 * TARGET" means the sight is on the body but outside the hit ring.
 */
const SCOPE_COPY = {
    searching: { label: 'NO TARGET', hint: 'Ring is your hit radius' },
    incoming: { label: 'INCOMING', hint: 'Materialising - not yet shootable' },
    near: { label: 'OFF TARGET', hint: 'Body under the sight, outside the ring' },
    locked: { label: 'LOCKED', hint: 'A shot here connects' },
    assist: { label: 'ASSIST', hint: 'Aim assist will pull this volley on' }
};

export function createHUD(options = {}) {
    const doc = options.document || document;
    const bus = options.bus;
    let engine = null;
    let runActive = false;
    let comboPopTimer = null;
    const popups = [];
    const feeds = [];
    let bound = false;
    // Scope writes are cached: this runs every frame, and re-writing identical
    // text/geometry for ~10 nodes is pure layout churn.
    let scopeCache = {};

    const $ = (id) => doc.getElementById(id);

    function scopeWrite(key, apply) {
        if (scopeCache[key] === apply.value) return;
        scopeCache[key] = apply.value;
        apply.set(apply.value);
    }

    function reset() {
        scopeCache = {};
        $('hud-scope')?.classList.remove('active');
        $('hud-target')?.classList.add('hidden');
        $('hud-killfeed').innerHTML = '';
        $('hud-popups').innerHTML = '';
        popups.length = 0;
        feeds.length = 0;
        setScore(0);
        setCombo(0, 0);
        setCore(3, 3);
        setHyper(0, false);
        setWave(1);
    }

    function setRunActive(active) {
        runActive = active;
        $('hud')?.classList.toggle('active', active);
        if (!active) $('hud-scope')?.classList.remove('active');
    }

    function setScore(value) {
        const el = $('hud-score');
        if (el) el.textContent = formatScore(value);
    }

    function setCombo(combo, maxCombo) {
        const value = $('hud-combo-value');
        const meter = $('hud-combo');
        if (value) value.textContent = `${combo}`;
        if (meter) {
            meter.classList.toggle('active', combo >= 2);
            meter.dataset.multiplier = `${Math.round((1 + Math.floor(combo / 8) * 0.12) * 100) / 100}x`;
        }
        const best = $('hud-combo-best');
        if (best) best.textContent = `BEST ${maxCombo}`;
    }

    function setCore(core, coreMax) {
        const el = $('hud-core');
        if (!el) return;
        const pips = [];
        for (let i = 0; i < coreMax; i++) {
            pips.push(`<span class="core-pip${i < core ? ' filled' : ''}"></span>`);
        }
        el.innerHTML = pips.join('');
        el.dataset.core = `${core}/${coreMax}`;
    }

    function setHyper(progress, active) {
        const bar = $('hud-hyper-bar');
        const host = $('hud-hyper');
        if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
        if (host) host.classList.toggle('active', !!active);
    }

    function setWave(wave) {
        const el = $('hud-wave');
        if (el) el.textContent = wave;
    }

    function setQuality(text) {
        const el = $('hud-quality');
        if (el) el.textContent = text;
    }

    function setWeapon(id) {
        const el = $('hud-weapon');
        if (el) el.textContent = String(id || '').toUpperCase();
    }

    function setSeed(seed, mode, daily) {
        const el = $('hud-seed');
        if (el) el.textContent = `SEED ${seed}${mode === 'daily' ? ' · DAILY' : ''}`;
        const dailyEl = $('hud-daily');
        if (dailyEl) dailyEl.textContent = daily ? daily.label : '';
    }

    /**
     * Aim readout: a reticle at the aim point whose ring is the real hit radius,
     * plus a plate naming whatever is under it.
     *
     * Everything shown comes from the same `readScope` result Weapons.js resolves
     * the shot with, so the HUD cannot tell the player a shot will land when it
     * will not.
     */
    function setScope(scope) {
        const root = $('hud-scope');
        if (!root) return;
        if (!runActive || !scope || !scope.screen) {
            root.classList.remove('active');
            return;
        }
        root.classList.add('active');
        const state = scope.state || SCOPE_STATE.SEARCHING;
        root.dataset.state = state;

        const reticle = $('scope-reticle');
        if (reticle) {
            reticle.style.transform = `translate(-50%, -50%) translate(${scope.screen.x}px, ${scope.screen.y}px)`;
        }

        const ring = $('scope-ring');
        const ringPx = Math.max(6, Math.round(scope.ringPx || 0));
        if (ring) {
            ring.style.width = `${ringPx * 2}px`;
            ring.style.height = `${ringPx * 2}px`;
        }

        const copy = SCOPE_COPY[state] || SCOPE_COPY.searching;
        scopeWrite('state', {
            value: copy.label,
            set: (v) => { const el = $('scope-state'); if (el) el.textContent = v; }
        });
        scopeWrite('hint', {
            value: copy.hint,
            set: (v) => { const el = $('target-hint'); if (el) el.textContent = v; }
        });

        const target = scope.target;
        const card = $('hud-target');
        if (card) {
            const flipped = scope.screen.x > (engine?.viewport?.width ?? window.innerWidth) * 0.62;
            const raised = scope.screen.y > (engine?.viewport?.height ?? window.innerHeight) * 0.6;
            if (scopeCache.hidden !== !target) {
                scopeCache.hidden = !target;
                card.classList.toggle('hidden', !target);
            }
            if (scopeCache.flipped !== flipped) {
                scopeCache.flipped = flipped;
                // Flip the plate to the other side of the sight near the right
                // edge so it never runs off screen.
                card.classList.toggle('flip', flipped);
            }
            if (scopeCache.raised !== raised) {
                scopeCache.raised = raised;
                card.classList.toggle('up', raised);
            }
        }
        if (!target) return;

        scopeWrite('name', {
            value: target.name,
            set: (v) => { const el = $('target-name'); if (el) el.textContent = v; }
        });

        const tags = [];
        if (target.boss) tags.push('BOSS');
        if (target.elite) tags.push('ELITE');
        if (target.assist) tags.push('ASSIST');
        if (!target.hittable) tags.push('SPAWNING');
        scopeWrite('tags', {
            value: tags.join(' · '),
            set: (v) => { const el = $('target-tags'); if (el) el.textContent = v; }
        });

        scopeWrite('hpFill', {
            value: Math.round(target.hpFrac * 100),
            set: (v) => { const el = $('target-hp-fill'); if (el) el.style.width = `${v}%`; }
        });
        scopeWrite('hpText', {
            value: `${target.hp}/${target.maxHp} HP`,
            set: (v) => { const el = $('target-hp-text'); if (el) el.textContent = v; }
        });
        scopeWrite('shots', {
            value: target.hittable
                ? (scope.shots > 0 ? `${scope.shots} SHOT${scope.shots === 1 ? '' : 'S'}` : 'DEAD')
                : '--',
            set: (v) => { const el = $('target-shots'); if (el) el.textContent = v; }
        });
        scopeWrite('weapon', {
            value: scope.weapon ? `${scope.weapon.id} · ${scope.weapon.damage}` : '--',
            set: (v) => { const el = $('target-weapon'); if (el) el.textContent = v; }
        });
        scopeWrite('distance', {
            value: target.inside
                ? `IN RING · ${target.distance.toFixed(1)}u`
                : `+${(target.distance - target.reach).toFixed(1)}u OUT`,
            set: (v) => { const el = $('target-distance'); if (el) el.textContent = v; }
        });
    }

    function popup(screenPos, text, kind = 'normal') {
        const host = $('hud-popups');
        if (!host || !screenPos) return;
        const element = doc.createElement('div');
        element.className = `hud-popup ${kind}`;
        element.textContent = text;
        element.style.left = `${Math.round(screenPos.x)}px`;
        element.style.top = `${Math.round(screenPos.y)}px`;
        host.appendChild(element);
        popups.push({ element, life: 0.85 });
        if (popups.length > 26) {
            const oldest = popups.shift();
            oldest.element.remove();
        }
    }

    function toast(text, kind = 'info') {
        const host = $('hud-toasts');
        if (!host) return;
        const element = doc.createElement('div');
        element.className = `hud-toast ${kind}`;
        element.textContent = text;
        host.appendChild(element);
        setTimeout(() => element.classList.add('out'), 1200);
        setTimeout(() => element.remove(), 1800);
    }

    function killFeed(entry) {
        const host = $('hud-killfeed');
        if (!host) return;
        const element = doc.createElement('div');
        element.className = `kill-entry ${entry.kind}`;
        element.innerHTML = `<span class="kill-name">${entry.name}</span><span class="kill-score">+${formatScore(entry.score)}</span>`;
        host.appendChild(element);
        feeds.push({ element, life: 2.4 });
        while (feeds.length > 5) {
            const oldest = feeds.shift();
            oldest.element.remove();
        }
    }

    function bind(engineRef) {
        engine = engineRef;
        if (bound) return;
        bound = true;

        bus.on(EVENTS.SCORE_CHANGED, (event) => setScore(event.score));
        bus.on(EVENTS.COMBO_CHANGED, (event) => {
            setCombo(event.combo, event.maxCombo);
            if (event.combo > 0 && event.combo % 10 === 0) {
                toast(`${event.combo} COMBO`, 'combo');
            }
        });
        bus.on(EVENTS.CORE_DAMAGED, (event) => {
            setCore(Math.max(0, event.core), event.coreMax);
            document.body.classList.add('core-hit');
            setTimeout(() => document.body.classList.remove('core-hit'), 350);
        });
        bus.on(EVENTS.CORE_HEALED, (event) => setCore(event.core, event.coreMax));
        bus.on(EVENTS.HYPER_START, (event) => {
            setHyper(1, true);
            toast(`HYPER MODE ${Math.round(event.duration)}s`, 'hyper');
        });
        bus.on(EVENTS.HYPER_END, () => setHyper(engine?.run?.hyper.progress ?? 0, false));
        bus.on(EVENTS.WAVE_START, (event) => setWave(event.wave));
        bus.on(EVENTS.ENEMY_KILL, (event) => {
            const name = event.boss ? 'WARDEN' : (event.elite ? `ELITE ${event.archetype.toUpperCase()}` : String(event.archetype).toUpperCase());
            killFeed({ name, score: event.score, kind: event.boss ? 'boss' : (event.elite ? 'elite' : 'normal') });
        });
        bus.on(EVENTS.POWERUP_PICKUP, (event) => toast(event.name, event.type));
        bus.on(EVENTS.UPGRADE_SELECTED, (event) => {
            toast(event.evolved ? `${event.name} ONLINE` : `${event.name} Lv${event.level}`, event.evolved ? 'evolved' : 'upgrade');
            for (const ready of event.evolutionsReady || []) toast(`EVOLUTION READY · ${ready}`, 'evolved');
        });
    }

    function update(dt, ctx) {
        if (!runActive || !ctx?.run) return;
        const run = ctx.run;

        setCore(run.core, run.coreMax);
        setHyper(run.hyper.progress, run.hyper.active);
        setWave(run.wave);

        const comboBar = $('hud-combo-timer');
        if (comboBar) {
            const ratio = run.combo > 0 ? Math.max(0, Math.min(1, run.state.comboTimer / run.state.comboWindow)) : 0;
            comboBar.style.width = `${Math.round(ratio * 100)}%`;
        }

        for (let i = popups.length - 1; i >= 0; i--) {
            popups[i].life -= dt;
            popups[i].element.style.transform = `translate(-50%, -50%) translateY(${Math.round((0.85 - popups[i].life) * -46)}px)`;
            popups[i].element.style.opacity = `${Math.max(0, popups[i].life / 0.85)}`;
            if (popups[i].life <= 0) {
                popups[i].element.remove();
                popups.splice(i, 1);
            }
        }

        for (let i = feeds.length - 1; i >= 0; i--) {
            feeds[i].life -= dt;
            if (feeds[i].life <= 0) {
                feeds[i].element.remove();
                feeds.splice(i, 1);
            }
        }

        const debugEl = $('hud-debug');
        if (debugEl && debugEl.classList.contains('active')) {
            const stats = ctx;
            debugEl.innerHTML = [
                `TIER ${stats.quality.tier}${stats.quality.manual !== 'AUTO' ? ` (${stats.quality.manual})` : ''} · ${stats.quality.fps} FPS · ${stats.quality.avg}ms avg / ${stats.quality.p95}ms p95`,
                `TICK ${stats.clock.ticks} · dropped ${Math.round(stats.clock.droppedTime * 1000)}ms · stalls ${stats.clock.stallCount}`,
                `ENEMIES ${stats.pools.enemies.active}/${stats.pools.enemies.maxActive} (peak ${stats.pools.enemies.peakActive}) · HAZARDS ${stats.pools.hazards.active}`,
                `PARTICLES ${stats.pools.particles.live}/${stats.pools.particles.budget} · DEBRIS ${stats.pools.debris.live}/${stats.pools.debris.budget} · TRACERS ${stats.pools.tracers.active}`,
                `POWER ${JSON.stringify(run.power())} · EFFECTS ${Object.entries(run.effects).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${Math.round(v)}s`).join(' ') || 'none'}`,
                `HYPER ${run.hyper.stats().charge}%${run.hyper.active ? ` ACTIVE ${run.hyper.stats().remaining}s` : ''} · WORLD ${run.worldTimeFactor().toFixed(2)}x`,
                `DIRECTOR w${run.director.stats().wave} ${run.director.stats().phase} pending ${run.director.stats().pending} spawned ${run.director.stats().spawned} elites ${run.director.stats().elites}`,
                `HASH ${JSON.stringify(stats.hash)}`
            ].join('<br>');
        }
    }

    return {
        bind,
        reset,
        update,
        setRunActive,
        setScore,
        setCombo,
        setCore,
        setHyper,
        setWave,
        setQuality,
        setWeapon,
        setSeed,
        setScope,
        popup,
        toast,
        stats() {
            return { runActive, popups: popups.length, feeds: feeds.length };
        }
    };
}
