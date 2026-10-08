// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { commands, ExtensionContext } from 'vscode';

import { registerChatParticipant } from './agent/participant';
import { runDeepEval } from './suites';

export function activate(context: ExtensionContext) {
	const rc = commands.registerCommand;

	const d1 = rc('deval.runDeepEval', () => runDeepEval());
	const d2 = rc('deval.evaluateAgentRun', () => runDeepEval(true));
	context.subscriptions.push(d1, d2);

	void registerChatParticipant(context);
}

export function deactivate() {}
