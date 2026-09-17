/**
 * Arena visuals.
 *
 * Three layers do the heavy lifting:
 *   1. a full-screen procedural hologrid backdrop — deep space, drifting stars
 *      and a scanning glow, so the arena reads as a place rather than a void,
 *   2. a shader grid floor carrying scanline pulses, a radial energy sweep and
 *      impact ripples, which sells depth and makes every hit feel placed,
 *   3. the core crystal the player defends, with a shield shell that lights as
 *      integrity drops.
 *
 * All arena shading is procedural: no textures, no models, nothing to download,
 * no camera, no video decoding anywhere in the render path.
 */

import * as THREE from 'three';
import { ARENA, CAMERA_RIG } from './ArenaSpec.js';
import { damp } from '../util/Math.js';

const BACKDROP_VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const BACKDROP_FRAGMENT = /* glsl */`
    uniform float uTime;
    uniform vec2 uParallax;
    uniform vec3 uTint;
    uniform float uHyper;
    uniform float uDamage;

    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5453); }

    /* The procedural hologrid: the only backdrop, always on. */
    vec3 holoGrid(vec2 uv, float time) {
        vec2 grid = abs(fract(uv * vec2(28.0, 16.0)) - 0.5);
        float lines = smoothstep(0.48, 0.5, max(grid.x, grid.y));
        float sweep = smoothstep(0.0, 1.0, sin((uv.y + time * 0.06) * 6.2831) * 0.5 + 0.5);
        float glow = exp(-length(uv - vec2(0.5 + sin(time * 0.12) * 0.22, 0.42)) * 3.4);
        float stars = step(0.995, hash(floor(uv * 260.0))) * 0.7;
        vec3 base = vec3(0.02, 0.04, 0.09);
        vec3 color = base + vec3(0.05, 0.35, 0.55) * lines * 0.35;
        color += vec3(0.1, 0.5, 0.85) * sweep * 0.12;
        color += vec3(0.25, 0.75, 1.0) * glow * 0.5;
        color += vec3(0.6, 0.9, 1.0) * stars;
        return color;
    }

    void main() {
        vec2 uv = vUv;
        vec2 parallaxUv = uv + uParallax * 0.012;

        vec3 color = holoGrid(parallaxUv, uTime);

        // Depth vignette tightens the play area.
        vec2 centered = uv - 0.5;
        float r2 = dot(centered, centered);
        color *= 1.0 - smoothstep(0.14, 0.72, r2) * 0.62;

        // Scanline shimmer, stronger during Hyper.
        float scan = 0.5 + 0.5 * sin(uv.y * 900.0 + uTime * 2.2);
        color *= 1.0 - (0.045 + uHyper * 0.05) * scan;

        color = mix(color, uTint, 0.16);
        color += uTint * uHyper * 0.1;

        // Damage bleeds colour out of the world for a beat.
        color = mix(color, vec3(0.45, 0.03, 0.07), uDamage * 0.35);

        gl_FragColor = vec4(color, 1.0);
    }
`;

const GRID_VERTEX = /* glsl */`
    varying vec2 vWorld;
    varying float vFade;
    void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xz;
        vec4 mvPosition = viewMatrix * world;
        vFade = clamp(1.0 - (-mvPosition.z / 60.0), 0.0, 1.0);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const GRID_FRAGMENT = /* glsl */`
    uniform float uTime;
    uniform vec3 uGridColor;
    uniform vec3 uAccent;
    uniform float uHyper;
    uniform float uQuality;          // ripple tap count 0..1
    uniform vec3 uRipples[8];        // x, z, age  (age 0 == free)

    varying vec2 vWorld;
    varying float vFade;

    void main() {
        vec2 grid = abs(fract(vWorld * 0.5) - 0.5) / fwidth(vWorld * 0.5);
        float line = 1.0 - min(min(grid.x, grid.y), 1.0);

        float radial = length(vWorld) * 0.055;
        float sweep = 0.5 + 0.5 * sin(radial * 6.2831 - uTime * 2.6);
        float pulse = smoothstep(0.35, 1.0, sweep) * 0.4;

        vec3 color = uGridColor * line * (0.5 + pulse);
        color += uAccent * line * uHyper * 0.7;

        for (int i = 0; i < 8; i++) {
            vec3 ripple = uRipples[i];
            if (ripple.z <= 0.0) continue;
            float age = ripple.z;
            float radius = age * 9.0;
            float dist = length(vWorld - ripple.xy);
            float ring = smoothstep(1.5, 0.0, abs(dist - radius));
            color += uAccent * ring * max(0.0, 1.0 - age * 0.75) * uQuality;
        }

        float alpha = line * 0.42 * vFade + pulse * 0.1 * vFade;
        gl_FragColor = vec4(color, alpha * (1.0 + uHyper * 0.4));
    }
