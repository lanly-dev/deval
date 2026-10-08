import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendScore, readScores, SCORES_FILENAME, type ScoreRecord } from '../scores';

function sampleRecord(overrides: Partial<ScoreRecord> = {}): ScoreRecord {
	return {
		timestamp: '2026-10-08T12:00:00.000Z',
		kind: 'agent-run',
		label: 'abc123.jsonl',
		checks: [
			{ label: 'Run finished (Stop event)', passed: true, detail: 'Stop event present' },
			{ label: 'Tool calls resolved', passed: false, detail: '1 unresolved tool call out of 4' },
		],
		...overrides,
	};
}

suite('scores', () => {
	let dir: string;

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'deval-scores-'));
	});

	teardown(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('appends records and reads them back oldest-first', async () => {
		await appendScore(dir, sampleRecord({ timestamp: '2026-10-08T12:00:00.000Z', label: 'first' }));
		await appendScore(
			dir,
			sampleRecord({ timestamp: '2026-10-08T13:00:00.000Z', kind: 'model-benchmark', label: 'second' }),
		);

		const records = await readScores(dir);
		assert.strictEqual(records.length, 2);
		assert.strictEqual(records[0].label, 'first');
		assert.strictEqual(records[1].label, 'second');
		assert.strictEqual(records[1].kind, 'model-benchmark');
		assert.deepStrictEqual(records[0].checks[1], {
			label: 'Tool calls resolved',
			passed: false,
			detail: '1 unresolved tool call out of 4',
		});
	});

	test('returns an empty list when no history exists', async () => {
		assert.deepStrictEqual(await readScores(dir), []);
	});

	test('skips corrupt lines but keeps the rest', async () => {
		writeFileSync(
			join(dir, SCORES_FILENAME),
			'not json\n' + JSON.stringify(sampleRecord()) + '\n{"timestamp": 42, "checks": []}\n',
			'utf8',
		);
		const records = await readScores(dir);
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].label, 'abc123.jsonl');
	});

	test('appendScore never throws, even when the directory is unusable', async () => {
		const filePath = join(dir, 'not-a-directory');
		writeFileSync(filePath, 'x', 'utf8');
		await appendScore(filePath, sampleRecord());
		assert.deepStrictEqual(await readScores(filePath), []);
	});
});
