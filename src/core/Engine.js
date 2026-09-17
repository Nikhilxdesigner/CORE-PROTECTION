/**
 * Engine.
 *
 * Owns the platform layer: renderer, scene graph, the fixed-step loop, the
 * quality governor, lifecycle handling, and the FX/audio responses to gameplay
 * events. It never mutates gameplay state - a run decides everything - which is
 * what keeps the event bus honest and the dependency graph acyclic (main.js
 * wires systems; systems talk to the bus).
 *
 * Frame shape:
 *   rAF -> FixedStep.advance -> [run.tick(dt) x N] -> syncVisuals(alpha) -> composer.render()
 */

import * as THREE from 'three';
import { createEventBus, EVENTS } from './Events.js';
import { FixedStep } from './Clock.js';
import { createQuality, detectPlatform, TIER_NAMES } from './Quality.js';
import { createLifecycle } from './Lifecycle.js';
import { STATES, createStateMachine } from './State.js';
import { Pool } from './Pool.js';
import { ARENA, CAMERA_RIG } from '../world/ArenaSpec.js';
import { createArena } from '../world/Arena.js';
import { createEnemyManager } from '../world/Enemies.js';
import { createHazardManager } from '../world/Hazards.js';
import { createPowerupManager } from '../world/Powerups.js';
import { createParticleField } from '../fx/Particles.js';
import { createDebris } from '../fx/Debris.js';
import { createPostFX } from '../fx/PostFX.js';
import { SpatialHash } from '../world/SpatialHash.js';
import { ARENA as ARENA_SPEC } from '../world/ArenaSpec.js';
import { createRun, RUN_MODES } from '../game/Run.js';
import { readScope, shotsToKill, SCOPE_STATE } from '../game/Aim.js';
import { createProgression } from '../game/Progression.js';
import { WEAPON_LIST } from '../world/Weapons.js';

const WEAPON_IDS = WEAPON_LIST.map((weapon) => weapon.id);
import { dailyConfig, utcDateKey, msUntilNextUtcMidnight, createStreak, dailySeedForKey } from '../game/Daily.js';
import { Recorder, Replayer, EVENT as RECORD_EVENT } from '../game/Recorder.js';
import { damp } from '../util/Math.js';
import { screenToWorld, worldToScreen } from '../util/CamMath.js';

