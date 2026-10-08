/**
 * Built-in benchmark: score responses from the chat model wired to VS Code.
 *
 * This suite ships inside the extension (`resources/builtin-suites/`). The
 * `Deval: Benchmark Chat Model` command queries the user's selected chat
 * model for every case in `spec.json`, writes the responses to a JSON file,
 * stages this suite next to it, and runs it with `DEEPEVAL_MODEL_RESPONSES`
 * pointing at the responses file.
 *
 * Scoring is deterministic — no API key is needed — and comes in two kinds:
 * - `keyword` cases pass when the response contains the required keywords
 *   (case-insensitive) and none of the forbidden ones.
 * - `code` cases ask the model to write a JavaScript function; the metric
 *   extracts the code, runs it in a sandboxed VM with a timeout, and checks
 *   it against test vectors — a miniature HumanEval. Execution, not keyword
 *   matching, is what makes these discriminate between models.
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
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BaseMetric, checkSingleTurnParams } from 'deepeval/metrics';
import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';

const ENV_VAR = 'DEEPEVAL_MODEL_RESPONSES';

/** Wall-clock budget for loading the model's code and running every vector. */
const CODE_EXECUTION_TIMEOUT_MS = 2000;

interface CodeVector {
	args: unknown[];
	expected: unknown;
}

interface BenchmarkCase {
	id: string;
	kind?: 'keyword' | 'code';
	prompt: string;
	required: string[];
	forbidden?: string[];
	function?: string;
	vectors?: CodeVector[];
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

/**
 * Deterministic DeepEval metric: extract the JavaScript function from the
 * model's response, run it against test vectors in a sandboxed VM, and score
 * the fraction of vectors whose result structurally equals the expectation.
 *
 * The model only ever sees the prompt — the vectors stay hidden in spec.json —
 * so this measures actual correctness, the way HumanEval does.
 */
class CodeExecutionMetric extends BaseMetric {
	functionName: string;
	vectors: CodeVector[];

	constructor(functionName: string, vectors: CodeVector[]) {
		super(1);
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) {
			throw new Error(`invalid function name: ${functionName}`);
		}
		this.functionName = functionName;
		this.vectors = vectors;
		this.requiredParams = [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT];
	}

	async measure(testCase: LLMTestCase): Promise<number> {
		checkSingleTurnParams(testCase, this.requiredParams, this);

		const total = this.vectors.length;
		const failures: string[] = [];
		let passed = 0;
		try {
			const outcomes = runVectors(testCase.actualOutput ?? '', this.functionName, this.vectors);
			for (const [index, outcome] of outcomes.entries()) {
				if (outcome.threw) {
					failures.push(`vector ${index + 1} threw: ${outcome.error}`);
				} else if (!deepEqual(outcome.value, this.vectors[index].expected)) {
					failures.push(
						`vector ${index + 1}: got ${formatValue(outcome.value)}, expected ${formatValue(this.vectors[index].expected)}`,
					);
				} else {
					passed++;
				}
			}
		} catch (error) {
			// The code never loaded (syntax error, timeout, missing function):
			// no vector ran, so none passed.
			failures.push(`could not run the code: ${error instanceof Error ? error.message : String(error)}`);
			passed = 0;
		}

		this.score = total === 0 ? 0 : passed / total;
		this.reason =
			failures.length === 0
				? `All ${total} test vector(s) passed.`
				: `${failures.length}/${total} vector(s) failed: ${failures.join('; ')}`;
		this.success = this.isSuccessful();
		return this.score;
	}

	get name(): string {
		return 'Code Execution';
	}
}

/** Pull the code out of the response, tolerating markdown fences and prose. */
function extractCode(response: string): string {
	const fenced = response.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/);
	return (fenced ? fenced[1] : response).trim();
}

interface VectorOutcome {
	threw: boolean;
	value?: unknown;
	error?: string;
}

/**
 * Run every vector against the extracted function inside one VM script, so a
 * single timeout covers loading and all calls — an infinite loop fails the
 * case instead of hanging the suite. Results cross back as JSON, keeping the
 * comparison in this realm.
 */
function runVectors(code: string, functionName: string, vectors: CodeVector[]): VectorOutcome[] {
	const script = `${extractCode(code)}
;(() => {
	const __fn = ${functionName};
	if (typeof __fn !== 'function') {
		throw new Error('no function named "${functionName}" found in the response');
	}
	const __args = ${JSON.stringify(vectors.map((vector) => vector.args))};
	return JSON.stringify(__args.map((__callArgs) => {
		try {
			return { threw: false, value: __fn(...__callArgs) };
		} catch (__error) {
			return { threw: true, error: String((__error && __error.message) || __error) };
		}
	}));
})()`;
	const raw: unknown = runInContext(script, createContext({}), { timeout: CODE_EXECUTION_TIMEOUT_MS });
	if (typeof raw !== 'string') {
		throw new Error('the sandboxed run did not return results');
	}
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error('the sandboxed run returned malformed results');
	}
	return parsed as VectorOutcome[];
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) {
		return true;
	}
	if (typeof a !== typeof b || a === null || b === null) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => deepEqual(value, (b as unknown[])[index]))
		);
	}
	if (typeof a === 'object') {
		const aRecord = a as Record<string, unknown>;
		const bRecord = b as Record<string, unknown>;
		const aKeys = Object.keys(aRecord);
		return aKeys.length === Object.keys(bRecord).length && aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
	}
	return false;
}

function formatValue(value: unknown): string {
	const json = JSON.stringify(value);
	return json === undefined ? String(value) : json;
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
			if (testCase.kind === 'code') {
				if (!testCase.function || !Array.isArray(testCase.vectors) || testCase.vectors.length === 0) {
					throw new Error(`code case "${testCase.id}" is missing its function or vectors`);
				}
				await expect(llmTestCase).toPass([new CodeExecutionMetric(testCase.function, testCase.vectors)]);
			} else {
				await expect(llmTestCase).toPass([new KeywordMetric(testCase.required, testCase.forbidden ?? [])]);
			}
		});
	}
});
