/**
 * Run recorder tests.
 *
 * A record is only useful if replaying it reproduces the run exactly and if a
 * mismatch can be located, so the two promises checked here are: the recorded
 * action stream comes back out in tick order, and the state checksum is stable
 * for equal state while changing the moment the state changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    Recorder, Replayer, EVENT, RECORD_VERSION, checksum, stateChecksum
} from '../src/game/Recorder.js';
import { createStream } from '../src/core/Rng.js';

test('checksums ignore key order but react to every value', () => {
    assert.equal(checksum({ a: 1, b: 2 }), checksum({ b: 2, a: 1 }));
    assert.equal(checksum([1, 2, 3]), checksum([1, 2, 3]));
    assert.notEqual(checksum({ a: 1 }), checksum({ a: 2 }));
    assert.notEqual(checksum({ a: 1 }), checksum({ a: 1, b: 0 }));
    assert.notEqual(checksum({ a: 'x' }), checksum({ a: 'y' }));
    assert.notEqual(checksum(true), checksum(false));
    assert.equal(checksum(null), checksum(undefined), 'empty input is consistent');

    // Floats are compared at gameplay precision, not bit-exactly.
    assert.equal(checksum({ x: 1.00001 }), checksum({ x: 1.00002 }));
    assert.notEqual(checksum({ x: 1.0 }), checksum({ x: 1.5 }));
});

test('the state checksum is stable, order-insensitive, and sensitive to progress', () => {
    const state = {
        tick: 600,
        score: 4200,
        wave: 7,
        core: 2,
        combo: 14,
        enemies: 9,
        kills: 130,
        rngDraws: 812,
        hyper: 40,
        enemyPositions: [{ x: 1.234, y: -2.5, hp: 1 }, { x: -4.56, y: 3.1, hp: 4 }]
    };

    const baseline = stateChecksum(state);
    assert.equal(stateChecksum({ ...state }), baseline);
    assert.equal(
        stateChecksum({ ...state, enemyPositions: state.enemyPositions.slice().reverse() }),
        baseline,
        'enemy order in the pool must not change the checksum'
    );
    assert.notEqual(stateChecksum({ ...state, score: 4201 }), baseline);
    assert.notEqual(stateChecksum({ ...state, tick: 601 }), baseline);
    assert.notEqual(
        stateChecksum({ ...state, enemyPositions: [{ x: 1.234, y: -2.5, hp: 2 }, state.enemyPositions[1]] }),
        baseline,
        'a wounded enemy is a different world'
    );

    // Sub-pixel jitter is below the recorded precision.
    assert.equal(
        stateChecksum({ ...state, enemyPositions: [{ x: 1.2344, y: -2.5, hp: 1 }, state.enemyPositions[1]] }),
        baseline
    );
});

test('the recorder stores a replayable header, inputs and checksums', () => {
    const recorder = new Recorder({ max: 100 });
    const meta = recorder.start({
        seed: 1234, mode: 'daily', profile: 'mobile', weapon: 'lance', rules: { id: 'swarm' }, dateKey: '2026-01-05', tick: 0
    });

    assert.equal(meta.seed, 1234);
    assert.equal(meta.mode, 'daily');
    assert.equal(meta.weapon, 'lance');
    assert.equal(meta.rules, 'swarm');
    assert.equal(meta.version, RECORD_VERSION);
    assert.equal(recorder.recording, true);

    recorder.input(0, { x: -3.456, y: 2.999, fire: true, pointer: 'touch' });
    recorder.input(30, { x: -3.5, y: 3, fire: false, pointer: 'touch' });
    recorder.event(60, EVENT.DRAFT_PICK, { index: 1 });
    recorder.checksum(60, { tick: 60, score: 0, wave: 1, core: 3, combo: 0, enemies: 4, kills: 0, rngDraws: 12, hyper: 0, enemyPositions: [] });

    const record = recorder.stop(90);
    assert.equal(recorder.recording, false);
    assert.equal(record.version, RECORD_VERSION);
    assert.equal(record.meta.seed, 1234);
    assert.equal(record.eventCount, 5, 'four actions plus the end marker');
    assert.equal(record.dropped, 0);
    assert.equal(record.events[0].k, EVENT.INPUT);
    assert.equal(record.events[0].d.x, -3.46, 'input positions are rounded for stable JSON');
    assert.equal(record.events[1].k, EVENT.INPUT_RELEASE);
    assert.equal(record.events[record.events.length - 1].k, EVENT.RUN_END);

    // Export -> parse -> replay is the loop the debug panel offers.
    const json = recorder.export();
    const parsed = Recorder.parse(json);
    assert.equal(parsed.meta.seed, 1234);
    assert.equal(Recorder.parse(parsed).eventCount, record.eventCount);
    assert.throws(() => Recorder.parse('{"nope":1}'), /Invalid run record/);
    assert.throws(() => Recorder.parse('not json'), SyntaxError);

    const stats = recorder.stats();
    assert.equal(stats.recording, false);
    assert.equal(stats.seed, 1234);
    assert.equal(stats.mode, 'daily');
});

test('the event buffer is capped and reports what it dropped', () => {
    const recorder = new Recorder({ max: 3 });
    recorder.start({ seed: 1 });
    for (let i = 0; i < 5; i++) assert.equal(recorder.event(i, EVENT.WAVE_START, { wave: i }), i < 3);

    assert.equal(recorder.events.length, 3);
    assert.equal(recorder.dropped, 2);
    assert.equal(recorder.stats().dropped, 2);

    recorder.recording = false;
    assert.equal(recorder.event(99, EVENT.WAVE_END, {}), false, 'a stopped recorder accepts nothing');
});

test('the replayer feeds actions back in tick order and proves a match', () => {
    const recorder = new Recorder({ max: 200 });
    recorder.start({ seed: 77, mode: 'standard', weapon: 'pulse', tick: 0 });

    const rng = createStream(77, 'replay-test');
    const scripted = [];
    for (let tick = 0; tick < 120; tick++) {
        if (tick % 10 === 0) {
            const action = { x: rng.range(-10, 10), y: rng.range(-6, 6), fire: true, pointer: 'mouse' };
            scripted.push({ tick, action });
            recorder.input(tick, action);
        }
        if (tick === 45) recorder.event(tick, EVENT.DRAFT_PICK, { index: 0 });
    }
    const stateAt = (tick) => ({
        tick, score: tick * 10, wave: 1 + Math.floor(tick / 40), core: 3,
        combo: tick % 7, enemies: tick % 5, kills: tick, rngDraws: tick * 3, hyper: 0, enemyPositions: []
    });
    const checksumAt = (tick) => stateChecksum(stateAt(tick));
    recorder.checksum(60, stateAt(60));
    recorder.checksum(120, stateAt(120));
    const record = recorder.stop(120);

    const replayer = new Replayer(record);
    assert.equal(replayer.seed, 77);
    assert.equal(replayer.mode, 'standard');
    assert.equal(replayer.totalEvents, record.eventCount);

    const replayed = [];
    let verifyCount = 0;
    for (let tick = 0; tick <= 120; tick++) {
        for (const event of replayer.poll(tick)) {
            if (event.k === EVENT.INPUT) replayed.push({ tick: event.t, action: event.d });
        }
        const verification = replayer.verify(tick, checksumAt(tick));
        if (verification.checked) {
            verifyCount += 1;
            assert.equal(verification.match, true, `checksum must match at tick ${tick}`);
        }
    }

    assert.equal(verifyCount, 2, 'both recorded checksums were compared');
    assert.equal(replayer.done, true);
    assert.equal(replayer.stats().progress, 100);

    assert.equal(replayed.length, scripted.length);
    for (let i = 0; i < scripted.length; i++) {
        assert.equal(replayed[i].tick, scripted[i].tick, 'actions come back on their own tick');
        assert.ok(Math.abs(replayed[i].action.x - scripted[i].action.x) < 0.01);
        assert.ok(Math.abs(replayed[i].action.y - scripted[i].action.y) < 0.01);
    }

    // A late poll still drains everything rather than losing events.
    const late = new Replayer(record);
    const drained = late.poll(10000);
    assert.equal(drained.length, record.eventCount);
    assert.equal(late.done, true);
    assert.equal(late.poll(10001).length, 0);
});

test('a divergence is detected and pinned to the first bad tick', () => {
    const recorder = new Recorder();
    recorder.start({ seed: 5 });
    recorder.event(50, EVENT.CHECKSUM, { value: 111 });
    recorder.event(100, EVENT.CHECKSUM, { value: 222 });
    const record = recorder.stop(150);

    const replayer = new Replayer(record);
    assert.deepEqual(replayer.verify(50, 111), { checked: true, match: true, expected: 111, actual: 111 });
    assert.deepEqual(replayer.verify(60, 12345), { checked: false, match: true }, 'ticks without a record are not checked');

    const wrong = replayer.verify(100, 999);
    assert.equal(wrong.checked, true);
    assert.equal(wrong.match, false);
    assert.deepEqual(replayer.divergence, { tick: 100, expected: 222, actual: 999 });
    assert.deepEqual(replayer.stats().divergence, { tick: 100, expected: 222, actual: 999 });

    // A later match never clears the first divergence: that is the one to debug.
    assert.equal(replayer.verify(110, 222).checked, false, 'the checksum list is consumed in order');

    const stringy = new Replayer(JSON.stringify(record));
    assert.equal(stringy.seed, 5);
    assert.equal(stringy.totalEvents, record.eventCount);
});
