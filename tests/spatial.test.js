/**
 * Aim and hit-query tests.
 *
 * Two claims are pinned here, because the whole "no raycaster per shot" design
 * rests on them:
 *   1. screen -> world maths is exact and round-trips, so the crosshair and the
 *      hit query cannot disagree, and
 *   2. the spatial hash returns the targets a full scan would, while looking at a
 *      small fraction of them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    tanHalfFov, ndcFromScreen, rayFromNdc, screenToPlane, screenToWorld,
    worldToScreen, distanceToSegment
} from '../src/util/CamMath.js';
import { SpatialHash } from '../src/world/SpatialHash.js';
import { CAMERA_RIG, ARENA, spawnPoint, spawnRing, insideBounds } from '../src/world/ArenaSpec.js';
import { Rng } from '../src/core/Rng.js';
import { TAU } from '../src/util/Math.js';

/** Same rig derivation the engine uses: look-at point -> yaw/pitch (YXZ order). */
function rigCamera(aspect = 16 / 9) {
    const dx = CAMERA_RIG.lookAt.x - CAMERA_RIG.position.x;
    const dy = CAMERA_RIG.lookAt.y - CAMERA_RIG.position.y;
    const dz = CAMERA_RIG.lookAt.z - CAMERA_RIG.position.z;
    const length = Math.hypot(dx, dy, dz) || 1;
    const pitch = Math.asin(dy / length);
    const cosPitch = Math.cos(pitch) || 1e-4;
    return {
        position: { ...CAMERA_RIG.position },
        pitch,
        yaw: Math.atan2(-(dx / length) / cosPitch, -(dz / length) / cosPitch),
        fovDeg: CAMERA_RIG.fovDeg,
        aspect
    };
}

const RECT = { left: 0, top: 0, width: 1600, height: 900 };

test('screen corners map to the corners of NDC', () => {
    const rect = { left: 100, top: 50, width: 800, height: 400 };
    const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);

    const topLeft = ndcFromScreen(100, 50, rect);
    almost(topLeft.x, -1); almost(topLeft.y, 1);

    const bottomRight = ndcFromScreen(900, 450, rect);
    almost(bottomRight.x, 1); almost(bottomRight.y, -1);

    const centre = ndcFromScreen(500, 250, rect);
    almost(centre.x, 0); almost(centre.y, 0);
});

test('the centre pixel looks straight down the camera axis', () => {
    const flat = { position: { x: 0, y: 0, z: 10 }, yaw: 0, pitch: 0, fovDeg: 90, aspect: 1 };
    const dir = rayFromNdc({ x: 0, y: 0 }, flat);
    assert.ok(Math.abs(dir.x) < 1e-9);
    assert.ok(Math.abs(dir.y) < 1e-9);
    assert.equal(dir.z, -1);

    // 90 degree fov: the top-right NDC corner is 45 degrees off axis.
    const corner = rayFromNdc({ x: 1, y: 1 }, flat);
    assert.ok(Math.abs(Math.abs(corner.z) - Math.abs(corner.x)) < 1e-9);
    assert.equal(Math.round(tanHalfFov(90) * 1000) / 1000, 1);
});

test('the centre of the screen lands on the combat plane under the crosshair', () => {
    const camera = rigCamera();
    const point = screenToWorld(RECT.width / 2, RECT.height / 2, RECT, camera, ARENA.planeZ);

    assert.equal(point.hit, true);
    assert.equal(point.z, ARENA.planeZ);
    assert.ok(Math.abs(point.x) < 0.02, `expected x ~ 0, got ${point.x}`);
    // The rig looks slightly down from y=4.6, so the plane crosses it near y=0.77.
    assert.ok(point.y > 0.7 && point.y < 0.85, `expected y ~ 0.77, got ${point.y}`);

    // Closed form check against the rig geometry: y = y0 + z0 * tan(pitch),
    // because the centre ray is (0, sin p, -cos p) and t = -z0 / -cos p.
    const expected = CAMERA_RIG.position.y + Math.tan(camera.pitch) * CAMERA_RIG.position.z;
    assert.ok(Math.abs(point.y - expected) < 0.02, `${point.y} vs ${expected}`);
});

