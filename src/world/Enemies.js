/**
 * Enemy manager.
 *
 * One pool covers every enemy *and* every spawn telegraph: a view is acquired
 * when the director calls for a spawn, spends `telegraphSeconds` scaling up as a
 * visible warning, then joins the spatial hash and starts closing on the core.
 * Pooling both roles together is what keeps "spawn telegraph" free of extra
 * allocations.
 *
 * Each view owns its material (created once) so hit flashes and elite tints are
 * per-enemy uniforms rather than material swaps. Simulation fields live as plain
 * numbers on the view; `syncVisuals(alpha)` writes interpolated transforms at
 * render time, which is how a 60 Hz simulation looks smooth on any display.
 */

import * as THREE from 'three';
import { Pool } from '../core/Pool.js';
import { ARCHETYPES, ELITE } from './archetypes.js';
import { ARENA } from './ArenaSpec.js';
import { damp } from '../util/Math.js';

/**
 * How long a destroyed enemy lingers as a shrinking corpse before its pooled
 * view is recycled. Purely cosmetic: the moment it dies it leaves the hash, so
 * it cannot absorb shots or reach the core.
 */
const DEATH_FADE_SECONDS = 0.24;

/**
 * Locators: enemies float at various heights over a dark hologrid, so every
 * view also owns a glowing ring on the floor directly beneath it (the primary
 * "where do I shoot" cue) and a light pillar that burns during the spawn
 * telegraph ("something is arriving HERE"). Both are separate meshes in the
 * active group - never children of the body - because the body bobs and spins,
 * while the ring has to stay flat on the floor and the pillar upright.
 */

const ENEMY_VERTEX = /* glsl */`
    varying vec3 vNormal;
    varying vec3 vViewDir;
    varying float vRim;

    void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDir = -mvPosition.xyz;
        vRim = 1.0;
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const ENEMY_FRAGMENT = /* glsl */`
    uniform vec3 uColor;
    uniform vec3 uGlow;
    uniform float uFlash;
    uniform float uTime;
    uniform float uHyper;
    uniform float uElite;
    uniform float uHpFrac;
    uniform float uTelegraph;   // 1 while materialising

    varying vec3 vNormal;
    varying vec3 vViewDir;

    void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewDir);
        float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 1.8);

        float pulse = 0.5 + 0.5 * sin(uTime * 4.0 + normal.x * 3.0);
        float angry = 0.5 + 0.5 * sin(uTime * 9.0) * uElite;

        // Base mix is hotter than a flat dark body: the goal is that a glance
        // finds every enemy against the hologrid without washing out silhouette.
        vec3 color = mix(uColor * 0.85, uGlow, 0.45 + pulse * 0.35);
        color += uGlow * fresnel * (1.15 + uElite * 0.8 + angry * 0.5);
        color += vec3(1.0, 0.95, 0.85) * uFlash;

        // Damaged enemies glow hotter and read as "about to pop".
        color += uGlow * (1.0 - uHpFrac) * 0.7;

        // Hyper Mode pushes the whole palette hot.
        color = mix(color, color * vec3(1.25, 0.9, 1.3) + uGlow * 0.25, uHyper * 0.7);

        // Spawn telegraph: dim while forming, snap to full on arrival.
        color *= mix(0.35, 1.0, uTelegraph);

        float alpha = mix(0.55, 0.95, uTelegraph) + fresnel * 0.2;
        gl_FragColor = vec4(color, alpha);
    }
