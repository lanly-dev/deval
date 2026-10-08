/**
 * Benchmark: does the `@deval` agent loop use its tools and answer?
 *
 * The model here is scripted, so this suite is deterministic and needs no
 * `DEEPEVAL_API_KEY` — it measures the *loop* (tool dispatch, result
 * feedback, capture events), not any particular model. Swap the scripted
 * model for a real one to evaluate model behavior instead.
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

import {
	runAgentLoop,
	type EventPort,
	type ModelPort,
	type ModelTurn,
} from '../src/agent/loop';
import { DEVAL_TOOL_SCHEMAS, READ_FILE_TOOL } from '../src/agent/tool-schemas';
import { ContainsAllMetric } from './metrics/contains-all-metric';

/**
 * A model with two turns baked in: first it reads a file, then it answers
 * using what the tool returned.
 */
function scriptedModel(): ModelPort {
	const turns: ModelTurn[] = [
		{
			text: '',
			toolCalls: [{ id: 'call_1', name: READ_FILE_TOOL, input: { path: 'src/agent/tool-schemas.ts' } }],
		},
		{
			text: 'The deval_readFile tool reads the full text contents of a file in the workspace.',
			toolCalls: [],
		},
	];
	let index = 0;
	return {
		send: async () => turns[Math.min(index++, turns.length - 1)],
	};
}

const silentEvents: EventPort = {
	record: () => {},
};

/**
 * Run the loop the way the extension does, and publish the turn for metrics.
 *
 * Both levels are published on purpose: `updateCurrentSpan` fills the agent
 * span, and `updateCurrentTrace` fills the turn itself — which is the scope
 * `ToolCorrectnessMetric` reads `toolsCalled` from.
 */
const observedAgentLoop = observe({
	type: SpanType.AGENT,
	name: 'deval-agent-loop',
	fn: async (input: string) => {
		const run = await runAgentLoop(
			input,
			{
				model: scriptedModel(),
				tools: {
					invoke: async (name) =>
						name === READ_FILE_TOOL
							? 'Reads the full text contents of a file in the workspace.'
							: `unknown tool: ${name}`,
				},
				events: silentEvents,
			},
			{ toolSchemas: DEVAL_TOOL_SCHEMAS },
		);
		const turn = { input: run.input, output: run.output, toolsCalled: run.toolsCalled };
		updateCurrentSpan(turn);
		updateCurrentTrace(turn);
		return run.output;
	},
});

it('the agent loop reads a file and answers from it', async () => {
	const golden = new Golden({
		input: 'What does the deval_readFile tool do?',
		expectedTools: [{ name: READ_FILE_TOOL, inputParameters: { path: 'src/agent/tool-schemas.ts' } }],
	});

	await expect(golden).toPass(
		[
			new ContainsAllMetric({
				required: ['deval_readFile', 'full text contents'],
			}),
			new ToolCorrectnessMetric({ threshold: 1 }),
		],
		{ task: (testCase) => observedAgentLoop(testCase.input) },
	);
});
