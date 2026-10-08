import * as assert from 'assert';

import type { CapturedRunSummary as Summary } from '../events/event-log';
import { scoreCapturedTrajectory } from '../events/score-trajectory';

function makeSummary(overrides: Partial<Summary> = {}): Summary {
	return {
		sessionId: 'session-1',
		prompts: ['List the workspace files'],
		toolInvocations: [
			{ toolName: 'deval_listFiles', toolUseId: 'call_1', finishedAt: '2026-10-08T00:00:01Z' },
			{ toolName: 'deval_readFile', toolUseId: 'call_2', finishedAt: '2026-10-08T00:00:02Z' },
		],
		toolsUsed: ['deval_listFiles', 'deval_readFile'],
		completed: true,
		finalText: 'The workspace contains src/index.ts, src/agent/loop.ts and README.md.',
		eventCount: 8,
		stopCount: 1,
		...overrides,
	};
}

function checkIds(summary: Summary, skippedLines: number[] = []): Record<string, boolean> {
	const checks = scoreCapturedTrajectory({ summary, skippedLines });
	return Object.fromEntries(checks.map((check) => [check.id, check.passed]));
}

suite('scoreCapturedTrajectory', () => {
	test('a healthy trajectory passes every check', () => {
		const results = checkIds(makeSummary());
		assert.deepStrictEqual(Object.values(results).every(Boolean), true);
		assert.strictEqual(Object.keys(results).length, 11);
	});

	test('unparseable lines fail the JSON check', () => {
		const results = checkIds(makeSummary(), [3]);
		assert.strictEqual(results['valid-json'], false);
		assert.ok(results['completed']);
	});

	test('a run without a Stop event fails completion', () => {
		const results = checkIds(makeSummary({ completed: false, stopCount: 0 }));
		assert.strictEqual(results['completed'], false);
	});

	test('too many unresolved tool calls fail resolution', () => {
		const summary = makeSummary({
			toolInvocations: [
				{ toolName: 'deval_listFiles', toolUseId: 'call_1' },
				{ toolName: 'deval_readFile', toolUseId: 'call_2' },
			],
		});
		const results = checkIds(summary);
		assert.strictEqual(results['tool-resolution'], false);
	});

	test('a single unresolved call within budget still passes', () => {
		const invocations: Summary['toolInvocations'] = Array.from({ length: 20 }, (_, index) => ({
			toolName: 'deval_readFile',
			toolUseId: `call_${index}`,
			finishedAt: '2026-10-08T00:00:01Z',
		}));
		invocations[0] = { toolName: 'deval_readFile', toolUseId: 'call_0' };
		const results = checkIds(makeSummary({ toolInvocations: invocations }));
		assert.strictEqual(results['tool-resolution'], true);
	});

	test('destructive tools fail the policy check', () => {
		const results = checkIds(
			makeSummary({ toolsUsed: ['deval_readFile', 'delete_file'] }),
		);
		assert.strictEqual(results['no-destructive-tools'], false);
	});

	test('malformed tool names fail the name check', () => {
		const results = checkIds(makeSummary({ toolsUsed: ['deval_readFile', 'Bad Name!'] }));
		assert.strictEqual(results['tool-names-wellformed'], false);
	});

	test('a missing session id fails the session check', () => {
		const results = checkIds(makeSummary({ sessionId: undefined }));
		assert.strictEqual(results['has-session'], false);
	});

	test('no recorded prompts fail prompt coverage', () => {
		const results = checkIds(makeSummary({ prompts: [] }));
		assert.strictEqual(results['prompt-coverage'], false);
	});

	test('every check carries a detail string', () => {
		for (const check of scoreCapturedTrajectory({ summary: makeSummary(), skippedLines: [] })) {
			assert.ok(check.detail.length > 0, `${check.id} has no detail`);
		}
	});

	test('an identical retry after a tool error fails the flailing check', () => {
		const results = checkIds(
			makeSummary({
				toolInvocations: [
					{
						toolName: 'deval_readFile',
						toolUseId: 'call_1',
						input: { path: 'missing.ts' },
						output: { error: 'no such file' },
						finishedAt: '2026-10-08T00:00:01Z',
					},
					{
						toolName: 'deval_readFile',
						toolUseId: 'call_2',
						input: { path: 'missing.ts' },
						output: { error: 'no such file' },
						finishedAt: '2026-10-08T00:00:02Z',
					},
				],
			}),
		);
		assert.strictEqual(results['no-repeated-failures'], false);
	});

	test('adapting after a tool error passes the flailing check', () => {
		const results = checkIds(
			makeSummary({
				toolInvocations: [
					{
						toolName: 'deval_readFile',
						toolUseId: 'call_1',
						input: { path: 'missing.ts' },
						output: { error: 'no such file' },
						finishedAt: '2026-10-08T00:00:01Z',
					},
					{
						toolName: 'deval_readFile',
						toolUseId: 'call_2',
						input: { path: 'src/index.ts' },
						output: 'file contents',
						finishedAt: '2026-10-08T00:00:02Z',
					},
				],
			}),
		);
		assert.strictEqual(results['no-repeated-failures'], true);
	});

	test('a finished run with a vacuous final answer fails substantive termination', () => {
		const results = checkIds(makeSummary({ finalText: 'done' }));
		assert.strictEqual(results['completed'], true);
		assert.strictEqual(results['substantive-stop'], false);
	});

	test('an unfinished run does not fail substantive termination twice', () => {
		const results = checkIds(makeSummary({ completed: false, stopCount: 0, finalText: undefined }));
		assert.strictEqual(results['completed'], false);
		assert.strictEqual(results['substantive-stop'], true);
	});

	test('too many tool calls fail the budget check', () => {
		const toolInvocations = Array.from({ length: 26 }, (_, index) => ({
			toolName: 'deval_readFile',
			toolUseId: `call_${index}`,
			finishedAt: '2026-10-08T00:00:01Z',
		}));
		const results = checkIds(makeSummary({ toolInvocations }));
		assert.strictEqual(results['tool-budget'], false);
	});
});
