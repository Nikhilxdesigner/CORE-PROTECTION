/**
 * Chunky debris.
 *
 * One InstancedMesh for every shard in the game: spawning a fragment costs a
 * slot index, never a new object, and inactive slots are parked at zero scale so
 * they draw nothing. This is the "heavy" half of the destruction feedback, with
 * the GPU particle field handling the sparks.
 */

import * as THREE from 'three';

export function createDebris(options = {}) {
    const scene = options.scene;
    const maxSlots = options.maxSlots ?? 260;
    let budget = Math.min(options.budget ?? 200, maxSlots);

    const geometry = options.geometry || new THREE.TetrahedronGeometry(0.22, 0);
    const material = options.material || new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95
    });

    const mesh = new THREE.InstancedMesh(geometry, material, maxSlots);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = maxSlots;
    mesh.renderOrder = 15;
    scene?.add(mesh);

    const slots = [];
    const free = [];
    for (let i = 0; i < maxSlots; i++) {
        slots.push({
            active: false,
            x: 0, y: 0, z: 0,
            vx: 0, vy: 0, vz: 0,
            spin: 0, spinAxis: new THREE.Vector3(1, 0, 0),
            rotation: new THREE.Quaternion(),
            scale: 1,
            life: 0, maxLife: 1,
            gravity: 9,
            color: new THREE.Color(0xffffff)
        });
        free.push(i);
    }

    const dummy = new THREE.Object3D();
    const colorScratch = new THREE.Color();
    const rotationScratch = new THREE.Quaternion();
    let live = 0;
    let spawned = 0;
    let recycled = 0;

    function deactivateSlot(index) {
        const slot = slots[index];
        slot.active = false;
        slot.life = 0;
        dummy.position.set(0, -9999, 0);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        mesh.instanceMatrix.needsUpdate = true;
    }

    // Park everything off-screen to begin with.
    for (let i = 0; i < maxSlots; i++) deactivateSlot(i);

    function acquire() {
        if (free.length > 0) return free.pop();
        // Budget reached: recycle the oldest slot we can find.
        recycled += 1;
        let bestIndex = 0;
        let bestLife = Infinity;
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].active && slots[i].life < bestLife) {
                bestLife = slots[i].life;
                bestIndex = i;
            }
        }
        deactivateSlot(bestIndex);
        return bestIndex;
    }

    return {
        object: mesh,

        get live() { return live; },
        get budget() { return budget; },

        setBudget(next) {
            budget = Math.max(0, Math.min(maxSlots, Math.round(next)));
            // Shrink immediately by retiring the excess.
            while (live > budget) {
                const index = slots.findIndex((slot) => slot.active);
                if (index === -1) break;
                deactivateSlot(index);
                free.push(index);
                live -= 1;
            }
            return budget;
        },

        /** Spawn one shard. */
        spawn(spec = {}) {
            if (budget <= 0 || live >= budget) return null;
            const index = acquire();
            const slot = slots[index];

            slot.active = true;
            slot.x = spec.x || 0;
            slot.y = spec.y || 0;
            slot.z = spec.z || 0;
            slot.vx = spec.vx ?? (Math.random() - 0.5) * 6;
            slot.vy = spec.vy ?? (2 + Math.random() * 5);
            slot.vz = spec.vz ?? (Math.random() - 0.5) * 4;
            slot.spin = (Math.random() - 0.5) * 12;
            slot.spinAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            slot.rotation.setFromAxisAngle(slot.spinAxis, Math.random() * Math.PI);
            slot.scale = spec.scale ?? (0.6 + Math.random() * 0.9);
            slot.maxLife = spec.life ?? (0.9 + Math.random() * 0.7);
            slot.life = slot.maxLife;
            slot.gravity = spec.gravity ?? 11;
            slot.color.set(spec.color ?? 0xffffff);

            mesh.setColorAt(index, colorScratch.copy(slot.color));
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

            live += 1;
            spawned += 1;
            return index;
        },

        /** Shard burst used by kills, explosions and core hits. */
        burst(spec = {}) {
            const count = Math.min(spec.count ?? 6, Math.max(0, budget - live));
            for (let i = 0; i < count; i++) {
                this.spawn({
                    x: (spec.x || 0) + (Math.random() - 0.5) * 0.4,
                    y: (spec.y || 0) + (Math.random() - 0.5) * 0.4,
                    z: (spec.z || 0) + (Math.random() - 0.5) * 0.4,
                    vx: (spec.vx ?? 0) + (Math.random() - 0.5) * (spec.spread ?? 7),
                    vy: (spec.vy ?? 3) + Math.random() * (spec.spread ?? 7) * 0.5,
                    vz: (Math.random() - 0.5) * 4,
                    color: spec.color ?? 0xffffff,
                    scale: spec.scale ?? (0.5 + Math.random() * 1.1),
                    life: spec.life ?? (0.8 + Math.random() * 0.8)
                });
            }
            return count;
        },

        update(dt) {
            let dirty = false;
            const floorY = 0.05;

            for (let i = 0; i < maxSlots; i++) {
                const slot = slots[i];
                if (!slot.active) continue;

                slot.life -= dt;
                if (slot.life <= 0) {
                    deactivateSlot(i);
                    free.push(i);
                    live -= 1;
                    dirty = true;
                    continue;
                }

                slot.vy -= slot.gravity * dt;
                slot.x += slot.vx * dt;
                slot.y += slot.vy * dt;
                slot.z += slot.vz * dt;

                // Bounce once, then settle and fade: reads as ground contact.
                if (slot.y < floorY) {
                    slot.y = floorY;
                    slot.vy = Math.abs(slot.vy) * 0.32;
                    slot.vx *= 0.62;
                    slot.vz *= 0.62;
                    slot.spin *= 0.5;
                }

                const t = Math.max(0, slot.life / slot.maxLife);
                rotationScratch.setFromAxisAngle(slot.spinAxis, slot.spin * (slot.maxLife - slot.life));
                dummy.position.set(slot.x, slot.y, slot.z);
                dummy.quaternion.copy(rotationScratch);
                dummy.scale.setScalar(slot.scale * Math.min(1, t * 2.2));
                dummy.updateMatrix();
                mesh.setMatrixAt(i, dummy.matrix);
                dirty = true;
            }

            if (dirty) mesh.instanceMatrix.needsUpdate = true;
            return live;
        },

        reset() {
            for (let i = 0; i < maxSlots; i++) {
                if (slots[i].active) deactivateSlot(i);
            }
            free.length = 0;
            for (let i = 0; i < maxSlots; i++) free.push(i);
            live = 0;
        },

        stats() {
            return { live, budget, maxSlots, spawned, recycled, free: free.length };
        },

        dispose() {
            scene?.remove(mesh);
            geometry.dispose?.();
            material.dispose?.();
        }
    };
}
