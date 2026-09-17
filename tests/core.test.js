/**
 * Core infrastructure tests: math helpers, storage + migrations, seeded RNG,
 * the object pool, the fixed-step clock, the state machine and the event bus.
 *
 * These are the modules the rest of the game trusts to be correct, and they are
 * all dependency-free, so they run in plain Node with no browser and no build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    clamp, clamp01, lerp, damp, smoothstep, moveToward, dist, dist2,
    formatScore, shortNumber, formatTime, formatCountdown, pad2
} from '../src/util/Math.js';

import {
    Storage, createMemoryBackend, createPracticeStorage,
    STORAGE_VERSION, PRACTICE_PREFIX, DEFAULT_PREFIX
} from '../src/util/Storage.js';

import { Rng, mulberry32, hashString, createStream } from '../src/core/Rng.js';
import { Pool } from '../src/core/Pool.js';
import { FixedStep } from '../src/core/Clock.js';
import { STATES, createStateMachine } from '../src/core/State.js';
import { createEventBus, EVENTS } from '../src/core/Events.js';

/* ------------------------------------------------------------------ math -- */

test('math helpers clamp and interpolate as documented', () => {
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(clamp(-5, 0, 1), 0);
    assert.equal(clamp01(0.5), 0.5);
    assert.equal(lerp(0, 10, 0.25), 2.5);
    assert.equal(smoothstep(0, 1, 0), 0);
    assert.equal(smoothstep(0, 1, 1), 1);
    assert.equal(smoothstep(0, 1, 0.5), 0.5);
    assert.equal(moveToward(0, 10, 3), 3);
    assert.equal(moveToward(0, 2, 3), 2, 'never overshoots');
    assert.equal(dist(0, 0, 3, 4), 5);
    assert.equal(dist2(0, 0, 3, 4), 25);
});

test('damp converges toward the target without overshooting', () => {
    let value = 0;
    for (let i = 0; i < 600; i++) value = damp(value, 1, 8, 1 / 60);
    assert.ok(Math.abs(1 - value) < 1e-3, `expected ~1, got ${value}`);
    assert.ok(value <= 1);
    // Frame-rate independence: one 100ms step lands near sixty 1.67ms steps.
    const oneBig = damp(0, 1, 8, 0.1);
    let many = 0;
    for (let i = 0; i < 6; i++) many = damp(many, 1, 8, 1 / 60);
    assert.ok(Math.abs(oneBig - many) < 0.02, `${oneBig} vs ${many}`);
});

test('formatting helpers produce stable UI strings', () => {
    assert.equal(pad2(3), '03');
    assert.equal(pad2(12), '12');
    assert.equal(shortNumber(999), '999');
    assert.equal(shortNumber(12345), '12.3K');
    assert.equal(shortNumber(2500000), '2.5M');
    assert.equal(shortNumber(3.1e9), '3.1B');
    assert.equal(formatTime(65), '1:05');
    assert.equal(formatTime(-5), '0:00');
    assert.equal(formatCountdown(1000 * 65), '01:05');
    assert.equal(formatCountdown(1000 * 3725), '1:02:05');
    assert.equal(formatScore(1234), (1234).toLocaleString('en-US'));
});

/* --------------------------------------------------------------- storage -- */

test('storage round-trips values through a memory backend', () => {
    const backend = createMemoryBackend();
    const storage = new Storage({ backend });

    assert.equal(storage.get('missing', 'fallback'), 'fallback');
    assert.equal(storage.set('cores', 10), true);
    assert.equal(storage.get('cores'), 10);
    assert.equal(storage.increment('cores', 5), 15);
    assert.equal(storage.increment('fresh', 3), 3, 'increment seeds a missing key');
    storage.update({ a: 1, b: 2 });
    assert.equal(storage.get('a'), 1);
    assert.equal(storage.remove('a'), true);
    assert.equal(storage.get('a', null), null);

    // A second instance over the same backend sees the persisted blob.
    const reloaded = new Storage({ backend });
    assert.equal(reloaded.get('cores'), 15);
    assert.equal(reloaded.get('b'), 2);
});

