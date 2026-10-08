/**
 * Built-in benchmark: score responses from the chat model wired to VS Code.
 *
 * This suite ships inside the extension (`resources/builtin-suites/`). The
 * `Deval: Benchmark Chat Model` command queries the user's selected chat
 * model for every case in `spec.json`, writes the responses to a JSON file,
 * stages this suite next to it, and runs it with `DEEPEVAL_MODEL_RESPONSES`
 * pointing at the responses file.
 *
 * Scoring is deterministic — each case passes when the response contains the
 * required keywords (case-insensitive) and none of the forbidden ones — so no
 * API key is needed.
 *
 * The assertions go through DeepEval's `toPass` matcher (not plain vitest
 * assertions) so that `deepeval test run` persists each case and writes its
 * `.latest_test_run.json` results file, which the extension reads back for
 * the scoreboard.
 *
 * Run it from the Command Palette. Running it directly without
 * `DEEPEVAL_MODEL_RESPONSES` skips every case.
 */

import 'deepeval/vitest';

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BaseMetric, checkSingleTurnParams } from 'deepeval/metrics';
import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';

const ENV_VAR = 'DEEPEVAL_MODEL_RESPONSES';

interface BenchmarkCase {
	id: string;
	prompt: string;
	required: string[];
	forbidden?: string[];
}

interface ModelResponse {
	id: string;
	response: string;
}

/**
 * Deterministic DeepEval metric: every required keyword is present in the
 * output (case-insensitive) and no forbidden keyword appears.
 */
class KeywordMetric extends BaseMetric {
	required: string[];
	forbidden: string[];

	constructor(required: string[], forbidden: string[] = []) {
		super(1);
		this.required = required;
		this.forbidden = forbidden;
		this.requiredParams = [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT];
	}

	async measure(testCase: LLMTestCase): Promise<number> {
		checkSingleTurnParams(testCase, this.requiredParams, this);

		const text = (testCase.actualOutput ?? '').toLowerCase();
		const missing = this.required.filter((keyword) => !text.includes(keyword.toLowerCase()));
		const hitForbidden = this.forbidden.filter((keyword) => text.includes(keyword.toLowerCase()));

		const total = this.required.length + this.forbidden.length;
		const failed = missing.length + hitForbidden.length;
		this.score = total === 0 ? 1 : (total - failed) / total;

		const problems: string[] = [];
		if (missing.length > 0) {
			problems.push(`missing ${missing.map((keyword) => `"${keyword}"`).join(', ')}`);
		}
		if (hitForbidden.length > 0) {
			problems.push(`contained forbidden ${hitForbidden.map((keyword) => `"${keyword}"`).join(', ')}`);
		}
		this.reason =
			problems.length === 0
				? `The output contains all ${this.required.length} required keyword(s).`
				: `The output ${problems.join(' and ')}.`;

		this.success = this.isSuccessful();
		return this.score;
	}

	get name(): string {
		return 'Keyword Check';
	}
}

function loadCases(): BenchmarkCase[] {
	const raw = readFileSync(new URL('./spec.json', import.meta.url), 'utf8');
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error('spec.json must contain an array of benchmark cases');
	}
	return parsed as BenchmarkCase[];
}

function loadResponses(): Map<string, string> | undefined {
	const path = process.env[ENV_VAR];
	if (!path) {
		return undefined;
	}
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
	const list = (Array.isArray(parsed) ? parsed : (parsed as { responses: unknown }).responses) as ModelResponse[];
	const responses = new Map<string, string>();
	for (const entry of list) {
		responses.set(entry.id, entry.response ?? '');
	}
	return responses;
}

describe('built-in chat model benchmark', () => {
	const responses = loadResponses();
	if (!responses) {
		it.skip(`set ${ENV_VAR} to a model-responses JSON file (run "Deval: Benchmark Chat Model")`, () => {});
		return;
	}

	for (const testCase of loadCases()) {
		it(`model: ${testCase.id}`, async () => {
			const response = responses.get(testCase.id);
			if (response === undefined) {
				throw new Error(`no response recorded for case "${testCase.id}"`);
			}
			const llmTestCase = new LLMTestCase({
				input: testCase.prompt,
				actualOutput: response,
			});
			await expect(llmTestCase).toPass([new KeywordMetric(testCase.required, testCase.forbidden ?? [])]);
		});
	}
});