export function createEngine(deps) {
    const bus = deps.bus || createEventBus({ history: true });
    const audio = deps.audio;
    const hud = deps.hud;
    const screens = deps.screens;
    const input = deps.input;
    const storage = deps.storage;
    const busRef = bus;

    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const debug = {
        enabled: params.get('debug') === '1',
        demo: params.get('demo') === '1',
        seed: params.get('seed') ? Number(params.get('seed')) : null,
        quality: params.get('quality') ? String(params.get('quality')).toUpperCase() : null,
        record: params.get('record') === '1',
        replay: params.get('replay') || null,
        // Debug mode implies practice: a run started from ?debug=1 can never write
        // cores, contracts, mastery or personal bests. Pass ?rewards=1 to opt in
        // when you are deliberately testing the progression path.
        practice: params.get('practice') === '1'
            || (params.get('debug') === '1' && params.get('rewards') !== '1'),
        rewards: params.get('rewards') === '1',
        // Core invulnerability is opt-in (?infinite=1 or the debug panel's
        // checkbox), so a practice run can still end, die and show results.
        infinite: params.get('infinite') === '1'
    };

    const platform = detectPlatform();
    const state = createStateMachine(STATES.BOOT, (next, prev) => {
        bus.emit('SCREEN_CHANGED', { tick: engine?.tickCount ?? 0, state: next, previous: prev });
    });

    const settings = {
        musicVolume: storage.get('setMusic', 45),
        sfxVolume: storage.get('setSfx', 70),
        qualityManual: storage.get('setQuality', 'AUTO'),
        reducedMotion: !!storage.get('setReducedMotion', false),
        reducedFlash: !!storage.get('setReducedFlash', false),
        reduceDilation: !!storage.get('setReduceDilation', false),
        aimAssist: Number(storage.get('setAimAssist', platform === 'mobile' ? 0.6 : 0.25))
    };

    const quality = createQuality({ platform, bus, windowSize: 90 });
    if (debug.quality && TIER_NAMES.includes(debug.quality)) {
        quality.setManual(debug.quality);
    } else if (settings.qualityManual && settings.qualityManual !== 'AUTO') {
        quality.setManual(settings.qualityManual);
    }

    const progression = createProgression({ storage: deps.progressionStorage || storage, bus });
    progression.setPractice(!!debug.practice);
    const streak = createStreak(storage);

    const clock = new FixedStep({ hz: 60, maxFrameDelta: 0.25, maxSubsteps: 5 });

    let renderer = null;
    let scene = null;
    let camera3d = null;
    let arena = null;
    let hash = null;
    let enemies = null;
    let hazards = null;
    let powerups = null;
    let particles = null;
    let debris = null;
    let postfx = null;
    let tracers = null;
    let run = null;
    let scope = null;
    let recorder = null;
    let replayer = null;
    let running = false;
    let disposed = false;
    let rafId = null;
    let lastFrameTime = 0;
    let renderScale = 1;
    let pixelRatioCap = 2;
    let viewport = { width: 1, height: 1 };
    let engine = null;

    // Camera rig state mirrored as plain numbers for the pure aim maths.
    const camState = {
        position: { ...CAMERA_RIG.position },
        yaw: 0,
        pitch: 0,
        fovDeg: CAMERA_RIG.fovDeg,
        aspect: 1
    };
    const shake = { x: 0, y: 0, intensity: 0, elapsed: 0, duration: 0.3 };
    const recoil = { z: 0 };
    let hyperVisual = 0;
    let damageVisual = 0;
    let waveBannerTimer = 0;
    let intermissionGuard = 0;
    let stepErrors = 0;
    // Tick at which the current run began, so spurious focus/pageshow events at
    // boot cannot pause a run that has only just started.
    let runStartTick = 0;

    /* ------------------------------------------------------------- renderer -- */

    function computeRigAngles() {
        const dx = CAMERA_RIG.lookAt.x - CAMERA_RIG.position.x;
        const dy = CAMERA_RIG.lookAt.y - CAMERA_RIG.position.y;
        const dz = CAMERA_RIG.lookAt.z - CAMERA_RIG.position.z;
        const length = Math.hypot(dx, dy, dz) || 1;
        const dir = { x: dx / length, y: dy / length, z: dz / length };
        const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        const cosPitch = Math.cos(pitch) || 0.0001;
        const yaw = Math.atan2(-dir.x / cosPitch, -dir.z / cosPitch);
        return { yaw, pitch };
    }

    function applyRendererSize() {
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const ratio = Math.max(0.5, Math.min(pixelRatioCap, dpr) * renderScale);
        renderer?.setPixelRatio(ratio);
        renderer?.setSize(viewport.width, viewport.height, false);
        postfx?.setPixelRatio(ratio);
        postfx?.setSize(viewport.width, viewport.height);
        particles?.setPixelRatio(ratio);
    }

    function resize() {
        if (!renderer) return;
        const width = Math.max(2, window.innerWidth);
        const height = Math.max(2, window.innerHeight);
        viewport = { width, height };
        camState.aspect = width / height;
        if (camera3d) {
            camera3d.aspect = camState.aspect;
            camera3d.updateProjectionMatrix();
        }
        arena?.setScreenAspect(camState.aspect);
        applyRendererSize();
        bus.emit('RESIZED', { tick: clock.ticks, width, height, aspect: camState.aspect });
    }

    function initThree() {
        scene = new THREE.Scene();
        scene.fog = new THREE.Fog(new THREE.Color(0x050814), 26, 96);

        renderer = new THREE.WebGLRenderer({
            antialias: quality.config().renderScale >= 0.9,
            powerPreference: 'high-performance',
            alpha: false,
            stencil: false
        });
        renderer.setClearColor(0x04060e, 1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.domElement.id = 'game-canvas';
        document.getElementById('stage')?.appendChild(renderer.domElement);
        bus.emit('QUALITY_NOTE', { tier: quality.name });

        const angles = computeRigAngles();
        camState.yaw = angles.yaw;
        camState.pitch = angles.pitch;

        camera3d = new THREE.PerspectiveCamera(CAMERA_RIG.fovDeg, 1, CAMERA_RIG.near, CAMERA_RIG.far);
        camera3d.position.set(CAMERA_RIG.position.x, CAMERA_RIG.position.y, CAMERA_RIG.position.z);
        camera3d.rotation.order = 'YXZ';
        camera3d.rotation.y = angles.yaw;
        camera3d.rotation.x = angles.pitch;

        const skin = progression.skin;
        arena = createArena({ scene, skin });

        hash = new SpatialHash({ cellSize: ARENA.averageEnemyRadius * 2.6 });
        enemies = createEnemyManager({ scene, hash, bus, rng: null, maxViews: 96, maxActive: quality.config().maxActiveEnemies });
        hazards = createHazardManager({ scene, hash, bus, maxViews: 16 });
        powerups = createPowerupManager({ scene, hash, bus, rng: null, maxViews: 6 });
        particles = createParticleField({ scene, budget: quality.config().particles });
        debris = createDebris({ scene, budget: quality.config().debris });
        tracers = createTracerPool(scene);
        postfx = createPostFX({
            renderer,
            scene,
            camera: camera3d,
            size: { width: window.innerWidth, height: window.innerHeight },
            pixelRatio: 1
        });
        postfx.setReducedMotion(settings.reducedMotion);

        qualityCtx.setBloom(quality.config().bloom);
        qualityCtx.setPost(quality.config().post);
        qualityCtx.setBudget('particles', quality.config().particles);
        qualityCtx.setBudget('debris', quality.config().debris);
        qualityCtx.setMaxActiveEnemies(quality.config().maxActiveEnemies);
        qualityCtx.setHazardCap(quality.config().hazardCap);
    }

    /* -------------------------------------------------------------- tracers -- */

    function createTracerPool(scene_) {
        const geometry = new THREE.BoxGeometry(0.07, 0.07, 1);
        const material = new THREE.MeshBasicMaterial({
            color: 0x9fe8ff,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        const pool = new Pool({
            name: 'tracers',
            maxSize: 160,
            prewarm: 32,
            create: () => {
                const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
                    color: 0x9fe8ff,
                    transparent: true,
                    opacity: 0.9,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                }));
                mesh.visible = false;
                mesh.renderOrder = 18;
                return {
                    mesh,
                    life: 0,
                    maxLife: 1,
                    activate(x1, y1, x2, y2, color, thickness = 1) {
                        const dx = x2 - x1;
                        const dy = y2 - y1;
                        const length = Math.max(0.2, Math.hypot(dx, dy));
                        this.mesh.visible = true;
                        this.mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, ARENA.planeZ + 0.4);
                        this.mesh.rotation.z = Math.atan2(dy, dx);
                        this.mesh.scale.set(thickness, thickness, length);
                        this.mesh.material.color.set(color);
                        this.maxLife = 0.11;
                        this.life = this.maxLife;
                        if (!this.mesh.parent) scene_.add(this.mesh);
                    },
                    deactivate() {
                        this.mesh.visible = false;
                        if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
                    },
                    dispose() { this.mesh.material.dispose(); }
                };
            }
        });

        return {
            pool,
            add(x1, y1, x2, y2, color = 0x9fe8ff, thickness = 1) {
                pool.acquire(x1, y1, x2, y2, color, thickness);
            },
            update(dt) {
                pool.forEachActive((tracer) => {
                    tracer.life -= dt;
                    if (tracer.life <= 0) pool.release(tracer);
                    else tracer.mesh.material.opacity = Math.max(0, tracer.life / tracer.maxLife) * 0.95;
                });
            },
            get activeCount() { return pool.activeCount; },
            dispose() { pool.clear(true); geometry.dispose(); material.dispose(); }
        };
    }

    /* ------------------------------------------------------------ quality ---- */

    const qualityCtx = {
        setPixelRatioCap(value) { pixelRatioCap = value; applyRendererSize(); },
        setRenderScale(value) { renderScale = value; applyRendererSize(); },
        setBloom(config) { postfx?.setBloom(config); },
        setPost(config) {
            postfx?.setPost({
                ...config,
                grain: settings.reducedMotion ? Math.min(config.grain ?? 0, 0.02) : config.grain
            });
            if (config.chromatic !== undefined && settings.reducedMotion) {
                postfx?.setPost({ chromatic: config.chromatic * 0.4 });
            }
            arena?.setQuality(config);
        },
        setBudget(kind, value) {
            if (kind === 'particles') particles?.setBudget(value);
            if (kind === 'debris') debris?.setBudget(value);
        },
        setMaxActiveEnemies(value) {
            enemies?.setBudget(value);
            run?.setLimits({ maxActiveEnemies: value });
        },
        setHazardCap(value) {
            hazards?.setBudget(value);
            run?.setLimits({ hazardCap: value });
        }
    };

    /* ------------------------------------------------------------- FX wiring -- */

    function worldToUv(x, y) {
        const screen = worldToScreen({ x, y, z: ARENA.planeZ }, camState, {
            left: 0, top: 0, width: viewport.width, height: viewport.height
        });
        if (!screen) return { u: 0.5, v: 0.5 };
        return { u: screen.x / viewport.width, v: 1 - screen.y / viewport.height };
    }

    function impactFx(x, y, strength = 1, color = 0x9fe8ff, options = {}) {
        const uv = worldToUv(x, y);
        postfx?.impact(uv.u, uv.v, strength * (settings.reducedFlash ? 0.5 : 1));
        particles?.burst({
            x, y, z: ARENA.planeZ + 0.25,
            count: Math.round((options.particles ?? 16) * (quality.name === 'EMERGENCY' ? 0.35 : 1)),
            color,
            speed: options.speed ?? 7,
            life: options.life ?? 0.55,
            size: options.size ?? 0.32
        });
        if (options.debris) {
            debris?.burst({ x, y, z: ARENA.planeZ + 0.25, count: options.debris, color, spread: options.spread ?? 7 });
        }
        if (options.ripple !== false) arena?.ripple(x, 0, strength);
    }

    function shakeScreen(intensity, duration = 0.3) {
        if (settings.reducedMotion) intensity *= 0.4;
        shake.intensity = Math.max(shake.intensity, intensity);
        shake.duration = duration;
        shake.elapsed = 0;
    }

    function bindGameplayEvents() {
        // Lighting: the engine is the only place that knows how to turn a fact
        // ("an enemy died") into light, sound and pixels.
        const wired = [
            [EVENTS.ENEMY_HIT, (e) => {
                impactFx(e.x, e.y, e.crit ? 0.8 : 0.4, e.crit ? 0xffe066 : 0xffffff, {
                    particles: e.crit ? 14 : 7,
                    speed: 5,
                    life: 0.35,
                    size: 0.22,
                    ripple: false
                });
                audio?.sfx.hit();
            }],
            [EVENTS.ENEMY_KILL, (e) => {
                const isBoss = !!e.boss;
                impactFx(e.x, e.y, isBoss ? 2.4 : (e.elite ? 1.6 : 1), e.color ?? 0xff8a5c, {
                    particles: isBoss ? 90 : (e.elite ? 44 : 22),
                    speed: isBoss ? 16 : (e.elite ? 11 : 8),
                    life: isBoss ? 1.2 : 0.7,
                    size: isBoss ? 0.6 : 0.36,
                    debris: isBoss ? 26 : (e.elite ? 12 : 6)
                });
                shakeScreen(isBoss ? 1.5 : (e.elite ? 0.6 : 0.28), isBoss ? 0.6 : 0.25);
                if (isBoss) audio?.sfx.explosion(); else audio?.sfx.kill();
            }],
            [EVENTS.CORE_DAMAGED, (e) => {
                if (e.shielded) {
                    audio?.sfx.hit();
                    return;
                }
                damageVisual = 1;
                postfx?.setFlash(settings.reducedFlash ? 0.12 : 0.3);
                shakeScreen(1.2, 0.5);
                arena?.setCoreHit(1);
                impactFx(ARENA.core.x, ARENA.core.y, 1.8, 0xff2b4a, { particles: 46, speed: 12, debris: 14, life: 0.9 });
                audio?.sfx.coreDamage();
            }],
            [EVENTS.CORE_HEALED, () => {
                audio?.sfx.coreHeal();
                impactFx(ARENA.core.x, ARENA.core.y, 1.1, 0x66ffbb, { particles: 30, speed: 6, life: 0.8 });
            }],
            [EVENTS.CORE_BREACHED, (e) => {
                arena?.ripple(e.x, 0, 1.2);
            }],
            [EVENTS.HYPER_START, () => {
                audio?.sfx.hyperStart();
                audio?.setHyper(true);
                postfx?.setFlash(0.18);
                screens?.banner('HYPER MODE', 'Fire rate up - world slowed', 'hyper');
            }],
            [EVENTS.HYPER_END, () => {
                audio?.sfx.hyperEnd();
                audio?.setHyper(false);
            }],
            [EVENTS.WAVE_START, (e) => {
                screens?.banner(`WAVE ${e.wave}`, e.bossPending ? 'WARDEN INCOMING' : (e.name || ''), 'wave');
                audio?.sfx.waveStart(e.wave);
                arena?.ripple(0, 0, 0.6);
            }],
            [EVENTS.WAVE_END, () => {
                audio?.sfx.uiConfirm();
            }],
            [EVENTS.BOSS_START, () => {
                audio?.sfx.bossStart();
                screens?.banner('WARDEN', 'Boss wave', 'boss');
                shakeScreen(1.4, 0.8);
            }],
            [EVENTS.BOSS_DEFEATED, () => {
                audio?.sfx.explosion();
                screens?.banner('WARDEN DOWN', '+1500', 'boss');
            }],
            [EVENTS.POWERUP_SPAWN, () => audio?.sfx.hazardBeep()],
            [EVENTS.POWERUP_PICKUP, (e) => {
                audio?.sfx.powerup();
                screens?.toast(`${e.name}`, e.type);
                hud?.toast(e.name, e.type);
            }],
            [EVENTS.HAZARD_SPAWN, () => audio?.sfx.hazardBeep()],
            [EVENTS.HAZARD_DETONATED, (e) => {
                impactFx(e.x, e.y, 1.5, 0xff2fd0, { particles: 40, speed: 10, debris: 10 });
                shakeScreen(0.9, 0.4);
                audio?.sfx.explosion();
            }],
        ];

        for (const [type, handler] of wired) bus.on(type, handler);

        bus.on(EVENTS.SHOT_FIRED, (e) => {
            audio?.sfx.shoot();
            for (const ray of e.rays || []) {
                tracers?.add(e.origin.x, e.origin.y, ray.endX, ray.endY,
                    e.source === 'drone' ? 0x8cff9e : (e.hyper ? 0xff8cf0 : 0x9fe8ff),
                    e.hyper ? 1.5 : (e.weapon === 'lance' ? 1.8 : 1));
            }
            particles?.spray({
                x: e.origin.x, y: e.origin.y, z: ARENA.planeZ + 0.3,
                count: 3, vx: (e.aim.x - e.origin.x) * 0.6, vy: (e.aim.y - e.origin.y) * 0.6,
                spread: 0.6, life: 0.22, size: 0.2
            });
            recoil.z = Math.min(0.45, recoil.z + 0.09);
        });

        bus.on(EVENTS.SHOT_MISS, (e) => {
            impactFx(e.aim.x, e.aim.y, 0.25, 0x88aaff, { particles: 5, speed: 3, life: 0.3, ripple: false, size: 0.18 });
        });

        bus.on('CHAIN_ARC', (e) => {
            tracers?.add(e.fromX, e.fromY, e.toX, e.toY, 0xfff36b, 0.7);
            particles?.spray({
                x: (e.fromX + e.toX) / 2, y: (e.fromY + e.toY) / 2, z: ARENA.planeZ + 0.3,
                count: 5, spread: 3, life: 0.25, size: 0.2, color: 0xfff36b
            });
        });

        bus.on('NUKE_PULSE', (e) => {
            const uv = worldToUv(e.x, e.y);
            postfx?.impact(uv.u, uv.v, 2.4);
            postfx?.setFlash(settings.reducedFlash ? 0.15 : 0.35);
            particles?.burst({ x: e.x, y: e.y, z: ARENA.planeZ + 0.4, count: 220, color: 0xffd0f0, speed: 22, life: 1.1, size: 0.6, up: 1.5 });
            debris?.burst({ x: e.x, y: e.y, count: 40, color: 0xff8adf, spread: 16 });
            arena?.ripple(e.x, 0, 1.4);
            shakeScreen(1.8, 0.7);
            audio?.sfx.explosion();
        });

        bus.on(EVENTS.SCORE_POPUP, (e) => {
            if (!e.value) return;
            hud?.popup(worldToScreen({ x: e.x, y: e.y, z: ARENA.planeZ + 0.5 }, camState, {
                left: 0, top: 0, width: viewport.width, height: viewport.height
            }), `+${e.value}`, e.crit ? 'crit' : (e.boss ? 'boss' : (e.elite ? 'elite' : (e.hazard ? 'hazard' : 'normal'))));
        });

        bus.on('QUALITY_CHANGED', (e) => {
            hud?.setQuality(`${e.to}${e.reason?.startsWith('manual') ? ' (manual)' : ''}`);
            if (debug.enabled) screens?.toast(`Quality ${e.from} -> ${e.to}`, 'quality');
        });

    }

    /* ---------------------------------------------------------------- runs --- */

    function startDemo(reason = 'standard-run') {
        state.set(STATES.DEMO);
        audio?.init();
        startRun({ mode: RUN_MODES.STANDARD, demo: true, reason });
    }

    function buildRunConfig(options = {}) {
        const mode = options.mode || RUN_MODES.STANDARD;
        const isDaily = mode === RUN_MODES.DAILY;
        const daily = isDaily ? dailyConfig() : null;

        let seed = options.seed ?? debug.seed;
        if (seed === null || seed === undefined) {
            if (isDaily) seed = daily.seed;
            else seed = (Math.floor(Math.random() * 0xffffffff)) >>> 0;
        }

        const coreBase = 3;
        const mods = {
            damage: 1,
            rof: 1,
            projectiles: 0,
            crit: 0,
            hitRadius: 1,
            dropRate: 0,
            hyperRate: 1,
            coreMax: 0,
            shieldEvery: 0
        };
        progression.modifiersFromTracks(mods);
        const weapon = options.weaponId || storage.get('weapon', 'pulse');
        if (!WEAPON_IDS.includes(weapon)) return buildRunConfig({ ...options, weaponId: 'pulse' });
        mods.damage *= 1 + progression.weaponDamageBonus(weapon);

        return {
            mode,
            seed,
            daily,
            rules: isDaily ? daily.rules : undefined,
            weaponId: weapon,
            core: coreBase + (mods.coreMax || 0),
            mods,
            aimAssist: settings.aimAssist,
            practice: !!options.practice,
            demo: !!options.demo
        };
    }

    function startRun(options = {}) {
        const config = buildRunConfig(options);
        const practice = !!config.practice || (debug.enabled && debug.practice);

        if (run) {
            // A fresh run reuses the same managers: pooled objects are released,
            // never reallocated.
            enemies.clear();
            hazards.clear();
            powerups.clear();
            hash.clear();
            particles.reset();
            debris.reset();
        }

        run = createRun({
            bus,
            hash,
            enemies,
            hazards,
            powerups,
            seed: config.seed,
            mode: config.mode,
            rules: config.rules,
            weaponId: config.weaponId,
            core: config.core,
            mods: config.mods,
            aimAssist: config.aimAssist,
            practice,
            tickHz: clock.hz,
            limits: {
                maxActiveEnemies: quality.config().maxActiveEnemies,
                hazardCap: quality.config().hazardCap
            },
            debug: {
                infiniteLives: !!debug.infinite,
                freeze: false
            },
            daily: config.daily
        });

        arena?.setSkin(progression.skin);
        run.start(0);
        audio?.setMuted(false);
        audio?.setHyper(false);
        hyperVisual = 0;
        damageVisual = 0;
        stepErrors = 0;
        clock.reset();
        runStartTick = clock.ticks;

        if (debug.record || (debug.enabled && options.record)) {
            recorder = new Recorder({ max: 20000 });
            recorder.start({
                seed: config.seed,
                mode: config.mode,
                profile: platform,
                weapon: config.weaponId,
                rules: config.rules?.id || 'standard',
                dateKey: config.daily?.dateKey || null,
                tick: 0
            });
        } else {
            recorder = null;
        }

        hud?.reset();
        hud?.setRunActive(true);
        screens?.showScreen('game');
        screens?.hideDraft();
        state.set(STATES.PLAYING);
        hud?.setSeed(config.seed, config.mode, config.daily);
        hud?.setWeapon(config.weaponId);
        screens?.setRunMode(config.mode, config.daily);

        return run;
    }

    function restartRun() {
        startRun({ mode: run?.mode || RUN_MODES.STANDARD, seed: run?.seed });
    }

    function finishRun(stats) {
        hud?.setRunActive(false);
        const summaries = progression.recordRun(stats, { practice: stats.practice });

        let streakResult = null;
        if (stats.mode === RUN_MODES.DAILY && !stats.practice) {
            const todayKey = utcDateKey(new Date());
            streakResult = streak.completeRun(todayKey, stats.score);
            bus.emit(EVENTS.STREAK_UPDATED, { tick: stats.tick, ...streakResult });
        }

        const nearUnlocks = progression.nearUnlocks(3);
        screens?.showResults({
            stats,
            progression: summaries,
            streak: streakResult,
            streakState: streak.stats(),
            nearUnlocks,
            daily: run?.mode === RUN_MODES.DAILY ? dailyConfig() : null
        });

        state.set(STATES.RESULTS);
        audio?.sfx.gameOver();
        audio?.setHyper(false);
        screens?.hideDraft();
    }

    /* ------------------------------------------------------------- drafts ---- */

    function handleDraftOffer(offer) {
        state.set(STATES.DRAFT);
        screens?.showDraft(offer, (index) => {
            const outcome = run?.pickDraft(index);
            if (outcome?.ok) audio?.sfx.uiConfirm();
            screens?.hideDraft();
            state.set(STATES.PLAYING);
        });
    }

    /* --------------------------------------------------------------- pause --- */

    function pause(reason = 'manual') {
        if (!run || run.finished) return false;
        if (state.is(STATES.PAUSED)) return false;
        input?.cancelFire();
        run.setFireHeld(false);
        clock.reset();
        state.set(STATES.PAUSED);
        screens?.showScreen('pause', { reason });
        return true;
    }

    function resume() {
        if (!state.is(STATES.PAUSED)) return false;
        clock.reset();
        state.set(STATES.PLAYING);
        screens?.showScreen('game');
        return true;
    }

    function togglePause() {
        if (state.is(STATES.PAUSED)) return resume();
        if (state.is(STATES.PLAYING)) return pause('manual');
        if (state.is(STATES.DRAFT)) return false;
        return false;
    }

    function returnToMenu() {
        if (run) {
            run.setFireHeld(false);
            run.endRun('abandoned');
            run = null;
        }
        enemies?.clear();
        hazards?.clear();
        powerups?.clear();
        hash?.clear();
        particles?.reset();
        debris?.reset();

        audio?.setHyper(false);
        hud?.setRunActive(false);
        screens?.hideDraft();
        state.set(STATES.MENU);
        screens?.showScreen('menu');
        screens?.refreshMenu(progression, streak, dailyConfig());
        return true;
    }

    /* ---------------------------------------------------------------- loop --- */

    /**
     * A thrown simulation error must never stall the fixed step: the clock would
     * keep re-running the same tick, freezing the wave forever (which is exactly
     * what a bad payload in a kill event used to do). Count, report, and if it
     * keeps happening, end the run rather than loop on a broken tick.
     */
    function handleSimulationError(err, tick) {
        stepErrors += 1;
        console.error(`[engine] simulation error at tick ${tick}:`, err);
        bus.emit('RUNTIME_ERROR', {
            tick,
            message: String(err?.message || err),
            where: 'step',
            count: stepErrors
        });
        if (stepErrors > 30 && run && !run.finished) {
            run.endRun('error', tick);
        }
    }

    function step(dt, tick) {
        if (!run || run.finished) return;
        try {
            stepInner(dt, tick);
        } catch (err) {
            handleSimulationError(err, tick);
        }
    }

    function stepInner(dt, tick) {
        if (state.is(STATES.PLAYING)) {
            run.setFireHeld(input?.fireHeld || false, input?.pointerType);

            // Replay mode feeds recorded actions instead of live input.
            if (replayer) {
                const due = replayer.poll(tick);
                for (const event of due) {
                    if (event.k === RECORD_EVENT.INPUT) {
                        run.setAim(event.d.x, event.d.y);
                        run.setFireHeld(true, event.d.pointer);
                    } else if (event.k === RECORD_EVENT.INPUT_RELEASE) {
                        run.setFireHeld(false, event.d.pointer);
                    } else if (event.k === RECORD_EVENT.DRAFT_PICK) {
                        run.pickDraft(event.d.index);
                    }
                }
                const verification = replayer.verify(tick, run.checksum());
                if (verification.checked && !verification.match) {
                    screens?.toast(`Replay diverged at tick ${tick}`, 'quality');
                }
                if (replayer.done && !run.finished) {
                    run.endRun('replay-complete', tick);
                }
            }

            const before = run.drafting;
            run.tick(dt);
            if (!before && run.drafting) handleDraftOffer(run.draftOffer);

            if (recorder?.recording) {
                recorder.event(tick, 'aim', {
                    x: Math.round(run.state.aim.x * 100) / 100,
                    y: Math.round(run.state.aim.y * 100) / 100,
                    fire: input?.fireHeld || false
                });
                if (tick % 600 === 0) recorder.checksum(tick, run.checksum());
            }
        } else if (state.is(STATES.DRAFT)) {
            // Drafting still steps the world, at a crawl, so the arena stays alive.
            run.tick(dt);
        }
    }

    function evaluateFrame(frameTimeMs, dt) {
        const changed = quality.sample(frameTimeMs, dt);
        if (changed) quality.apply(qualityCtx);
    }

    function renderFrame(alpha) {
        if (!renderer || !run) return;

        enemies.syncVisuals(alpha);
        powerups.syncVisuals(alpha);
        hazards.syncVisuals();
        arena.update(1 / 60, {
            hyper: run.hyper.active,
            integrity: run.coreMax > 0 ? run.core / run.coreMax : 0
        });

        // Screen shake and recoil on the rig.
        shake.elapsed += 1 / 60;
        let shakeX = 0;
        let shakeY = 0;
        if (shake.intensity > 0) {
            const progress = shake.elapsed / shake.duration;
            if (progress >= 1) {
                shake.intensity = 0;
            } else {
                const decay = 1 - progress;
                shakeX = (Math.random() - 0.5) * 2 * shake.intensity * decay * 0.35;
                shakeY = (Math.random() - 0.5) * 2 * shake.intensity * decay * 0.25;
            }
        }
        recoil.z = damp(recoil.z, 0, CAMERA_RIG.recoilRecovery, 1 / 60);

        camera3d.position.set(
            camState.position.x + shakeX,
            camState.position.y + shakeY,
            camState.position.z + recoil.z
        );

        hyperVisual = damp(hyperVisual, run.hyper.active ? 1 : 0, 5, 1 / 60);
        postfx.setHyper(hyperVisual);
        if (damageVisual > 0) damageVisual = Math.max(0, damageVisual - (1 / 60) * 1.8);
        postfx.setDamage(damageVisual);

        audio?.setIntensity(Math.min(1,
            (run.wave / 14) * 0.5
            + Math.min(1, run.combo / 40) * 0.3
            + (run.hyper.active ? 0.35 : 0)
            + (run.coreMax > 0 ? (1 - run.core / run.coreMax) * 0.3 : 0)
        ));

        postfx.render();
    }

    function frame(timestamp) {
        if (disposed) return;
        rafId = requestAnimationFrame(frame);

        const frameTimeMs = lastFrameTime > 0 ? Math.min(250, timestamp - lastFrameTime) : 16.7;
        lastFrameTime = timestamp;
        const dt = frameTimeMs / 1000;

        evaluateFrame(frameTimeMs, dt);

        if (state.isSimulating && run && !run.finished) {
            clock.advance(dt, step);
        } else {
            clock.reset();
        }

        particles?.update(dt);
        debris?.update(dt);
        tracers?.update(dt);
        postfx?.update(dt);
        audio?.update(dt);
        screens?.update(dt);
        deps.debugPanel?.update(dt);
        refreshScope();
        hud?.setScope(scope);
        hud?.update(dt, {
            run,
            quality: quality.stats(),
            clock: clock.stats(),
            pools: poolSnapshot()
        });

        renderFrame(clock.alpha);

        if (run?.finished && state.is(STATES.PLAYING)) {
            const stats = run.runStats(run.state.finishReason || 'stopped');
            finishRun(stats);
        }
    }

    function poolSnapshot() {
        return {
            enemies: enemies?.poolStats(),
            hazards: hazards?.poolStats(),
            powerups: powerups?.poolStats(),
            particles: particles?.stats(),
            debris: debris?.stats(),
            tracers: { active: tracers?.activeCount ?? 0 }
        };
    }

    /* ------------------------------------------------------------ input glue -- */

    function pointerToWorld(clientX, clientY) {
        return screenToWorld(clientX, clientY, {
            left: 0, top: 0, width: viewport.width, height: viewport.height
        }, camState, ARENA.planeZ);
    }

    function handleAim(clientX, clientY) {
        const point = pointerToWorld(clientX, clientY);
        if (!point.hit) return;
        run?.setAim(point.x, point.y);
        arena?.setPointerAim((clientX / viewport.width) * 2 - 1, -((clientY / viewport.height) * 2 - 1));
        refreshScope();
    }

    /* ---------------------------------------------------------------- scope -- */

    const screenRect = () => ({ left: 0, top: 0, width: viewport.width, height: viewport.height });

    /**
     * Pixel radius of a world-space radius at the aim point.
     *
     * The reticle ring is drawn at the *real* hit radius, so this has to measure
     * the projection instead of assuming a constant pixels-per-unit: the arena is
     * a plane in perspective, and a fixed scale would make the ring lie at the
     * screen edges (which is exactly when the player needs it to be honest).
     */
    function ringPixelRadius(aim, worldRadius) {
        const rect = screenRect();
        const center = worldToScreen({ x: aim.x, y: aim.y, z: ARENA.planeZ }, camState, rect);
        const alongX = worldToScreen({ x: aim.x + worldRadius, y: aim.y, z: ARENA.planeZ }, camState, rect);
        const alongY = worldToScreen({ x: aim.x, y: aim.y + worldRadius, z: ARENA.planeZ }, camState, rect);
        if (!center || !alongX || !alongY) return 0;
        return Math.max(3, (Math.abs(alongX.x - center.x) + Math.abs(alongY.y - center.y)) / 2);
    }

    /**
     * Refresh the aim readout.
     *
     * Uses the run's own effective weapon and the enemies manager's own ownership
     * predicate, through the same hit-plane maths Weapons.js resolves shots with,
     * so the readout cannot drift from what a shot actually does.
     */
    function refreshScope() {
        if (!run || !hash || run.finished || !state.isSimulating) {
            scope = null;
            return null;
        }
        const weapon = run.effectiveWeapon();
        const aim = run.state.aim;
        const next = readScope({ hash, aim, weapon, predicate: (view) => enemies.isEnemy(view) });
        const screen = worldToScreen({ x: aim.x, y: aim.y, z: ARENA.planeZ }, camState, screenRect());
        next.screen = screen ? { x: screen.x, y: screen.y } : null;
        next.ringPx = ringPixelRadius(aim, next.hitRadius);
        next.shots = shotsToKill(next.target, weapon);
        next.hit = next.state === SCOPE_STATE.LOCKED;
        scope = next;
        return scope;
    }

    function handleFire(down) {
        audio?.init();
        run?.setFireHeld(down, input?.pointerType);
        if (recorder?.recording && down) {
            recorder.input(clock.ticks, { x: run?.state.aim.x ?? 0, y: run?.state.aim.y ?? 0, fire: true, pointer: input?.pointerType });
        }
    }

    /* --------------------------------------------------------------- boot ---- */

    function bindLifecycle() {
        return createLifecycle({
            handlers: {
                onSuspend: () => {
                    input?.cancelFire();
                    if (state.is(STATES.PLAYING)) pause('lifecycle');
                    audio?.suspend();
                },
                onRestore: () => {
                    audio?.resumeAudio();
                    // Never resume a live combat session automatically: show pause.
                    // A run that has barely started has nothing to lose, and pausing
                    // it here would trap the player on a pause screen at boot.
                    if (state.is(STATES.PLAYING) && clock.ticks - runStartTick > 30) {
                        pause('lifecycle-return');
                    }
                },
                onResize: () => resize(),
                onOrientation: () => resize()
            }
        });
    }

    engine = {
        bus,
        quality,
        state,
        settings,
        progression,
        streak,
        debug,
        get audio() { return audio; },
        get input() { return input; },
        get hud() { return hud; },
        // Used by the input layer and the debug panel for on-screen feedback
        // ("Audio muted", "Quality LOW", ...), so it has to be reachable.
        get screens() { return screens; },        get run() { return run; },
        /** Live aim readout: what is under the crosshair and whether a shot hits. */
        get scope() { return scope; },
        get tickCount() { return clock.ticks; },
        get platform() { return platform; },
        get scene() { return scene; },
        get camera3d() { return camera3d; },
        get camState() { return camState; },
        get viewport() { return viewport; },
        get postfx() { return postfx; },
        get managers() { return { enemies, hazards, powerups, particles, debris, tracers, hash }; },

        boot() {
            initThree();
            bindGameplayEvents();
            resize();
            if (quality.manual !== 'AUTO') quality.apply(qualityCtx);
            quality.apply(qualityCtx);
            postfx.setReducedMotion(settings.reducedMotion);
            this.lifecycle = bindLifecycle().attach();

            audio?.setMusicVolume(settings.musicVolume / 100);
            audio?.setSfxVolume(settings.sfxVolume / 100);

            hud?.bind(engine);
            screens?.bind(engine);
            input?.bind(engine);
            // Builds and reveals the practice/debug panel when ?debug=1 is set.
            deps.debugPanel?.bind?.(engine);

            running = true;
            rafId = requestAnimationFrame(frame);

            screens?.showScreen('menu');
            screens?.refreshMenu(progression, streak, dailyConfig());
            state.set(STATES.MENU);

            if (debug.replay) {
                try {
                    const record = Recorder.parse(decodeURIComponent(debug.replay));
                    replayer = new Replayer(record);
                    startRun({ mode: record.meta?.mode || RUN_MODES.STANDARD, seed: record.meta?.seed });
                } catch (err) {
                    console.error('[engine] replay parse failed:', err);
                }
            } else if (debug.demo) {
                // ?demo=1 drops straight into a run, which is how the game is
                // verified (and screenshotted) without touching the menu.
                startDemo('url');
            }

            bus.emit('ENGINE_READY', { tick: 0, platform, quality: quality.name });
            return engine;
        },

        // Run + screen control used by the UI layer.
        play: () => startDemo('menu'),
        demo: () => startDemo('menu'),
        startRun,
        restartRun,
        finishRun,
        pause,
        resume,
        togglePause,
        returnToMenu,
        pickDraft: (index) => run?.pickDraft(index),
        handleAim,
        handleFire,
        pointerToWorld,

        setWeapon(weaponId) {
            const id = WEAPON_IDS.includes(weaponId) ? weaponId : 'pulse';
            storage.set('weapon', id);
            bus.emit('WEAPON_SELECTED', { weapon: id });
            return id;
        },

        setSkin(skinId) {
            if (!progression.setSkin(skinId)) return false;
            arena?.setSkin(progression.skin);
            bus.emit('SKIN_SELECTED', { skin: skinId });
            return true;
        },

        setQualityManual(choice) {
            settings.qualityManual = choice;
            storage.set('setQuality', choice);
            quality.setManual(choice, qualityCtx);
            return quality.name;
        },
        setSetting(key, value) {
            settings[key] = value;
            if (key === 'musicVolume') audio?.setMusicVolume(value / 100);
            if (key === 'sfxVolume') audio?.setSfxVolume(value / 100);
            if (key === 'reducedMotion') {
                postfx?.setReducedMotion(value);
                quality.apply(qualityCtx);
            }
            storage.set(`set${key.charAt(0).toUpperCase()}${key.slice(1)}`, value);
            return value;
        },
        debugApi() {
            return {
                seed: () => run?.seed ?? null,
                stats: () => ({
                    run: run?.debugSnapshot() ?? null,
                    quality: quality.stats(),
                    clock: clock.stats(),
                    pools: poolSnapshot(),
                    audio: audio?.stats(),
                    arena: arena?.stats(),
                    postfx: postfx?.stats(),
                    hash: hash?.efficiency(),
                    lifecycle: engine.lifecycle?.stats(),
                    scope: scope
                        ? {
                            state: scope.state,
                            ringPx: Math.round(scope.ringPx),
                            hitRadius: scope.hitRadius,
                            weapon: scope.weapon?.id ?? null,
                            shots: scope.shots,
                            target: scope.target
                                ? {
                                    name: scope.target.name,
                                    archetype: scope.target.archetype,
                                    hp: scope.target.hp,
                                    maxHp: scope.target.maxHp,
                                    distance: Math.round(scope.target.distance * 100) / 100,
                                    reach: scope.target.reach,
                                    inside: scope.target.inside,
                                    assist: scope.target.assist,
                                    hittable: scope.target.hittable
                                }
                                : null
                        }
                        : null,
                    events: bus.toJSON()
                }),
                setQuality: (name) => engine.setQualityManual(name),
                freezeWorld: (value) => run?.setDebugFreeze(value),
                infiniteLives: (value) => run?.setDebug({ unlimitedCore: !!value }),
                setDamage: (value) => run?.setDebug({ debugDamageMul: value }),
                setFireRate: (value) => run?.setDebug({ debugFireRateMul: value }),
                jumpToWave: (wave) => run?.director.jumpTo(wave, {
                    onSpawn: (envelope) => !!enemies.spawn(envelope, { tick: clock.ticks, telegraphSeconds: 0.2 }),
                    onHazard: () => true,
                    onWaveStart: () => {},
                    onWaveEnd: () => {}
                }),
                spawn: (archetypeId, elite = false) => run?.director.forceSpawn({
                    onSpawn: (envelope) => !!enemies.spawn(envelope, { tick: clock.ticks, telegraphSeconds: 0 }),
                    onHazard: () => true
                }, archetypeId, elite),
                spawnBoss: () => run?.director.forceBoss({}),
                grantUpgrade: (id) => {
                    const card = run?.upgrades ? null : null;
                    void card;
                    return null;
                },
                grantPowerup: (type) => {
                    const view = powerups.spawn({ type, x: ARENA.core.x, y: ARENA.core.y + 2 }, { tick: clock.ticks });
                    if (!view) return false;
                    return !!run?.collectPowerup(view, clock.ticks);
                },
                killAll: () => run?.detonate(ARENA.core.x, ARENA.core.y, 60, 99, 'debug'),
                exportRecord: () => recorder?.export() ?? null,
                recorder: () => recorder?.stats() ?? null,
                replay: (json) => {
                    replayer = new Replayer(json);
                    startRun({ mode: replayer.mode, seed: replayer.seed });
                },
                events: () => bus.history(),
                exportProfile: () => storage.exportData(),
                importProfile: (payload) => storage.importData(payload)
            };
        },

        poolSnapshot,
        applyRendererSize,
        resize,

        shutdown() {
            disposed = true;
            if (rafId) cancelAnimationFrame(rafId);
            this.lifecycle?.detach();
            input?.unbind();
            enemies?.dispose();
            hazards?.dispose();
            powerups?.dispose();
            particles?.dispose();
            debris?.dispose();
            tracers?.dispose();
            postfx?.dispose();
            arena?.dispose();
            renderer?.dispose?.();
            run = null;
            bus.emit('ENGINE_SHUTDOWN', { tick: clock.ticks });
        }
    };

    // Keep the engine's own STATE constants discoverable by the UI layer.
    engine.STATES = STATES;
    engine.EVENTS = EVENTS;
    engine.util = { msUntilNextUtcMidnight, dailySeedForKey, utcDateKey };
    return engine;
}

export { STATES, EVENTS, ARENA_SPEC };
