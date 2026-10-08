// Built-in benchmark for the chat model wired to VS Code.
// `Deval: Benchmark Chat Model` asks the user's selected chat model every
// prompt in the built-in spec, records the responses, stages the built-in
// suite into the workspace, and runs it with the responses fed in.
import * as vscode from 'vscode';

import { ensureDeepEvalReady, executeTaskWithReporting } from './suites';
import { pickChatModel } from './chat-models';

/** Environment variable the staged suite reads the model responses from. */
export const MODEL_BENCHMARK_ENV = 'DEEPEVAL_MODEL_RESPONSES';

interface BenchmarkCase {
	id: string;
	prompt: string;
	required: string[];
	forbidden?: string[];
}

interface ModelResponse {
	id: string;
	prompt: string;
	response: string;
	error?: string;
}

function isBenchmarkCase(value: unknown): value is BenchmarkCase {
	const candidate = value as Partial<BenchmarkCase>;
	return (
		typeof candidate?.id === 'string' &&
		typeof candidate?.prompt === 'string' &&
		Array.isArray(candidate?.required) &&
		candidate.required.every((keyword) => typeof keyword === 'string')
	);
}

async function loadSpec(extensionUri: vscode.Uri): Promise<BenchmarkCase[]> {
	const specUri = vscode.Uri.joinPath(extensionUri, 'resources', 'builtin-suites', 'spec.json');
	const raw = await vscode.workspace.fs.readFile(specUri);
	const parsed: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
	if (!Array.isArray(parsed) || !parsed.every(isBenchmarkCase)) {
		throw new Error('The built-in benchmark spec is malformed.');
	}
	return parsed;
}

async function askModel(
	model: vscode.LanguageModelChat,
	prompt: string,
	token: vscode.CancellationToken,
): Promise<string> {
	const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
	let text = '';
	for await (const part of response.text) {
		if (token.isCancellationRequested) {
			break;
		}
		text += part;
	}
	return text;
}

/**
 * Run the built-in model benchmark: query the wired chat model, record its
 * answers, and score them with the suite that ships in `resources/`.
 */
export async function runModelBenchmark(context: vscode.ExtensionContext): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		void vscode.window.showWarningMessage('Open a workspace folder to benchmark the chat model.');
		return;
	}
	const workspaceFolder = folders[0];

	const model = await pickChatModel();
	if (!model) {
		return;
	}

	let spec: BenchmarkCase[];
	try {
		spec = await loadSpec(context.extensionUri);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Could not load the built-in benchmark: ${message}`);
		return;
	}

	const responses = await vscode.window.withProgress<ModelResponse[] | undefined>(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Benchmarking ${model.name}`,
			cancellable: true,
		},
		async (progress, token) => {
			const collected: ModelResponse[] = [];
			for (const [index, testCase] of spec.entries()) {
				if (token.isCancellationRequested) {
					return undefined;
				}
				progress.report({
					message: `${index + 1}/${spec.length}: ${testCase.id}`,
					increment: 100 / spec.length,
				});
				try {
					const response = await askModel(model, testCase.prompt, token);
					collected.push({ id: testCase.id, prompt: testCase.prompt, response });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					collected.push({ id: testCase.id, prompt: testCase.prompt, response: '', error: message });
				}
			}
			return collected;
		},
	);
	if (!responses) {
		return;
	}

	// The suite resolves `vitest` from the workspace, so stage the built-in
	// files there instead of running them from the extension's install
	// directory. Everything for one run lives in a single timestamped folder.
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const runDirectory = vscode.Uri.joinPath(workspaceFolder.uri, '.deepeval', 'model-benchmark', timestamp);
	const responsesUri = vscode.Uri.joinPath(runDirectory, 'responses.json');
	const stagedSuiteUri = vscode.Uri.joinPath(runDirectory, 'model-benchmark.test.ts');
	try {
		await vscode.workspace.fs.createDirectory(runDirectory);
		await vscode.workspace.fs.writeFile(
			responsesUri,
			Buffer.from(JSON.stringify({ model: model.name, created: timestamp, responses }, null, 2), 'utf8'),
		);
		for (const name of ['model-benchmark.test.ts', 'spec.json']) {
			await vscode.workspace.fs.copy(
				vscode.Uri.joinPath(context.extensionUri, 'resources', 'builtin-suites', name),
				vscode.Uri.joinPath(runDirectory, name),
				{ overwrite: true },
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Could not stage the built-in benchmark: ${message}`);
		return;
	}

	const command = await ensureDeepEvalReady(workspaceFolder, 'the built-in model benchmark');
	if (!command) {
		return;
	}

	const relativeSuitePath = vscode.workspace.asRelativePath(stagedSuiteUri, false);
	const label = `Deval: Benchmark ${model.name}`;
	const task = new vscode.Task(
		{ type: 'deepeval', benchmark: 'model' },
		workspaceFolder,
		label,
		'Deval',
		new vscode.ProcessExecution(command, ['deepeval', 'test', 'run', relativeSuitePath], {
			cwd: workspaceFolder.uri.fsPath,
			env: { [MODEL_BENCHMARK_ENV]: responsesUri.fsPath },
		}),
	);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
	await executeTaskWithReporting(task, label);
}
