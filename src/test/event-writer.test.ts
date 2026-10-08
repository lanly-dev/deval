import * as assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCaptureWriter, sanitizeSessionId } from '../events/event-writer';

suite('capture writer', () => {
	const createdRoots: string[] = [];

	teardown(() => {
		for (const root of createdRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function tempWorkspace(): string {
		const root = mkdtempSync(join(tmpdir(), 'deval-writer-'));
		createdRoots.push(root);
		return root;
	}

	test('fills in session_id and timestamp', () => {
		const writer = createCaptureWriter(tempWorkspace(), 'session-1');

		writer.append({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });

		const lines = readFileSync(writer.filePath, 'utf8').trim().split('\n');
		assert.strictEqual(lines.length, 1);
		const record = JSON.parse(lines[0]);
		assert.strictEqual(record.session_id, 'session-1');
		assert.strictEqual(record.hook_event_name, 'UserPromptSubmit');
		assert.strictEqual(record.prompt, 'hi');
		assert.ok(typeof record.timestamp === 'string' && record.timestamp.length > 0);
	});

	test('writes into the capture directory the run commands read', () => {
		const root = tempWorkspace();
		const writer = createCaptureWriter(root, 'abc');

		assert.strictEqual(
			writer.filePath,
			join(root, '.deval', 'vscode-agent-events', 'abc.jsonl'),
		);
		assert.ok(!existsSync(writer.filePath), 'file appears on first append, not on open');
		writer.append({ hook_event_name: 'Stop' });
		assert.ok(existsSync(writer.filePath));
	});

	test('appends one JSON object per line', () => {
		const writer = createCaptureWriter(tempWorkspace(), 'multi');

		writer.append({ hook_event_name: 'PreToolUse', tool_name: 'deval_readFile' });
		writer.append({ hook_event_name: 'PostToolUse', tool_name: 'deval_readFile' });

		const lines = readFileSync(writer.filePath, 'utf8').trim().split('\n');
		assert.strictEqual(lines.length, 2);
		for (const line of lines) {
			assert.strictEqual(JSON.parse(line).session_id, 'multi');
		}
	});

	test('keeps an explicit timestamp when given', () => {
		const writer = createCaptureWriter(tempWorkspace(), 'ts');

		writer.append({ hook_event_name: 'Stop', timestamp: '2026-01-01T00:00:00.000Z' });

		const record = JSON.parse(readFileSync(writer.filePath, 'utf8'));
		assert.strictEqual(record.timestamp, '2026-01-01T00:00:00.000Z');
	});

	test('sanitizes hostile session ids for the file name', () => {
		assert.strictEqual(sanitizeSessionId('../../etc/passwd'), '______etc_passwd');
		assert.strictEqual(sanitizeSessionId('ok-1_2'), 'ok-1_2');

		const writer = createCaptureWriter(tempWorkspace(), '../../evil');
		assert.ok(!writer.filePath.includes('..'));
		writer.append({ hook_event_name: 'Stop' });
		assert.ok(existsSync(writer.filePath));
	});
});
