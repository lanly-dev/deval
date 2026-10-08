import * as assert from 'assert';

import {
	LOOP_CUTOFF_MESSAGE,
	runAgentLoop,
	type EventPort,
	type LoopMessage,
	type ModelPort,
	type ModelTurn,
	type ToolPort,
} from '../agent/loop';
import { DEVAL_TOOL_SCHEMAS, READ_FILE_TOOL } from '../agent/tool-schemas';
import type { AgentEvent } from '../events/event-log';

interface FakeWorld {
	events: AgentEvent[];
	toolCalls: Array<{ name: string; input: unknown }>;
	sentMessages: LoopMessage[][];
	ports: { model: ModelPort; tools: ToolPort; events: EventPort };
}

/** Ports driven by a script of model turns, recording everything. */
function fakeWorld(
	turns: ModelTurn[],
	toolImpl?: (name: string, input: unknown) => Promise<unknown> | unknown,
): FakeWorld {
	const events: AgentEvent[] = [];
	const toolCalls: Array<{ name: string; input: unknown }> = [];
	const sentMessages: LoopMessage[][] = [];
	let turnIndex = 0;

	return {
		events,
		toolCalls,
		sentMessages,
		ports: {
			model: {
				send: async (messages) => {
					sentMessages.push(messages);
					return turns[Math.min(turnIndex++, turns.length - 1)];
				},
			},
			tools: {
				invoke: async (name, input) => {
					toolCalls.push({ name, input });
					return toolImpl ? toolImpl(name, input) : `result-of-${name}`;
				},
			},
			events: {
				record: (event) =>
					events.push({ session_id: 'test', timestamp: 't', ...event }),
			},
		},
	};
}

function hookNames(events: AgentEvent[]): Array<string | undefined> {
	return events.map((event) => event.hook_event_name);
}

suite('agent loop', () => {
	test('a text-only run records prompt and stop, with no tool calls', async () => {
		const world = fakeWorld([{ text: 'hello there', toolCalls: [] }]);

		const run = await runAgentLoop('hi', world.ports, { toolSchemas: DEVAL_TOOL_SCHEMAS });

		assert.strictEqual(run.input, 'hi');
		assert.strictEqual(run.output, 'hello there');
		assert.deepStrictEqual(run.toolsCalled, []);
		assert.deepStrictEqual(hookNames(world.events), ['UserPromptSubmit', 'Stop']);
		assert.strictEqual(world.toolCalls.length, 0);
	});

	test('a tool call is executed, paired, and its result fed back', async () => {
		const world = fakeWorld(
			[
				{
					text: '',
					toolCalls: [{ id: 'call_1', name: READ_FILE_TOOL, input: { path: 'a.txt' } }],
				},
				{ text: 'the file says hello', toolCalls: [] },
			],
			() => 'file contents: hello',
		);

		const run = await runAgentLoop('read a.txt', world.ports, {
			toolSchemas: DEVAL_TOOL_SCHEMAS,
		});

		assert.deepStrictEqual(hookNames(world.events), [
			'UserPromptSubmit',
			'PreToolUse',
			'PostToolUse',
			'Stop',
		]);
		const pre = world.events[1];
		const post = world.events[2];
		assert.strictEqual(pre.tool_use_id, 'call_1');
		assert.strictEqual(post.tool_use_id, 'call_1');
		assert.strictEqual(pre.tool_name, READ_FILE_TOOL);
		assert.strictEqual(post.tool_response, 'file contents: hello');

		assert.strictEqual(run.toolsCalled.length, 1);
		assert.strictEqual(run.toolsCalled[0].name, READ_FILE_TOOL);
		assert.deepStrictEqual(run.toolsCalled[0].inputParameters, { path: 'a.txt' });
		assert.strictEqual(run.toolsCalled[0].output, 'file contents: hello');
		assert.strictEqual(run.output, 'the file says hello');

		// The second model turn saw the tool call and its result.
		const secondTurn = world.sentMessages[1];
		assert.ok(secondTurn.some((m) => m.role === 'tool-call' && m.id === 'call_1'));
		assert.ok(
			secondTurn.some((m) => m.role === 'tool-result' && m.output === 'file contents: hello'),
		);
	});

	test('a failing tool is recorded as an error result and the loop continues', async () => {
		const world = fakeWorld(
			[
				{
					text: '',
					toolCalls: [{ id: 'call_1', name: 'nope', input: {} }],
				},
				{ text: 'done anyway', toolCalls: [] },
			],
			() => {
				throw new Error('boom');
			},
		);

		const run = await runAgentLoop('go', world.ports, { toolSchemas: DEVAL_TOOL_SCHEMAS });

		const post = world.events.find((e) => e.hook_event_name === 'PostToolUse');
		assert.deepStrictEqual(post?.tool_response, { error: 'boom' });
		assert.deepStrictEqual(hookNames(world.events).at(-1), 'Stop');
		assert.strictEqual(run.output, 'done anyway');
	});

	test('the loop stops after maxTurns without a Stop event', async () => {
		const world = fakeWorld([
			{ text: '', toolCalls: [{ id: 'c1', name: READ_FILE_TOOL, input: {} }] },
		]);

		const run = await runAgentLoop('go', world.ports, {
			toolSchemas: DEVAL_TOOL_SCHEMAS,
			maxTurns: 2,
		});

		assert.strictEqual(world.sentMessages.length, 2);
		assert.ok(run.output.includes(LOOP_CUTOFF_MESSAGE));
		assert.ok(!hookNames(world.events).includes('Stop'), 'a cut-off run reads as incomplete');
		assert.strictEqual(run.toolsCalled.length, 2);
	});
});
