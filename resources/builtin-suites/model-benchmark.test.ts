/**
 * Built-in benchmark: score responses from the chat model wired to VS Code.
 *
 * This suite ships inside the extension (`resources/builtin-suites/`). The
 * `DeepEval: Benchmark Chat Model` command queries the user's selected chat
 * model for every case in `spec.json`, writes the responses to a JSON file,
 * stages this suite next to it, and runs it with `DEEPEVAL_MODEL_RESPONSES`
 * pointing at the responses file.
 *
 * Scoring is deterministic — each case passes when the response contains the
 * required keywords (case-insensitive) and none of the forbidden ones — so no
 * API key is needed.
 *
 * Run it from the Command Palette. Running it directly without
 * `DEEPEVAL_MODEL_RESPONSES` skips every case.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
		it.skip(`set ${ENV_VAR} to a model-responses JSON file (run "DeepEval: Benchmark Chat Model")`, () => {});
		return;
	}

	for (const testCase of loadCases()) {
		it(`model: ${testCase.id}`, () => {
			const response = responses.get(testCase.id);
			expect(response, `no response recorded for case "${testCase.id}"`).toBeDefined();
			const text = (response ?? '').toLowerCase();
			const missing = testCase.required.filter((keyword) => !text.includes(keyword.toLowerCase()));
			expect(missing, `missing keywords: ${missing.join(', ')}`).toEqual([]);
			for (const keyword of testCase.forbidden ?? []) {
				expect(text.includes(keyword.toLowerCase()), `forbidden keyword present: ${keyword}`).toBe(false);
			}
		});
	}
});
