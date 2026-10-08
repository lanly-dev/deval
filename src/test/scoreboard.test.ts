import * as assert from 'assert';

import { renderScoreboardHtml } from '../scoreboard';
import type { ScoreRecord } from '../scores';

const agentRun = (label: string, failedLabels: string[] = []): ScoreRecord => ({
	timestamp: '2026-10-08T12:00:00.000Z',
	kind: 'agent-run',
	label,
	checks: ['Run finished (Stop event)', 'Tool calls resolved', 'No destructive tools used'].map((checkLabel) => ({
		label: checkLabel,
		passed: !failedLabels.includes(checkLabel),
		detail: `${checkLabel} detail`,
	})),
});

const modelRun = (label: string): ScoreRecord => ({
	timestamp: '2026-10-08T13:00:00.000Z',
	kind: 'model-benchmark',
	label,
	checks: [
		{ label: 'capital-france', passed: true, detail: 'Contains All: pass (score 1)' },
		{ label: 'arithmetic', passed: false, detail: 'Contains All: fail (score 0)' },
	],
});

suite('scoreboard', () => {
	test('renders one column per run with pass/fail glyphs', () => {
		const html = renderScoreboardHtml([agentRun('a.jsonl'), agentRun('b.jsonl', ['Tool calls resolved']), modelRun('GPT-5')]);

		assert.ok(html.includes('<h2>Agent runs</h2>'), 'agent section');
		assert.ok(html.includes('<h2>Model benchmarks</h2>'), 'model section');
		assert.ok(html.includes('a.jsonl'), 'first run label');
		assert.ok(html.includes('b.jsonl'), 'second run label');
		assert.ok(html.includes('GPT-5'), 'model label');
		// 3 + 3 agent checks + 2 model checks = 8 cells: 6 pass, 2 fail.
		assert.strictEqual((html.match(/class="pass"/g) ?? []).length, 6);
		assert.strictEqual((html.match(/class="fail"/g) ?? []).length, 2);
		// Per-run summary in the header.
		assert.ok(html.includes('2/3'), 'agent run summary');
	});

	test('shows a dash for checks a run did not measure', () => {
		const html = renderScoreboardHtml([agentRun('a.jsonl'), { ...agentRun('b.jsonl'), checks: [] }]);
		assert.ok(html.includes('class="na"'), 'missing check renders as —');
	});

	test('shows the model in the run header when recorded', () => {
		const html = renderScoreboardHtml([{ ...agentRun('a.jsonl'), model: 'GPT-5' }, agentRun('b.jsonl')]);
		assert.ok(html.includes('GPT-5 ·'), 'model appears in the header meta line');
		// Only one run has a model; the other header must not gain a stray separator.
		assert.strictEqual((html.match(/GPT-5 ·/g) ?? []).length, 1);
	});

	test('escapes HTML in labels and details', () => {
		const html = renderScoreboardHtml([
			{
				timestamp: '2026-10-08T12:00:00.000Z',
				kind: 'agent-run',
				label: '<script>alert(1)</script>',
				checks: [{ label: 'x', passed: true, detail: '<b>bold</b>' }],
			},
		]);
		assert.ok(!html.includes('<script>alert(1)</script>'), 'label escaped');
		assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'label escaped correctly');
		assert.ok(html.includes('title="&lt;b&gt;bold&lt;/b&gt;"'), 'detail escaped');
	});
});
