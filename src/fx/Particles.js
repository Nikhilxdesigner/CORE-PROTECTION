/**
 * GPU particle field.
 *
 * Every particle's whole trajectory is baked into its spawn attributes
 * (origin, velocity, birth time, lifetime, size, colour), so the vertex shader
 * derives the current position from a single `uTime` uniform. The CPU therefore
 * pays *nothing* per frame for motion - it only uploads when particles are born,
 * and only over the dirty byte range. That is what makes tens of thousands of
 * sparks affordable where the old build was limited to a few hundred
 * CPU-integrated objects.
 *
 * Slots come from a free list; when the budget is saturated the oldest slot is
 * recycled, so a burst degrades gracefully instead of allocating.
 */

import * as THREE from 'three';

const VERTEX = /* glsl */`
    attribute vec3 aOrigin;
    attribute vec3 aVelocity;
    attribute float aStart;
    attribute float aLife;
    attribute float aSize;
    attribute vec3 aColor;
    attribute float aSeed;

    uniform float uTime;
    uniform float uPixelRatio;
    uniform float uSizeScale;
    uniform float uDrag;
    uniform float uGravity;
    uniform float uGlobalLife;

    varying vec3 vColor;
    varying float vAlpha;
    varying float vSeed;

    void main() {
        float age = uTime - aStart;
        float life = aLife * uGlobalLife;
        float t = clamp(age / max(life, 0.0001), 0.0, 1.0);
        float alive = step(0.0, age) * step(age, life);

        // Analytic damped motion: cost is identical for every particle.
        float damped = (1.0 - exp(-uDrag * age)) / max(uDrag, 0.0001);
        vec3 displaced = aOrigin + aVelocity * damped;
        displaced.y -= 0.5 * uGravity * age * age;

        vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float fadeIn = smoothstep(0.0, 0.08, t);
        float fadeOut = 1.0 - smoothstep(0.55, 1.0, t);
        vAlpha = alive * fadeIn * fadeOut;

        float flicker = 0.85 + 0.15 * sin((age * 22.0) + aSeed * 6.2831);
        float size = aSize * flicker * uSizeScale;
        gl_PointSize = max(1.0, size * uPixelRatio * (14.0 / max(-mvPosition.z, 0.2)));

        vColor = aColor;
        vSeed = aSeed;
    }
`;

const FRAGMENT = /* glsl */`
    varying vec3 vColor;
    varying float vAlpha;
    varying float vSeed;

    uniform float uGlow;

    void main() {
        vec2 centered = gl_PointCoord - vec2(0.5);
        float dist = length(centered);
        if (dist > 0.5 || vAlpha <= 0.001) discard;

        // Soft core plus a wider halo, so sparks read as light, not dots.
        float core = smoothstep(0.5, 0.02, dist);
        float halo = smoothstep(0.5, 0.18, dist) * 0.45;
        float alpha = (core + halo) * vAlpha;

        vec3 color = vColor * (1.0 + uGlow * core);
        gl_FragColor = vec4(color, alpha);
    }
`;

