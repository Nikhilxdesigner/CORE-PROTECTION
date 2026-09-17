/**
 * Screens.
 *
 * All DOM work for the non-gameplay screens lives here: the menu, draft
 * overlay, pause, results, arsenal, contracts, how-to-play and settings. Screens
 * read state and call engine methods; they never touch simulation internals.
 */

import { formatCountdown, formatScore, formatTime, shortNumber } from '../util/Math.js';
import { TIER_NAMES, MANUAL_CHOICES } from '../core/Quality.js';
import { WEAPON_LIST } from '../world/Weapons.js';

const RARITY_LABEL = { common: 'COMMON', rare: 'RARE', epic: 'EPIC' };

export function createScreens(options = {}) {
    const bus = options.bus;
    const doc = options.document || document;
    let engine = null;
    let bannerTimer = null;
    let toastTimer = null;
    let draftVisible = false;
    let bound = false;

    const $ = (id) => doc.getElementById(id);
    const screens = {};

    function cacheScreens() {
        for (const element of doc.querySelectorAll('.screen')) {
            screens[element.id.replace(/^screen-/, '')] = element;
        }
    }

    function showScreen(name, data = {}) {
        for (const [key, element] of Object.entries(screens)) {
            element.classList.toggle('active', key === name);
        }
        if (name === 'game') {
            $('stage')?.classList.add('active');
        }
        if (name === 'arsenal') renderArsenal();
        if (name === 'contracts') renderContracts();
        if (name === 'settings') renderSettings();
        return name;
    }

    function banner(title, sub = '', kind = 'wave') {
        const host = $('hud-banner');
        if (!host) return;
        $('hud-banner-title').textContent = title;
        $('hud-banner-sub').textContent = sub || '';
        host.className = `hud-banner active ${kind}`;
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => {
            host.classList.remove('active');
        }, 2200);
    }

    function toast(text, kind = 'info') {
        const host = $('screens-toast');
        if (!host) return;
        host.textContent = text;
        host.className = `screen-toast active ${kind}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => host.classList.remove('active'), 1900);
    }

    /* --------------------------------------------------------------- draft -- */

    function showDraft(offer, onPick) {
        const host = $('draft-cards');
        if (!host) return;
        host.innerHTML = '';
        draftVisible = true;

        offer.forEach((card, index) => {
            const button = doc.createElement('button');
            button.className = `draft-card ${card.rarity}`;
            button.type = 'button';
            button.innerHTML = `
                <span class="draft-index">${index + 1}</span>
                <span class="draft-rarity">${RARITY_LABEL[card.rarity] || 'COMMON'}${card.evolved ? ' · EVOLUTION' : ''}</span>
                <span class="draft-name">${card.name}</span>
                <span class="draft-desc">${card.desc}</span>
                <span class="draft-level">${card.evolved ? 'UNLOCK' : `Lv ${(Number.isFinite(card.level) ? card.level : 0) + 1}/${card.max}`}</span>
            `;
            button.addEventListener('click', () => {
                if (!draftVisible) return;
                draftVisible = false;
                onPick(index);
            });
            host.appendChild(button);
        });

        $('screen-draft')?.classList.add('active');
    }

    function hideDraft() {
        draftVisible = false;
        $('screen-draft')?.classList.remove('active');
    }

    /* ------------------------------------------------------------- results -- */

    function showResults(payload) {
        const { stats, progression: summary, streak, streakState, nearUnlocks, daily } = payload;

        const set = (id, value) => {
            const el = $(id);
            if (el) el.textContent = value;
        };

        set('res-score', formatScore(stats.score));
        set('res-wave', stats.wave);
        set('res-combo', stats.maxCombo);
        set('res-accuracy', `${stats.accuracy}%`);
        set('res-time', formatTime(stats.timeSurvived));
        set('res-kills', stats.kills);
        set('res-cores', `+${summary.coresEarned}${summary.practice ? ' (practice)' : ''}`);
        set('res-best', formatScore(Math.max(summary.previousBest, stats.score)));
        set('res-reason', describeReason(stats.reason));

        const delta = $('res-delta');
        if (delta) {
            const vs = stats.score - summary.previousBest;
            if (summary.newBest) {
                delta.textContent = `NEW BEST (+${formatScore(vs)})`;
                delta.className = 'res-delta best';
            } else if (delta) {
                const percent = summary.previousBest > 0 ? Math.round((vs / summary.previousBest) * 100) : 0;
                delta.textContent = `${percent >= 0 ? '+' : ''}${percent}% vs your best`;
                delta.className = `res-delta ${percent >= 0 ? 'up' : 'down'}`;
            }
        }

        const rating = $('res-rating');
        if (rating) rating.textContent = ratingFor(stats);

        const dailyLine = $('res-daily');
        if (dailyLine) {
            if (stats.mode === 'daily' && daily) {
                const credited = streak?.credited;
                dailyLine.textContent = credited
                    ? `Daily complete · streak ${streak.current} day${streak.current === 1 ? '' : 's'} (+${Math.round((streak.bonusMultiplier - 1) * 100)}% bonus)`
                    : `Daily already credited today · streak ${streakState.current}`;
            } else if (streakState) {
                dailyLine.textContent = `Daily streak ${streakState.current} · best daily ${formatScore(streakState.bestDailyScore)}`;
            }
        }

        const contractHost = $('res-contracts');
        if (contractHost) {
            contractHost.innerHTML = '';
            for (const contract of summary.contractsCompleted || []) {
                const row = doc.createElement('div');
                row.className = 'res-contract';
                row.innerHTML = `<span>${contract.name}</span><span>+${contract.cores} cores</span>`;
                contractHost.appendChild(row);
            }
        }

        const unlockHost = $('res-unlocks');
        if (unlockHost) {
            unlockHost.innerHTML = '';
            for (const unlock of summary.unlocked || []) {
                const row = doc.createElement('div');
                row.className = 'res-unlock';
                row.textContent = `UNLOCKED · ${unlock.name}`;
                unlockHost.appendChild(row);
            }
        }

        const nearHost = $('res-near');
        if (nearHost) {
            nearHost.innerHTML = '';
            for (const item of nearUnlocks || []) {
                const row = doc.createElement('div');
                row.className = 'near-item';
                const percent = Math.round((item.progress / item.target) * 100);
                row.innerHTML = `
                    <div class="near-row"><span>${item.label}</span><span>${shortNumber(item.progress)}/${shortNumber(item.target)}</span></div>
                    <div class="near-bar"><div style="width:${Math.min(100, percent)}%"></div></div>
                    <div class="near-hint">${item.hint}</div>
                `;
                nearHost.appendChild(row);
            }
        }

        const buildHost = $('res-build');
        if (buildHost) {
            buildHost.innerHTML = '';
            for (const entry of stats.upgraded || []) {
                const chip = doc.createElement('span');
                chip.className = `build-chip ${entry.rarity}${entry.evolved ? ' evolved' : ''}`;
                chip.textContent = entry.evolved ? entry.name : `${entry.name} ${entry.level}/${entry.max}`;
                buildHost.appendChild(chip);
            }
        }

        showScreen('results');
    }

    function describeReason(reason) {
        switch (reason) {
            case 'core-destroyed': return 'Core destroyed';
            case 'abandoned': return 'Run abandoned';
            case 'replay-complete': return 'Replay finished';
            default: return reason || 'Run ended';
        }
    }

    function ratingFor(stats) {
        const score = (stats.score / 9000) + (stats.wave / 10) + (stats.accuracy / 100) + (stats.maxCombo / 40);
        if (score >= 4.2) return 'S';
        if (score >= 3.2) return 'A';
        if (score >= 2.4) return 'B';
        if (score >= 1.6) return 'C';
        return 'D';
    }

    /* --------------------------------------------------------------- menu --- */

    function refreshMenu(progression, streak, daily) {
        const summary = progression.summary();
        const set = (id, value) => {
            const el = $(id);
            if (el) el.textContent = value;
        };
        set('menu-cores', formatScore(summary.cores));
        set('menu-best', formatScore(summary.bestScore));
        set('menu-best-wave', summary.bestWave);
        set('menu-contracts', summary.contracts);
        set('menu-kills', shortNumber(summary.kills));
        set('menu-streak', `${streak.current} day${streak.current === 1 ? '' : 's'}${streak.bonusPercent > 0 ? ` (+${streak.bonusPercent}%)` : ''}`);

        const dailyInfo = $('menu-daily-info');
        if (dailyInfo && daily) {
            dailyInfo.textContent = `${daily.label} · ${formatCountdown(msUntilUtcMidnight())} until reset`;
        }
    }

    function msUntilUtcMidnight() {
        if (engine?.util?.msUntilNextUtcMidnight) return engine.util.msUntilNextUtcMidnight(new Date());
        return 0;
    }

    function setRunMode(mode, daily) {
        const el = $('hud-mode');
        if (el) el.textContent = mode === 'daily' ? `DAILY · ${daily?.label || ''}` : 'STANDARD';
    }

    /* ------------------------------------------------------------ arsenal --- */

    function renderArsenal() {
        if (!engine) return;
        const progression = engine.progression;
        const cores = $('arsenal-cores');
        if (cores) cores.textContent = formatScore(progression.cores);

        const host = $('arsenal-list');
        if (!host) return;
        host.innerHTML = '';

        for (const track of progression.TRACKS) {
            const level = progression.trackLevel(track.id);
            const maxed = progression.trackMaxed(track.id);
            const cost = progression.trackCost(track.id);
            const affordable = !maxed && progression.cores >= cost;

            const row = doc.createElement('div');
            row.className = `arsenal-row${maxed ? ' maxed' : ''}`;
            row.innerHTML = `
                <div class="arsenal-head">
                    <span class="arsenal-name">${track.name}</span>
                    <span class="arsenal-level">${level}/${track.max}</span>
                </div>
                <div class="arsenal-desc">${track.desc}</div>
                <div class="arsenal-bar"><div style="width:${(level / track.max) * 100}%"></div></div>
                <button class="arsenal-buy" ${maxed || !affordable ? 'disabled' : ''}>
                    ${maxed ? 'MAXED' : `UPGRADE · ${cost} CORES`}
                </button>
            `;
            row.querySelector('.arsenal-buy')?.addEventListener('click', () => {
                const result = progression.buyTrack(track.id, engine.tickCount);
                if (result.ok) {
                    engine.bus.emit('ARSENAL_PURCHASED', { track: track.id, level: result.level });
                    renderArsenal();
                } else if (result.reason === 'insufficient') {
                    toast('Not enough cores', 'warn');
                } else if (result.reason === 'practice') {
                    toast('Practice mode: progression is disabled', 'warn');
                }
            });
            host.appendChild(row);
        }

        const weaponsHost = $('arsenal-weapons');
        if (weaponsHost) {
            weaponsHost.innerHTML = '';
            const unlocked = progression.weaponsUnlocked();
            for (const weapon of WEAPON_LIST) {
                const mastery = progression.masteryFor(weapon.id);
                const card = doc.createElement('div');
                card.className = `weapon-card${unlocked[weapon.id] ? '' : ' locked'}`;
                card.innerHTML = `
                    <div class="weapon-name">${weapon.name}</div>
                    <div class="weapon-blurb">${weapon.blurb}</div>
                    <div class="weapon-stats">DMG ${weapon.damage} · ROF ${(1 / weapon.rof).toFixed(1)}/s · PIERCE ${weapon.pierce} · CRIT ${Math.round(weapon.crit * 100)}%</div>
                    ${unlocked[weapon.id]
                        ? `<div class="weapon-mastery">Mastery ${mastery.level} · ${mastery.xp} XP</div>
                           <button class="weapon-select" ${engine.run?.weapon.id === weapon.id ? 'disabled' : ''}>
                               ${engine.run?.weapon.id === weapon.id ? 'EQUIPPED' : 'EQUIP'}
                           </button>`
                        : `<div class="weapon-lock">LOCKED · ${weapon.unlock?.label || 'keep playing'}</div>`}
                `;
                card.querySelector('.weapon-select')?.addEventListener('click', () => {
                    engine.setWeapon(weapon.id);
                    renderArsenal();
                    toast(`${weapon.name} equipped`, 'info');
                });
                weaponsHost.appendChild(card);
            }
        }

        const skinsHost = $('arsenal-skins');
        if (skinsHost) {
            skinsHost.innerHTML = '';
            for (const skin of progression.SKINS) {
                const unlocked = progression.skinUnlocked(skin.id);
                const chip = doc.createElement('button');
                chip.className = `skin-chip${unlocked ? '' : ' locked'}${progression.profile.skin === skin.id ? ' active' : ''}`;
                chip.textContent = unlocked ? skin.name : `${skin.name} · locked`;
                chip.disabled = !unlocked;
                chip.addEventListener('click', () => {
                    if (engine.setSkin(skin.id)) {
                        renderArsenal();
                        toast(`${skin.name} equipped`, 'info');
                    }
                });
                skinsHost.appendChild(chip);
            }
        }
    }

    /* ---------------------------------------------------------- contracts --- */

    function renderContracts() {
        if (!engine) return;
        const progression = engine.progression;
        const host = $('contracts-list');
        if (!host) return;
        host.innerHTML = '';

        const state = progression.contractsState();
        const doneCount = state.filter((c) => c.done).length;
        const summary = $('contracts-summary');
        if (summary) summary.textContent = `${doneCount}/${state.length} complete · ${formatScore(progression.cores)} cores available`;

        for (const contract of state) {
            const percent = Math.min(100, Math.round((contract.progress / contract.target) * 100));
            const row = doc.createElement('div');
            row.className = `contract-row${contract.done ? ' done' : ''}`;
            row.innerHTML = `
                <div class="contract-head">
                    <span class="contract-name">${contract.done ? '✔ ' : ''}${contract.name}</span>
                    <span class="contract-reward">+${contract.cores}</span>
                </div>
                <div class="contract-desc">${contract.desc}</div>
                <div class="contract-bar"><div style="width:${percent}%"></div></div>
                <div class="contract-progress">${shortNumber(contract.progress)} / ${shortNumber(contract.target)}</div>
            `;
            host.appendChild(row);
        }
    }

    /* ----------------------------------------------------------- settings --- */

    function renderSettings() {
        if (!engine) return;
        const qualitySelect = $('set-quality');
        if (qualitySelect && qualitySelect.options.length === 0) {
            for (const choice of MANUAL_CHOICES) {
                const option = doc.createElement('option');
                option.value = choice;
                option.textContent = choice === 'AUTO' ? 'Auto (adaptive)' : choice;
                qualitySelect.appendChild(option);
            }
        }
        if (qualitySelect) qualitySelect.value = engine.settings.qualityManual || 'AUTO';

        const setValue = (id, value) => {
            const el = $(id);
            if (el) el.value = value;
        };
        setValue('set-music', engine.settings.musicVolume);
        setValue('set-sfx', engine.settings.sfxVolume);
        setValue('set-aimassist', Math.round(engine.settings.aimAssist * 100));

        const setChecked = (id, value) => {
            const el = $(id);
            if (el) el.checked = !!value;
        };
        setChecked('set-reduced-motion', engine.settings.reducedMotion);
        setChecked('set-reduced-flash', engine.settings.reducedFlash);
        setChecked('set-reduce-dilation', engine.settings.reduceDilation);

        const label = (id, value) => {
            const el = $(id);
            if (el) el.textContent = value;
        };
        label('set-music-val', `${engine.settings.musicVolume}%`);
        label('set-sfx-val', `${engine.settings.sfxVolume}%`);
        label('set-aimassist-val', `${Math.round(engine.settings.aimAssist * 100)}%`);
    }

    /* --------------------------------------------------------------- bind --- */

    function bind(engineRef) {
        engine = engineRef;
        if (bound) return;
        bound = true;
        cacheScreens();

        const click = (id, fn) => $(id)?.addEventListener('click', (event) => {
            event.preventDefault();
            engine.bus.emit('UI_CLICK', { tick: engine.tickCount, id });
            audio(engine)?.sfx.ui();
            fn(event);
        });

        click('btn-play', () => engine.play());
        click('btn-daily', () => engine.startRun({ mode: 'daily' }));
        click('btn-arsenal', () => showScreen('arsenal'));
        click('btn-contracts', () => showScreen('contracts'));
        click('btn-howto', () => showScreen('howto'));
        click('btn-settings', () => showScreen('settings'));
        click('btn-resume', () => engine.resume());
        click('btn-restart', () => engine.restartRun());
        click('btn-menu', () => engine.returnToMenu());
        click('btn-again', () => engine.restartRun());
        click('btn-results-menu', () => engine.returnToMenu());
        click('btn-arsenal-back', () => { engine.returnToMenu(); });
        click('btn-contracts-back', () => { engine.returnToMenu(); });
        click('btn-howto-back', () => { engine.returnToMenu(); });
        click('btn-settings-back', () => {
            engine.bus.emit('SETTINGS_CLOSED', {});
            if (engine.run && !engine.run.finished) {
                engine.resume();
                showScreen('game');
            } else {
                engine.returnToMenu();
            }
        });
        click('btn-pause-settings', () => showScreen('settings'));
        click('btn-close-draft', () => hideDraft());

        // In-game HUD controls: pause freezes the run, exit abandons it and
        // returns to the menu (confirm-free: abandoning mid-run is deliberate).
        click('btn-hud-pause', () => {
            if (engine.state.is(engine.STATES.PAUSED)) engine.resume();
            else engine.pause('hud');
        });
        click('btn-hud-exit', () => engine.returnToMenu());

        $('btn-reset-profile')?.addEventListener('click', () => {
            engine.progression.reset();
            toast('Profile reset', 'warn');
            renderSettings();
        });

        $('set-quality')?.addEventListener('change', (event) => {
            const chosen = engine.setQualityManual(event.target.value);
            toast(`Quality: ${chosen}`, 'quality');
        });
        $('set-music')?.addEventListener('input', (event) => {
            engine.setSetting('musicVolume', Number(event.target.value));
            $('set-music-val').textContent = `${event.target.value}%`;
        });
        $('set-sfx')?.addEventListener('input', (event) => {
            engine.setSetting('sfxVolume', Number(event.target.value));
            $('set-sfx-val').textContent = `${event.target.value}%`;
        });
        $('set-aimassist')?.addEventListener('input', (event) => {
            engine.setSetting('aimAssist', Number(event.target.value) / 100);
            $('set-aimassist-val').textContent = `${event.target.value}%`;
        });
        $('set-reduced-motion')?.addEventListener('change', (event) => engine.setSetting('reducedMotion', event.target.checked));
        $('set-reduced-flash')?.addEventListener('change', (event) => engine.setSetting('reducedFlash', event.target.checked));
        $('set-reduce-dilation')?.addEventListener('change', (event) => engine.setSetting('reduceDilation', event.target.checked));

        bus?.on('ARSENAL_PURCHASED', () => renderArsenal());
    }

    function audio(engineRef) {
        return engineRef?.audio || null;
    }

    function currentScreen() {
        for (const [key, element] of Object.entries(screens)) {
            if (element.classList.contains('active')) return key;
        }
        return null;
    }

    return {
        bind,
        showScreen,
        banner,
        toast,
        showDraft,
        hideDraft,
        showResults,
        refreshMenu,
        setRunMode,
        renderSettings,
        renderArsenal,
        renderContracts,
        update() {},
        get current() { return currentScreen(); },
        stats() {
            return { cached: Object.keys(screens).length, current: this.current };
        }
    };
}
