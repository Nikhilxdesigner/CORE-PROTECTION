/**
 * Powerups.
 *
 * Drops arrive as floating pods that must be *shot* to collect - the player has
 * no avatar to walk over them with, and making you spend a shot (and a moment of
 * aim) turns a drop into a decision instead of a gift.
 *
 * Five effects, deliberately covering different failure modes: FREEZE buys
 * breathing room, CHAIN scales with crowd size, DRONE adds passive damage,
 * NUKE resets the arena, OVERCHARGE raises the ceiling.
 */

import * as THREE from 'three';
import { Pool } from '../core/Pool.js';
import { ARENA } from './ArenaSpec.js';

export const POWERUPS = Object.freeze({
    freeze: {
        id: 'freeze',
        name: 'Cryo Field',
        desc: 'The world slows to a crawl',
        color: 0x66e0ff,
        glow: 0x00d0ff,
        duration: 6,
        worldTimeScale: 0.42
    },
    chain: {
        id: 'chain',
        name: 'Arc Conduit',
        desc: 'Kills arc lightning into nearby enemies',
        color: 0xfff36b,
        glow: 0xffd000,
        duration: 9,
        chainTargets: 3,
        chainRange: 5.2
    },
    drone: {
        id: 'drone',
        name: 'Sentry Drone',
        desc: 'A drone auto-fires for you',
        color: 0x8cff9e,
        glow: 0x00ff88,
        duration: 14
    },
    nuke: {
        id: 'nuke',
        name: 'Purge Pulse',
        desc: 'Clears the arena instantly',
        color: 0xffd0f0,
        glow: 0xff00e6,
        duration: 0,
        damage: 5,
        radius: 40
    },
    overcharge: {
        id: 'overcharge',
        name: 'Overcharge',
        desc: 'Fire rate and damage surging',
        color: 0xffb066,
        glow: 0xff7a18,
        duration: 9,
        rofMul: 2,
        damageMul: 1.3
    }
});

export const POWERUP_LIST = Object.freeze(Object.values(POWERUPS));

