/**
 * Hazards.
 *
 * Void Mines are the pressure valve that lets the director escalate without
 * adding more enemies: they occupy no enemy slot, they threaten the core on a
 * visible fuse, and the player can defuse them for score. A detonation also
 * shoves nearby enemies, so ignoring one is rarely the safe play.
 */

import * as THREE from 'three';
import { Pool } from '../core/Pool.js';
import { HAZARDS } from './archetypes.js';
import { ARENA } from './ArenaSpec.js';

const MINE_FRAGMENT = /* glsl */`
    uniform vec3 uColor;
    uniform vec3 uGlow;
    uniform float uTime;
    uniform float uFuse;      // 1 -> fresh, 0 -> detonation
    uniform float uFlash;

    varying vec3 vNormal;
    varying vec3 vViewDir;

    void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewDir);
        float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 1.6);

        // Beeps accelerate as the fuse runs out: tension without a UI element.
        float rate = mix(14.0, 4.0, clamp(uFuse, 0.0, 1.0));
        float blink = 0.5 + 0.5 * sin(uTime * rate);

        vec3 color = mix(uColor * 0.35, uGlow, blink);
        color += uGlow * fresnel * (1.0 + blink);
        color += vec3(1.0) * uFlash;
        gl_FragColor = vec4(color, 0.6 + blink * 0.4 + fresnel * 0.2);
    }
`;

