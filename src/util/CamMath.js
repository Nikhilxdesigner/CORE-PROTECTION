/**
 * Screen -> world aim projection.
 *
 * The combat plane is z = 0 and the camera rig never rolls, so a click can be
 * resolved with a handful of multiplications instead of a full Three.js
 * Raycaster against every enemy. The same maths is used for the crosshair and
 * for hit queries, which keeps aiming and rendering in exact agreement.
 *
 * Camera descriptor (all plain numbers, no Three.js):
 *   { position: {x, y, z}, yaw, pitch, fovDeg, aspect }
 * Rotation order is YXZ: pitch about X, then yaw about Y.
 */

import { DEG2RAD } from '../util/Math.js';

export function tanHalfFov(fovDeg) {
    return Math.tan((fovDeg * DEG2RAD) / 2);
}

/** Screen pixel position -> normalised device coordinates (y up). */
export function ndcFromScreen(clientX, clientY, rect) {
    const width = rect.width || 1;
    const height = rect.height || 1;
    return {
        x: ((clientX - rect.left) / width) * 2 - 1,
        // Canvas y grows downward, NDC y grows upward.
        y: -(((clientY - rect.top) / height) * 2 - 1)
    };
}

/**
 * Unit ray direction through an NDC point.
 * @returns {{x:number,y:number,z:number}}
 */
export function rayFromNdc(ndc, camera) {
    const tan = tanHalfFov(camera.fovDeg);
    const aspect = camera.aspect || 1;

    // Local view-space direction (camera looks down -Z).
    let x = ndc.x * aspect * tan;
    let y = ndc.y * tan;
    let z = -1;

    const length = Math.hypot(x, y, z) || 1;
    x /= length; y /= length; z /= length;

    // Pitch about X.
    const cp = Math.cos(camera.pitch || 0);
    const sp = Math.sin(camera.pitch || 0);
    const y1 = y * cp - z * sp;
    const z1 = y * sp + z * cp;

    // Yaw about Y.
    const cy = Math.cos(camera.yaw || 0);
    const sy = Math.sin(camera.yaw || 0);
    const x2 = x * cy + z1 * sy;
    const z2 = -x * sy + z1 * cy;

    return { x: x2, y: y1, z: z2 };
}

/**
 * Intersect a screen ray with a world plane of constant z.
 * @returns {{x,y,z,hit:boolean,t:number}} `t` is the distance along the ray.
 */
export function screenToPlane(ndc, camera, planeZ = 0) {
    const dir = rayFromNdc(ndc, camera);
    const originZ = camera.position.z;

    if (Math.abs(dir.z) < 1e-6) return { x: 0, y: 0, z: planeZ, hit: false, t: 0 };

    const t = (planeZ - originZ) / dir.z;
    if (t <= 0) return { x: 0, y: 0, z: planeZ, hit: false, t };

    return {
        x: camera.position.x + dir.x * t,
        y: camera.position.y + dir.y * t,
        z: planeZ,
        hit: true,
        t
    };
}

/** Convenience wrapper: raw pointer position straight to a world point. */
export function screenToWorld(clientX, clientY, rect, camera, planeZ = 0) {
    return screenToPlane(ndcFromScreen(clientX, clientY, rect), camera, planeZ);
}

/**
 * Inverse of `screenToPlane` for the HUD: where a world point lands on screen,
 * in CSS pixels. Returns null when the point is behind the camera.
 */
export function worldToScreen(point, camera, rect) {
    const dx = point.x - camera.position.x;
    const dy = point.y - camera.position.y;
    const dz = point.z - camera.position.z;

    // Inverse yaw.
    const cy = Math.cos(-(camera.yaw || 0));
    const sy = Math.sin(-(camera.yaw || 0));
    const x1 = dx * cy + dz * sy;
    const z1 = -dx * sy + dz * cy;

    // Inverse pitch.
    const cp = Math.cos(-(camera.pitch || 0));
    const sp = Math.sin(-(camera.pitch || 0));
    const y2 = dy * cp - z1 * sp;
    const z2 = dy * sp + z1 * cp;

    if (z2 >= -1e-4) return null; // behind camera

    const tan = tanHalfFov(camera.fovDeg);
    const aspect = camera.aspect || 1;
    const ndcX = (x1 / -z2) / (aspect * tan);
    const ndcY = (y2 / -z2) / tan;

    return {
        x: rect.left + ((ndcX + 1) / 2) * rect.width,
        y: rect.top + ((1 - ndcY) / 2) * rect.height,
        behind: false
    };
}

/** Squared distance from a point to a ray segment, used for tracer/fx timing. */
export function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 1e-9) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
