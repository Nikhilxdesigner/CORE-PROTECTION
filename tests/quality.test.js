/**
 * Quality governor tests.
 *
 * The governor is the thing standing between a mid-range laptop and a slideshow,
 * so its rules are pinned here: it must degrade on sustained slowness, protect
 * responsiveness with EMERGENCY, recover one tier at a time without oscillating,
 * respect the platform ceiling, and freeze completely when the player pins a
 * tier. "Make the frame budget" is a lookup, so the tier table is checked too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TIERS, TIER_NAMES, MANUAL_CHOICES, TIER_INDEX,
    tierByName, createQuality, FrameWindow, detectPlatform, PLATFORM_DEFAULTS
} from '../src/core/Quality.js';
import { createEventBus } from '../src/core/Events.js';

/** Feed `count` render frames of a fixed duration. */
function feed(quality, frameTimeMs, count) {
    let changes = 0;
    for (let i = 0; i < count; i++) if (quality.sample(frameTimeMs, 1 / 60)) changes += 1;
    return changes;
}

function fakeContext() {
    const calls = [];
    const record = (name) => (value) => calls.push([name, value]);
    return {
        calls,
        setPixelRatioCap: record('pixelRatioCap'),
        setRenderScale: record('renderScale'),
        setBloom: record('bloom'),
        setPost: record('post'),
        setBudget: (kind, value) => calls.push(['budget', kind, value]),
        setMaxActiveEnemies: record('maxActiveEnemies'),
        setHazardCap: record('hazardCap')
    };
}

test('tier table is ordered, complete, and never disables core gameplay', () => {
    assert.deepEqual(TIER_NAMES, ['ULTRA', 'HIGH', 'MEDIUM', 'LOW', 'EMERGENCY']);
    assert.equal(TIERS.length, TIER_NAMES.length);
    assert.ok(MANUAL_CHOICES.includes('AUTO'));

    for (let i = 0; i < TIERS.length; i++) {
        const tier = TIERS[i];
        assert.equal(tier.name, TIER_NAMES[i]);
        assert.ok(tier.pixelRatioCap > 0);
        assert.ok(tier.renderScale > 0 && tier.renderScale <= 1);
        assert.ok(tier.particles > 0, `${tier.name} must still allow particles`);
        assert.ok(tier.maxActiveEnemies > 0, `${tier.name} must still spawn enemies`);
        assert.ok(tier.telegraphFidelity > 0, `${tier.name} must still telegraph attacks`);

        if (i > 0) {
            const previous = TIERS[i - 1];
            assert.ok(tier.particles < previous.particles, 'particle budgets must decrease');
            assert.ok(tier.debris < previous.debris, 'debris budgets must decrease');
            assert.ok(tier.maxActiveEnemies < previous.maxActiveEnemies, 'enemy cap must decrease');
        }
    }

    assert.equal(tierByName('MEDIUM').name, 'MEDIUM');
    assert.equal(tierByName('nonsense').name, 'HIGH', 'unknown tiers fall back to HIGH');
    assert.equal(TIER_INDEX.ULTRA, 0);
    assert.equal(TIER_INDEX.EMERGENCY, 4);
});

test('platform detection picks a starting tier and a ceiling', () => {
    assert.equal(detectPlatform(null, null), 'desktop');
    assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone)' }, { innerWidth: 390 }), 'mobile');
    assert.equal(
        detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 }, { innerWidth: 1440 }),
        'desktop'
    );
    assert.equal(PLATFORM_DEFAULTS.mobile.ceiling, 'HIGH');

    const desktop = createQuality({ platform: 'desktop' });
    assert.equal(desktop.name, 'HIGH');
    const mobile = createQuality({ platform: 'mobile' });
    assert.equal(mobile.name, 'MEDIUM');
});

test('sustained slow frames step the tier down once, then hold through cooldown', () => {
    const bus = createEventBus();
    const changes = [];
    bus.on('QUALITY_CHANGED', (event) => changes.push(event));
    const quality = createQuality({ platform: 'desktop', bus });

    const applied = feed(quality, 25, 60);

    assert.equal(quality.name, 'MEDIUM', '40 slow frames trigger exactly one downgrade');
    assert.equal(applied, 1, 'sample() reports the change so the engine can apply it');
    assert.equal(quality.changes, 1);
    assert.match(quality.reason, /^slow:/);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].from, 'HIGH');
    assert.equal(changes[0].to, 'MEDIUM');

    // Still bad frames, but the cooldown forbids laddering down in one bad second.
    assert.equal(feed(quality, 25, 60), 0);
    assert.equal(quality.name, 'MEDIUM');
});