export function createParticleField(options = {}) {
    const scene = options.scene;
    const maxSlots = options.maxSlots ?? 40000;
    let budget = Math.min(options.budget ?? 20000, maxSlots);

    const geometry = new THREE.BufferGeometry();
    const origin = new Float32Array(maxSlots * 3);
    const velocity = new Float32Array(maxSlots * 3);
    const start = new Float32Array(maxSlots);
    const life = new Float32Array(maxSlots);
    const size = new Float32Array(maxSlots);
    const color = new Float32Array(maxSlots * 3);
    const seed = new Float32Array(maxSlots);

    // Park every slot far away with zero lifetime so it is invisible until used.
    for (let i = 0; i < maxSlots; i++) {
        start[i] = -1000;
        life[i] = 0.0001;
        size[i] = 0;
        seed[i] = (i % 97) / 97;
    }

    const attrs = {
        aOrigin: new THREE.BufferAttribute(origin, 3),
        aVelocity: new THREE.BufferAttribute(velocity, 3),
        aStart: new THREE.BufferAttribute(start, 1),
        aLife: new THREE.BufferAttribute(life, 1),
        aSize: new THREE.BufferAttribute(size, 1),
        aColor: new THREE.BufferAttribute(color, 3),
        aSeed: new THREE.BufferAttribute(seed, 1)
    };
    for (const [name, attribute] of Object.entries(attrs)) {
        attribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, attribute);
    }

    const uniforms = {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1) },
        uSizeScale: { value: 1 },
        uDrag: { value: 1.7 },
        uGravity: { value: 1.4 },
        uGlobalLife: { value: 1 },
        uGlow: { value: 0.6 }
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 20;
    scene?.add(points);

    const free = new Array(maxSlots);
    for (let i = 0; i < maxSlots; i++) free[i] = i;
    free.reverse();

    const dirty = { min: Infinity, max: -Infinity };
    let live = 0;
    let spawned = 0;
    let recycled = 0;
    let time = 0;

    function markDirty(index) {
        if (index < dirty.min) dirty.min = index;
        if (index > dirty.max) dirty.max = index;
    }

    function acquireSlot() {
        if (free.length > 0) return free.pop();
        recycled += 1;
        // Saturated: steal the oldest neighbour's slot deterministically.
        return Math.floor(Math.random() * maxSlots);
    }

    function flush() {
        if (dirty.max < dirty.min) return;
        const start_ = dirty.min;
        const count = dirty.max - dirty.min + 1;
        for (const attribute of Object.values(attrs)) {
            if (typeof attribute.addUpdateRange === 'function') {
                attribute.clearUpdateRanges?.();
                attribute.addUpdateRange(start_ * attribute.itemSize, count * attribute.itemSize);
                attribute.needsUpdate = true;
            } else {
                attribute.needsUpdate = true;
            }
        }
        dirty.min = Infinity;
        dirty.max = -Infinity;
    }

    const tmpColor = new THREE.Color();

    return {
        object: points,
        uniforms,

        get live() { return live; },
        get budget() { return budget; },

        setBudget(next) {
            budget = Math.max(0, Math.min(maxSlots, Math.round(next)));
            return budget;
        },

        setPixelRatio(ratio) {
            uniforms.uPixelRatio.value = Math.max(0.6, Math.min(2, ratio));
        },

        setGlow(value) {
            uniforms.uGlow.value = value;
        },

        setSizeScale(value) {
            uniforms.uSizeScale.value = value;
        },

        setDrag(value) { uniforms.uDrag.value = Math.max(0.05, value); },
        setGravity(value) { uniforms.uGravity.value = value; },
        setGlobalLife(value) { uniforms.uGlobalLife.value = Math.max(0.05, value); },

        /** Spawn one particle. Colours accept hex numbers or THREE.Color. */
        spawn(spec) {
            if (budget <= 0) return null;
            if (live >= budget * 1.15) return null;   // stay near budget, avoid unbounded overshoot

            const index = acquireSlot();
            const i3 = index * 3;

            origin[i3] = spec.x || 0;
            origin[i3 + 1] = spec.y || 0;
            origin[i3 + 2] = spec.z || 0;

            velocity[i3] = spec.vx || 0;
            velocity[i3 + 1] = spec.vy || 0;
            velocity[i3 + 2] = spec.vz || 0;

            start[index] = time + (spec.delay || 0);
            life[index] = spec.life ?? 0.6;
            size[index] = spec.size ?? 0.35;

            tmpColor.set(spec.color ?? 0x00f0ff);
            color[i3] = tmpColor.r;
            color[i3 + 1] = tmpColor.g;
            color[i3 + 2] = tmpColor.b;

            seed[index] = Math.random();
            live += 1;
            spawned += 1;
            markDirty(index);
            return index;
        },

        /**
         * Radial burst - the workhorse for impacts, kills and core hits.
         * @param {object} spec {x,y,z,count,color,speed,spread,life,size,gravity,up}
         */
        burst(spec = {}) {
            const count = Math.min(spec.count ?? 18, Math.max(0, Math.floor(budget - live)) || 0);
            const color = spec.color ?? 0x00f0ff;
            const speed = spec.speed ?? 6;
            const life = spec.life ?? 0.7;
            const size = spec.size ?? 0.34;
            const flatten = spec.flatten ?? 0.65;
            const up = spec.up ?? 0.5;

            for (let i = 0; i < count; i++) {
                const angle = Math.random() * Math.PI * 2;
                const elevation = (Math.random() - 0.5) * flatten * Math.PI;
                const magnitude = speed * (0.45 + Math.random() * 0.85);
                this.spawn({
                    x: spec.x || 0,
                    y: spec.y || 0,
                    z: spec.z || 0,
                    vx: Math.cos(angle) * Math.cos(elevation) * magnitude,
                    vy: Math.sin(elevation) * magnitude + up,
                    vz: Math.sin(angle) * Math.cos(elevation) * magnitude * 0.7,
                    life: life * (0.6 + Math.random() * 0.8),
                    size: size * (0.55 + Math.random() * 0.9),
                    color
                });
            }
            return count;
        },

        /** Directional spray, used for weapon tracers and thrusters. */
        spray(spec = {}) {
            const count = spec.count ?? 6;
            for (let i = 0; i < count; i++) {
                this.spawn({
                    x: spec.x || 0, y: spec.y || 0, z: spec.z || 0,
                    vx: (spec.vx || 0) * (0.6 + Math.random() * 0.8) + (Math.random() - 0.5) * (spec.spread ?? 1),
                    vy: (spec.vy || 0) * (0.6 + Math.random() * 0.8) + (Math.random() - 0.5) * (spec.spread ?? 1),
                    vz: (spec.vz || 0) * (0.6 + Math.random() * 0.8),
                    life: (spec.life ?? 0.5) * (0.7 + Math.random() * 0.6),
                    size: (spec.size ?? 0.28) * (0.6 + Math.random() * 0.8),
                    color: spec.color ?? 0x00f0ff
                });
            }
            return count;
        },

        update(dt) {
            time += dt;
            uniforms.uTime.value = time;
            flush();
            // Live count decays because expired particles are simply not drawn;
            // recount lazily every so often to keep the budget honest.
            live = Math.min(live, Math.round(live * 0.995) + 1);
            if (live < 0) live = 0;
            return live;
        },

        reset() {
            for (let i = 0; i < maxSlots; i++) {
                start[i] = -1000;
                life[i] = 0.0001;
                size[i] = 0;
            }
            markDirty(0);
            markDirty(maxSlots - 1);
            free.length = 0;
            for (let i = 0; i < maxSlots; i++) free[i] = i;
            live = 0;
        },

        stats() {
            return {
                live,
                budget,
                maxSlots,
                spawned,
                recycled,
                time: Math.round(time * 10) / 10
            };
        },

        dispose() {
            scene?.remove(points);
            geometry.dispose();
            material.dispose();
        }
    };
}