test('storage migrates an older schema instead of dropping the save', () => {
    const backend = createMemoryBackend();
    backend.setItem(`${DEFAULT_PREFIX}state`, JSON.stringify({ version: 1, data: { cores: 5 } }));

    const storage = new Storage({ backend });
    assert.equal(storage.get('cores'), 5, 'existing data survives the migration');
    assert.deepEqual(storage.lastMigration, { from: 1, to: STORAGE_VERSION });
    assert.equal(typeof storage.get('streak'), 'object');
    assert.equal(storage.get('streak').current, 0);

    // The migrated payload is written back at the new version.
    const raw = JSON.parse(backend.getItem(`${DEFAULT_PREFIX}state`));
    assert.equal(raw.version, STORAGE_VERSION);
});

test('storage recovers from a corrupt payload rather than crashing on boot', () => {
    const backend = createMemoryBackend();
    backend.setItem(`${DEFAULT_PREFIX}state`, '{not json at all');
    const storage = new Storage({ backend });
    assert.deepEqual(storage.data, {});
});

test('storage exports and imports a profile, and a practice sandbox is separate', () => {
    const backend = createMemoryBackend();
    const storage = new Storage({ backend });
    storage.set('profile', { cores: 12 });

    const payload = storage.exportData();
    payload.data.profile.cores = 999;
    assert.equal(storage.importData(payload), true);
    assert.equal(storage.get('profile').cores, 999);
    assert.equal(storage.importData({ nope: true }), false, 'malformed payloads are rejected');

    const practice = createPracticeStorage({ backend });
    assert.equal(practice.prefix, PRACTICE_PREFIX);
    assert.notEqual(practice.blobKey, storage.blobKey);
    assert.equal(practice.get('profile', null), null, 'practice writes never touch the real profile');
});

/* -------------------------------------------------------------------- rng -- */

test('rng is deterministic for a seed and independent across forks', () => {
    const a = new Rng(4242);
    const b = new Rng(4242);
    const first = Array.from({ length: 20 }, () => a.float());
    const second = Array.from({ length: 20 }, () => b.float());
    assert.deepEqual(first, second);

    for (const value of first) {
        assert.ok(value >= 0 && value < 1, `${value} outside [0,1)`);
    }

    const c = new Rng(4243);
    assert.notDeepEqual(Array.from({ length: 5 }, () => c.float()), first.slice(0, 5));

    // Same root + label -> same stream; different label -> different stream.
    const rootA = new Rng('seed');
    const rootB = new Rng('seed');
    assert.deepEqual(
        Array.from({ length: 6 }, () => rootA.fork('wave').float()),
        Array.from({ length: 6 }, () => rootB.fork('wave').float())
    );
    assert.notDeepEqual(
        Array.from({ length: 6 }, () => rootA.fork('wave').float()),
        Array.from({ length: 6 }, () => rootA.fork('draft').float())
    );
});

