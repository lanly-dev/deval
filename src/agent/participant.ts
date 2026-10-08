// The `@deval` chat participant: wires the dependency-free agent loop up to
// VS Code's Language Model API and the read-only workspace tools.
import * as vscode from 'vscode';

import { createCaptureWriter } from '../events/event-writer';
import { pickChatModel } from '../chat-models';
import { runAgentLoop, type EventPort } from './loop';
import { DEVAL_TOOL_SCHEMAS } from './tool-schemas';
import { registerDevalTools } from './tools';
import { createVscodeModelPort, createVscodeToolPort } from './vscode-adapter';

/** System instruction for the `@deval` agent loop. */
export const DEVAL_AGENT_SYSTEM_PROMPT =
	'You are Deval, a helpful coding assistant inside VS Code. ' +
	'You have read-only tools to inspect the workspace: read files, list directories, and search file contents. ' +
	'Use them to ground your answers in the actual workspace instead of guessing. ' +
	'Call a tool whenever you need information you do not already have, then answer concisely.';

/**
 * Run the `@deval` agent: an agentic loop over the chat model with tools.
 *
 * Every run is captured to `.deepeval/vscode-agent-events/<session-id>.jsonl`
 * in the workspace's own capture format, so `Deval: Evaluate Captured
 * Agent Run` can score the agent's trajectory without any extra wiring.
 */
export async function registerChatParticipant(context: vscode.ExtensionContext) {
	const participant = vscode.chat.createChatParticipant(
		'deval.agent',
		async (request, _chatContext, response, token) => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders?.length) {
				response.markdown('Open a workspace folder to use the deval agent.');
				return;
			}

			const writer = createCaptureWriter(folders[0].uri.fsPath);
			const events: EventPort = {
				record: (event) => writer.append(event),
			};
			const model = createVscodeModelPort(request.model, token, (chunk) =>
				response.markdown(chunk),
			);
			const tools = createVscodeToolPort(token, request.toolInvocationToken);

			response.progress('Deval agent is working…');
			try {
				const run = await runAgentLoop(
					request.prompt,
					{ model, tools, events },
					{ toolSchemas: DEVAL_TOOL_SCHEMAS, systemPrompt: DEVAL_AGENT_SYSTEM_PROMPT },
				);
				if (!run.output.trim()) {
					response.markdown('_The agent finished without producing text._');
				}
				response.markdown(
					`\n\n---\nFinished with ${run.toolsCalled.length} tool call(s). ` +
						'This run was captured for benchmarking.',
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				response.markdown(`\n\nThe agent loop failed: ${message}`);
			}
		},
	);

	context.subscriptions.push(participant, registerDevalTools());
}

/**
 * Run the `@deval` agent loop outside the Chat view — same loop, tools, and
 * capture, but driven by a command with a progress notification instead of a
 * chat response stream.
 *
 * Resolves to the capture file's `vscode.Uri` once the run completes, or
 * `undefined` when the user cancelled, picked no model, or the loop failed.
 */
export async function runDevalAgentHeadless(
	workspaceFolder: vscode.WorkspaceFolder,
	prompt: string,
): Promise<vscode.Uri | undefined> {
	const model = await pickChatModel();
	if (!model) {
		return undefined;
	}

	const writer = createCaptureWriter(workspaceFolder.uri.fsPath);
	const events: EventPort = {
		record: (event) => writer.append(event),
	};

	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Deval agent is working…',
			cancellable: true,
		},
		async (_progress, token) => {
			const modelPort = createVscodeModelPort(model, token, () => {});
			const toolPort = createVscodeToolPort(token, undefined);
			try {
				await runAgentLoop(
					prompt,
					{ model: modelPort, tools: toolPort, events },
					{ toolSchemas: DEVAL_TOOL_SCHEMAS, systemPrompt: DEVAL_AGENT_SYSTEM_PROMPT },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`The agent loop failed: ${message}`);
				return undefined;
			}
			return vscode.Uri.file(writer.filePath);
		},
	);
}
