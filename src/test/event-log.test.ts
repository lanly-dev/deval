import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ALL_LOCAL_HOOK_EVENTS,
	DEEPEVAL_VSCODE_EVENTS,
	loadCapturedRun,
	parseEventLog,
	resolveCapturedRunPath,
	summarizeEventLog,
} from '../events/event-log';

const TS = '2026-01-02T03:04:05.000Z';

function jsonl(...events: object[]): string {
	return events.map((event) => JSON.stringify(event)).join('\n');
}

suite('Captured run event log', () => {
	test('parses one JSON object per line', () => {
		const { events, skippedLines } = parseEventLog(
			jsonl(
				{ timestamp: TS, hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
				{ timestamp: TS, hook_event_name: 'Stop', stop_hook_active: false },
			),
		);

		assert.strictEqual(events.length, 2);
		assert.deepStrictEqual(skippedLines, []);
		assert.strictEqual(events[0].prompt, 'hello');
		assert.strictEqual(events[1].stop_hook_active, false);
	});

	test('skips blank lines and unparseable lines without throwing', () => {
		const text = ['', '{ not json', '[]', JSON.stringify({ hook_event_name: 'Stop' }), ''].join('\n');
		const { events, skippedLines } = parseEventLog(text);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].hook_event_name, 'Stop');
		assert.deepStrictEqual(skippedLines, [2, 3]);
	});

	test('splits CRLF files and trims surrounding whitespace', () => {
		const text = `  ${JSON.stringify({ hook_event_name: 'Stop' })}  \r\n`;
		const { events, skippedLines } = parseEventLog(text);

		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(skippedLines, []);
	});

	test('ignores non-string values where the contract expects a string', () => {
		const { events } = parseEventLog(
			JSON.stringify({ hook_event_name: 'Stop', tool_input: 'not-an-object', prompt: 42 }),
		);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].prompt, undefined);
		assert.strictEqual(events[0].tool_input, 'not-an-object');
	});

	test('summarizes prompts, tools, and completion', () => {
		const { events } = parseEventLog(
			jsonl(
				{ timestamp: TS, session_id: 's1', transcript_path: '/tmp/t.jsonl', cwd: '/w' },
				{ timestamp: TS, hook_event_name: 'UserPromptSubmit', prompt: 'add a task' },
				{ timestamp: TS, hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_use_id: 't1' },
				{ timestamp: TS, hook_event_name: 'PostToolUse', tool_name: 'read_file', tool_use_id: 't1' },
				{
					timestamp: '2026-01-02T03:04:05.000Z',
					hook_event_name: 'PreToolUse',
					tool_name: 'create_file',
					tool_use_id: 't2',
				},
				{
					timestamp: '2026-01-02T03:04:07.000Z',
					hook_event_name: 'PostToolUse',
					tool_name: 'create_file',
					tool_use_id: 't2',
				},
				{ timestamp: '2026-01-02T03:04:09.000Z', hook_event_name: 'Stop' },
			),
		);

		const summary = summarizeEventLog(events);

		assert.strictEqual(summary.sessionId, 's1');
		assert.strictEqual(summary.transcriptPath, '/tmp/t.jsonl');
		assert.strictEqual(summary.workingDirectory, '/w');
		assert.deepStrictEqual(summary.prompts, ['add a task']);
		assert.deepStrictEqual(summary.toolsUsed, ['read_file', 'create_file']);
		assert.strictEqual(summary.toolInvocations.length, 2);
		assert.strictEqual(summary.toolInvocations[1].durationMs, 2000);
		assert.strictEqual(summary.completed, true);
		assert.strictEqual(summary.stopCount, 1);
		assert.strictEqual(summary.eventCount, 7);
	});

	test('surfaces the model recorded on SessionStart', () => {
		const { events } = parseEventLog(
			jsonl(
				{ timestamp: TS, session_id: 's1', hook_event_name: 'SessionStart', model: 'GPT-5' },
				{ timestamp: TS, hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
				{ timestamp: TS, hook_event_name: 'Stop' },
			),
		);
		const summary = summarizeEventLog(events);
		assert.strictEqual(summary.model, 'GPT-5');
	});

	test('model is undefined when the capture recorded none', () => {
		const { events } = parseEventLog(jsonl({ timestamp: TS, hook_event_name: 'Stop' }));
		assert.strictEqual(summarizeEventLog(events).model, undefined);
	});

	test('pairs tool events that omit a tool_use_id, in order', () => {
		const { events } = parseEventLog(
			jsonl(
				{ timestamp: TS, hook_event_name: 'PreToolUse', tool_name: 'read_file' },
				{ timestamp: TS, hook_event_name: 'PreToolUse', tool_name: 'read_file' },
				{ timestamp: TS, hook_event_name: 'PostToolUse', tool_name: 'read_file' },
				{ timestamp: TS, hook_event_name: 'PostToolUse', tool_name: 'read_file' },
			),
		);

		const summary = summarizeEventLog(events);

		assert.strictEqual(summary.toolInvocations.length, 2);
		assert.ok(summary.toolInvocations.every((invocation) => invocation.finishedAt !== undefined));
		assert.strictEqual(summary.completed, false);
	});

	test('records a tool result that arrives without a preceding call', () => {
		const { events } = parseEventLog(
			jsonl({ timestamp: TS, hook_event_name: 'PostToolUse', tool_name: 'run_command' }),
		);

		const summary = summarizeEventLog(events);

		assert.strictEqual(summary.toolInvocations.length, 1);
		assert.strictEqual(summary.toolInvocations[0].toolName, 'run_command');
		assert.strictEqual(summary.toolInvocations[0].finishedAt, TS);
	});

	test('tolerates the hook events it does not interpret', () => {
		// SessionStart, SubagentStart, SubagentStop, and PreCompact are all real
		// Local-harness events. A capture that contains them must still evaluate.
		const { events, skippedLines } = parseEventLog(
			jsonl(
				{ timestamp: TS, hook_event_name: 'SessionStart' },
				{ timestamp: TS, hook_event_name: 'PreCompact', trigger: 'auto' },
				{ timestamp: TS, hook_event_name: 'SubagentStart', agent_type: 'Plan' },
				{ timestamp: TS, hook_event_name: 'SubagentStop', agent_type: 'Plan' },
				{ timestamp: TS, hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
				{ timestamp: TS, hook_event_name: 'Stop' },
			),
		);

		const summary = summarizeEventLog(events);

		assert.deepStrictEqual(skippedLines, []);
		assert.strictEqual(summary.eventCount, 6);
		assert.deepStrictEqual(summary.prompts, ['hello']);
		assert.deepStrictEqual(summary.toolsUsed, []);
		assert.strictEqual(summary.completed, true);
		assert.strictEqual(summary.stopCount, 1);
	});

	test('lists every documented Local hook event', () => {
		assert.strictEqual(ALL_LOCAL_HOOK_EVENTS.length, 8);
		for (const ignored of ['SessionStart', 'SubagentStart', 'SubagentStop', 'PreCompact']) {
			assert.ok(ALL_LOCAL_HOOK_EVENTS.includes(ignored as never), `${ignored} should be documented`);
		}
	});

	test('an empty capture summarizes to an empty, incomplete run', () => {
		const summary = summarizeEventLog([]);

		assert.deepStrictEqual(summary.prompts, []);
		assert.deepStrictEqual(summary.toolsUsed, []);
		assert.strictEqual(summary.completed, false);
		assert.strictEqual(summary.eventCount, 0);
		assert.strictEqual(summary.durationMs, undefined);
	});

	test('resolveCapturedRunPath reads the environment and ignores blanks', () => {
		assert.strictEqual(
			resolveCapturedRunPath({ [DEEPEVAL_VSCODE_EVENTS]: 'C:/runs/a.jsonl' }),
			'C:/runs/a.jsonl',
		);
		assert.strictEqual(resolveCapturedRunPath({ [DEEPEVAL_VSCODE_EVENTS]: '   ' }), undefined);
		assert.strictEqual(resolveCapturedRunPath({}), undefined);
	});

	test('resolveCapturedRunPath trims shell quoting artefacts', () => {
		assert.strictEqual(
			resolveCapturedRunPath({ [DEEPEVAL_VSCODE_EVENTS]: '  C:/runs/a.jsonl  ' }),
			'C:/runs/a.jsonl',
		);
	});

	test('loadCapturedRun reads and summarizes a real file', () => {
		const filePath = path.join(os.tmpdir(), `deval-event-log-${Date.now()}.jsonl`);
		fs.writeFileSync(
			filePath,
			jsonl(
				{ timestamp: TS, session_id: 'disk', hook_event_name: 'UserPromptSubmit', prompt: 'from disk' },
				{ timestamp: TS, hook_event_name: 'Stop' },
			),
			'utf8',
		);

		try {
			const { summary } = loadCapturedRun(filePath);
			assert.strictEqual(summary.sessionId, 'disk');
			assert.deepStrictEqual(summary.prompts, ['from disk']);
			assert.strictEqual(summary.completed, true);
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});
});
