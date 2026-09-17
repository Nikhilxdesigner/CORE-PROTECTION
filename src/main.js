/**
 * Composition root.
 *
 * The only module that knows about every system: it builds them, injects them
 * into each other through the engine, and owns the fatal-error path. Everything
 * else talks to the event bus or to the interfaces it was handed, which is what
 * keeps the dependency graph acyclic.
 *
 * Also exposed on `window.CD3D` for console debugging (and used by the run
 * recorder's replay entry point).
 */

import { createEventBus } from './core/Events.js';
import { createEngine } from './core/Engine.js';
import { createPlayerStorage } from './util/Storage.js';
import { createAudio } from './audio/Audio.js';
import { createHUD } from './ui/HUD.js';
import { createScreens } from './ui/Screens.js';
import { createInput } from './ui/Input.js';
import { createDebugPanel } from './ui/DebugPanel.js';
import { detectPlatform } from './core/Quality.js';

function showFatal(message, detail = '') {
    const boot = document.getElementById('screen-boot');
    const fatal = document.getElementById('screen-fatal');
    const msg = document.getElementById('fatal-msg');
    const det = document.getElementById('fatal-detail');
    if (msg) msg.textContent = message;
    if (det) det.textContent = detail;
    boot?.classList.remove('active');
    fatal?.classList.add('active');
}

function supportsWebGL2() {
    try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2');
        if (!context) return false;
        context.getExtension('WEBGL_lose_context')?.loseContext();
        return true;
    } catch {
        return false;
    }
}

async function boot() {
    const params = new URLSearchParams(window.location.search);
    const debugEnabled = params.get('debug') === '1';

    if (!supportsWebGL2()) {
        showFatal(
            'This game needs WebGL2',
            'Your browser or GPU driver does not expose WebGL2, which the 3D renderer requires. Try a recent Chrome, Edge, Firefox or Safari, or enable hardware acceleration.'
        );
        return;
    }

    const bus = createEventBus({ history: debugEnabled, strict: debugEnabled });
    const storage = createPlayerStorage();
    const platform = detectPlatform();
    const debug = { enabled: debugEnabled };

    const audio = createAudio({ bus });
    const hud = createHUD({ bus });
    const screens = createScreens({ bus });
    const input = createInput({ bus });
    const debugPanel = createDebugPanel({ bus });

    const engine = createEngine({
        bus,
        storage,
        audio,
        hud,
        screens,
        input,
        debugPanel
    });

    engine.debugPanel = debugPanel;
    engine.boot();

    // Console surface: window.CD3D.debug.* plus the engine itself.
    window.CD3D = {
        engine,
        bus,
        debug: engine.debugApi(),
        stats: () => engine.debugApi().stats(),
        quality: (name) => engine.setQualityManual(name),
        version: '2.0.0'
    };

    // Clear the boot watchdog set up in index.html.
    window.__CD3D_BOOTED = true;

    window.addEventListener('error', (event) => {
        console.error('[cd3d] uncaught error:', event.error || event.message);
        bus.emit('RUNTIME_ERROR', { message: String(event.message || 'unknown') });
    });
    window.addEventListener('unhandledrejection', (event) => {
        console.error('[cd3d] unhandled rejection:', event.reason);
        bus.emit('RUNTIME_ERROR', { message: String(event.reason?.message || event.reason || 'unknown') });
    });

    window.addEventListener('beforeunload', () => engine.shutdown());
    window.addEventListener('pagehide', () => engine.shutdown());

    bus.on('RUNTIME_ERROR', (event) => {
        if (debugEnabled) screens.toast(`Error: ${event.message}`, 'warn');
    });

    console.log('%cCAMERA DEFENSE: OVERDRIVE', 'color:#00f0ff;font-size:20px;font-weight:bold');
    console.log(`%cplatform: ${platform} · quality: ${engine.quality.name} · WebGL2`,
        'color:#8888aa');
}

boot().catch((error) => {
    console.error('[cd3d] boot failed:', error);
    showFatal('The game failed to start', String(error?.message || error));
});