test('worldToScreen inverts screenToWorld to sub-pixel accuracy', () => {
    const camera = rigCamera();
    const samples = [
        [800, 450], [200, 120], [1400, 800], [1000, 200], [640, 720]
    ];

    for (const [x, y] of samples) {
        const world = screenToWorld(x, y, RECT, camera, ARENA.planeZ);
        assert.equal(world.hit, true, `sample ${x},${y} should hit the plane`);

        const back = worldToScreen({ x: world.x, y: world.y, z: world.z }, camera, RECT);
        assert.ok(back, `sample ${x},${y} should project back on screen`);
        assert.ok(Math.abs(back.x - x) < 0.5, `x ${back.x} vs ${x}`);
        assert.ok(Math.abs(back.y - y) < 0.5, `y ${back.y} vs ${y}`);
    }
});

test('points behind the camera are refused rather than projected', () => {
    const camera = rigCamera();
    assert.equal(worldToScreen({ x: 0, y: 0, z: CAMERA_RIG.position.z + 5 }, camera, RECT), null);

    // Asking for a plane behind the rig gives t <= 0.
    const behind = screenToPlane({ x: 0, y: 0 }, camera, CAMERA_RIG.position.z + 10);
    assert.equal(behind.hit, false);
    assert.ok(behind.t < 0);
});

test('distanceToSegment clamps to the segment ends', () => {
    assert.equal(distanceToSegment(5, 0, 0, 0, 10, 0), 0);
    assert.equal(distanceToSegment(5, 3, 0, 0, 10, 0), 3);
    assert.equal(distanceToSegment(-4, 0, 0, 0, 10, 0), 4, 'beyond the start clamps to the start');
    assert.equal(distanceToSegment(14, 0, 0, 0, 10, 0), 4, 'beyond the end clamps to the end');
    assert.equal(distanceToSegment(3, 4, 3, 4, 3, 4), 0, 'degenerate segment is a point');
});

test('the spawn ring covers the arena evenly and stays inside bounds', () => {
    const angles = spawnRing(16);
    assert.equal(angles.length, 16);
    assert.equal(angles[0], 0);
    assert.ok(Math.abs(angles[15] + TAU / 16 - TAU) < 1e-9);

    const rng = new Rng(1234);
    for (let i = 0; i < 500; i++) {
        const angle = rng.range(0, TAU);
        const point = spawnPoint(angle, 0.94 + rng.range(0, 0.12), rng.float(), rng.float());
        assert.ok(insideBounds(point.x, point.y), `spawn ${point.x},${point.y} escaped the arena`);
        assert.ok(point.y > -ARENA.bounds.y);
    }
});

/* ------------------------------------------------------------ spatial hash -- */

function entity(x, y, radius = 0.5) {
    return { x, y, radius, id: `${x}:${y}` };
}

function overlaps(entry, x, y, radius) {
    const dx = entry.x - x;
    const dy = entry.y - y;
    const reach = radius + entry.radius;
    return dx * dx + dy * dy <= reach * reach;
}

test('the hash finds what a full scan would, at a fraction of the cost', () => {
    const cellSize = ARENA.averageEnemyRadius * 1.5;
    const hash = new SpatialHash({ cellSize });
    const rng = new Rng(90210);
    const all = [];

    for (let i = 0; i < 600; i++) {
        // Radius range spans the whole roster: Skitters up to a Warden, which is
        // wider than a cell - the case that used to be missed.
        const radius = i % 40 === 0 ? rng.range(1.4, 1.9) : rng.range(0.4, 0.9);
        const entity_ = entity(rng.range(-ARENA.bounds.x, ARENA.bounds.x), rng.range(-ARENA.bounds.y, ARENA.bounds.y), radius);
        all.push(entity_);
        hash.upsert(entity_, entity_.x, entity_.y, entity_.radius);
    }
    assert.ok(hash.maxEntryRadius > cellSize, 'the roster includes bodies wider than a cell');
    assert.equal(hash.size, 600);

    const scratch = [];
    for (let i = 0; i < 200; i++) {
        const x = rng.range(-ARENA.bounds.x, ARENA.bounds.x);
        const y = rng.range(-ARENA.bounds.y, ARENA.bounds.y);
        const radius = rng.range(0.9, 1.6);

        const found = hash.queryCircle(x, y, radius, scratch);
        assert.equal(found.length, scratch.length);

        const expected = all.filter((entry) => overlaps(entry, x, y, radius)).length;
        assert.equal(found.length, expected, `candidate count mismatch at ${x},${y}`);
        for (const target of found) {
            const entry = hash.entries.get(target);
            assert.ok(overlaps(entry, x, y, radius), 'no false positives');
        }
    }

    const efficiency = hash.efficiency();
    assert.equal(efficiency.tracked, 600);
    assert.equal(efficiency.queries, 200);
    assert.ok(
        efficiency.averageCandidates < 80,
        `expected a small candidate set, got ${efficiency.averageCandidates} of 600`
    );
    assert.ok(efficiency.cells < 600, 'objects share cells rather than each owning one');
});