test('a sustained terrible patch jumps straight to EMERGENCY', () => {
    const quality = createQuality({ platform: 'desktop' });
    feed(quality, 40, 30);

    assert.equal(quality.name, 'EMERGENCY');
    assert.match(quality.reason, /^emergency:/);
    assert.equal(quality.index, TIER_INDEX.EMERGENCY);

    // EMERGENCY is the responsiveness floor: it cannot be downgraded further.
    assert.equal(feed(quality, 80, 120), 0);
    assert.equal(quality.name, 'EMERGENCY');
});

test('recovery climbs one tier at a time and stops at the platform ceiling', () => {
    const desktop = createQuality({
        platform: 'desktop',
        tuning: { cooldownSeconds: 0.2, slowFrames: 20, fastFrames: 20 }
    });
    feed(desktop, 25, 30);
    assert.equal(desktop.name, 'MEDIUM');

    feed(desktop, 8, 120);
    assert.equal(desktop.name, 'ULTRA', 'desktop can climb back to its ceiling');
    assert.match(desktop.reason, /^headroom:/);

    // Mobile is capped at HIGH: headroom must not promote it to ULTRA.
    const mobile = createQuality({
        platform: 'mobile',
        tuning: { cooldownSeconds: 0.2, slowFrames: 20, fastFrames: 20 }
    });
    feed(mobile, 25, 30);
    assert.equal(mobile.name, 'LOW');
    feed(mobile, 8, 400);
    assert.equal(mobile.name, 'HIGH', 'never climbs above the platform ceiling');
});

test('a manual choice freezes the governor; AUTO hands control back', () => {
    const quality = createQuality({ platform: 'desktop' });
    const context = fakeContext();

    assert.equal(quality.setManual('LOW', context), 'LOW');
    assert.equal(quality.name, 'LOW');
    assert.equal(quality.frozen, true);
    assert.ok(context.calls.length > 0, 'a manual change applies immediately');

    // Even 5 seconds of disaster cannot move a pinned tier.
    assert.equal(feed(quality, 80, 300), 0);
    assert.equal(quality.name, 'LOW');
    assert.equal(quality.manual, 'LOW');

    assert.equal(quality.setManual('AUTO'), 'AUTO');
    assert.equal(quality.frozen, false);
    assert.equal(quality.name, 'HIGH', 'AUTO re-establishes the platform start tier');

    assert.equal(quality.setManual('garbage'), 'AUTO', 'unknown choices normalise to AUTO');
});

test('apply() pushes the whole tier into the render context', () => {
    const quality = createQuality({ platform: 'desktop' });
    const context = fakeContext();
    const config = quality.apply(context);

    assert.equal(config.name, 'HIGH');
    const names = context.calls.map((call) => call[0]);
    for (const expected of ['pixelRatioCap', 'renderScale', 'bloom', 'post', 'maxActiveEnemies', 'hazardCap']) {
        assert.ok(names.includes(expected), `apply() must set ${expected}`);
    }
    assert.ok(context.calls.some((call) => call[0] === 'budget' && call[1] === 'particles'));
    const bloom = context.calls.find((call) => call[0] === 'bloom')[1];
    assert.equal(bloom.enabled, true);
    assert.equal(typeof bloom.resolution, 'number');

    // EMERGENCY is governor-only: it is reachable through slow frames, not by
    // pinning it, so the safeguard cannot be disabled by a settings choice.
    assert.equal(quality.setManual('EMERGENCY'), 'AUTO');
    const slow = createQuality({ platform: 'desktop' });
    feed(slow, 40, 30);
    assert.equal(slow.name, 'EMERGENCY');
    const emergency = fakeContext();
    const emergencyConfig = slow.apply(emergency);
    assert.equal(emergencyConfig.bloom.resolution, 128, 'EMERGENCY shrinks the bloom target');
    assert.equal(emergencyConfig.post.scanlines, 0);
    assert.equal(emergencyConfig.post.shockwave, false);
});

test('frame window reports average, p95 and fps without drifting', () => {
    const window = new FrameWindow(10);
    window.push(16);
    window.push(16);

    assert.equal(window.average, 16);
    assert.equal(window.fps, 63);
    assert.equal(window.p95, 16);

    const window2 = new FrameWindow(4);
    for (const value of [10, 20, 30, 40]) window2.push(value);
    assert.equal(window2.average, 25);
    assert.ok(window2.p95 >= 30 && window2.p95 <= 40);

    const before = window2.count;
    window2.reset();
    assert.equal(window2.count, 0);
    assert.equal(before, 4);

    // Garbage input must not poison the estimate.
    const window3 = new FrameWindow(4);
    window3.push(Number.NaN);
    assert.ok(Number.isFinite(window3.average));

    const stats = createQuality({ platform: 'desktop' }).stats();
    assert.ok(['ULTRA', 'HIGH', 'MEDIUM', 'LOW', 'EMERGENCY'].includes(stats.tier));
    assert.ok(Number.isFinite(stats.avg));
});
