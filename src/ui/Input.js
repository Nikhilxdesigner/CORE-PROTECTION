/**
 * Input.
 *
 * Aim is continuous: moving the mouse retargets the crosshair, and holding the
 * button fires at the weapon's rate. Touch drags to aim (with a vertical offset
 * so the crosshair is not hidden under the finger) and tap-fires.
 *
 * Two rules learned the hard way from the earlier build:
 *   1. a click on a UI element must never fire a weapon,
 *   2. losing focus mid-drag must release the trigger.
 */

import { TIER_NAMES } from '../core/Quality.js';

export function createInput(options = {}) {
    const win = options.window || window;
    const doc = options.document || document;
    const bus = options.bus;
    const touchAimOffsetY = options.touchAimOffsetY ?? -68;

    const state = {
        fireHeld: false,
        pointerType: 'mouse',
        aimClient: { x: 0, y: 0 },
        bound: false,
        pointerId: null,
        dragging: false,
        hotkeys: 0,
        uiBlocks: 0,
        lastAimAt: 0
    };

    let engine = null;
    const listeners = [];

    function on(target, type, handler, opts) {
        target.addEventListener(type, handler, opts);
        listeners.push(() => target.removeEventListener(type, handler, opts));
    }

    /** True when the pointer landed on interactive UI rather than the stage. */
    function isUiTarget(event) {
        const element = event.target;
        if (!element || element === doc.body || element === doc.documentElement) return false;
        return !!element.closest?.('button, a, input, select, textarea, label, .draft-card, .screen.active:not(#screen-game):not(#screen-draft)');
    }

    function gameplayVisible() {
        const draft = doc.getElementById('screen-draft');
        const game = doc.getElementById('screen-game');
        const draftActive = draft?.classList.contains('active');
        const gameActive = game?.classList.contains('active');
        return gameActive || draftActive;
    }

    function aimFrom(clientX, clientY, pointerType) {
        state.pointerType = pointerType;
        state.aimClient.x = clientX;
        state.aimClient.y = clientY;
        const y = pointerType === 'touch' ? clientY + touchAimOffsetY : clientY;
        engine?.handleAim(clientX, y);
        state.lastAimAt = performance.now();
    }

    function onPointerMove(event) {
        if (!gameplayVisible()) return;
        if (isUiTarget(event)) return;
        aimFrom(event.clientX, event.clientY, event.pointerType || 'mouse');
    }

    function onPointerDown(event) {
        engine?.audio?.init();
        if (!gameplayVisible()) return;
        if (draftOpen()) return;
        if (isUiTarget(event)) {
            state.uiBlocks += 1;
            return;                     // UI clicks never fire
        }
        if (event.button !== undefined && event.button !== 0) return;

        state.pointerType = event.pointerType || 'mouse';
        state.pointerId = event.pointerId ?? null;
        state.dragging = true;
        win.getSelection?.()?.removeAllRanges?.();
        aimFrom(event.clientX, event.clientY, state.pointerType);
        setFire(true);
    }

    function onPointerUp(event) {
        if (event && state.pointerId !== null && event.pointerId !== undefined && event.pointerId !== state.pointerId) return;
        state.dragging = false;
        setFire(false);
    }

    function onPointerLeave() {
        setFire(false);
    }

    function draftOpen() {
        return doc.getElementById('screen-draft')?.classList.contains('active') || false;
    }

    function setFire(held) {
        if (state.fireHeld === held) return;
        state.fireHeld = held;
        engine?.handleFire(held);
        bus?.emit('INPUT_FIRE', { held, pointerType: state.pointerType });
    }

    function onKeyDown(event) {
        if (event.repeat) {
            // Allow held fire on Space, ignore other repeats.
            if (event.code === 'Space') return;
        }

        switch (event.code) {
            case 'Space': {
                if (draftOpen()) return;
                event.preventDefault();
                if (gameplayVisible()) setFire(true);
                break;
            }
            case 'Escape': {
                event.preventDefault();
                if (state.fireHeld) setFire(false);
                if (!engine) break;
                if (engine.state.is(engine.STATES.RESULTS)) engine.returnToMenu();
                else if (draftOpen()) { /* draft must be answered */ }
                else engine.togglePause();
                break;
            }
            case 'KeyP': {
                engine?.togglePause();
                break;
            }
            case 'KeyM': {
                engine?.audio?.toggleMute();
                engine?.screens?.toast(engine.audio.muted ? 'Audio muted' : 'Audio on', 'info');
                break;
            }
            case 'KeyR': {
                if (engine?.state.is(engine.STATES.RESULTS) || engine?.state.is(engine.STATES.PAUSED)) engine.restartRun();
                break;
            }
            case 'F3':
            case 'Backquote': {
                event.preventDefault();
                engine?.debugPanel?.toggle();
                break;
            }
            case 'Digit1':
            case 'Digit2':
            case 'Digit3': {
                if (!draftOpen()) break;
                const index = Number(event.code.slice(-1)) - 1;
                const cards = doc.querySelectorAll('#draft-cards .draft-card');
                if (cards[index]) cards[index].click();
                break;
            }
            case 'KeyQ': {
                if (!engine?.debug.enabled) break;
                const current = TIER_NAMES.indexOf(engine.quality.name);
                const next = TIER_NAMES[(current + 1) % TIER_NAMES.length];
                engine.setQualityManual(next);
                engine.screens?.toast(`Quality ${next}`, 'quality');
                break;
            }
            default:
                break;
        }

        state.hotkeys += 1;
    }

    function onKeyUp(event) {
        if (event.code === 'Space' && state.fireHeld) setFire(false);
    }

    function onContextMenu(event) {
        if (event.target?.tagName === 'CANVAS') event.preventDefault();
    }

    function onTouchMove(event) {
        if (!gameplayVisible()) return;
        // Stop the page from scrolling/zooming under the arena.
        event.preventDefault();
        const touch = event.changedTouches[0];
        if (!touch) return;
        aimFrom(touch.clientX, touch.clientY, 'touch');
    }

    return {
        get fireHeld() { return state.fireHeld; },
        get pointerType() { return state.pointerType; },

        bind(engineRef) {
            engine = engineRef;
            if (state.bound) return this;
            state.bound = true;

            on(win, 'pointermove', onPointerMove);
            on(win, 'pointerdown', onPointerDown, { passive: true });
            on(win, 'pointerup', onPointerUp);
            on(win, 'pointercancel', onPointerUp);
            on(win, 'blur', onPointerLeave);
            on(doc, 'pointerleave', onPointerLeave);
            on(win, 'keydown', onKeyDown);
            on(win, 'keyup', onKeyUp);
            on(doc, 'contextmenu', onContextMenu);
            on(doc, 'touchmove', onTouchMove, { passive: false });

            return this;
        },

        unbind() {
            for (const off of listeners.splice(0)) off();
            state.bound = false;
            setFire(false);
            engine = null;
        },

        /** Release the trigger without input (focus loss, pause, menu). */
        cancelFire() {
            state.dragging = false;
            state.pointerId = null;
            setFire(false);
            return state.fireHeld;
        },

        isFiring() {
            return state.fireHeld;
        },

        stats() {
            return {
                fireHeld: state.fireHeld,
                pointerType: state.pointerType,
                hotkeys: state.hotkeys,
                uiBlocks: state.uiBlocks,
                aim: { ...state.aimClient }
            };
        }
    };
}
