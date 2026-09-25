/**
 * Shared state kernel for pi-tiny-boss.
 * Shared across slices; slices never import each other directly.
 */

import type { TinyBossState } from "./types.js";

export function createInitialState(): TinyBossState {
	return {
		enabled: true,
		degraded: null,
		lastError: null,
		lastRunTimestamp: 0,
		planCount: 0,
		lastPlan: null,
		engine: null,
		engineLoadMs: null,
	};
}

/** Record a successful plan and clear any latched degradation. */
export function recordPlan(state: TinyBossState, plan: TinyBossState["lastPlan"]): void {
	state.lastPlan = plan;
	state.lastRunTimestamp = Date.now();
	state.planCount += 1;
	state.degraded = null;
	state.lastError = null;
}

/**
 * Latch a failure. Degraded modes stop the planner retrying on every
 * single prompt, which would otherwise mean a disk read per keystroke.
 */
export function recordFailure(
	state: TinyBossState,
	reason: TinyBossState["degraded"],
	message: string,
): void {
	state.degraded = reason;
	state.lastError = message;
}
