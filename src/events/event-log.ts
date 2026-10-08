/**
 * Reader for the JSONL files written by the `@deval` agent loop
 * (`src/events/event-writer.ts`).
 *
 * Like `src/agent/loop.ts`, this module is dependency-free so it can be loaded
 * both in the extension host and in a plain Node process started by the
 * DeepEval test runner.
 *
 * The hook keeps a fixed set of fields; anything else in the input payload is
 * dropped before it reaches disk, so the log never contains more than the
 * fields enumerated in {@link AgentEvent}.
 */

import * as fs from 'node:fs';

/** Environment variable the extension sets to point a suite at one capture. */
export const DEEPEVAL_VSCODE_EVENTS = 'DEEPEVAL_VSCODE_EVENTS';

/** The hook event names this reader interprets. */
export const HOOK_EVENT_NAMES = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * Every hook event the Local harness documents.
 *
 * The harness also emits events this reader has no use for. They are still
 * written to the capture and ignored by {@link summarizeEventLog}, so a capture
 * containing them stays evaluable.
 */
export const ALL_LOCAL_HOOK_EVENTS = [
	...HOOK_EVENT_NAMES,
	'SessionStart',
	'SubagentStart',
	'SubagentStop',
	'PreCompact',
] as const;

/** One line of a captured Local-harness session. */
export interface AgentEvent {
	timestamp?: string;
	cwd?: string;
	session_id?: string;
	hook_event_name?: string;
	transcript_path?: string;
	prompt?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_use_id?: string;
	tool_response?: unknown;
	stop_hook_active?: boolean;
}

/** A parsed capture: the events plus a note of any lines that were unusable. */
export interface ParsedEventLog {
	events: AgentEvent[];
	/** One-based line numbers that were blank or not valid JSON objects. */
	skippedLines: number[];
}

/** One tool invocation, paired from its PreToolUse and PostToolUse events. */
export interface ToolInvocation {
	toolName: string;
	toolUseId?: string;
	input?: unknown;
	output?: unknown;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
}

/** The trajectory a capture describes, in the shape a benchmark can assert on. */
export interface CapturedRunSummary {
	sessionId?: string;
	transcriptPath?: string;
	workingDirectory?: string;
	/** Prompts the user submitted, in order. */
	prompts: string[];
	/** Tool invocations, in order. */
	toolInvocations: ToolInvocation[];
	/** Distinct tool names used, in first-use order. */
	toolsUsed: string[];
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	/** True when the capture contains a `Stop` event, i.e. the run finished. */
	completed: boolean;
	eventCount: number;
	stopCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a JSONL capture.
 *
 * Blank lines and lines that are not JSON objects are skipped rather than
 * thrown on, so one truncated write cannot make an entire run unevaluable.
 */
export function parseEventLog(text: string): ParsedEventLog {
	const events: AgentEvent[] = [];
	const skippedLines: number[] = [];

	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			skippedLines.push(index + 1);
			continue;
		}

		if (!isRecord(parsed)) {
			skippedLines.push(index + 1);
			continue;
		}

		events.push({
			timestamp: asOptionalString(parsed.timestamp),
			cwd: asOptionalString(parsed.cwd),
			session_id: asOptionalString(parsed.session_id),
			hook_event_name: asOptionalString(parsed.hook_event_name),
			transcript_path: asOptionalString(parsed.transcript_path),
			prompt: asOptionalString(parsed.prompt),
			tool_name: asOptionalString(parsed.tool_name),
			tool_input: parsed.tool_input,
			tool_use_id: asOptionalString(parsed.tool_use_id),
			tool_response: parsed.tool_response,
			stop_hook_active: typeof parsed.stop_hook_active === 'boolean' ? parsed.stop_hook_active : undefined,
		});
	}

	return { events, skippedLines };
}

function elapsedMs(start: string | undefined, end: string | undefined): number | undefined {
	if (!start || !end) {
		return undefined;
	}
	const started = Date.parse(start);
	const finished = Date.parse(end);
	if (Number.isNaN(started) || Number.isNaN(finished)) {
		return undefined;
	}
	return Math.max(0, finished - started);
}