test('a query centred on an entity always finds it, whatever the cap', () => {
    const hash = new SpatialHash({ cellSize: ARENA.averageEnemyRadius * 2.6 });
    const rng = new Rng(5150);
    const entities = [];

    for (let i = 0; i < 300; i++) {
        const entity_ = entity(rng.range(-18, 18), rng.range(-11, 11), rng.range(0.4, 0.9));
        entities.push(entity_);
        hash.upsert(entity_, entity_.x, entity_.y, entity_.radius);
    }

    for (const target of entities) {
        assert.ok(hash.queryCircle(target.x, target.y, 0.95).includes(target), 'self-hit must never be missed');
    }
});

test('entities are re-bucketed when they cross a cell, and removed cleanly', () => {
    const hash = new SpatialHash({ cellSize: 2 });
    const mover = entity(0.5, 0.5, 0.4);

    hash.upsert(mover, 0.5, 0.5, 0.4);
    assert.equal(hash.cells.size, 1);
    assert.equal(hash.size, 1);

    // Same cell: coordinates update, no move recorded.
    hash.upsert(mover, 1.4, 0.5, 0.4);
    assert.equal(hash.stats.moves, 0);
    assert.equal(hash.entries.get(mover).x, 1.4);

    // Crossing a boundary re-buckets and drops the empty cell behind it.
    hash.upsert(mover, 2.6, 0.5, 0.4);
    assert.equal(hash.stats.moves, 1);
    assert.equal(hash.size, 1, 'never duplicated across cells');
    assert.equal(hash.cells.size, 1);
    assert.deepEqual(hash.queryCircle(2.6, 0.5, 0.5), [mover]);
    assert.deepEqual(hash.queryCircle(0.5, 0.5, 0.5), []);

    assert.equal(hash.remove(mover), true);
    assert.equal(hash.remove(mover), false);
    assert.equal(hash.size, 0);
    assert.equal(hash.cells.size, 0);

    hash.upsert(entity(1, 1), 1, 1, 0.5);
    hash.clear();
    assert.equal(hash.size, 0);
});

test('nearest, collect and queryRing answer the questions combat asks', () => {
    const hash = new SpatialHash({ cellSize: 2.4 });
    const near = entity(1, 1, 0.5);
    const far = entity(5, 5, 0.5);
    const farther = entity(9, 0, 0.5);
    for (const target of [near, far, farther]) hash.upsert(target, target.x, target.y, target.radius);

    assert.equal(hash.nearest(1.4, 1.4, 4), near);
    assert.equal(hash.nearest(0, 0, 0.5), null, 'nothing inside the search radius');
    assert.equal(hash.nearest(5, 5, 20, (target) => target === farther), farther, 'predicate is respected');

    const collected = hash.collect(1, 1, 6, null, []);
    assert.ok(collected.includes(near));
    assert.ok(collected.includes(far));
    assert.ok(!collected.includes(farther));

    const ring = hash.queryRing(1, 1, 1.2, 6, []);
    assert.ok(!ring.includes(near), 'annulus excludes the inner radius');
    assert.ok(ring.includes(far));
});