export function createHazardManager(options = {}) {
    const scene = options.scene;
    const hash = options.hash;
    const bus = options.bus;
    const maxViews = options.maxViews ?? 14;

    const geometry = new THREE.OctahedronGeometry(1, 0);
    const ringGeometry = new THREE.RingGeometry(0.9, 1.05, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0xff2fd0,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const group = new THREE.Group();
    group.name = 'hazards';
    scene?.add(group);

    function createView() {
        const material = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0xff2fd0) },
                uGlow: { value: new THREE.Color(0xff006e) },
                uTime: { value: 0 },
                uFuse: { value: 1 },
                uFlash: { value: 0 }
            },
            vertexShader: /* glsl */`
                varying vec3 vNormal;
                varying vec3 vViewDir;
                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    vViewDir = -mvPosition.xyz;
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: MINE_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        mesh.renderOrder = 11;

        const ring = new THREE.Mesh(ringGeometry, ringMaterial.clone());
        ring.rotation.x = -Math.PI / 2;
        ring.visible = false;
        ring.renderOrder = 4;
        group.add(ring);

        return {
            id: 0,
            mesh,
            ring,
            material,
            active: false,
            alive: false,
            type: HAZARDS.mine,
            x: 0, y: 0, z: 0,
            prevX: 0, prevY: 0,
            radius: HAZARDS.mine.radius,
            hitRadius: HAZARDS.mine.radius,
            hp: 1,
            fuse: HAZARDS.mine.fuse,
            maxFuse: HAZARDS.mine.fuse,
            flash: 0,
            armed: false,
            spawnTick: 0,

            activate(envelope, ctx = {}) {
                const type = envelope.type || HAZARDS.mine;
                this.type = type;
                this.active = true;
                this.alive = false;
                this.armed = false;
                this.x = envelope.x;
                this.y = envelope.y;
                this.z = ARENA.planeZ;
                this.prevX = this.x;
                this.prevY = this.y;
                this.radius = type.radius;
                this.hitRadius = type.radius;
                this.hp = type.hp;
                this.maxFuse = type.fuse;
                this.fuse = type.fuse;
                this.flash = 0;
                this.spawnTick = ctx.tick || 0;

                this.material.uniforms.uColor.value.set(type.color);
                this.material.uniforms.uGlow.value.set(type.glow);
                this.material.uniforms.uFuse.value = 1;
                this.material.uniforms.uFlash.value = 0;

                this.mesh.visible = true;
                this.mesh.scale.setScalar(type.radius * 1.4);
                this.ring.visible = true;
                this.ring.scale.setScalar(type.radius * 1.3);
                this.ring.material.opacity = 0.35;
                group.add(this.mesh);
                return this;
            },

            deactivate() {
                this.active = false;
                this.alive = false;
                this.mesh.visible = false;
                this.mesh.scale.setScalar(0.0001);
                this.ring.visible = false;
                if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
                hash?.remove(this);
            },

            dispose() {
                this.material.dispose();
                this.ring.material.dispose();
            },

            get damageable() { return this.active && this.alive; }
        };
    }

    const pool = new Pool({
        name: 'hazards',
        create: createView,
        maxSize: maxViews,
        prewarm: 4
    });

    /** The spatial hash is shared with enemies and pods: only our own views count. */
    function isHazard(view) {
        return !!view && view.__pool === pool;
    }

    const stats = { spawned: 0, defused: 0, detonated: 0, cap: 4 };
    let nextId = 1;
    const scratch = [];

    return {
        pool,
        stats,

        get activeCount() { return pool.activeCount; },
        get cap() { return stats.cap; },

        setBudget(cap) {
            stats.cap = Math.max(0, Math.round(cap));
            return stats.cap;
        },

        spawn(envelope, ctx = {}) {
            if (stats.cap <= 0 || pool.activeCount >= stats.cap) return null;
            const view = pool.acquire(envelope, ctx);
            if (!view) return null;
            view.id = nextId++;
            stats.spawned += 1;
            bus?.emit('HAZARD_SPAWN', { tick: ctx.tick, id: view.id, x: view.x, y: view.y, type: view.type.id });
            return view;
        },

        update(dt, ctx = {}) {
            const timeFactor = Math.max(0.05, ctx.timeFactor ?? 1);
            const scaled = dt * timeFactor;

            pool.forEachActive((view) => {
                view.material.uniforms.uTime.value += dt;

                // Arming delay so a mine cannot detonate the instant it appears.
                if (!view.armed) {
                    view.armed = true;
                    view.alive = true;
                    hash?.upsert(view, view.x, view.y, view.radius);
                }

                view.fuse -= scaled;
                const frac = Math.max(0, view.fuse / view.maxFuse);
                view.material.uniforms.uFuse.value = frac;
                view.mesh.rotation.y += dt * (1.2 + (1 - frac) * 4);
                view.mesh.rotation.x += dt * 0.6;

                const pulse = 1 + Math.sin(view.material.uniforms.uTime.value * (3 + (1 - frac) * 12)) * 0.08 * (1.6 - frac);
                view.mesh.scale.setScalar(view.radius * 1.4 * pulse);
                view.ring.scale.setScalar(view.radius * (1.6 + (1 - frac) * 2.4));
                view.ring.material.opacity = 0.2 + (1 - frac) * 0.45;
                view.flash = Math.max(0, view.flash - dt * 5);
                view.material.uniforms.uFlash.value = view.flash;

                if (view.fuse <= 0) {
                    stats.detonated += 1;
                    bus?.emit('HAZARD_DETONATED', { tick: ctx.tick, id: view.id, x: view.x, y: view.y, type: view.type.id });
                    ctx.onDetonate?.(view);
                }
            });

            return pool.activeCount;
        },

        /** Player shot it: defused for score, no core damage. */
        applyDamage(view, amount, meta = {}) {
            if (!isHazard(view) || !view.damageable) return { destroyed: false };
            view.hp -= amount;
            view.flash = Math.min(1, view.flash + 0.7);
            if (view.hp > 0) return { destroyed: false, hp: view.hp };

            stats.defused += 1;
            bus?.emit('ENEMY_KILL', {
                tick: meta.tick,
                id: view.id,
                archetype: 'mine',
                elite: false,
                boss: false,
                crit: !!meta.crit,
                score: view.type.score,
                x: view.x,
                y: view.y,
                hazard: true
            });
            pool.release(view);
            return { destroyed: true, score: view.type.score };
        },

        forEachActive(fn) { pool.forEachActive(fn); },

        within(x, y, radius, predicate = null, out = []) {
            const candidates = hash ? hash.queryCircle(x, y, radius, scratch) : [];
            out.length = 0;
            for (const view of candidates) {
                if (!isHazard(view) || !view.damageable) continue;
                if (predicate && !predicate(view)) continue;
                out.push(view);
            }
            return out;
        },

        syncVisuals() {
            pool.forEachActive((view) => {
                view.mesh.position.set(view.x, view.y, view.z);
            });
        },

        clear() {
            const count = pool.activeCount;
            pool.releaseAll();
            hash?.clear();
            return count;
        },

        checksumData() {
            const out = [];
            pool.forEachActive((view) => out.push({ x: view.x, y: view.y, fuse: Math.round(view.fuse * 100) }));
            return out;
        },

        poolStats() { return pool.stats(); },

        dispose() {
            pool.clear(true);
            scene?.remove(group);
            geometry.dispose();
            ringGeometry.dispose();
            ringMaterial.dispose();
        }
    };
}
