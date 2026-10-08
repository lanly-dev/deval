// Picking the chat model wired to VS Code, shared by the commands that
// drive a model outside the Chat view.
import * as vscode from 'vscode';

/**
 * Ask `vscode.lm` which chat models are available and return the one to use.
 *
 * Returns the only model when there is just one, asks the user when there are
 * several, and warns when there are none (the user needs to select a model in
 * the Chat view first).
 */
export async function pickChatModel(): Promise<vscode.LanguageModelChat | undefined> {
	const models = await vscode.lm.selectChatModels();
	if (!models.length) {
		void vscode.window.showWarningMessage(
			'No chat models are available. Select a model in the VS Code Chat view first — deval tests whichever model you have wired up.',
		);
		return undefined;
	}
	if (models.length === 1) {
		return models[0];
	}
	const picked = await vscode.window.showQuickPick(
		models.map((model) => ({
			label: model.name,
			description: [model.vendor, model.family].filter(Boolean).join(' · '),
			model,
		})),
		{ placeHolder: 'Select the chat model' },
	);
	return picked?.model;
}
