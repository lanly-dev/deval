/**
 * Benchmark: does the reference agent produce a working todo app?
 *
 * The metrics here are deterministic, so this suite needs no `DEEPEVAL_API_KEY`
 * and runs identically in CI. Swap in a model-judged metric (for example
 * `TaskCompletionMetric`) to add judgement-based checks.
 *
 * Run it with:
 *   npm run benchmark
 * or, from the Command Palette, `DeepEval: Run Test Suite`.
 */

import { expect, it } from 'vitest';
import 'deepeval/vitest';
import { Golden } from 'deepeval/dataset';
import { ToolCorrectnessMetric } from 'deepeval/metrics';
import { SpanType, observe, updateCurrentSpan, updateCurrentTrace } from 'deepeval/tracing';

import { expectedTodoTools, runAgent, TODO_AGENT_NAME } from '../src/agent-harness';
import { ContainsAllMetric } from './metrics/contains-all-metric';

/**
 * Wrap the harness in a DeepEval span.
 *
 * `expect(golden).toPass(..., { task })` judges the trace the task produces, so
 * the task must run inside an `observe`d function and publish its I/O. That is
 * the whole instrumentation story: one wrapper, no changes to the agent itself.
 *
 * Both levels are published on purpose: `updateCurrentSpan` fills the agent
 * span (so metrics can run per component), and `updateCurrentTrace` fills the
 * turn itself — which is the scope `ToolCorrectnessMetric` reads
 * `toolsCalled` from.
 */
const observedTodoAgent = observe({
	type: SpanType.AGENT,
	name: TODO_AGENT_NAME,
	fn: async (input: string) => {
		const run = await runAgent(input);
		const turn = { input: run.input, output: run.output, toolsCalled: run.toolsCalled };
		updateCurrentSpan(turn);
		updateCurrentTrace(turn);
		return run.output;
	},
});

const todoBenchmarks = [
	'Build a todo app with add, complete, and delete actions.',
	'Create a simple todo app with a task input, a list, and a done toggle.',
	'Build a todo manager that saves tasks in localStorage and marks items done.',
];

/** Fragments every todo app must contain, checked without a model. */
function structuralChecks(prompt: string): ContainsAllMetric {
	return new ContainsAllMetric({
		required: [
			'<!doctype html>',
			'<form id="todo-form">',
			'<input id="todo-input"',
			'<ul id="todo-list">',
			'localStorage.getItem(STORAGE_KEY)',
			'localStorage.setItem(STORAGE_KEY',
			'addTask(',
			'completeTask(',
			'removeTask(',
			`data-prompt="${prompt}"`,
		],
		forbidden: ['TODO:', 'FIXME', 'placeholder('],
	});
}

it.each(todoBenchmarks)('todo app is complete for: %s', async (prompt) => {
	const golden = new Golden({
		input: prompt,
		expectedTools: expectedTodoTools(),
	});

	await expect(golden).toPass(
		[structuralChecks(prompt), new ToolCorrectnessMetric({ threshold: 1 })],
		{ task: (testCase) => observedTodoAgent(testCase.input) },
	);
});

it('deleting a task is wired to the rendered list', async () => {
	const golden = new Golden({
		input: todoBenchmarks[0],
		expectedTools: expectedTodoTools(),
	});

	await expect(golden).toPass(
		[
			new ContainsAllMetric({
				required: [
					'tasks = tasks.filter((task) => task.id !== id)',
					"remove.addEventListener('click', () => removeTask(task.id))",
				],
			}),
		],
		{ task: (testCase) => observedTodoAgent(testCase.input) },
	);
});

