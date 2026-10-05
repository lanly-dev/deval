/**
 * A custom, fully deterministic DeepEval metric.
 *
 * Subclassing `BaseMetric` is how you add a check that DeepEval does not ship.
 * This one needs no model and no `DEEPEVAL_API_KEY`, so the reference suites in
 * `benchmarks/` can run offline — which also makes them usable in CI.
 *
 * Copy this file as the starting point for your own rubric: set
 * `requiredParams`, compute a score in `measure`, and let `isSuccessful()`
 * compare it against the threshold.
 */

import { BaseMetric, checkSingleTurnParams } from 'deepeval/metrics';
import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';

export interface ContainsAllMetricOptions {
	/** Substrings that must appear in `actualOutput`. */
	required: string[];
	/** Substrings that must NOT appear in `actualOutput`. */
	forbidden?: string[];
	/** Score at or above which the metric passes. Defaults to `1`. */
	threshold?: number | null;
	/** Report the score without failing the test case. */
	flaky?: boolean;
	showIndicator?: boolean;
}

/**
 * Contains All — is every required substring present in `actualOutput`, and no
 * forbidden one?
 *
 * The score is the fraction of satisfied checks, so a partial match still
 * reports how far it got.
 */
export class ContainsAllMetric extends BaseMetric {
	required: string[];
	forbidden: string[];
	missing: string[] = [];
	present: string[] = [];

	constructor(options: ContainsAllMetricOptions) {
		super(options.threshold ?? 1, {
			flaky: options.flaky,
			showIndicator: options.showIndicator,
		});
		this.required = options.required;
		this.forbidden = options.forbidden ?? [];
		this.requiredParams = [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT];
	}

	async measure(testCase: LLMTestCase): Promise<number> {
		await this.startProgress();
		try {
			checkSingleTurnParams(testCase, this.requiredParams, this);

			const actual = testCase.actualOutput ?? '';
			this.missing = this.required.filter((needle) => !actual.includes(needle));
			this.present = this.forbidden.filter((needle) => actual.includes(needle));

			const total = this.required.length + this.forbidden.length;
			const failed = this.missing.length + this.present.length;
			this.score = total === 0 ? 1 : (total - failed) / total;

			const problems: string[] = [];
			if (this.missing.length > 0) {
				problems.push(`missing ${formatList(this.missing)}`);
			}
			if (this.present.length > 0) {
				problems.push(`contained forbidden ${formatList(this.present)}`);
			}
			this.reason =
				problems.length === 0
					? `The output contains all ${this.required.length} required fragment(s).`
					: `The output ${problems.join(' and ')}.`;

			this.success = this.isSuccessful();
			return this.score;
		} finally {
			this.stopProgress();
		}
	}

	get name(): string {
		return 'Contains All';
	}
}

function formatList(values: string[]): string {
	return values.map((value) => `"${value}"`).join(', ');
}