`;

const CORE_FRAGMENT = /* glsl */`
    uniform float uTime;
    uniform vec3 uColor;
    uniform vec3 uAccent;
    uniform float uIntegrity;   // 0..1
    uniform float uHit;         // hit flash
    uniform float uHyper;

    varying vec3 vNormal;
    varying vec3 vViewDir;

    void main() {
        float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0), 2.2);
        float pulse = 0.5 + 0.5 * sin(uTime * (2.0 + uHyper * 5.0));
        float heartbeat = 0.5 + 0.5 * sin(uTime * (3.0 + (1.0 - uIntegrity) * 9.0));

        vec3 color = mix(uColor, uAccent, fresnel * (0.6 + uHyper * 0.4));
        color += uAccent * fresnel * (0.5 + pulse * 0.5) * (0.4 + uHyper * 0.8);
        color += vec3(1.0) * uHit;
        color *= 0.55 + 0.45 * heartbeat * (0.4 + uIntegrity * 0.6);

        gl_FragColor = vec4(color, 0.86 + fresnel * 0.14);
    }
`;

export function createArena(options = {}) {
    const scene = options.scene;
    const group = new THREE.Group();
    group.name = 'arena';
    scene?.add(group);

    const skin = options.skin || { grid: 0x00f0ff, fog: 0x050814, accent: 0xff00e6 };

    /* ------------------------------------------------------------ backdrop -- */

    const backdropUniforms = {
        uTime: { value: 0 },
        uParallax: { value: new THREE.Vector2(0, 0) },
        uTint: { value: new THREE.Color(skin.grid).multiplyScalar(0.25) },
        uHyper: { value: 0 },
        uDamage: { value: 0 }
    };

    // Sized to comfortably overfill the frustum at its distance.
    const backdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 68),
        new THREE.ShaderMaterial({
            uniforms: backdropUniforms,
            vertexShader: BACKDROP_VERTEX,
            fragmentShader: BACKDROP_FRAGMENT,
            depthWrite: false,
            depthTest: false,
            toneMapped: false
        })
    );
    backdrop.position.set(0, 0, -22);
    backdrop.renderOrder = 0;
    group.add(backdrop);

    /* ---------------------------------------------------------------- grid -- */

    const rippleUniforms = {
        uRipples: { value: new Array(8).fill(0).map(() => new THREE.Vector3(0, 0, 0)) }
    };

    const gridUniforms = {
        uTime: { value: 0 },
        uGridColor: { value: new THREE.Color(skin.grid) },
        uAccent: { value: new THREE.Color(skin.accent) },
        uHyper: { value: 0 },
        uQuality: { value: 1 },
        uRipples: rippleUniforms.uRipples
    };

    const grid = new THREE.Mesh(
        new THREE.PlaneGeometry(ARENA.grid.size, ARENA.grid.size, 1, 1),
        new THREE.ShaderMaterial({
            uniforms: gridUniforms,
            vertexShader: GRID_VERTEX,
            fragmentShader: GRID_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide
        })
    );
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = -0.01;
    grid.renderOrder = 2;
    group.add(grid);

    /* ---------------------------------------------------------------- core -- */

    const coreUniforms = {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x0d6dff) },
        uAccent: { value: new THREE.Color(skin.grid) },
        uIntegrity: { value: 1 },
        uHit: { value: 0 },
        uHyper: { value: 0 }
    };

    const coreMaterial = new THREE.ShaderMaterial({
        uniforms: coreUniforms,
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
        fragmentShader: CORE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });

    const core = new THREE.Mesh(new THREE.OctahedronGeometry(ARENA.core.radius * 0.72, 0), coreMaterial);
    core.position.set(ARENA.core.x, ARENA.core.y, ARENA.core.z);
    core.renderOrder = 6;
    group.add(core);

    const coreShell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(ARENA.core.radius * 1.16, 1),
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(skin.grid),
            wireframe: true,
            transparent: true,
            opacity: 0.24,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );
    coreShell.position.copy(core.position);
    coreShell.renderOrder = 5;
    group.add(coreShell);

    const coreRing = new THREE.Mesh(
        new THREE.TorusGeometry(ARENA.core.radius * 1.55, 0.035, 8, 64),
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(skin.accent),
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );
    coreRing.position.copy(core.position);
    coreRing.rotation.x = Math.PI / 2;
    coreRing.renderOrder = 5;
    group.add(coreRing);

    /* ------------------------------------------------------ core locators -- */

    /*
     * Traceability kit for the thing the player must always be able to find.
     * The crystal is only ~1 unit wide in a 44x26 arena, so three cheap
     * additive cues mark it from any angle and distance:
     *   - a bright ground disc at the core's feet (visible across the arena),
     *   - a vertical beacon beam so the core reads even in the player's
     *     peripheral vision, or when the body is hidden behind enemies,
     *   - a slow sonar halo expanding outward once per ~2.4s, which draws the
     *     eye inward without ever being mistaken for an impact ripple (those
     *     live in the grid shader, this one is geometry).
     */
    const coreDisc = new THREE.Mesh(
        new THREE.CircleGeometry(ARENA.core.radius * 2.6, 40),
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(skin.grid),
            transparent: true,
            opacity: 0.28,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );
    coreDisc.rotation.x = -Math.PI / 2;
    coreDisc.position.set(ARENA.core.x, 0.03, ARENA.core.z);
    coreDisc.renderOrder = 3;
    group.add(coreDisc);

    const beaconHeight = 15;
    const coreBeacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.14, beaconHeight, 8, 1, true),
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(0x66ccff),
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide
        })
    );
    coreBeacon.position.set(ARENA.core.x, beaconHeight / 2, ARENA.core.z);
    coreBeacon.renderOrder = 4;
    group.add(coreBeacon);

    const coreHalo = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.05, 6, 64),
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(skin.accent),
            transparent: true,
            opacity: 0.55,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );
    coreHalo.rotation.x = Math.PI / 2;
    coreHalo.position.set(ARENA.core.x, 0.04, ARENA.core.z);
    coreHalo.renderOrder = 4;
    group.add(coreHalo);

    /* --------------------------------------------------------------- motes -- */

    const moteCount = 320;
    const motePositions = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) {
        motePositions[i * 3] = (Math.random() - 0.5) * 46;
        motePositions[i * 3 + 1] = Math.random() * 16 - 2;
        motePositions[i * 3 + 2] = (Math.random() - 0.5) * 40;
    }
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
    const motes = new THREE.Points(moteGeometry, new THREE.PointsMaterial({
        color: new THREE.Color(skin.grid),
        size: 0.16,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true
    }));
    motes.renderOrder = 3;
    group.add(motes);

    if (scene) scene.fog = new THREE.Fog(skin.fog, 26, 96);

    /* -------------------------------------------------------------- state --- */

    const state = {
        time: 0,
        parallax: new THREE.Vector2(0, 0),
        targetParallax: new THREE.Vector2(0, 0),
        integrity: 1,
        hit: 0,
        hyper: 0,
        damage: 0,
        rippleCursor: 0,
        haloAge: 0,
        haloPeriod: 2.4
    };

    return {
        group,
        core,
        backdrop,
        grid,
        uniforms: {
            backdrop: backdropUniforms,
            grid: gridUniforms,
            core: coreUniforms
        },

        get corePosition() { return core.position; },

        setSkin(next) {
            const palette = next || skin;
            gridUniforms.uGridColor.value.set(palette.grid);
            gridUniforms.uAccent.value.set(palette.accent);
            backdropUniforms.uTint.value.set(palette.grid).multiplyScalar(0.25);
            coreUniforms.uAccent.value.set(palette.grid);
            coreShell.material.color.set(palette.grid);
            coreRing.material.color.set(palette.accent);
            coreDisc.material.color.set(palette.grid);
            coreHalo.material.color.set(palette.accent);
            motes.material.color.set(palette.grid);
            if (scene && scene.fog) scene.fog.color.set(palette.fog);
            return palette;
        },

        /** Ground ripple under an impact. */
        ripple(x, z = 0, strength = 1) {
            const index = state.rippleCursor % 8;
            state.rippleCursor += 1;
            rippleUniforms.uRipples.value[index].set(x, z, Math.max(0.001, Math.min(1.4, 0.35 + strength * 0.4)));
            return index;
        },

        setCoreIntegrity(value) {
            state.integrity = Math.max(0, Math.min(1, value));
            coreUniforms.uIntegrity.value = state.integrity;
            coreShell.material.opacity = 0.14 + state.integrity * 0.2;
            return state.integrity;
        },

        setCoreHit(strength = 1) {
            state.hit = Math.min(1, state.hit + strength);
            return state.hit;
        },

        /** Mouse parallax, so the world feels like a space rather than a poster. */
        setPointerAim(ndcX, ndcY) {
            state.targetParallax.set(-ndcX * 0.6, -ndcY * 0.4);
        },

        setDamage(value) {
            state.damage = Math.max(0, Math.min(1, value));
            backdropUniforms.uDamage.value = state.damage;
        },

        update(dt, ctx = {}) {
            state.time += dt;
            backdropUniforms.uTime.value = state.time;
            gridUniforms.uTime.value = state.time;
            coreUniforms.uTime.value = state.time;
            backdropUniforms.uDamage.value = state.damage;

            if (ctx.integrity !== undefined) this.setCoreIntegrity(ctx.integrity);

            // Age ripples; a zero age releases the slot for reuse.
            for (const ripple of rippleUniforms.uRipples.value) {
                if (ripple.z > 0) {
                    ripple.z += dt * 0.42;
                    if (ripple.z > 1.4) ripple.z = 0;
                }
            }

            state.hyper = ctx.hyper ? 1 : Math.max(0, state.hyper - dt * 2);
            gridUniforms.uHyper.value = damp(gridUniforms.uHyper.value, state.hyper, 4, dt);
            backdropUniforms.uHyper.value = gridUniforms.uHyper.value;
            coreUniforms.uHyper.value = gridUniforms.uHyper.value;

            state.hit = Math.max(0, state.hit - dt * 3.4);
            coreUniforms.uHit.value = state.hit;

            // Parallax easing.
            state.parallax.x = damp(state.parallax.x, state.targetParallax.x, 3.2, dt);
            state.parallax.y = damp(state.parallax.y, state.targetParallax.y, 3.2, dt);
            backdropUniforms.uParallax.value.copy(state.parallax);

            // Core idle motion: slow spin plus a hover bob.
            core.rotation.y += dt * 0.45;
            core.rotation.x += dt * 0.18;
            core.position.y = ARENA.core.y + Math.sin(state.time * 1.4) * 0.07;
            coreRing.rotation.z += dt * 0.6;
            coreShell.rotation.y -= dt * 0.25;
            coreShell.position.y = core.position.y;

            // Locator cues follow the bobbing crystal. The disc breathes with
            // integrity and flares on a hit; the beacon dims as the core weakens
            // (a faltering light reads as "the core is in trouble"); the halo
            // expands once per cycle and releases its slot at full spread.
            coreDisc.position.set(ARENA.core.x, 0.03, ARENA.core.z);
            coreDisc.material.opacity = 0.16 + state.integrity * 0.14 + state.hit * 0.5;
            const discPulse = 1 + Math.sin(state.time * 2.1) * 0.05;
            coreDisc.scale.setScalar(discPulse * (0.8 + (1 - state.integrity) * 0.45));
            coreBeacon.position.set(ARENA.core.x, beaconHeight / 2, ARENA.core.z);
            coreBeacon.material.opacity = 0.18 + state.integrity * 0.34;
            coreBeacon.rotation.y += dt * 0.9;
            coreHalo.position.set(ARENA.core.x, 0.04, ARENA.core.z);
            if (state.haloAge >= state.haloPeriod) state.haloAge = 0;
            state.haloAge += dt;
            const haloProgress = state.haloAge / state.haloPeriod;
            coreHalo.scale.setScalar(1.2 + haloProgress * 9);
            coreHalo.material.opacity = 0.55 * (1 - haloProgress) * (0.5 + state.integrity * 0.5);

            motes.rotation.y += dt * 0.01;
        },

        setScreenAspect(aspect) {
            state.screenAspect = aspect;
            return aspect;
        },

        setQuality(config = {}) {
            gridUniforms.uQuality.value = config.ripples === 0 ? 0 : Math.max(0.2, config.ripples ?? 1);
            coreShell.material.wireframe = config.wireframe !== false;
            coreShell.visible = config.wireframe !== false;
            motes.visible = (config.ripples ?? 1) > 0.35;
            return config;
        },

        stats() {
            return {
                integrity: Math.round(state.integrity * 100) / 100,
                ripples: rippleUniforms.uRipples.value.filter((r) => r.z > 0).length
            };
        },

        dispose() {
            scene?.remove(group);
            group.traverse((child) => {
                child.geometry?.dispose?.();
                if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
                else child.material?.dispose?.();
            });
        }
    };
}
