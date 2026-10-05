import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	CAPTURE_HOOK_COMMAND,
	CAPTURE_HOOK_CONFIG_FILE,
	CAPTURE_HOOK_DIRECTORY,
	CAPTURE_HOOK_EVENTS,
	CAPTURE_HOOK_SCRIPT_FILE,
	getCaptureHookConfigSource,
	getCaptureHookFiles,
	getCaptureHookScriptSource,
} from '../capture-hook';
import { CAPTURED_RUN_DIRECTORY, describeMissingCaptures } from '../extension';

suite('capture hook', () => {
	/** The repository's own copy, which is what the embedded text must match. */
	function referenceFile(name: string): string {
		return readFileSync(join(__dirname, '..', '..', ...CAPTURE_HOOK_DIRECTORY, name), 'utf8');
	}

	/** The repository stores both files with CRLF; the embedded text uses LF. */
	function normalized(text: string): string {
		return text.replace(/\r\n/g, '\n');
	}

	test('ships the two files the Local harness discovers', () => {
		const hookRoot = CAPTURE_HOOK_DIRECTORY.join('/');

		assert.deepStrictEqual(
			getCaptureHookFiles().map((file) => file.segments.join('/')),
			[`${hookRoot}/${CAPTURE_HOOK_CONFIG_FILE}`, `${hookRoot}/${CAPTURE_HOOK_SCRIPT_FILE}`],
		);
	});

	test('the config subscribes every recorded event to the script', () => {
		const source = getCaptureHookConfigSource();

		assert.ok(source.endsWith('}\n'), 'the config ends with a newline');
		type HookAction = { type: string; command: string; cwd: string; timeout: number };
		const config = JSON.parse(source) as { hooks: Record<string, HookAction[]> };
		assert.deepStrictEqual(Object.keys(config.hooks), [...CAPTURE_HOOK_EVENTS]);
		for (const event of CAPTURE_HOOK_EVENTS) {
			const [action] = config.hooks[event];
			assert.strictEqual(action.type, 'command');
			assert.strictEqual(action.command, CAPTURE_HOOK_COMMAND);
			assert.strictEqual(action.command, 'node .github/hooks/deval-hook.cjs');
			assert.strictEqual(action.cwd, '.', 'the script must run at the workspace root');
		}
	});

	test('the script appends to the directory the evaluator reads', () => {
		const script = getCaptureHookScriptSource();

		assert.ok(script.includes('process.cwd()'), 'captures must land relative to the hook cwd');
		for (const segment of CAPTURED_RUN_DIRECTORY) {
			assert.ok(script.includes(`'${segment}'`), `the script must write ${segment}`);
		}
		assert.ok(script.includes('appendFileSync'));
		assert.ok(script.includes('hook_event_name'), 'the reader keys off the event name');
		assert.ok(script.includes('deval-hook.cjs') === false, 'the script does not reference itself');
	});

	test('stays in sync with the copies in .github/hooks', () => {
		const embedded = [getCaptureHookConfigSource(), getCaptureHookScriptSource()];

		for (const [index, file] of getCaptureHookFiles().entries()) {
			const name = file.segments[file.segments.length - 1];
			assert.strictEqual(
				normalized(embedded[index]),
				normalized(referenceFile(name)),
				`the embedded ${name} must match .github/hooks/${name}`,
			);
		}
	});

	test('the no-capture message names the directory that was searched', () => {
		const message = describeMissingCaptures({
			workspaceName: 'mt',
			eventsDirectory: '.deepeval/vscode-agent-events',
			hookConfig: '.github/hooks/deval.json',
			hookInstalled: false,
		});

		assert.ok(message.includes('Looked in .deepeval/vscode-agent-events'), message);
		assert.ok(message.includes('This workspace has no capture hook'), message);
		assert.ok(message.includes('.github/hooks/deval.json'), message);
		// The old wording blamed the user for a hook that was never installed.
		assert.ok(!message.includes('Enable the workspace hook'), message);
	});

	test('the no-capture message blames a silent hook rather than a missing one', () => {
		const message = describeMissingCaptures({
			workspaceName: 'deval',
			eventsDirectory: '.deepeval/vscode-agent-events',
			hookConfig: '.github/hooks/deval.json',
			hookInstalled: true,
		});

		assert.ok(message.includes('is installed but has not recorded a run yet'), message);
		assert.ok(message.includes('Local target'), message);
		assert.ok(!message.includes('no capture hook'), message);
	});
});
