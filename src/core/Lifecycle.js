/**
 * Browser lifecycle handling.
 *
 * Losing focus, hiding the tab, or rotating the device must never let the
 * simulation jump forward or keep firing shots, and returning must never drop
 * the player straight back into live combat. This module owns the listeners and
 * reports facts; the Engine decides what to do about them.
 */

export function createLifecycle(options = {}) {
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const handlers = options.handlers || {};

    const state = {
        hidden: false,
        focused: true,
        attached: false,
        lastEvent: null,
        counts: {},
        /**
         * True between a suspend and its matching restore. `pageshow` also fires
         * on the initial load with nothing suspended, and treating that as a
         * "welcome back" would pause a run the instant it started.
         */
        suspended: false
    };

    const listeners = [];

    function count(name) {
        state.counts[name] = (state.counts[name] || 0) + 1;
    }

    function bind(target, type, fn, opts) {
        if (!target) return;
        target.addEventListener(type, fn, opts);
        listeners.push(() => target.removeEventListener(type, fn, opts));
    }

    function fire(name, payload) {
        state.lastEvent = { name, at: Date.now(), payload };
        try {
            handlers[name]?.(payload);
        } catch (err) {
            console.error(`[lifecycle] handler ${name} threw:`, err);
        }
    }

    /** Report a suspension once, and remember that we are owed a restore. */
    function suspend(reason) {
        if (state.suspended) return false;
        state.suspended = true;
        fire('onSuspend', { reason });
        return true;
    }

    /** Report a restore only if something was actually suspended. */
    function restore(reason) {
        if (!state.suspended) return false;
        state.suspended = false;
        fire('onRestore', { reason });
        return true;
    }

    function onVisibility() {
        const hidden = !!doc?.hidden;
        count(hidden ? 'visibilitychange:hidden' : 'visibilitychange:visible');
        if (hidden === state.hidden) return;
        state.hidden = hidden;
        // Coming back is not a resume: report it and let the player decide.
        if (hidden) suspend('visibilitychange');
        else restore('visibilitychange');
    }

    function onBlur() {
        count('blur');
        if (!state.focused) return;
        state.focused = false;
        suspend('blur');
    }

    function onFocus() {
        count('focus');
        if (state.focused) return;
        state.focused = true;
        if (!state.hidden) restore('focus');
    }

    function onPageHide() {
        count('pagehide');
        suspend('pagehide');
    }

    function onPageShow() {
        count('pageshow');
        restore('pageshow');
    }

    function onFreeze() {
        count('freeze');
        suspend('freeze');
    }

    function onResume() {
        count('resume');
        restore('resume');
    }

    let pendingResize = null;
    function onResize() {
        count('resize');
        if (pendingResize) return;
        pendingResize = setTimeout(() => {
            pendingResize = null;
            fire('onResize', { width: win?.innerWidth || 0, height: win?.innerHeight || 0 });
        }, 120);
    }

    function onOrientation() {
        count('orientationchange');
        fire('onOrientation', { orientation: win?.screen?.orientation?.type || win?.orientation || 'unknown' });
        // Orientation changes always imply a geometry change.
        fire('onResize', { width: win?.innerWidth || 0, height: win?.innerHeight || 0 });
    }

    return {
        get hidden() { return state.hidden; },
        get focused() { return state.focused; },
        get active() { return state.attached; },
        get counts() { return { ...state.counts }; },
        get lastEvent() { return state.lastEvent; },
        get suspended() { return state.suspended; },

        attach() {
            if (state.attached || !win || !doc) return this;
            state.hidden = !!doc.hidden;
            state.focused = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;

            bind(doc, 'visibilitychange', onVisibility);
            bind(win, 'blur', onBlur);
            bind(win, 'focus', onFocus);
            bind(win, 'pagehide', onPageHide);
            bind(win, 'pageshow', onPageShow);
            bind(win, 'orientationchange', onOrientation);
            bind(win, 'resize', onResize);
            bind(doc, 'freeze', onFreeze);
            bind(doc, 'resume', onResume);

            state.attached = true;
            return this;
        },

        detach() {
            for (const off of listeners.splice(0)) off();
            state.attached = false;
            return this;
        },

        /** True when the page should not be simulating at all. */
        get shouldSuspend() {
            return state.hidden || !state.focused;
        },

        stats() {
            return {
                hidden: state.hidden,
                focused: state.focused,
                suspended: state.suspended,
                counts: { ...state.counts },
                lastEvent: state.lastEvent?.name || null
            };
        }
    };
}
