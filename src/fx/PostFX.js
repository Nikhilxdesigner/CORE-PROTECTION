/**
 * Post-processing chain.
 *
 *   RenderPass -> UnrealBloomPass -> custom grade/distortion pass -> OutputPass
 *
 * The custom pass carries the "high graphics" character: barrel distortion,
 * chromatic aberration, scanlines, film grain, a Hyper Mode speed warp, damage
 * vignette, and SDF shockwaves pushed into the UVs on every impact. Every dial
 * is a uniform, so the quality governor can switch effects *off* without
 * rebuilding the chain, and accessibility settings can damp the ones that cause
 * motion discomfort.
 *
 * OutputPass is required after bloom so tone mapping and colour space are
 * applied once, at the end.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const MAX_IMPACTS = 6;

const POST_VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const POST_FRAGMENT = /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uChromatic;
    uniform float uDistortion;
    uniform float uScanlines;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uHyper;
    uniform float uDamage;
    uniform float uFlash;
    uniform float uMotionScale;
    uniform vec2 uImpactPos[${MAX_IMPACTS}];
    uniform vec2 uImpactData[${MAX_IMPACTS}];

    varying vec2 vUv;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
        vec2 uv = vUv;
        vec2 centered = vUv - 0.5;
        float r2 = dot(centered, centered);

        // Barrel distortion, exaggerated while Hyper is running.
        float warp = uDistortion * 0.055 * (0.6 + uHyper * 0.8);
        uv += centered * r2 * warp;

        // Impact shockwaves displace UVs radially.
        for (int i = 0; i < ${MAX_IMPACTS}; i++) {
            vec2 data = uImpactData[i];
            if (data.x <= 0.0) continue;
            vec2 delta = vUv - uImpactPos[i];
            float radius = length(delta);
            float ring = data.x * 0.55;
            float band = smoothstep(0.085, 0.0, abs(radius - ring));
            uv += normalize(delta + vec2(0.0001)) * band * 0.03 * data.y * uMotionScale;
        }

        float ca = uChromatic * (0.5 + r2 * 3.2) * (1.0 + uHyper * 2.2) * uMotionScale;

        vec3 color;
        color.r = texture2D(tDiffuse, uv + centered * ca).r;
        color.g = texture2D(tDiffuse, uv).g;
        color.b = texture2D(tDiffuse, uv - centered * ca).b;

        // Hyper Mode colour grade: hotter highlights, cooler shadows.
        if (uHyper > 0.001) {
            vec3 hyper = color * vec3(1.12, 0.94, 1.22);
            hyper += vec3(0.06, 0.0, 0.12) * uHyper;
            color = mix(color, hyper, uHyper);
        }

        if (uScanlines > 0.0001) {
            float lines = 0.5 + 0.5 * sin(vUv.y * uResolution.y * 1.35);
            color *= 1.0 - uScanlines * lines;
        }

        if (uGrain > 0.0001) {
            float noise = hash(vUv * uResolution + fract(uTime) * 137.0);
            color += (noise - 0.5) * uGrain;
        }

        // Damage feedback: red creeping in from the edges of the frame.
        if (uDamage > 0.0001) {
            float edge = smoothstep(0.08, 0.55, r2);
            color = mix(color, vec3(0.85, 0.05, 0.12), edge * uDamage * 0.75 * uMotionScale);
        }

        // Base cinematic vignette.
        color *= 1.0 - uVignette * smoothstep(0.12, 0.8, r2);

        if (uFlash > 0.0001) {
            color = mix(color, vec3(1.0), uFlash * uMotionScale);
        }

        gl_FragColor = vec4(color, 1.0);
    }
`;

export function createPostFX(options = {}) {
    const renderer = options.renderer;
    const scene = options.scene;
    const camera = options.camera;
    const size = options.size || { width: 1280, height: 720 };

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(options.pixelRatio ?? 1);
    composer.setSize(size.width, size.height);

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.width, size.height),
        options.bloomStrength ?? 0.7,
        options.bloomRadius ?? 0.55,
        options.bloomThreshold ?? 0.55
    );
    composer.addPass(bloomPass);

    const uniforms = {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(size.width, size.height) },
        uTime: { value: 0 },
        uChromatic: { value: 0.0018 },
        uDistortion: { value: 1.15 },
        uScanlines: { value: 0.05 },
        uGrain: { value: 0.045 },
        uVignette: { value: 0.55 },
        uHyper: { value: 0 },
        uDamage: { value: 0 },
        uFlash: { value: 0 },
        uMotionScale: { value: 1 },
        uImpactPos: { value: new Array(MAX_IMPACTS).fill(0).map(() => new THREE.Vector2(0, 0)) },
        uImpactData: { value: new Array(MAX_IMPACTS).fill(0).map(() => new THREE.Vector2(0, 0)) }
    };

    const gradePass = new ShaderPass({
        uniforms,
        vertexShader: POST_VERTEX,
        fragmentShader: POST_FRAGMENT
    });
    composer.addPass(gradePass);

    const outputPass = new OutputPass();
    composer.addPass(outputPass);

    const state = {
        hyper: 0,
        damage: 0,
        flash: 0,
        motionScale: 1,
        reducedMotion: false,
        pixelRatio: options.pixelRatio ?? 1,
        width: size.width,
        height: size.height,
        renderScale: 1,
        impactCursor: 0,
        impulses: 0
    };

    return {
        composer,
        bloomPass,
        gradePass,
        renderPass,
        outputPass,
        uniforms,

        get reducedMotion() { return state.reducedMotion; },

        setSize(width, height) {
            state.width = Math.max(2, Math.floor(width));
            state.height = Math.max(2, Math.floor(height));
            composer.setSize(state.width, state.height);
            uniforms.uResolution.value.set(state.width, state.height);
            bloomPass.resolution.set(
                Math.max(64, uniforms.uResolution.value.x * 0.5),
                Math.max(64, uniforms.uResolution.value.y * 0.5)
            );
            return this;
        },

        setPixelRatio(ratio) {
            state.pixelRatio = Math.max(0.5, Math.min(2.5, ratio));
            composer.setPixelRatio(state.pixelRatio);
            return this;
        },

        setBloom(config = {}) {
            bloomPass.enabled = config.enabled !== false;
            if (config.strength !== undefined) bloomPass.strength = config.strength;
            if (config.radius !== undefined) bloomPass.radius = config.radius;
            if (config.threshold !== undefined) bloomPass.threshold = config.threshold;
            if (config.resolution !== undefined) {
                // Bloom runs at its own (quarter-ish) resolution: the biggest
                // single lever the governor has.
                const res = Math.max(64, config.resolution);
                bloomPass.resolution.set(res, res);
            }
            return this;
        },

        /** Apply a quality tier's post config. */
        setPost(config = {}) {
            if (config.chromatic !== undefined) uniforms.uChromatic.value = config.chromatic;
            if (config.distortion !== undefined) uniforms.uDistortion.value = config.distortion;
            if (config.scanlines !== undefined) uniforms.uScanlines.value = config.scanlines;
            if (config.grain !== undefined) uniforms.uGrain.value = config.grain;
            return this;
        },

        setVignette(value) {
            uniforms.uVignette.value = value;
            return this;
        },

        /** Push a shockwave at a screen-space UV position. */
        impact(u, v, strength = 1) {
            const index = state.impactCursor % MAX_IMPACTS;
            state.impactCursor += 1;
            state.impulses += 1;
            uniforms.uImpactPos.value[index].set(u, v);
            uniforms.uImpactData.value[index].set(0.0001, Math.min(2, strength) * (state.reducedMotion ? 0.35 : 1));
            return index;
        },

        setHyper(value) {
            state.hyper = Math.max(0, Math.min(1, value));
            uniforms.uHyper.value = state.hyper;
            return this;
        },

        setDamage(value) {
            state.damage = Math.max(0, Math.min(1, value));
            uniforms.uDamage.value = state.damage;
            return this;
        },

        setFlash(value) {
            state.flash = Math.max(0, Math.min(1, value));
            uniforms.uFlash.value = state.flash;
            return this;
        },

        setReducedMotion(value) {
            state.reducedMotion = !!value;
            state.motionScale = state.reducedMotion ? 0.35 : 1;
            uniforms.uMotionScale.value = state.motionScale;
            return this;
        },

        update(dt) {
            uniforms.uTime.value += dt;

            // Age shockwaves; a zero age marks the slot as free.
            let active = 0;
            for (const data of uniforms.uImpactData.value) {
                if (data.x > 0) {
                    data.x += dt;
                    if (data.x > 1.1) data.x = 0;
                    else active += 1;
                }
            }
            state.activeImpacts = active;

            // Damage vignette eases away on its own.
            if (state.damage > 0) {
                state.damage = Math.max(0, state.damage - dt * 1.6);
                uniforms.uDamage.value = state.damage;
            }
            if (state.flash > 0) {
                state.flash = Math.max(0, state.flash - dt * 3.2);
                uniforms.uFlash.value = state.flash;
            }
            return this;
        },

        render() {
            composer.render();
        },

        stats() {
            return {
                bloom: bloomPass.enabled,
                bloomStrength: bloomPass.strength,
                chromatic: uniforms.uChromatic.value,
                distortion: uniforms.uDistortion.value,
                scanlines: uniforms.uScanlines.value,
                grain: uniforms.uGrain.value,
                hyper: uniforms.uHyper.value,
                damage: Math.round(uniforms.uDamage.value * 100) / 100,
                activeImpacts: state.activeImpacts || 0,
                impulses: state.impulses,
                reducedMotion: state.reducedMotion,
                pixelRatio: state.pixelRatio
            };
        },

        dispose() {
            composer.dispose?.();
            bloomPass.dispose?.();
            gradePass.dispose?.();
        }
    };
}