test('rng helpers stay inside their documented ranges', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 200; i++) {
        const value = rng.int(2, 5);
        assert.ok(value >= 2 && value <= 5, `${value} outside [2,5]`);
        assert.ok(Number.isInteger(value));
    }
    assert.equal(rng.chance(0), false);
    assert.equal(rng.chance(1), true);
    assert.equal(rng.pick([]), undefined);
    assert.equal(rng.weighted([]), undefined);

    const bag = ['a', 'b', 'c', 'd'];
    const sampled = rng.sample(bag, 3);
    assert.equal(sampled.length, 3);
    assert.equal(new Set(sampled).size, 3, 'sample returns distinct items');

    const shuffled = new Rng(9).shuffle(['a', 'b', 'c', 'd', 'e']);
    assert.equal(shuffled.length, 5);
    assert.deepEqual(shuffled.slice().sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('weighted draws favour heavier entries and clone() resumes a stream', () => {
    const rng = new Rng(11);
    const items = [{ id: 'light', weight: 1 }, { id: 'heavy', weight: 999 }];
    let heavy = 0;
    for (let i = 0; i < 500; i++) if (rng.weighted(items).id === 'heavy') heavy += 1;
    assert.ok(heavy > 480, `heavy picked ${heavy}/500`);

    const original = new Rng(123);
    for (let i = 0; i < 5; i++) original.float();
    const copy = original.clone();
    assert.deepEqual(
        Array.from({ length: 8 }, () => original.float()),
        Array.from({ length: 8 }, () => copy.float())
    );

    assert.equal(hashString('same'), hashString('same'));
    assert.notEqual(hashString('same'), hashString('different'));
    assert.equal(typeof mulberry32(1), 'function');

    const stream = createStream(99, 'director');
    assert.equal(stream.label, 'root:director');
    const streamAgain = createStream(99, 'director');
    assert.equal(stream.float(), streamAgain.float());
});

/* ------------------------------------------------------------------- pool -- */

function counterObject() {
    return {
        active: false,
        value: 0,
        activations: 0,
        deactivations: 0,
        disposed: false,
        activate(value) {
            this.active = true;
            this.value = value ?? 0;
            this.activations += 1;
        },
        deactivate() {
            this.active = false;
            this.deactivations += 1;
        },
        dispose() { this.disposed = true; }
    };
}

test('pool reuses objects, prewarms, and reports honest stats', () => {
    const pool = new Pool({ name: 'test', create: counterObject, maxSize: 4, prewarm: 2 });
    assert.equal(pool.freeCount, 2);
    assert.equal(pool.stats().allocated, 2);

    const a = pool.acquire(1);
    const b = pool.acquire(2);
    assert.equal(a.value, 1);
    assert.equal(a.active, true);
    assert.equal(pool.activeCount, 2);
    assert.equal(pool.stats().expansions, 0, 'prewarmed objects are reused before allocating');

    pool.release(a);
    assert.equal(a.active, false);
    const reused = pool.acquire(3);
    assert.equal(reused, a, 'the freed object is handed back out');
    assert.equal(reused.value, 3);
    assert.equal(pool.activeCount, 2);

    assert.equal(pool.release({}), false, 'foreign objects are refused');
    assert.equal(pool.release(b), true);
    assert.equal(pool.release(b), false, 'double release is refused');
});

test('saturated pools recycle the oldest object instead of growing', () => {
    const pool = new Pool({ create: counterObject, maxSize: 2 });
    const first = pool.acquire(1);
    const second = pool.acquire(2);
    const third = pool.acquire(3);

    assert.equal(pool.stats().allocated, 2);
    assert.equal(pool.stats().recycled, 1);
    assert.equal(third, first, 'FIFO recycling hands back the oldest object');
    assert.equal(second.active, true);
    assert.equal(pool.activeCount, 2);

    const noRecycle = new Pool({ create: counterObject, maxSize: 1, recycleOldest: false });
    noRecycle.acquire(1);
    assert.equal(noRecycle.acquire(2), null, 'without recycling, saturation returns null');
});

test('setMaxSize shrinks the pool and releaseAll/clear reset it', () => {
    const pool = new Pool({ create: counterObject, maxSize: 8 });
    for (let i = 0; i < 6; i++) pool.acquire(i);
    assert.equal(pool.activeCount, 6);

    pool.setMaxSize(3);
    assert.equal(pool.activeCount, 3, 'shrinking releases the surplus immediately');
    assert.equal(pool.maxSize, 3);

    pool.releaseAll();
    assert.equal(pool.activeCount, 0);

    const activations = pool.stats();
    assert.ok(activations.peakActive >= 6);

    const objects = [];
    const tracked = new Pool({
        create: () => {
            const obj = counterObject();
            objects.push(obj);
            return obj;
        },
        maxSize: 4
    });
    tracked.prewarm(3);
    tracked.clear(true);
    assert.equal(tracked.activeCount, 0);
    assert.equal(tracked.freeCount, 0);
    assert.equal(tracked.stats().allocated, 0);
    assert.ok(objects.every((obj) => obj.disposed), 'clear(true) disposes allocated objects');
});

/* ------------------------------------------------------------------ clock -- */

test('fixed step runs a constant dt and interpolates the remainder', () => {
    const clock = new FixedStep({ hz: 60, maxFrameDelta: 0.25, maxSubsteps: 5 });
    const deltas = [];
    const result = clock.advance(1 / 60, (dt, tick) => deltas.push([dt, tick]));

    assert.equal(result.steps, 1);
    assert.equal(clock.ticks, 1);
    assert.equal(deltas[0][0], 1 / 60);
    assert.equal(deltas[0][1], 0);
    assert.equal(result.dropped, 0);

    // Half a tick of extra time = no step yet, but alpha interpolates.
    const partial = clock.advance(1 / 120, () => {});
    assert.equal(partial.steps, 0);
    assert.ok(Math.abs(partial.alpha - 0.5) < 1e-6);

    // 2.5 ticks of work in one frame: 2 steps, 0.5 tick left over.
    clock.reset();
    const multi = clock.advance(2.5 / 60, () => {});
    assert.equal(multi.steps, 2);
    assert.ok(Math.abs(multi.alpha - 0.5) < 1e-6);
});

test('a stalled frame is clamped, capped, and its debt discarded', () => {
    const clock = new FixedStep({ hz: 60, maxFrameDelta: 0.25, maxSubsteps: 5 });
    const result = clock.advance(3.5, () => {});

    assert.equal(result.stalled, true);
    assert.equal(result.steps, 5, 'never runs more than maxSubsteps updates');
    assert.equal(clock.stallCount, 1);
    assert.ok(clock.droppedTime > 3, 'the unpayable debt is counted as dropped');
    assert.ok(clock.accumulator <= 1 / 60 + 1e-9, 'accumulator cannot grow without bound');

    // A sleeping phone or a hidden tab therefore cannot spiral.
    for (let i = 0; i < 50; i++) clock.advance(5, () => {});
    assert.ok(clock.accumulator <= 1 / 60 + 1e-9);

    assert.equal(clock.secondsToTicks(0.5), 30);
    const stats = clock.stats();
    assert.equal(stats.hz, 60);
    assert.ok(stats.stallCount >= 50);
});

/* ------------------------------------------------------------------ state -- */

test('state machine tracks transitions and which states simulate', () => {
    const seen = [];
    const machine = createStateMachine(STATES.BOOT, (next, previous) => seen.push([previous, next]));

    assert.equal(machine.current, STATES.BOOT);
    assert.equal(machine.isSimulating, false);

    machine.set(STATES.PLAYING);
    assert.equal(machine.is(STATES.PLAYING), true);
    assert.equal(machine.is(STATES.PAUSED, STATES.PLAYING), true);
    assert.equal(machine.isSimulating, true);
    assert.equal(machine.previous, STATES.BOOT);
    assert.deepEqual(seen, [[STATES.BOOT, STATES.PLAYING]]);

    machine.set(STATES.PLAYING);
    assert.equal(seen.length, 1, 'a no-op transition does not notify');

    machine.set(STATES.DRAFT);
    assert.equal(machine.isSimulating, true, 'drafting keeps the arena alive');
    machine.set(STATES.RESULTS);
    assert.equal(machine.isSimulating, false);

    machine.reset();
    assert.equal(machine.current, STATES.BOOT);
    assert.equal(machine.previous, null);
});

/* ----------------------------------------------------------------- events -- */

test('event bus delivers to listeners, supports once/off and counts emits', () => {
    const bus = createEventBus();
    const received = [];
    const off = bus.on('PING', (payload) => received.push(payload));
    let onceCount = 0;
    bus.once('PING', () => { onceCount += 1; });

    bus.emit('PING', { n: 1 });
    bus.emit('PING', { n: 2 });

    assert.equal(received.length, 2);
    assert.equal(onceCount, 1, 'once() unsubscribes itself');
    assert.equal(bus.count('PING'), 2);
    assert.equal(bus.listenerCount('PING'), 1);

    off();
    bus.emit('PING', { n: 3 });
    assert.equal(received.length, 2, 'off() detaches the listener');
    assert.deepEqual(bus.toJSON(), { PING: 3 });
});

test('event bus keeps a bounded history ring and can freeze payloads', () => {
    const bus = createEventBus({ history: true, strict: true });
    for (let i = 0; i < 250; i++) bus.emit('TICK', { tick: i });

    const history = bus.history();
    assert.equal(history.length, 200, 'history is capped');
    assert.equal(history[history.length - 1].payload.tick, 249);

    const returned = bus.emit('FROZEN', { a: 1 });
    assert.equal(Object.isFrozen(returned), true);
    assert.throws(() => { 'use strict'; returned.a = 2; }, TypeError);

    bus.clear();
    assert.equal(bus.count('TICK'), 0);
    assert.equal(bus.history().length, 0);
    assert.equal(bus.listenerCount(), 0);
});

test('a throwing listener cannot break the emit', () => {
    const bus = createEventBus();
    let reached = false;
    bus.on('BROKEN', () => { throw new Error('listener exploded'); });
    bus.on('BROKEN', () => { reached = true; });

    const originalError = console.error;
    console.error = () => {};
    try {
        bus.emit('BROKEN', {});
    } finally {
        console.error = originalError;
    }
    assert.equal(reached, true);
    assert.equal(typeof EVENTS.ENEMY_KILL, 'string');
});
