/**
 * Application state machine.
 *
 * Holds *where we are* (which screen and mode), never gameplay values. Systems
 * read it to decide whether they should be simulating or reacting.
 */

export const STATES = Object.freeze({
    BOOT: 'BOOT',
    MENU: 'MENU',
    DEMO: 'DEMO',
    PLAYING: 'PLAYING',
    DRAFT: 'DRAFT',
    PAUSED: 'PAUSED',
    RESULTS: 'RESULTS',
    ARSENAL: 'ARSENAL',
    CONTRACTS: 'CONTRACTS',
    HOW_TO_PLAY: 'HOW_TO_PLAY',
    SETTINGS: 'SETTINGS',
    FATAL: 'FATAL'
});

/** States during which the simulation is stepping. */
const SIMULATING = new Set([STATES.PLAYING, STATES.DRAFT]);

export function createStateMachine(initial = STATES.BOOT, onChange = null) {
    let current = initial;
    let previous = null;
    let enteredAt = 0;

    return {
        get current() { return current; },
        get previous() { return previous; },
        get isSimulating() { return SIMULATING.has(current); },
        get isPlaying() { return current === STATES.PLAYING; },
        get isPaused() { return current === STATES.PAUSED; },
        is(...names) { return names.includes(current); },
        set(next) {
            if (next === current) return current;
            previous = current;
            current = next;
            enteredAt = Date.now();
            onChange?.(next, previous);
            return current;
        },
        enteredAgo() { return Date.now() - enteredAt; },
        reset() {
            current = initial;
            previous = null;
            enteredAt = Date.now();
        }
    };
}
