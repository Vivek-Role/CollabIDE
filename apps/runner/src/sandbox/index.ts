/**
 * The sandbox barrel. Cross-module callers go through here, never straight at
 * docker.ts — the same rule the server's modules follow.
 *
 * Module 6.5's worker is the first caller, and it should call runWithLimits
 * rather than runInContainer: the raw driver has no timeout and no output cap.
 */

export { runInContainer } from './docker.js';
export type { RunSpec, RunResult, OutputStream } from './docker.js';

export { runWithLimits } from './limits.js';
export type { LimitedRunSpec, LimitedRunResult } from './limits.js';

export { reapStaleContainers } from './reaper.js';