/**
 * Collapse a capture into the trajectory a benchmark asserts on.
 *
 * `PreToolUse` / `PostToolUse` pairs are joined by `tool_use_id` when the
 * harness provides one, and fall back to the earliest still-open invocation of
 * the same tool otherwise.
 */
export function summarizeEventLog(events: AgentEvent[]): CapturedRunSummary {
	const prompts: string[] = [];
	const toolInvocations: ToolInvocation[] = [];
	const openByToolUseId = new Map<string, ToolInvocation>();
	const openByToolName = new Map<string, ToolInvocation[]>();

	let sessionId: string | undefined;
	let transcriptPath: string | undefined;
	let workingDirectory: string | undefined;
	let startedAt: string | undefined;
	let endedAt: string | undefined;
	let stopCount = 0;

	for (const event of events) {
		sessionId ??= event.session_id;
		transcriptPath ??= event.transcript_path;
		workingDirectory ??= event.cwd;
		if (event.timestamp) {
			startedAt ??= event.timestamp;
			endedAt = event.timestamp;
		}

		switch (event.hook_event_name) {
			case 'UserPromptSubmit': {
				if (typeof event.prompt === 'string') {
					prompts.push(event.prompt);
				}
				break;
			}
			case 'PreToolUse': {
				const invocation: ToolInvocation = {
					toolName: event.tool_name ?? 'unknown',
					toolUseId: event.tool_use_id,
					input: event.tool_input,
					startedAt: event.timestamp,
				};
				toolInvocations.push(invocation);
				if (invocation.toolUseId) {
					openByToolUseId.set(invocation.toolUseId, invocation);
				}
				const byName = openByToolName.get(invocation.toolName) ?? [];
				byName.push(invocation);
				openByToolName.set(invocation.toolName, byName);
				break;
			}
			case 'PostToolUse': {
				const toolName = event.tool_name ?? 'unknown';
				let match = event.tool_use_id ? openByToolUseId.get(event.tool_use_id) : undefined;
				if (!match) {
					const candidates = openByToolName.get(toolName) ?? [];
					match = candidates.find((candidate) => candidate.finishedAt === undefined);
				}
				if (!match) {
					match = { toolName, toolUseId: event.tool_use_id, startedAt: event.timestamp };
					toolInvocations.push(match);
				}
				match.output = event.tool_response;
				match.finishedAt = event.timestamp;
				match.durationMs = elapsedMs(match.startedAt, match.finishedAt);
				if (match.toolUseId) {
					openByToolUseId.delete(match.toolUseId);
				}
				const byName = openByToolName.get(match.toolName);
				if (byName) {
					const index = byName.indexOf(match);
					if (index >= 0) {
						byName.splice(index, 1);
					}
				}
				break;
			}
			case 'Stop': {
				stopCount += 1;
				break;
			}
			default:
				break;
		}
	}

	const toolsUsed: string[] = [];
	for (const invocation of toolInvocations) {
		if (!toolsUsed.includes(invocation.toolName)) {
			toolsUsed.push(invocation.toolName);
		}
	}

	return {
		sessionId,
		transcriptPath,
		workingDirectory,
		prompts,
		toolInvocations,
		toolsUsed,
		startedAt,
		endedAt,
		durationMs: elapsedMs(startedAt, endedAt),
		completed: stopCount > 0,
		eventCount: events.length,
		stopCount,
	};
}

/** Parse and summarize a capture file. */
export function loadCapturedRun(filePath: string): { parsed: ParsedEventLog; summary: CapturedRunSummary } {
	const parsed = parseEventLog(fs.readFileSync(filePath, 'utf8'));
	return { parsed, summary: summarizeEventLog(parsed.events) };
}

/**
 * Read the capture path the extension selected via
 * {@link DEEPEVAL_VSCODE_EVENTS}.
 *
 * Returns `undefined` when the variable is unset, which is the normal case when
 * a suite is launched directly through `npx deepeval test run` rather than
 * through the `DeepEval: Evaluate Captured Agent Run` command.
 */
export function resolveCapturedRunPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[DEEPEVAL_VSCODE_EVENTS];
	// Trimmed because the variable is often set from a shell, where a stray
	// space before `&&` silently becomes part of the value.
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}
