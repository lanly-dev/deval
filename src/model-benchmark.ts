// Built-in benchmark for the chat model wired to VS Code.
// `Deval: Benchmark Chat Model` asks the user's selected chat model every
// prompt in the built-in spec, records the responses, stages the built-in
// suite into the workspace, and runs it with the responses fed in.
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { ensureDeepEvalReady, devalDirectoryUri, executeTaskWithReporting } from './suites';
import { appendScore, type ScoreCheck } from './scores';
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
	const runDirectory = vscode.Uri.joinPath(workspaceFolder.uri, '.deval', 'model-benchmark', timestamp);
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

	const ready = await ensureDeepEvalReady(workspaceFolder, 'the built-in model benchmark');
	if (!ready) {
		return;
	}

	// The suite path is relative to wherever the runner executes: the
	// workspace root for a workspace install, `.deval/` for a `.deval/` install.
	const relativeSuitePath = relative(ready.cwd, stagedSuiteUri.fsPath).split(sep).join('/');
	const label = `Deval: Benchmark ${model.name}`;
	const task = new vscode.Task(
		{ type: 'deepeval', benchmark: 'model' },
		workspaceFolder,
		label,
		'Deval',
		new vscode.ProcessExecution(ready.command, ['deepeval', 'test', 'run', relativeSuitePath], {
			cwd: ready.cwd,
			env: { [MODEL_BENCHMARK_ENV]: responsesUri.fsPath },
		}),
	);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
	const succeeded = await executeTaskWithReporting(task, label);
	if (succeeded) {
		// Record the score so the scoreboard (command 3) can compare models side by side.
		await recordBenchmarkScore(workspaceFolder, ready.cwd, runDirectory, model.name);
	}
}

/**
 * Read the DeepEval run's own results file and append one score record per
 * benchmark case. Best-effort: a missing or unreadable results file only
 * means this run won't appear on the scoreboard.
 */
async function recordBenchmarkScore(
	workspaceFolder: vscode.WorkspaceFolder,
	runCwd: string,
	runDirectory: vscode.Uri,
	modelName: string,
): Promise<void> {
	const checks = await readBenchmarkChecks(runCwd, vscode.Uri.joinPath(runDirectory, 'spec.json'));
	if (!checks) {
		return;
	}
	void appendScore(devalDirectoryUri(workspaceFolder).fsPath, {
		timestamp: new Date().toISOString(),
		kind: 'model-benchmark',
		label: modelName,
		checks,
	});
}

/** Parse DeepEval's `.latest_test_run.json` into one check per benchmark case. */
async function readBenchmarkChecks(runCwd: string, stagedSpecUri: vscode.Uri): Promise<ScoreCheck[] | undefined> {
	let latest: { cases?: Array<{ metricsData?: Array<{ name?: string; success?: boolean; score?: number; reason?: string }> }> };
	try {
		latest = JSON.parse(await readFile(join(runCwd, '.deepeval', '.latest_test_run.json'), 'utf8'));
	} catch {
		return undefined;
	}
	const cases = Array.isArray(latest.cases) ? latest.cases : [];
	if (!cases.length) {
		return undefined;
	}
	// DeepEval's results file doesn't name the cases, so label them from the
	// staged spec, which lists them in run order.
	let caseIds: string[] = [];
	try {
		const spec = JSON.parse(await readFile(stagedSpecUri.fsPath, 'utf8'));
		if (Array.isArray(spec)) {
			caseIds = spec.map((entry, index) =>
				typeof entry?.id === 'string' && entry.id ? entry.id : `case ${index + 1}`,
			);
		}
	} catch {
		// Fall back to positional labels below.
	}
	return cases.map((testCase, index) => {
		const metrics = Array.isArray(testCase.metricsData) ? testCase.metricsData : [];
		const failed = metrics.filter((metric) => metric.success === false);
		return {
			label: caseIds[index] ?? `case ${index + 1}`,
			passed: metrics.length > 0 && failed.length === 0,
			detail: metrics.length
				? metrics
						.map(
							(metric) =>
								`${metric.name ?? 'metric'}: ${metric.success === false ? 'fail' : 'pass'}${
									typeof metric.score === 'number' ? ` (score ${metric.score})` : ''
								}`,
						)
						.join('; ')
				: 'no metrics reported',
		};
	});
}