`;

const GEOMETRY_BUILDERS = {
    icosa: () => new THREE.IcosahedronGeometry(1, 0),
    tetra: () => new THREE.TetrahedronGeometry(1, 0),
    box: () => new THREE.BoxGeometry(1.5, 1.5, 1.5),
    dodeca: () => new THREE.DodecahedronGeometry(1, 0),
    octa: () => new THREE.OctahedronGeometry(1, 0)
};

export function createEnemyManager(options = {}) {
    const scene = options.scene;
    const hash = options.hash;
    const bus = options.bus;
    const rng = options.rng;
    const maxViews = options.maxViews ?? 80;
    let maxActive = options.maxActive ?? 60;

    /* ------------------------------------------------------------ geometry -- */

    const geometries = {};
    for (const [key, build] of Object.entries(GEOMETRY_BUILDERS)) {
        geometries[key] = build();
    }
    geometries.ring = new THREE.TorusGeometry(1, 0.04, 6, 40);
    geometries.marker = new THREE.TorusGeometry(1, 0.085, 6, 40);
    geometries.pillar = new THREE.CylinderGeometry(0.05, 0.09, 1, 6, 1, true);

    const shellGeometry = new THREE.IcosahedronGeometry(1.22, 0);
    const bossRingMaterial = new THREE.MeshBasicMaterial({
        color: 0xd9a6ff,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const activeGroup = new THREE.Group();
    activeGroup.name = 'enemies';
    scene?.add(activeGroup);

    let nextId = 1;

    function createView() {
        const material = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0xff4d3d) },
                uGlow: { value: new THREE.Color(0xff2b1c) },
                uFlash: { value: 0 },
                uTime: { value: 0 },
                uHyper: { value: 0 },
                uElite: { value: 0 },
                uHpFrac: { value: 1 },
                uTelegraph: { value: 1 }
            },
            vertexShader: ENEMY_VERTEX,
            fragmentShader: ENEMY_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        const mesh = new THREE.Mesh(geometries.icosa, material);
        mesh.visible = false;
        mesh.renderOrder = 12;

        const shellMaterial = new THREE.MeshBasicMaterial({
            color: 0xffd166,
            wireframe: true,
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const shell = new THREE.Mesh(shellGeometry, shellMaterial);
        shell.visible = false;
        shell.renderOrder = 13;
        mesh.add(shell);

        const bossRing = new THREE.Mesh(geometries.ring, bossRingMaterial);
        bossRing.visible = false;
        bossRing.renderOrder = 13;
        mesh.add(bossRing);

        // Floor locator ring, under the enemy. Thicker than a hairline torus so
        // it stays readable at spawn distance (~18 units from the camera).
        const markerMaterial = new THREE.MeshBasicMaterial({
            color: 0xff4d3d,
            transparent: true,
            opacity: 0.55,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const marker = new THREE.Mesh(geometries.marker, markerMaterial);
        marker.rotation.x = Math.PI / 2;
        marker.visible = false;
        marker.renderOrder = 4;

        // Telegraph light pillar, floor to sky at the spawn point.
        const pillarMaterial = new THREE.MeshBasicMaterial({
            color: 0xffd9a0,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        const pillar = new THREE.Mesh(geometries.pillar, pillarMaterial);
        pillar.visible = false;
        pillar.renderOrder = 4;

        const view = {
            id: nextId++,
            mesh,
            shell,
            shellMaterial,
            bossRing,
            marker,
            markerMaterial,
            pillar,
            pillarMaterial,
            uniforms: material.uniforms,
            material,

            // simulation fields
            active: false,
            alive: false,
            archetype: ARCHETYPES.basic,
            archetypeId: 'basic',
            elite: false,
            boss: false,
            hp: 1,
            maxHp: 1,
            speed: 1.5,
            radius: 0.6,
            score: 100,
            hitRadius: 0.6,
            x: 0, y: 0, z: 0,
            prevX: 0, prevY: 0,
            vx: 0, vy: 0,
            speedMul: 1,
            scoreMul: 1,
            flash: 0,
            rotation: 0,
            rotationSpeed: 0.4,
            phase: 0,
            bob: 0,
            telegraph: 0,
            telegraphTotal: 0.45,
            spawnTick: 0,
            deathTimer: 0,

            activate(envelope, ctx = {}) {
                this.active = true;
                this.alive = false;
                this.deathTimer = 0;
                this.archetype = envelope.archetype;
                this.archetypeId = envelope.archetype.id;
                this.elite = !!envelope.elite;
                this.boss = !!envelope.archetype.boss || !!envelope.boss;
                this.telegraph = ctx.telegraphSeconds ?? 0.45;

                const elite = this.elite ? ELITE : { hpMul: 1, speedMul: 1, radiusMul: 1, scoreMul: 1, costMul: 1, dropChanceMul: 1 };
                this.hp = Math.max(1, Math.round(envelope.archetype.hp * elite.hpMul));
                this.maxHp = this.hp;
                this.speed = envelope.archetype.speed * (envelope.speedMul || 1) * elite.speedMul;
                this.radius = envelope.archetype.radius * elite.radiusMul;
                this.score = Math.round(envelope.archetype.score * (envelope.scoreMul || 1) * elite.scoreMul);
                this.hitRadius = this.radius;

                this.x = envelope.x;
                this.y = envelope.y;
                this.z = ARENA.planeZ;
                this.prevX = this.x;
                this.prevY = this.y;
                this.vx = 0;
                this.vy = 0;
                this.flash = 0;
                this.rotation = rng ? rng.range(0, Math.PI * 2) : 0;
                this.rotationSpeed = 0.25 + (rng ? rng.range(0, 0.5) : 0.2);
                this.phase = rng ? rng.range(0, Math.PI * 2) : 0;
                this.spawnTick = ctx.tick || 0;

                this.mesh.geometry = geometries[envelope.archetype.shape] || geometries.icosa;
                this.mesh.visible = true;
                this.mesh.scale.setScalar(this.radius * 0.2);

                this.uniforms.uColor.value.set(envelope.archetype.color);
                this.uniforms.uGlow.value.set(envelope.archetype.glow);
                this.uniforms.uElite.value = this.elite ? 1 : 0;
                this.uniforms.uHpFrac.value = 1;
                this.uniforms.uFlash.value = 0;
                this.uniforms.uTelegraph.value = this.telegraph > 0 ? 0 : 1;

                this.shell.visible = this.elite;
                this.shell.scale.setScalar(1);
                this.bossRing.visible = this.boss;
                if (this.boss) {
                    this.bossRing.scale.setScalar(this.radius * 1.6);
                    this.bossRing.rotation.x = Math.PI / 2.4;
                }

                // Locators: the marker carries the archetype colour so a Skitter's
                // ring reads differently from a Bulwark's; the pillar is hot amber
                // for as long as the telegraph runs. Both are positioned now, not
                // on the first tick, so nothing flashes at the world origin.
                // Elites and bosses get a wider ring so threat is readable from
                // the floor alone, without finding the body in a crowd.
                this.markerMaterial.color.set(envelope.archetype.glow);
                this.marker.visible = true;
                this.marker.scale.setScalar(this.radius * (this.boss ? 2.4 : this.elite ? 1.9 : 1.55));
                this.marker.position.set(this.x, 0.02, ARENA.planeZ);
                this.pillarMaterial.color.set(0xffd9a0);
                this.pillarMaterial.opacity = this.telegraph > 0 ? 0.85 : 0;
                this.pillar.visible = this.telegraph > 0;
                this.pillar.scale.set(1, Math.max(0.5, ARENA.enemyHoverY + 6), 1);
                this.pillar.position.set(this.x, (ARENA.enemyHoverY + 6) / 2, ARENA.planeZ);

                activeGroup.add(this.mesh);
                activeGroup.add(this.marker);
                activeGroup.add(this.pillar);
                return this;
            },

            deactivate() {
                this.active = false;
                this.alive = false;
                this.mesh.visible = false;
                this.mesh.scale.setScalar(0.0001);
                this.shell.visible = false;
                this.bossRing.visible = false;
                this.marker.visible = false;
                this.pillar.visible = false;
                if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
                if (this.marker.parent) this.marker.parent.remove(this.marker);
                if (this.pillar.parent) this.pillar.parent.remove(this.pillar);
                hash?.remove(this);
            },

            dispose() {
                this.material.dispose();
                this.shellMaterial.dispose();
                this.markerMaterial.dispose();
                this.pillarMaterial.dispose();
            },

            /** Damageable only once the telegraph has completed. */
            get damageable() {
                return this.active && this.alive;
            },

            get hpFrac() {
                return this.maxHp > 0 ? Math.max(0, this.hp / this.maxHp) : 0;
            }
        };

        return view;
    }

    const pool = new Pool({
        name: 'enemies',
        create: createView,
        maxSize: maxViews,
        prewarm: Math.min(maxViews, 24),
        onAcquire: () => { stats.acquired += 1; },
        onRelease: () => { /* view.deactivate already detached everything */ }
    });

    /**
     * The spatial hash is shared by enemies, hazards and powerup pods, so every
     * query that means "enemies" has to prove ownership. `Pool.acquire` stamps
     * each live object with its owning pool, which makes that a pointer compare
     * rather than a shape check - and it means a chain arc or a nuke can never
     * route a pod through the enemy damage path.
     */
    function isEnemy(view) {
        return !!view && view.__pool === pool;
    }

    const stats = {
        spawned: 0,
        killed: 0,
        leaked: 0,
        acquired: 0,
        recycledSpawns: 0,
        telegraphsCompleted: 0
    };

    /**
     * Bring a view into existence as a real target: full size, damageable, and
     * registered in the hash so hit queries can find it.
     *
     * Shared by the telegraph-complete path and by spawns that skip the telegraph
     * (telegraphSeconds = 0, used by the debug panel). Those used to fall through
     * the telegraph branch untouched: never alive, never scaled up, yet still
     * present in the hash - i.e. an invisible phantom that absorbed shots and
     * could not be killed.
     */
    function materialise(view, ctx = {}) {
        view.alive = true;
        view.uniforms.uTelegraph.value = 1;
        view.mesh.scale.setScalar(view.radius);
        // Locator handover: pillar off, marker at full strength.
        view.pillar.visible = false;
        view.pillarMaterial.opacity = 0;
        view.markerMaterial.opacity = 0.55;
        view.marker.scale.setScalar(view.radius * (view.boss ? 2.4 : view.elite ? 1.9 : 1.55));
        hash?.upsert(view, view.x, view.y, view.radius);
        stats.telegraphsCompleted += 1;
        bus?.emit('ENEMY_SPAWN', {
            tick: ctx.tick,
            id: view.id,
            archetype: view.archetypeId,
            elite: view.elite,
            boss: view.boss,
            hp: view.hp,
            x: view.x,
            y: view.y
        });
        return view;
    }

    const scratch = [];
    const pendingRelease = [];

    return {
        pool,
        hash,
        stats,

        /**
         * Ownership test, exported so the aim/scope query can pass exactly the
         * same predicate the damage path uses - the reticle and a shot can never
         * disagree about what counts as a target.
         */
        isEnemy,

        get activeCount() { return pool.activeCount; },
        get maxActive() { return maxActive; },

        setBudget(next) {
            maxActive = Math.max(1, Math.round(next));
            pool.setMaxSize(Math.max(maxViews, maxActive + 8));
            return maxActive;
        },

        /**
         * Spawn an enemy with a telegraph.
         * @returns {object|null} the view, or null when the cap is reached.
         */
        spawn(envelope, ctx = {}) {
            if (pool.activeCount >= maxActive) {
                stats.recycledSpawns += 1;
                return null;
            }
            const view = pool.acquire(envelope, ctx);
            if (!view) return null;
            stats.spawned += 1;
            return view;
        },

        /** Force an immediate spawn with no telegraph (debug/practice). */
        spawnImmediate(envelope, ctx = {}) {
            return this.spawn(envelope, { ...ctx, telegraphSeconds: 0 });
        },

        /** True when the view is one of ours and still a legal target. */
        isEnemy,

        /**
         * Fixed-step update.
         * @param {object} ctx {timeFactor, coreX, coreY, onReachCore(view), tick}
         */
        update(dt, ctx = {}) {
            const timeFactor = Math.max(0.05, ctx.timeFactor ?? 1);
            const scaled = dt * timeFactor;
            const coreX = ctx.coreX ?? ARENA.core.x;
            const coreY = ctx.coreY ?? ARENA.core.y;
            // Released after the sweep: mutating the pool mid-iteration would skip
            // the view that slides into the freed slot.
            pendingRelease.length = 0;

            pool.forEachActive((view) => {
                view.prevX = view.x;
                view.prevY = view.y;

                view.flash = Math.max(0, view.flash - dt * 4.5);
                view.uniforms.uFlash.value = view.flash;
                view.uniforms.uTime.value += dt;
                view.uniforms.uElite.value = view.elite ? 1 : 0;

                // Locators track the simulation position each tick: the floor ring
                // sits under the body, the pillar burns only while the telegraph
                // runs, and both fade out with the death shrink.

                // A dead view is already out of the hash: it only needs to finish
                // its fade and get recycled. Never replays movement or telegraph.
                if (!view.alive && view.deathTimer > 0) {
                    view.deathTimer -= dt;
                    const fade = Math.max(0, view.deathTimer / DEATH_FADE_SECONDS);
                    view.mesh.scale.setScalar(view.radius * (0.35 + fade * 0.65));
                    view.mesh.rotation.y += dt * 6;
                    // Locator fade mirrors the corpse shrink.
                    view.markerMaterial.opacity = 0.55 * fade;
                    view.marker.scale.multiplyScalar(Math.max(0.55, fade));
                    view.pillarMaterial.opacity = 0;
                    if (view.deathTimer <= 0) pendingRelease.push(view);
                    return;
                }

                if (view.telegraph > 0) {
                    view.telegraph -= scaled;
                    const total = Math.max(0.0001, view.telegraphTotal);
                    const progress = 1 - Math.max(0, view.telegraph) / total;
                    view.uniforms.uTelegraph.value = Math.min(1, progress);
                    view.mesh.scale.setScalar(view.radius * (0.2 + progress * 0.8));
                    view.mesh.rotation.y += dt * 3;
                    // Pillar burns brightest early, dimming as the body forms, and
                    // stands on the floor (the cylinder's origin is its centre).
                    const pillarHeight = Math.max(0.5, ARENA.enemyHoverY + 6);
                    view.pillarMaterial.opacity = 0.85 * (1 - progress * 0.55);
                    view.pillar.scale.set(1, pillarHeight, 1);
                    view.pillar.position.set(view.x, pillarHeight / 2, ARENA.planeZ);
                    // The telegraph ring grows into its live size, so arrival is
                    // a seamless handover rather than a visible pop.
                    const ringAtBirth = view.radius * (view.boss ? 2.4 : view.elite ? 1.9 : 1.55);
                    view.marker.scale.setScalar(ringAtBirth * (0.55 + progress * 0.45));
                    view.marker.position.set(view.x, 0.02, ARENA.planeZ);
                    view.markerMaterial.opacity = 0.35 + progress * 0.45;
                    if (view.telegraph > 0) return;
                    materialise(view, ctx);
                    return;
                }

                // Spawned with no telegraph: make it real before it starts moving.
                if (!view.alive) materialise(view, ctx);

                // Close on the core.
                const dx = coreX - view.x;
                const dy = coreY - view.y;
                const distance = Math.hypot(dx, dy) || 0.0001;
                const step = view.speed * scaled;
                view.x += (dx / distance) * step;
                view.y += (dy / distance) * step;
                view.vx = (dx / distance) * view.speed;
                view.vy = (dy / distance) * view.speed;

                hash?.update(view, view.x, view.y, view.radius);

                view.rotation += dt * view.rotationSpeed;
                view.uniforms.uHpFrac.value = damp(view.uniforms.uHpFrac.value, view.hpFrac, 6, dt);

                // Live locator: pulse the ring, keep it glued to the floor point.
                const ringSize = view.radius * (view.boss ? 2.4 : view.elite ? 1.9 : 1.55);
                const markerPulse = 1 + Math.sin(view.uniforms.uTime.value * 5.0 + view.phase) * 0.08;
                view.marker.scale.setScalar(ringSize * markerPulse);
                view.marker.position.set(view.x, 0.02, ARENA.planeZ);
                view.markerMaterial.opacity = 0.55 + (1 - view.hpFrac) * 0.35;
                view.pillarMaterial.opacity = 0;

                if (distance <= ARENA.coreHitDistance + view.radius * 0.2) {
                    stats.leaked += 1;
                    ctx.onReachCore?.(view);
                }
            });

            for (const view of pendingRelease) pool.release(view);

            return pool.activeCount;
        },

        /** Write interpolated transforms for rendering. */
        syncVisuals(alpha = 1) {
            pool.forEachActive((view) => {
                if (!view.mesh.visible) return;
                const t = view.telegraph > 0 ? 1 : alpha;
                const x = view.prevX + (view.x - view.prevX) * t;
                const y = view.prevY + (view.y - view.prevY) * t;
                const bob = view.telegraph > 0 ? 0 : Math.sin(view.uniforms.uTime.value * 2.4 + view.phase) * 0.08;
                view.mesh.position.set(x, y, view.z + bob);
                view.mesh.rotation.y = view.rotation;
                view.mesh.rotation.x = view.telegraph > 0 ? 0 : Math.sin(view.rotation * 0.6) * 0.2;
                if (view.bossRing.visible) view.bossRing.rotation.z += 0.01;
                // The marker follows the interpolated body, not the raw tick
                // position, so ring and body never visibly disagree.
                view.marker.position.set(x, 0.02, ARENA.planeZ);
            });
        },

        /**
         * Apply damage to a view.
         * @returns {{killed:boolean, damage:number, hp:number}}
         */
        applyDamage(view, amount, meta = {}) {
            if (!isEnemy(view) || !view.damageable) return { killed: false, damage: 0, hp: view?.hp ?? 0 };

            let damage = amount;
            if (view.elite && meta.eliteBonus) damage *= 1 + meta.eliteBonus;
            if (view.boss && meta.bossBonus) damage *= 1 + meta.bossBonus;

            view.hp -= damage;
            view.flash = Math.min(1, view.flash + 0.55);

            bus?.emit('ENEMY_HIT', {
                tick: meta.tick,
                id: view.id,
                archetype: view.archetypeId,
                elite: view.elite,
                boss: view.boss,
                crit: !!meta.crit,
                damage,
                hp: Math.max(0, view.hp),
                x: view.x,
                y: view.y
            });

            if (view.hp > 0) return { killed: false, damage, hp: view.hp };

            stats.killed += 1;

            // The kill is real the instant hp hits zero. Leaving the view in the
            // hash as a "living" corpse meant it kept absorbing shots (wasting
            // pierce), kept being re-killed for score and combo, and could still
            // breach the core.
            view.alive = false;
            view.deathTimer = DEATH_FADE_SECONDS;
            hash?.remove(view);

            bus?.emit('ENEMY_KILL', {
                tick: meta.tick,
                id: view.id,
                archetype: view.archetypeId,
                elite: view.elite,
                boss: view.boss,
                crit: !!meta.crit,
                score: view.score,
                x: view.x,
                y: view.y,
                color: view.archetype?.color
            });
            bus?.emit('ENEMY_DEATH', {
                tick: meta.tick,
                id: view.id,
                archetype: view.archetypeId,
                boss: view.boss,
                elite: view.elite,
                x: view.x,
                y: view.y,
                color: view.color
            });

            return { killed: true, damage, hp: 0, view };
        },

        /** Remove a view without counting it as a kill (leaks, nukes, cleanup). */
        release(view) {
            if (!view) return false;
            return pool.release(view);
        },

        forEachActive(fn) {
            pool.forEachActive(fn);
        },

        /** Candidates near a point, damageable only. */
        within(x, y, radius, predicate = null, out = []) {
            const candidates = hash ? hash.queryCircle(x, y, radius, scratch) : [];
            out.length = 0;
            for (const view of candidates) {
                if (!isEnemy(view) || !view.damageable) continue;
                if (predicate && !predicate(view)) continue;
                out.push(view);
            }
            return out;
        },

        nearest(x, y, radius, predicate = null) {
            if (!hash) return null;
            return hash.nearest(x, y, radius, (view) => isEnemy(view) && view.damageable && (!predicate || predicate(view)));
        },

        clear({ countAsEscape = false } = {}) {
            const released = [];
            pool.forEachActive((view) => released.push(view));
            for (const view of released) {
                if (countAsEscape) stats.leaked += 1;
                pool.release(view);
            }
            hash?.clear();
            return released.length;
        },

        /** Snapshot used by the replay checksum. */
        checksumData() {
            const out = [];
            pool.forEachActive((view) => {
                if (!view.alive) return;
                out.push({ x: view.x, y: view.y, hp: view.hp });
            });
            return out;
        },

        poolStats() {
            return { ...pool.stats(), maxActive };
        },

        dispose() {
            pool.clear(true);
            scene?.remove(activeGroup);
            for (const geometry of Object.values(geometries)) geometry.dispose?.();
            shellGeometry.dispose();
            bossRingMaterial.dispose();
        }
    };
}
