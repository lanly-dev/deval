/**
 * Adapts the dependency-free agent loop (`loop.ts`) to `vscode.lm`.
 *
 * The loop core speaks `LoopMessage`s; this module translates them to and from
 * `vscode.LanguageModelChatMessage`s on every model call, and executes tools
 * through `vscode.lm.invokeTool` so the chat UI shows the invocations.
 */

import * as vscode from 'vscode';

import type {
	EventPort,
	LoopMessage,
	ModelPort,
	ModelTurn,
	RequestedToolCall,
	ToolPort,
} from './loop';
import type { DevalToolSchema } from './tool-schemas';

export type { EventPort };

function stringifyToolOutput(output: unknown): string {
	return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
}

function toVscodeMessage(message: LoopMessage): vscode.LanguageModelChatMessage {
	switch (message.role) {
		case 'user':
			return vscode.LanguageModelChatMessage.User(message.text);
		case 'assistant':
			return vscode.LanguageModelChatMessage.Assistant(message.text);
		case 'tool-call': {
			const input = typeof message.input === 'object' && message.input !== null ? message.input : {};
			return vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart(message.id, message.name, input),
			]);
		}
		case 'tool-result':
			return vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart(message.id, [
					new vscode.LanguageModelTextPart(stringifyToolOutput(message.output)),
				]),
			]);
	}
}

/**
 * A `ModelPort` backed by a `vscode.LanguageModelChat`.
 *
 * Text streams to `onTextChunk` as it arrives, so the chat participant can
 * display the agent thinking in real time.
 */
export function createVscodeModelPort(
	model: vscode.LanguageModelChat,
	token: vscode.CancellationToken,
	onTextChunk: (chunk: string) => void,
): ModelPort {
	return {
		async send(messages: LoopMessage[], tools: DevalToolSchema[]): Promise<ModelTurn> {
			const response = await model.sendRequest(
				messages.map(toVscodeMessage),
				{
					justification: 'deval runs its agent loop to answer your request.',
					tools: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
				},
				token,
			);

			let text = '';
			const toolCalls: RequestedToolCall[] = [];
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					text += part.value;
					onTextChunk(part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({ id: part.callId, name: part.name, input: part.input });
				}
			}
			return { text, toolCalls };
		},
	};
}

/**
 * A `ToolPort` backed by `vscode.lm.invokeTool`.
 *
 * `toolInvocationToken` comes from the chat request and makes the chat UI
 * show each invocation; it is `undefined` outside a chat participant.
 */
export function createVscodeToolPort(
	token: vscode.CancellationToken,
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
): ToolPort {
	return {
		async invoke(name: string, input: unknown): Promise<unknown> {
			const result = await vscode.lm.invokeTool(
				name,
				{ input: (input ?? {}) as object, toolInvocationToken },
				token,
			);
			return result.content
				.map((part) =>
					part instanceof vscode.LanguageModelTextPart ? part.value : JSON.stringify(part),
				)
				.join('\n');
		},
	};
}
