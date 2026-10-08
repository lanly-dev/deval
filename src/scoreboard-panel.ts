// Command 3: show the Deval scoreboard webview.
import * as vscode from 'vscode';

import { readScores } from './scores';
import { renderScoreboardHtml } from './scoreboard';
import { devalDirectoryUri } from './suites';

/** Open the scoreboard: every recorded run side by side, oldest first. */
export async function showScoreboard(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		void vscode.window.showWarningMessage('Open a workspace folder to show the Deval scoreboard.');
		return;
	}
	const records = await readScores(devalDirectoryUri(folders[0]).fsPath);
	if (!records.length) {
		void vscode.window.showInformationMessage(
			'Deval: no scores recorded yet. Run "Deval: Evaluate Captured Agent Run" or "Deval: Benchmark Chat Model" first.',
		);
		return;
	}
	const panel = vscode.window.createWebviewPanel('devalScoreboard', 'Deval Scoreboard', vscode.ViewColumn.One, {});
	panel.webview.html = renderScoreboardHtml(records);
}
