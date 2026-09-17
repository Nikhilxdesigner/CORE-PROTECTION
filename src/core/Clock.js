/**
 * Fixed-timestep clock.
 *
 *     browser frame -> render delta -> accumulator -> fixed 60 Hz updates -> state -> variable-rate render
 *
 * Gameplay only ever sees a constant dt, so behaviour cannot drift with frame
 * rate. Three protections keep a stalled tab or a sleeping phone from wrecking
 * the simulation:
 *   1. a single render delta is clamped (default 250 ms),
 *   2. at most `maxSubsteps` fixed updates run per render frame,
 *   3. leftover accumulator debt is discarded instead of growing without bound,
 *      which is what prevents the classic "spiral of death".
 */

export const FIXED_HZ = 60;
export const FIXED_DT = 1 / FIXED_HZ;

export class FixedStep {
    /**
     * @param {object} [options]
     * @param {number} [options.hz] simulation frequency, default 60
     * @param {number} [options.maxFrameDelta] seconds; larger deltas are clamped
     * @param {number} [options.maxSubsteps] fixed updates per render frame
     */
    constructor(options = {}) {
        this.hz = options.hz ?? FIXED_HZ;
        this.dt = 1 / this.hz;
        this.maxFrameDelta = options.maxFrameDelta ?? 0.25;
        this.maxSubsteps = options.maxSubsteps ?? 5;

        this.accumulator = 0;
        this.ticks = 0;
        this.droppedTime = 0;
        this.stallCount = 0;
        this.clampCount = 0;
        this.lastRenderDelta = 0;
        this.alpha = 0;
    }

    /**
     * Advance the simulation.
     *
     * @param {number} renderDelta seconds since the previous render frame
     * @param {(dt: number, tick: number) => void} update fixed-step callback
     * @returns {{steps: number, alpha: number, dropped: number, stalled: boolean}}
     */
    advance(renderDelta, update) {
        let delta = Number.isFinite(renderDelta) ? renderDelta : 0;
        if (delta < 0) delta = 0;
        this.lastRenderDelta = delta;

        const stalled = delta > this.maxFrameDelta;
        if (stalled) {
            // Tab was hidden, throttled, or the device slept: throw the time away.
            this.stallCount += 1;
            this.droppedTime += delta - this.maxFrameDelta;
            this.clampCount += 1;
            delta = this.maxFrameDelta;
        }

        this.accumulator += delta;

        let steps = 0;
        while (this.accumulator >= this.dt && steps < this.maxSubsteps) {
            update(this.dt, this.ticks);
            this.ticks += 1;
            this.accumulator -= this.dt;
            steps += 1;
        }

        // Debt we could not pay off this frame is dropped, never carried.
        let dropped = 0;
        if (this.accumulator > this.dt) {
            dropped = this.accumulator - this.dt;
            this.droppedTime += dropped;
            this.accumulator = this.dt;
            this.clampCount += 1;
        }

        this.alpha = this.accumulator / this.dt;
        return { steps, alpha: this.alpha, dropped, stalled };
    }

    /** Discard pending time (pause, resume, mode change). */
    reset() {
        this.accumulator = 0;
        this.alpha = 0;
        return this;
    }

    resetCounters() {
        this.ticks = 0;
        this.droppedTime = 0;
        this.stallCount = 0;
        this.clampCount = 0;
        return this;
    }

    /** Convert seconds to whole ticks, useful for designer-facing config. */
    secondsToTicks(seconds) {
        return Math.max(1, Math.round(seconds * this.hz));
    }

    stats() {
        return {
            hz: this.hz,
            ticks: this.ticks,
            accumulator: this.accumulator,
            alpha: this.alpha,
            droppedTime: this.droppedTime,
            stallCount: this.stallCount,
            clampCount: this.clampCount
        };
    }
}
