/**
 * A second custom, deterministic metric: how much of a captured trajectory
 * actually completed?
 *
 * A VS Code Local-harness capture emits `PreToolUse` before a tool runs and
 * `PostToolUse` after. A tool the user *denies* never produces a `PostToolUse`,
 * so a small number of unresolved calls is normal. A large number means the run
 * was interrupted or the hook is misconfigured — which is what this metric
 * fails on.
 *
 * It reads the counts straight out of the trajectory digest, so the benchmark
 * only has to hand it the same string it hands every other metric.
 */

import { BaseMetric, checkSingleTurnParams } from 'deepeval/metrics';
import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';

export interface ToolCallResolutionMetricOptions {
	/** Highest tolerated share of unresolved calls, between 0 and 1. */
	maxUnresolvedRatio?: number;
	threshold?: number | null;
	showIndicator?: boolean;
}

const CALL_LINE = /^tool\[\d+\]:/gm;
const RESOLVED_MARKER = /resolved=true/gm;

export class ToolCallResolutionMetric extends BaseMetric {
	readonly maxUnresolvedRatio: number;
	totalCalls = 0;
	unresolvedCalls = 0;

	constructor(options: ToolCallResolutionMetricOptions = {}) {
		super(options.threshold ?? 1, { showIndicator: options.showIndicator });
		this.maxUnresolvedRatio = options.maxUnresolvedRatio ?? 0.05;
		this.requiredParams = [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT];
	}

	async measure(testCase: LLMTestCase): Promise<number> {
		await this.startProgress();
		try {
			checkSingleTurnParams(testCase, this.requiredParams, this);

			const digest = testCase.actualOutput ?? '';
			this.totalCalls = (digest.match(CALL_LINE) ?? []).length;
			const resolved = (digest.match(RESOLVED_MARKER) ?? []).length;
			this.unresolvedCalls = Math.max(0, this.totalCalls - resolved);

			const ratio = this.totalCalls === 0 ? 0 : this.unresolvedCalls / this.totalCalls;
			this.score = ratio <= this.maxUnresolvedRatio ? 1 : 0;

			const percentage = (ratio * 100).toFixed(1);
			const budget = (this.maxUnresolvedRatio * 100).toFixed(0);
			this.reason =
				this.unresolvedCalls === 0
					? `All ${this.totalCalls} tool call(s) returned a result.`
					: `${this.unresolvedCalls}/${this.totalCalls} tool call(s) never returned a result ` +
						`(${percentage}%, budget ${budget}%). A tool the user denied is recorded as a ` +
						`PreToolUse with no matching PostToolUse.`;

			this.success = this.isSuccessful();
			return this.score;
		} finally {
			this.stopProgress();
		}
	}

	get name(): string {
		return 'Tool Call Resolution';
	}
}
