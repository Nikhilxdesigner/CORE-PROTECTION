/**
 * Audio: synthesised SFX plus an adaptive music bed.
 *
 * No sample files, so nothing can 404 and there is no load hitch. Music is a
 * small scheduler that crossfades three layers (bass pulse, arp, hyper lead)
 * whose intensity follows combo, wave and Hyper Mode - the soundtrack escalates
 * with play without a composer.
 *
 * The context is created on the first user gesture (browser autoplay policy) and
 * every voice is disposable, so nothing leaks between runs.
 */

const NOTES = { A1: 55, C2: 65.41, D2: 73.42, E2: 82.41, G2: 98, A2: 110, C3: 130.81, D3: 146.83, E3: 164.81, G3: 196, A3: 220, C4: 261.63, D4: 293.66, E4: 329.63 };
const BASS_SEQUENCE = [NOTES.A1, NOTES.A1, NOTES.C2, NOTES.G2];
const ARP_SEQUENCE = [NOTES.A3, NOTES.C4, NOTES.E4, NOTES.D4, NOTES.C4, NOTES.E4, NOTES.G3, NOTES.A3];

export function createAudio(options = {}) {
    const bus = options.bus || null;

    const state = {
        context: null,
        master: null,
        sfxGain: null,
        musicGain: null,
        noiseBuffer: null,
        musicTimer: null,
        musicStep: 0,
        intensity: 0,
        targetIntensity: 0,
        hyper: false,
        muted: false,
        sfxVolume: options.sfxVolume ?? 0.7,
        musicVolume: options.musicVolume ?? 0.45,
        started: false,
        voices: 0
    };

    function ensureContext() {
        if (state.context) return state.context;
        const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!Ctor) return null;
        try {
            state.context = new Ctor();
        } catch (err) {
            console.warn('[audio] AudioContext unavailable:', err);
            return null;
        }
        state.master = state.context.createGain();
        state.master.gain.value = state.muted ? 0 : 1;
        state.master.connect(state.context.destination);

        state.sfxGain = state.context.createGain();
        state.sfxGain.gain.value = state.sfxVolume;
        state.sfxGain.connect(state.master);

        state.musicGain = state.context.createGain();
        state.musicGain.gain.value = state.musicVolume;
        state.musicGain.connect(state.master);

        // Two seconds of noise, reused by every explosion.
        const length = Math.floor(state.context.sampleRate * 2);
        const buffer = state.context.createBuffer(1, length, state.context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        state.noiseBuffer = buffer;

        return state.context;
    }

    function resume() {
        const context = ensureContext();
        if (context && context.state === 'suspended') context.resume().catch(() => {});
        return context;
    }

    /**
     * One-shot oscillator voice.
     * @param {object} preset {freq, type, duration, decay, slide, volume, detune}
     */
    function tone(preset) {
        const context = resume();
        if (!context || state.muted) return null;

        const now = context.currentTime;
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        oscillator.type = preset.type || 'sine';
        oscillator.frequency.setValueAtTime(preset.freq, now);
        if (preset.slide) {
            const target = Math.max(20, preset.freq + preset.slide);
            oscillator.frequency.exponentialRampToValueAtTime(target, now + (preset.duration || 0.2));
        }
        if (preset.detune) oscillator.detune.value = preset.detune;

        const peak = Math.max(0.0001, (preset.volume ?? 0.6));
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(peak, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + (preset.decay || preset.duration || 0.2));

        oscillator.connect(gain);
        gain.connect(preset.destination || state.sfxGain);
        oscillator.start(now);
        oscillator.stop(now + (preset.duration || 0.2) + 0.05);
        state.voices += 1;
        oscillator.onended = () => { state.voices -= 1; };
        return oscillator;
    }

    function noiseBurst({ duration = 0.4, cutoff = 1200, volume = 0.5, sweep = -900, type = 'lowpass' } = {}) {
        const context = resume();
        if (!context || state.muted || !state.noiseBuffer) return;
        const now = context.currentTime;

        const source = context.createBufferSource();
        source.buffer = state.noiseBuffer;

        const filter = context.createBiquadFilter();
        filter.type = type;
        filter.frequency.setValueAtTime(cutoff, now);
        if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(60, cutoff + sweep), now + duration);

        const gain = context.createGain();
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        source.connect(filter);
        filter.connect(gain);
        gain.connect(state.sfxGain);
        source.start(now);
        source.stop(now + duration);
    }

    /* ------------------------------------------------------------- SFX API -- */

    const sfx = {
        shoot() {
            tone({ freq: 900, type: 'square', duration: 0.07, decay: 0.06, slide: -520, volume: 0.18 });
            tone({ freq: 1500, type: 'sine', duration: 0.04, decay: 0.035, slide: -700, volume: 0.09 });
        },
        hit() {
            tone({ freq: 320, type: 'triangle', duration: 0.08, decay: 0.07, slide: -160, volume: 0.22 });
        },
        kill() {
            tone({ freq: 200, type: 'sawtooth', duration: 0.16, decay: 0.15, slide: -120, volume: 0.26 });
            noiseBurst({ duration: 0.18, cutoff: 1800, volume: 0.2 });
        },
        explosion() {
            noiseBurst({ duration: 0.55, cutoff: 1400, volume: 0.42, sweep: -1200 });
            tone({ freq: 90, type: 'sawtooth', duration: 0.5, decay: 0.45, slide: -50, volume: 0.3 });
        },
        bossHit() {
            tone({ freq: 140, type: 'sawtooth', duration: 0.22, decay: 0.2, slide: -60, volume: 0.3 });
            noiseBurst({ duration: 0.25, cutoff: 900, volume: 0.24 });
        },
        coreDamage() {
            noiseBurst({ duration: 0.7, cutoff: 700, volume: 0.5, sweep: -500 });
            tone({ freq: 160, type: 'square', duration: 0.6, decay: 0.55, slide: -90, volume: 0.34 });
        },
        coreHeal() {
            tone({ freq: 620, type: 'sine', duration: 0.3, decay: 0.28, slide: 420, volume: 0.26 });
        },
        combo(level = 1) {
            const base = 780 + Math.min(level, 12) * 40;
            tone({ freq: base, type: 'sine', duration: 0.14, decay: 0.12, slide: 120, volume: 0.2 });
        },
        powerup() {
            tone({ freq: 520, type: 'triangle', duration: 0.35, decay: 0.32, slide: 620, volume: 0.3 });
            tone({ freq: 780, type: 'sine', duration: 0.35, decay: 0.3, slide: 520, volume: 0.18 });
        },
        hyperStart() {
            tone({ freq: 180, type: 'sawtooth', duration: 0.9, decay: 0.85, slide: 900, volume: 0.34 });
            noiseBurst({ duration: 0.9, cutoff: 4000, volume: 0.3, sweep: -3000, type: 'bandpass' });
        },
        hyperEnd() {
            tone({ freq: 700, type: 'sawtooth', duration: 0.5, decay: 0.45, slide: -520, volume: 0.24 });
        },
        waveStart(wave = 1) {
            const semitone = Math.min(9, wave) * 0.6;
            tone({ freq: 300 * Math.pow(1.06, semitone), type: 'triangle', duration: 0.5, decay: 0.45, slide: 120, volume: 0.26 });
        },
        bossStart() {
            tone({ freq: 70, type: 'sawtooth', duration: 1.4, decay: 1.3, slide: 20, volume: 0.4 });
            noiseBurst({ duration: 1.4, cutoff: 500, volume: 0.3, sweep: -350 });
        },
        hazardBeep() {
            tone({ freq: 1200, type: 'square', duration: 0.06, decay: 0.05, volume: 0.14 });
        },
        ui() {
            tone({ freq: 1100, type: 'sine', duration: 0.05, decay: 0.045, volume: 0.14 });
        },
        uiConfirm() {
            tone({ freq: 880, type: 'sine', duration: 0.12, decay: 0.1, volume: 0.2 });
            tone({ freq: 1320, type: 'sine', duration: 0.14, decay: 0.12, volume: 0.14 });
        },
        gameOver() {
            tone({ freq: 420, type: 'sawtooth', duration: 1.2, decay: 1.1, slide: -260, volume: 0.34 });
            tone({ freq: 210, type: 'triangle', duration: 1.4, decay: 1.3, slide: -110, volume: 0.24 });
        },
        draft() {
            tone({ freq: 660, type: 'sine', duration: 0.2, decay: 0.18, slide: 220, volume: 0.22 });
        }
    };

    /* ------------------------------------------------------------ music bed -- */

    function musicTick() {
        const context = state.context;
        if (!context || state.muted) return;
        const now = context.currentTime;
        const step = state.musicStep;
        const intensity = state.intensity;

        // Bass pulse, always present.
        const bassFreq = BASS_SEQUENCE[step % BASS_SEQUENCE.length];
        tone({
            freq: bassFreq,
            type: 'triangle',
            duration: 0.36,
            decay: 0.34,
            volume: 0.16 + intensity * 0.12,
            destination: state.musicGain
        });

        // Arpeggio from medium intensity up.
        if (intensity > 0.25 && step % 2 === 0) {
            tone({
                freq: ARP_SEQUENCE[step % ARP_SEQUENCE.length],
                type: 'square',
                duration: 0.12,
                decay: 0.1,
                volume: 0.05 + intensity * 0.08,
                destination: state.musicGain
            });
        }

        // Lead layer only during Hyper Mode.
        if (state.hyper && step % 4 === 3) {
            const root = 330 * Math.pow(1.06, step % 5);
            tone({ freq: root, type: 'sawtooth', duration: 0.3, decay: 0.26, slide: 180, volume: 0.12, destination: state.musicGain });
            tone({ freq: root * 1.5, type: 'sine', duration: 0.3, decay: 0.26, slide: 90, volume: 0.08, destination: state.musicGain });
        }

        if (intensity > 0.75 && step % 8 === 0) {
            noiseBurst({ duration: 0.2, cutoff: 6000, volume: 0.05, type: 'highpass' });
        }

        state.musicStep = (step + 1) % 16;
        void now;
    }

    function startMusic() {
        if (state.musicTimer || state.muted) return;
        state.musicStep = 0;
        state.musicTimer = setInterval(musicTick, 260);
    }

    function stopMusic() {
        if (state.musicTimer) clearInterval(state.musicTimer);
        state.musicTimer = null;
    }

    return {
        sfx,
        get started() { return state.started; },
        get muted() { return state.muted; },
        get voices() { return state.voices; },
        get contextState() { return state.context?.state || 'none'; },
        get intensity() { return state.intensity; },

        /** Call from a user gesture. Safe to call repeatedly. */
        init() {
            if (state.started) return true;
            const context = ensureContext();
            if (!context) return false;
            state.started = true;
            resume();
            startMusic();
            return true;
        },

        /** Music/swell intensity 0..1, driven by combo, wave and Hyper. */
        setIntensity(value) {
            state.targetIntensity = Math.max(0, Math.min(1, value));
        },

        /** Smoothly approach the target intensity (called from the render loop). */
        update(dt) {
            const target = state.targetIntensity;
            state.intensity += (target - state.intensity) * Math.min(1, dt * 2.2);
            return state.intensity;
        },

        setHyper(active) {
            state.hyper = !!active;
        },

        setMusicVolume(value) {
            state.musicVolume = Math.max(0, Math.min(1, value));
            if (state.musicGain) state.musicGain.gain.value = state.musicVolume;
        },

        setSfxVolume(value) {
            state.sfxVolume = Math.max(0, Math.min(1, value));
            if (state.sfxGain) state.sfxGain.gain.value = state.sfxVolume;
        },

        toggleMute() {
            state.muted = !state.muted;
            if (state.master) state.master.gain.value = state.muted ? 0 : 1;
            if (state.muted) stopMusic();
            else startMusic();
            return state.muted;
        },

        setMuted(value) {
            if (state.muted !== !!value) return this.toggleMute();
            return state.muted;
        },

        suspend() {
            stopMusic();
            state.context?.suspend?.().catch?.(() => {});
        },

        resumeAudio() {
            resume();
            startMusic();
        },

        stats() {
            return {
                started: state.started,
                context: state.contextState,
                voices: state.voices,
                intensity: Math.round(state.intensity * 100) / 100,
                muted: state.muted,
                hyper: state.hyper
            };
        }
    };
}
