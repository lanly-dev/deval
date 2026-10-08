/**
 * The `@deval` agent loop, as dependency-free logic.
 *
 * This module imports neither `vscode` nor `deepeval`: the model, the tools,
 * and the capture sink arrive as ports, so the same loop runs inside the
 * extension host (wired to `vscode.lm` by `vscode-adapter.ts`), in unit tests
 * with fakes, and in benchmark suites with a scripted model.
 *
 * The loop speaks the same capture language as the Local-harness hook: every
 * turn records `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`
 * events through the event port, so a run of this loop is a capture that
 * `src/events/event-log.ts` already knows how to read and the captured-run
 * benchmark already knows how to score.
 */

import type { AgentEvent } from '../events/event-log';
import type { DevalToolSchema } from './tool-schemas';

/** A tool invocation an agent made while producing its artifact. */
export interface AgentToolCall {
	name: string;
	inputParameters?: Record<string, unknown>;
	output?: unknown;
}

/** One completed agent run, in the shape the benchmark suites consume. */
export interface AgentRun {
	/** The prompt the agent was asked to satisfy. */
	input: string;
	/** The artifact the agent produced, as text. */
	output: string;
	/** The tools the agent used to get there, in call order. */
	toolsCalled: AgentToolCall[];
}

/** One message in the agent's conversation. */
export type LoopMessage =
	| { role: 'user'; text: string }
	| { role: 'assistant'; text: string }
	| { role: 'tool-call'; id: string; name: string; input: unknown }
	| { role: 'tool-result'; id: string; output: unknown };

/** One tool call the model requested this turn. */
export interface RequestedToolCall {
	id: string;
	name: string;
	input: unknown;
}

/** What the model returned for a single turn. */
export interface ModelTurn {
	/** Text the model produced this turn, possibly empty. */
	text: string;
	/** Tool calls the model requested this turn, in order. */
	toolCalls: RequestedToolCall[];
}

/** Sends the conversation to the model. Implemented by `vscode-adapter.ts`. */
export interface ModelPort {
	send(messages: LoopMessage[], tools: DevalToolSchema[]): Promise<ModelTurn>;
}

/** Executes a tool by name. Implemented by `vscode-adapter.ts`. */
export interface ToolPort {
	invoke(name: string, input: unknown): Promise<unknown>;
}

/** Records capture events. Implemented by `event-writer.ts`. */
export interface EventPort {
	record(event: Omit<AgentEvent, 'session_id' | 'timestamp'> & { timestamp?: string }): void;
}

export interface AgentLoopOptions {
	/** Tool schemas offered to the model. */
	toolSchemas: DevalToolSchema[];
	/** Turns before the loop gives up. Defaults to `DEFAULT_MAX_TURNS`. */
	maxTurns?: number;
	/** System instruction placed before the user prompt. */
	systemPrompt?: string;
	/** Called with each text chunk the model streams, for live display. */
	onTextChunk?: (chunk: string) => void;
}

/** How many model turns the loop attempts before stopping. */
export const DEFAULT_MAX_TURNS = 10;

/** True when the loop stopped because it ran out of turns. */
export const LOOP_CUTOFF_MESSAGE = 'The agent reached the turn limit before finishing.';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run one agentic turn loop for `input`.
 *
 * Returns an `AgentRun` — the same shape the benchmark suites consume — so the
 * agent this loop drives is directly measurable. Capture events are recorded
 * through the event port; a `Stop` event is recorded only when the model
 * finishes on its own, so a run that hits the turn limit reads as incomplete.
 */
export async function runAgentLoop(
	input: string,
	ports: { model: ModelPort; tools: ToolPort; events: EventPort },
	options: AgentLoopOptions,
): Promise<AgentRun> {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const messages: LoopMessage[] = [];
	if (options.systemPrompt) {
		messages.push({ role: 'user', text: options.systemPrompt });
	}
	messages.push({ role: 'user', text: input });
	ports.events.record({ hook_event_name: 'UserPromptSubmit', prompt: input });

	const toolsCalled: AgentToolCall[] = [];
	const outputParts: string[] = [];
	let finished = false;

	for (let turn = 0; turn < maxTurns && !finished; turn += 1) {
		const { text, toolCalls } = await ports.model.send(messages, options.toolSchemas);

		if (text) {
			outputParts.push(text);
			messages.push({ role: 'assistant', text });
			options.onTextChunk?.(text);
		}

		if (toolCalls.length === 0) {
			finished = true;
			break;
		}

		for (const call of toolCalls) {
			const inputParameters = isRecord(call.input) ? call.input : undefined;
			ports.events.record({
				hook_event_name: 'PreToolUse',
				tool_name: call.name,
				tool_input: call.input,
				tool_use_id: call.id,
			});

			let output: unknown;
			try {
				output = await ports.tools.invoke(call.name, call.input);
			} catch (error) {
				output = { error: error instanceof Error ? error.message : String(error) };
			}

			ports.events.record({
				hook_event_name: 'PostToolUse',
				tool_name: call.name,
				tool_input: call.input,
				tool_use_id: call.id,
				tool_response: output,
			});
			toolsCalled.push({ name: call.name, inputParameters, output });
			messages.push({ role: 'tool-call', id: call.id, name: call.name, input: call.input });
			messages.push({ role: 'tool-result', id: call.id, output });
		}
	}

	if (finished) {
		ports.events.record({ hook_event_name: 'Stop', final_text: outputParts.join('') });
	} else {
		outputParts.push(`\n\n${LOOP_CUTOFF_MESSAGE}`);
	}

	return { input, output: outputParts.join(''), toolsCalled };
}
