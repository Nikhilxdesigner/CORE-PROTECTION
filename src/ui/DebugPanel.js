/**
 * Debug / practice panel.
 *
 * Only reachable with `?debug=1` (or F3 once debug mode is on). It can spawn
 * things, jump waves, freeze the world and export/import run records, but every
 * reward path is fenced: practice runs are flagged and never write cores,
 * contracts, mastery or personal bests.
 *
 * The panel is built entirely in JS so the production HTML stays free of dev
 * markup, and every control is inert unless debug mode is enabled.
 */

import { ARCHETYPES } from '../world/archetypes.js';
import { POWERUP_LIST } from '../world/Powerups.js';
import { MANUAL_CHOICES } from '../core/Quality.js';

export function createDebugPanel(options = {}) {
    const doc = options.document || document;
    const bus = options.bus;
    let engine = null;
    let root = null;
    let statsHost = null;
    let active = false;
    let built = false;
    let updateTimer = 0;

    function build() {
        if (built) return;
        built = true;

        root = doc.createElement('div');
        root.id = 'debug-panel';
        root.className = 'debug-panel';

        root.innerHTML = `
            <div class="debug-head">
                <strong>PRACTICE / DEBUG</strong>
                <span class="debug-badge">NO REWARDS</span>
                <button class="debug-close" type="button">✕</button>
            </div>
            <div class="debug-stats" id="debug-stats">waiting for a run...</div>
            <div class="debug-group">
                <label>Wave
                    <input type="number" id="debug-wave" min="1" max="200" value="1">
                    <button type="button" data-action="jump">JUMP</button>
                </label>
                <label>Spawn
                    <select id="debug-enemy">
                        ${Object.values(ARCHETYPES).map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}
                    </select>
                    <button type="button" data-action="spawn">SPAWN</button>
                    <button type="button" data-action="spawn-elite">ELITE</button>
                    <button type="button" data-action="boss">BOSS</button>
                </label>
                <label>Powerup
                    <select id="debug-powerup">
                        ${POWERUP_LIST.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}
                    </select>
                    <button type="button" data-action="powerup">GRANT</button>
                </label>
            </div>
            <div class="debug-group">
                <label><input type="checkbox" id="debug-lives"> Infinite core</label>
                <label><input type="checkbox" id="debug-freeze"> Freeze world</label>
                <label>Damage x<input type="number" id="debug-damage" min="0" max="50" step="0.5" value="1"></label>
                <label>Fire rate x<input type="number" id="debug-rof" min="0.1" max="20" step="0.5" value="1"></label>
            </div>
            <div class="debug-group">
                <button type="button" data-action="kill-all">KILL ALL</button>
                <button type="button" data-action="draft">FORCE DRAFT</button>
                <button type="button" data-action="quality">CYCLE QUALITY</button>
                <button type="button" data-action="export">EXPORT RECORD</button>
                <button type="button" data-action="import">IMPORT RECORD</button>
                <button type="button" data-action="profile">COPY PROFILE</button>
                <button type="button" data-action="menu">MENU</button>
            </div>
            <div class="debug-note" id="debug-note"></div>
        `;

        doc.body.appendChild(root);
        statsHost = root.querySelector('#debug-stats');

        root.querySelector('.debug-close').addEventListener('click', () => toggle(false));

        root.addEventListener('click', (event) => {
            const action = event.target?.dataset?.action;
            if (action) handleAction(action);
        });

        const bindToggle = (id, handler) => {
            const element = root.querySelector(id);
            element?.addEventListener('change', () => handler(element));
        };
        bindToggle('#debug-lives', (el) => api().infiniteLives(el.checked));
        bindToggle('#debug-freeze', (el) => api().freezeWorld(el.checked));
        bindToggle('#debug-damage', (el) => api().setDamage(Number(el.value) || 1));
        bindToggle('#debug-rof', (el) => api().setFireRate(Number(el.value) || 1));
    }

    function api() {
        return engine?.debugApi?.() || {};
    }

    function note(message) {
        const host = root?.querySelector('#debug-note');
        if (host) host.textContent = message;
        bus?.emit('DEBUG_NOTE', { message, scope: 'panel' });
    }

    function handleAction(action) {
        const debug = api();
        switch (action) {
            case 'jump': {
                const wave = Number(root.querySelector('#debug-wave').value) || 1;
                debug.jumpToWave?.(wave);
                note(`Jumped to wave ${wave}`);
                break;
            }
            case 'spawn': {
                const id = root.querySelector('#debug-enemy').value;
                note(debug.spawn?.(id, false) ? `Spawned ${id}` : 'Spawn refused (cap reached)');
                break;
            }
            case 'spawn-elite': {
                const id = root.querySelector('#debug-enemy').value;
                note(debug.spawn?.(id, true) ? `Spawned elite ${id}` : 'Spawn refused (cap reached)');
                break;
            }
            case 'boss': {
                debug.spawnBoss?.();
                note('Boss queued');
                break;
            }
            case 'powerup': {
                const id = root.querySelector('#debug-powerup').value;
                note(debug.grantPowerup?.(id) ? `Granted ${id}` : 'Powerup refused');
                break;
            }
            case 'kill-all': {
                note(`Purged ${debug.killAll?.() ?? 0} enemies`);
                break;
            }
            case 'draft': {
                engine?.run?.openDraft();
                note('Draft forced');
                break;
            }
            case 'quality': {
                // Only offer the pinnable tiers: EMERGENCY is the governor's own
                // responsiveness safeguard and is not selectable.
                const current = engine?.quality.manual || 'AUTO';
                const next = MANUAL_CHOICES[(MANUAL_CHOICES.indexOf(current) + 1) % MANUAL_CHOICES.length];
                const applied = engine?.setQualityManual(next);
                note(`Quality ${applied ?? next}${applied === 'AUTO' ? '' : ' (pinned)'}`);
                break;
            }
            case 'export': {
                const json = debug.exportRecord?.();
                if (!json) { note('No record: start a run with ?record=1'); break; }
                copy(json).then((ok) => note(ok ? `Record copied (${json.length} chars)` : 'Copy failed - see console'));
                if (!navigator.clipboard) console.log('[record]', json);
                break;
            }
            case 'import': {
                const json = win().prompt('Paste a run record JSON to replay:');
                if (!json) return;
                try {
                    engine?.debugApi?.().replay?.(json);
                    note('Replaying record');
                } catch (err) {
                    note(`Replay failed: ${err.message}`);
                }
                break;
            }
            case 'profile': {
                const payload = JSON.stringify(debug.exportProfile?.() ?? {}, null, 2);
                copy(payload).then((ok) => note(ok ? 'Profile copied' : 'Copy failed'));
                break;
            }
            case 'menu': {
                engine?.returnToMenu();
                break;
            }
            default:
                break;
        }
    }

    function win() {
        return typeof window !== 'undefined' ? window : {};
    }

    async function copy(text) {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }

    function toggle(force) {
        if (!engine?.debug.enabled) return false;
        build();
        active = force === undefined ? !active : !!force;
        root.classList.toggle('active', active);
        return active;
    }

    function renderStats() {
        if (!active || !statsHost) return;
        const debug = api();
        if (!debug.stats) return;
        const s = debug.stats();
        const run = s.run || {};
        const lines = [
            `seed ${run.seed ?? s.run?.seed ?? '-'} · tick ${s.clock?.ticks ?? 0} · tier ${s.quality?.tier} (${s.quality?.manual})`,
            `fps ${s.quality?.fps} · avg ${s.quality?.avg}ms · p95 ${s.quality?.p95}ms · changes ${s.quality?.changes}`,
            s.clock ? `acc ${Math.round((s.clock.accumulator || 0) * 1000)}ms · dropped ${Math.round((s.clock.droppedTime || 0) * 1000)}ms · stalls ${s.clock.stallCount}` : '',
            run.power ? `score ${run.score} · wave ${run.wave} · core ${run.core}/${run.coreMax} · combo ${run.combo} (best ${run.maxCombo})` : 'no active run',
            run.director ? `director w${run.director.wave} ${run.director.phase} pending ${run.director.pending} spawned ${run.director.spawned} elites ${run.director.elites} hazards ${run.director.hazards}` : '',
            run.power ? `damage ${run.power.damage} · rof ${run.power.rof}/s · proj ${run.power.projectiles} · pierce ${run.power.pierce} · crit ${Math.round(run.power.crit * 100)}%` : '',
            run.hyper ? `hyper ${run.hyper.charge}%${run.hyper.active ? ` ACTIVE ${run.hyper.remaining}s` : ''} · activations ${run.hyper.activations} · world ${run.worldTimeFactor}x` : '',
            s.pools?.enemies ? `pools: enemies ${s.pools.enemies.active}/${s.pools.enemies.maxActive} peak ${s.pools.enemies.peakActive} recycled ${s.pools.enemies.recycled} · hazards ${s.pools.hazards.active} · powerups ${s.pools.powerups.active} · tracers ${s.pools.tracers.active}` : '',
            s.pools?.particles ? `particles ${s.pools.particles.live}/${s.pools.particles.budget} · debris ${s.pools.debris.live}/${s.pools.debris.budget}` : '',
            s.hash ? `hash cells ${s.hash.cells} tracked ${s.hash.tracked} avg candidates/query ${s.hash.averageCandidates}` : '',
            // Aim readout, so a mis-aimed shot can be told apart from a bad hit query.
            s.scope
                ? `scope ${s.scope.state} ring ${s.scope.ringPx}px shots ${s.scope.shots}`
                    + (s.scope.target
                        ? ` · ${s.scope.target.name} ${s.scope.target.hp}/${s.scope.target.maxHp} d${s.scope.target.distance} ${s.scope.target.inside ? 'IN RING' : 'OUT'}`
                        : '')
                : 'scope n/a',
            s.lifecycle ? `lifecycle hidden ${s.lifecycle.hidden} focused ${s.lifecycle.focused} last ${s.lifecycle.lastEvent}` : '',
            s.postfx ? `post bloom ${s.postfx.bloom} ca ${s.postfx.chromatic} dist ${s.postfx.distortion}` : ''
        ].filter(Boolean);

        statsHost.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
    }

    return {
        build,
        toggle,
        get active() { return active; },
        bind(engineRef) {
            engine = engineRef;
            if (engine.debug.enabled) {
                build();
                const badge = root.querySelector('.debug-badge');
                if (badge) {
                    badge.textContent = engine.debug.practice ? 'NO REWARDS' : 'REWARDS ON';
                    badge.dataset.rewards = engine.debug.practice ? 'off' : 'on';
                }
                root.classList.add('active');
                active = true;
            }
            return this;
        },
        update(dt) {
            if (!active) return;
            updateTimer += dt;
            if (updateTimer < 0.25) return;
            updateTimer = 0;
            renderStats();
        },
        note,
        stats() {
            return { active, built };
        }
    };
}