export function createPowerupManager(options = {}) {
    const scene = options.scene;
    const hash = options.hash;
    const bus = options.bus;
    const rng = options.rng;
    const maxViews = options.maxViews ?? 6;

    const coreGeometry = new THREE.IcosahedronGeometry(0.55, 0);
    const haloGeometry = new THREE.IcosahedronGeometry(0.95, 0);

    const group = new THREE.Group();
    group.name = 'powerups';
    scene?.add(group);

    function createView() {
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff88,
            transparent: true,
            opacity: 0.92,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const mesh = new THREE.Mesh(coreGeometry, material);
        mesh.visible = false;

        const haloMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ff88,
            wireframe: true,
            transparent: true,
            opacity: 0.4,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const halo = new THREE.Mesh(haloGeometry, haloMaterial);
        halo.visible = false;
        group.add(halo);

        return {
            id: 0,
            mesh,
            halo,
            material,
            haloMaterial,
            active: false,
            alive: false,
            type: POWERUPS.freeze,
            x: 0, y: 0, z: 0,
            prevX: 0, prevY: 0,
            radius: 0.85,
            hitRadius: 0.95,
            life: 14,
            maxLife: 14,
            phase: 0,
            driftX: 0,
            driftY: 0,

            activate(envelope, ctx = {}) {
                const type = envelope.type || POWERUPS.freeze;
                this.type = type;
                this.active = true;
                this.alive = true;
                this.x = envelope.x;
                this.y = envelope.y;
                this.z = ARENA.planeZ + 0.35;
                this.prevX = this.x;
                this.prevY = this.y;
                this.radius = 0.85;
                this.hitRadius = 0.95;
                this.maxLife = envelope.life ?? 14;
                this.life = this.maxLife;
                this.phase = rng ? rng.range(0, Math.PI * 2) : 0;
                this.driftX = rng ? rng.range(-0.35, 0.35) : 0;
                this.driftY = rng ? rng.range(-0.2, 0.2) : 0;

                this.material.color.set(type.color);
                this.haloMaterial.color.set(type.color);

                this.mesh.visible = true;
                this.halo.visible = true;
                this.mesh.scale.setScalar(1);
                this.halo.scale.setScalar(1);
                group.add(this.mesh);
                hash?.upsert(this, this.x, this.y, this.radius);
                return this;
            },

            deactivate() {
                this.active = false;
                this.alive = false;
                this.mesh.visible = false;
                this.halo.visible = false;
                if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
                hash?.remove(this);
            },

            dispose() {
                this.material.dispose();
                this.haloMaterial.dispose();
            },

            /** Collectable while alive (shoot it). */
            get damageable() { return this.active && this.alive; }
        };
    }

    const pool = new Pool({ name: 'powerups', create: createView, maxSize: maxViews, prewarm: maxViews });

    /** The spatial hash is shared with enemies and hazards: only our own views count. */
    function isPowerup(view) {
        return !!view && view.__pool === pool;
    }

    const stats = { spawned: 0, collected: 0, expired: 0 };
    let nextId = 1;

    return {
        pool,
        stats,
        POWERUPS,

        get activeCount() { return pool.activeCount; },
        get maxActive() { return maxViews; },

        spawn(envelope, ctx = {}) {
            if (pool.activeCount >= maxViews) return null;
            const view = pool.acquire(envelope, ctx);
            if (!view) return null;
            view.id = nextId++;
            stats.spawned += 1;
            bus?.emit('POWERUP_SPAWN', { tick: ctx.tick, id: view.id, type: view.type.id, x: view.x, y: view.y });
            return view;
        },

        spawnRandom(x, y, ctx = {}, allowed = POWERUP_LIST) {
            const type = rng ? rng.pick(allowed) : allowed[0];
            return this.spawn({ type, x, y }, ctx);
        },

        update(dt, ctx = {}) {
            const timeFactor = Math.max(0.05, ctx.timeFactor ?? 1);
            const scaled = dt * timeFactor;

            pool.forEachActive((view) => {
                view.prevX = view.x;
                view.prevY = view.y;
                view.life -= scaled;

                if (view.life <= 0) {
                    stats.expired += 1;
                    pool.release(view);
                    return;
                }

                view.x += view.driftX * scaled;
                view.y += view.driftY * scaled;
                view.halo.rotation.y += dt * 1.4;
                view.halo.rotation.x += dt * 0.7;
                hash?.update(view, view.x, view.y, view.radius);

                // Blink out the last two seconds so the expiry is legible.
                const frac = view.life / view.maxLife;
                const blink = frac > 0.15 ? 1 : (0.35 + 0.65 * Math.abs(Math.sin(view.life * 12)));
                view.material.opacity = 0.92 * blink;
                view.haloMaterial.opacity = 0.4 * blink;
            });

            return pool.activeCount;
        },

        /** A shot landed on a pod: collect it. */
        collect(view, meta = {}) {
            if (!isPowerup(view) || !view.active) return null;
            const type = view.type;
            stats.collected += 1;
            pool.release(view);
            bus?.emit('POWERUP_PICKUP', {
                tick: meta.tick,
                id: view.id,
                type: type.id,
                name: type.name,
                x: view.x,
                y: view.y
            });
            return type;
        },

        forEachActive(fn) { pool.forEachActive(fn); },

        within(x, y, radius, predicate = null, out = []) {
            const candidates = hash ? hash.queryCircle(x, y, radius, []) : [];
            out.length = 0;
            for (const view of candidates) {
                if (!isPowerup(view) || !view.damageable) continue;
                if (predicate && !predicate(view)) continue;
                out.push(view);
            }
            return out;
        },

        syncVisuals(alpha = 1) {
            pool.forEachActive((view) => {
                const x = view.prevX + (view.x - view.prevX) * alpha;
                const y = view.prevY + (view.y - view.prevY) * alpha;
                const bob = Math.sin((view.halo.rotation.y + view.phase) * 1.6) * 0.14;
                const scale = 0.85 + 0.15 * Math.sin(view.halo.rotation.y * 2.2);
                view.mesh.position.set(x, y + bob, view.z);
                view.halo.position.set(x, y + bob, view.z);
                view.mesh.scale.setScalar(scale);
                view.halo.scale.setScalar(scale);
            });
        },

        clear() {
            const count = pool.activeCount;
            pool.releaseAll();
            return count;
        },

        checksumData() {
            const out = [];
            pool.forEachActive((view) => out.push({ x: view.x, y: view.y, type: view.type.id }));
            return out;
        },

        poolStats() { return pool.stats(); },

        dispose() {
            pool.clear(true);
            scene?.remove(group);
            coreGeometry.dispose();
            haloGeometry.dispose();
        }
    };
}
