/**
 * Benchmark: evaluate a captured `@deval` agent run.
 *
 * The deterministic scoring lives in `src/events/score-trajectory.ts`, shared
 * with the `Deval: Evaluate Captured Agent Run` command — this suite just runs
 * each check as a test case so `npm run benchmark` reports them.
 *
 * `Deval: Evaluate Captured Agent Run` picks a JSONL capture and sets
 * `DEEPEVAL_VSCODE_EVENTS` to its absolute path before starting the suite.
 *
 * When the environment variable is unset (a plain `npx deepeval test run`) the
 * whole suite is skipped instead of failing.
 */

import { describe, expect, it } from 'vitest';

import {
	DEEPEVAL_VSCODE_EVENTS,
	loadCapturedRun,
	resolveCapturedRunPath,
} from '../src/events/event-log';
import { scoreCapturedTrajectory } from '../src/events/score-trajectory';

const capturePath = resolveCapturedRunPath();
const capture = capturePath ? loadCapturedRun(capturePath) : undefined;

describe.skipIf(!capture)('captured agent run', () => {
	// This callback still runs during collection when skipped, so tolerate a
	// missing capture here; skipIf keeps the tests from running.
	const checks = capture
		? scoreCapturedTrajectory({ summary: capture.summary, skippedLines: capture.parsed.skippedLines })
		: [];

	if (!checks.length) {
		it.skip(`set ${DEEPEVAL_VSCODE_EVENTS} to a .jsonl file to evaluate a capture`, () => {});
		return;
	}

	for (const check of checks) {
		it(check.label, () => {
			expect(check.passed, check.detail).toBe(true);
		});
	}
});
