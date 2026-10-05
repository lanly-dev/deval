// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import {
	CAPTURE_HOOK_CONFIG_FILE,
	CAPTURE_HOOK_DIRECTORY,
	getCaptureHookFiles,
} from './capture-hook';
import { hasDeepEvalInstall, patchDeepEvalInstall } from './deepeval-patch';
import { DEEPEVAL_VSCODE_EVENTS } from './events/event-log';

/** Folder the hook writes captures into, relative to the workspace root. */
export const CAPTURED_RUN_DIRECTORY = ['.deepeval', 'vscode-agent-events'];

/** Globs searched for DeepEval TypeScript suites. */
export const DEEPEVAL_TEST_PATTERNS = [
	'**/*.test.ts',
	'**/*.spec.ts',
	'**/benchmarks/**/*.test.ts',
	'**/src/**/*.test.ts',
	'**/test/**/*.test.ts',
];

/** Paths that never contain a DeepEval suite worth running from here. */
export const DEEPEVAL_TEST_EXCLUDES = '**/{node_modules,dist,out,.vscode-test}/**';

export function getDeepEvalTestPatterns(): string[] {
	return [...DEEPEVAL_TEST_PATTERNS];
}

export function mergeUniqueUris(...groups: vscode.Uri[][]): vscode.Uri[] {
	const seen = new Map<string, vscode.Uri>();
	for (const group of groups) {
		for (const uri of group) {
			seen.set(uri.toString(), uri);
		}
	}
	return [...seen.values()];
}

export async function findDeepEvalTestFiles(): Promise<vscode.Uri[]> {
	const discoveryGroups = await Promise.all(
		getDeepEvalTestPatterns().map(async (pattern) => {
			try {
				return await vscode.workspace.findFiles(pattern, DEEPEVAL_TEST_EXCLUDES);
			} catch {
				return [];
			}
		}),
	);

	return mergeUniqueUris(...discoveryGroups);
}

function buildChatMessages(chatContext: vscode.ChatContext, request: vscode.ChatRequest): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(
			'You are Deval, a helpful local agent harness. Answer the user clearly and accurately.',
		),
	];

	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = turn.response
				.filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
				.map((part) => part.value.value)
				.join('');
			if (text) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(text));
			}
		}
	}

	messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
	return messages;
}

async function registerChatParticipant(context: vscode.ExtensionContext) {
	const participant = vscode.chat.createChatParticipant('deval.agent', async (request, chatContext, response, token) => {
		const messages = buildChatMessages(chatContext, request);
		const modelResponse = await request.model.sendRequest(messages, {}, token);
		for await (const fragment of modelResponse.text) {
			response.markdown(fragment);
		}
	});

	context.subscriptions.push(participant);
}

/**
 * Ask the user which captured Local-harness run to evaluate.
 *
 * Returns `undefined` when the caller did not ask for a capture
 * (`withCapturedRun` is false) or when the user cancelled the picker.
 */
export async function selectDeepEvalRun(
	workspaceFolder: vscode.WorkspaceFolder,
	withCapturedRun: boolean,
): Promise<vscode.Uri | undefined> {
	if (!withCapturedRun) {
		return undefined;
	}

	const eventsDirectory = vscode.Uri.joinPath(workspaceFolder.uri, ...CAPTURED_RUN_DIRECTORY);
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(eventsDirectory);
	} catch {
		await reportMissingCaptures(workspaceFolder, eventsDirectory);
		return undefined;
	}

	const runFiles = entries
		.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.jsonl'))
		.map(([name]) => vscode.Uri.joinPath(eventsDirectory, name));
	if (!runFiles.length) {
		await reportMissingCaptures(workspaceFolder, eventsDirectory);
		return undefined;
	}

	const selectedRun = await vscode.window.showQuickPick(
		runFiles.map((uri) => ({ label: uri.path.split('/').pop() ?? uri.fsPath, uri })),
		{ placeHolder: 'Select a captured Local agent run' },
	);
	if (!selectedRun) {
		return undefined;
	}
	return selectedRun.uri;
}

/** True when `uri` can be stat'ed, i.e. it already exists. */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** The hook registration file inside `folder`. */
function captureHookConfigUri(folder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(folder.uri, ...CAPTURE_HOOK_DIRECTORY, CAPTURE_HOOK_CONFIG_FILE);
}

/**
 * Explain why no captured run could be offered.
 *
 * The previous wording told every caller to "enable the workspace hook", which
 * was wrong in the common case: the hook ships with this repository, so a
 * workspace that only ever received a scaffolded benchmark has never had one.
 * Naming the directory that was searched and the hook's actual state turns a
 * dead end into a next step. Exported so the tests can assert on both halves.
 */
export function describeMissingCaptures(details: {
	workspaceName: string;
	eventsDirectory: string;
	hookConfig: string;
	hookInstalled: boolean;
}): string {
	const searched = `No captured Local agent runs found in "${details.workspaceName}". Looked in ${details.eventsDirectory}.`;
	if (details.hookInstalled) {
		return `${searched} ${details.hookConfig} is installed but has not recorded a run yet: start a chat session with the Local target, send one turn, and run this again.`;
	}
	return `${searched} This workspace has no capture hook: ${details.hookConfig} does not exist.`;
}

/**
 * Report an empty capture directory and, when the missing hook is the reason,
 * offer to install it into this workspace. Resolves once the message is gone.
 */
async function reportMissingCaptures(
	workspaceFolder: vscode.WorkspaceFolder,
	eventsDirectory: vscode.Uri,
): Promise<void> {
	const hookConfig = captureHookConfigUri(workspaceFolder);
	const hookInstalled = await fileExists(hookConfig);
	const message = describeMissingCaptures({
		workspaceName: workspaceFolder.name,
		eventsDirectory: vscode.workspace.asRelativePath(eventsDirectory, false),
		hookConfig: vscode.workspace.asRelativePath(hookConfig, false),
		hookInstalled,
	});

	if (hookInstalled) {
		// There is nothing to install, so the only useful content is the path
		// and what to do in the harness; a button here would be noise.
		await vscode.window.showWarningMessage(message);
		return;
	}

	const install = 'Install Capture Hook';
	const choice = await vscode.window.showWarningMessage(message, install);
	if (choice === install) {
		await installCaptureHook(workspaceFolder);
	}
}

/**
 * Run a task and report how it ended.
 *
 * `vscode.tasks.executeTask` resolves as soon as the process starts, so the
 * exit code has to be picked up from `onDidEndTaskProcess`. Without this the
 * only feedback for a broken suite is a red terminal the user may never see.
 */
export async function executeTaskWithReporting(task: vscode.Task, label: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let subscription: vscode.Disposable | undefined;

		const finish = (succeeded: boolean): void => {
			subscription?.dispose();
			resolve(succeeded);
		};

		vscode.tasks.executeTask(task).then(
			(execution) => {
				subscription = vscode.tasks.onDidEndTaskProcess((event) => {
					if (event.execution !== execution) {
						return;
					}
					if (event.exitCode === 0) {
						vscode.window.showInformationMessage(`${label} passed.`);
						finish(true);
					} else {
						vscode.window.showErrorMessage(
							`${label} failed with exit code ${event.exitCode ?? 'unknown'}. See the terminal for details.`,
						);
						finish(false);
					}
				});
			},
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Could not start ${label}: ${message}`);
				finish(false);
			},
		);
	});
}

/**
 * Repair the DeepEval CLI inside `projectRoot` before spawning it.
 *
 * Handles the `deepeval@0.9.22` shadowing bug that otherwise makes every run
 * fail with "Cannot find module '@sentry/node'". Doing it here as well as after
 * an install heals workspaces whose deepeval was installed by hand.
 */
function applyDeepEvalPatch(projectRoot: string): void {
	const { patched, blocked } = patchDeepEvalInstall(projectRoot);

	if (patched.length) {
		console.log(`[deval] Disabled stale deepeval dist file(s): ${patched.join(', ')}.`);
	}
	if (blocked.length) {
		void vscode.window.showWarningMessage(
			`The installed deepeval package is broken (${blocked.join(', ')}) and could not be repaired. See "Known upstream issue" in the deval README.`,
		);
	}
}

async function runDeepEval(withCapturedRun = false): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		vscode.window.showWarningMessage('Open a workspace folder to run DeepEval tests.');
		return;
	}

	const uniqueTestFiles = await findDeepEvalTestFiles();
	if (!uniqueTestFiles.length) {
		vscode.window.showWarningMessage('No TypeScript test files found. Expected *.test.ts or *.spec.ts.');
		return;
	}

	const selectedFile = await vscode.window.showQuickPick(
		uniqueTestFiles.map((uri) => ({
			label: vscode.workspace.asRelativePath(uri),
			uri,
		})),
		{ placeHolder: 'Select a DeepEval TypeScript test suite' },
	);
	if (!selectedFile) {
		return;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(selectedFile.uri);
	if (!workspaceFolder) {
		vscode.window.showErrorMessage('Could not determine the workspace folder for this test suite.');
		return;
	}

	const command = vscode.workspace.getConfiguration('deval').get<string>('deepevalCommand', 'npx');
	if (requiresLocalDeepEvalInstall(command, workspaceFolder.uri.fsPath)) {
		// npx would download DeepEval into npm's cache: unpinned, outside the
		// workspace, and unusable here because the suite also needs Vitest.
		const install = 'Install dependencies';
		const choice = await vscode.window.showWarningMessage(
			`DeepEval is not installed in "${workspaceFolder.name}", so npx would download a copy that cannot run ${vscode.workspace.asRelativePath(selectedFile.uri)}.`,
			{ modal: true },
			install,
		);
		if (choice !== install || !(await installDeepEvalDependencies(workspaceFolder))) {
			return;
		}
	}

	// The child process cannot repair its own dependency, so patch first.
	applyDeepEvalPatch(workspaceFolder.uri.fsPath);

	const eventsFile = await selectDeepEvalRun(workspaceFolder, withCapturedRun);
	if (withCapturedRun && !eventsFile) {
		return;
	}

	const relativeTestPath = vscode.workspace.asRelativePath(selectedFile.uri, false);
	const label = `DeepEval: ${selectedFile.label}`;
	const task = new vscode.Task(
		{ type: 'deepeval', testFile: relativeTestPath },
		workspaceFolder,
		label,
		'DeepEval',
		new vscode.ProcessExecution(command, ['deepeval', 'test', 'run', relativeTestPath], {
			cwd: workspaceFolder.uri.fsPath,
			env: eventsFile ? { DEEPEVAL_VSCODE_EVENTS: eventsFile.fsPath } : undefined,
		}),
	);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
	await executeTaskWithReporting(task, label);
}

/** File name used by the `DeepEval: Scaffold Sample Benchmark` command. */
export const SCAFFOLD_FILE_NAME = 'my-agent.test.ts';

/** Package managers the scaffolder knows how to install with. */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Arguments that add the benchmark dependencies as devDependencies. */
const INSTALL_ARGUMENTS: Record<PackageManager, string[]> = {
	npm: ['install', '--save-dev', 'deepeval', 'vitest'],
	pnpm: ['add', '--save-dev', 'deepeval', 'vitest'],
	yarn: ['add', '--dev', 'deepeval', 'vitest'],
	bun: ['add', '--dev', 'deepeval', 'vitest'],
};

/**
 * Build the command that installs the benchmark dependencies.
 *
 * Deliberately *not* derived from `deval.deepevalCommand`: that setting names
 * the DeepEval runner (`npx`), and `npx install --save-dev deepeval vitest`
 * makes npx look for an executable called `install`, which fails with
 * "could not determine executable to run".
 *
 * An unset or unrecognised value falls back to npm rather than erroring, since
 * a typo in a setting should not block the scaffolder.
 */
export function getInstallInvocation(packageManager: string | undefined): {
	command: string;
	args: string[];
} {
	const name = (packageManager ?? '').trim().toLowerCase();
	const resolved = Object.hasOwn(INSTALL_ARGUMENTS, name) ? (name as PackageManager) : 'npm';
	return { command: resolved, args: [...INSTALL_ARGUMENTS[resolved]] };
}

/**
 * A self-contained starter suite.
 *
 * Built from an array of lines rather than one template literal so the
 * backticks and `${}` inside the generated code need no escaping here.
 */
const SCAFFOLD_SUITE_LINES = [
	'/**',
	' * A DeepEval suite for your own agent.',
	' *',
	' * The metrics below are deterministic, so this file runs without a',
	' * DEEPEVAL_API_KEY. Add a model-judged metric (TaskCompletionMetric, GEval,',
	' * ToolCorrectnessMetric with `availableTools`, ...) once you have one.',
	' */',
	'',
	"import { expect, it } from 'vitest';",
	"import 'deepeval/vitest';",
	"import { Golden } from 'deepeval/dataset';",
	"import { BaseMetric, checkSingleTurnParams } from 'deepeval/metrics';",
	"import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';",
	"import { SpanType, observe, updateCurrentSpan } from 'deepeval/tracing';",
	'',
	'// 1. The system under test. Point this at your own implementation.',
	'async function runMyAgent(input: string): Promise<string> {',
	'  return `handled: ${input}`;',
	'}',
	'',
	'// 2. A deterministic metric. Swap in a model-judged one when you need',
	'//    subjective checks and have DEEPEVAL_API_KEY set.',
	'class MentionsInputMetric extends BaseMetric {',
	'  constructor() {',
	'    super(1);',
	'    this.requiredParams = [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT];',
	'  }',
	'',
	'  async measure(testCase: LLMTestCase): Promise<number> {',
	'    checkSingleTurnParams(testCase, this.requiredParams, this);',
	'    this.score = testCase.actualOutput.includes(testCase.input) ? 1 : 0;',
	'    this.reason =',
	'      this.score === 1 ? "The output echoes the prompt." : "The output dropped the prompt.";',
	'    this.success = this.isSuccessful();',
	'    return this.score;',
	'  }',
	'',
	'  get name(): string {',
	'    return "Mentions Input";',
	'  }',
	'}',
	'',
	'// 3. Instrument the agent. `toPass` judges the trace the task produces, so the',
	'//    call has to run inside an observed function and publish its I/O.',
	'const observedAgent = observe({',
	'  type: SpanType.AGENT,',
	'  name: "my-agent",',
	'  fn: async (input: string) => {',
	'    const output = await runMyAgent(input);',
	'    updateCurrentSpan({ input, output, toolsCalled: [{ name: "runMyAgent" }] });',
	'    return output;',
	'  },',
	'});',
	'',
	'const cases = ["Summarise the change log.", "Draft a release note."];',
	'',
	"it.each(cases)('handles: %s', async (prompt) => {",
	'  const golden = new Golden({ input: prompt });',
	'',
	'  await expect(golden).toPass([new MentionsInputMetric()], {',
	'    task: (testCase) => observedAgent(testCase.input),',
	'  });',
	'});',
	'',
];

/** The generated starter suite, as text. Exported so tests can assert on it. */
export function getScaffoldSuiteSource(): string {
	return SCAFFOLD_SUITE_LINES.join('\n');
}

/**
 * Write a starter suite into the workspace and open it.
 *
 * Writing into the *workspace* (rather than into the extension) is the point:
 * `npx deepeval test run` is spawned with the workspace folder as its cwd, so
 * the suite and the `deepeval` dependency both have to live there.
 */
async function scaffoldBenchmark(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showWarningMessage('Open a workspace folder to scaffold a benchmark into.');
		return;
	}

	let folder = folders[0];
	if (folders.length > 1) {
		const picked = await vscode.window.showQuickPick(
			folders.map((candidate) => ({ label: candidate.name, folder: candidate })),
			{ placeHolder: 'Select the workspace folder for the new benchmark' },
		);
		if (!picked) {
			return;
		}
		folder = picked.folder;
	}

	const benchmarksDirectory = vscode.Uri.joinPath(folder.uri, 'benchmarks');
	const target = vscode.Uri.joinPath(benchmarksDirectory, SCAFFOLD_FILE_NAME);

	try {
		await vscode.workspace.fs.stat(target);
		const overwrite = await vscode.window.showWarningMessage(
			`${vscode.workspace.asRelativePath(target)} already exists. Overwrite it?`,
			{ modal: true },
			'Overwrite',
		);
		if (overwrite !== 'Overwrite') {
			return;
		}
	} catch {
		// No existing file: carry on and create it.
	}

	try {
		await vscode.workspace.fs.createDirectory(benchmarksDirectory);
		await vscode.workspace.fs.writeFile(target, Buffer.from(getScaffoldSuiteSource(), 'utf8'));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Could not create the benchmark: ${message}`);
		return;
	}

	await vscode.window.showTextDocument(target);
	const action = await vscode.window.showInformationMessage(
		`Created ${vscode.workspace.asRelativePath(target)}. Install DeepEval in this workspace, then run it.`,
		'Install dependencies',
		'Install Capture Hook',
	);
	if (action === 'Install dependencies') {
		await installDeepEvalDependencies(folder);
	} else if (action === 'Install Capture Hook') {
		await installCaptureHook(folder);
	}
}

/**
 * Install DeepEval and Vitest into `folder`, then repair the known-broken
 * upstream CLI. Resolves to true only when the install task succeeded.
 */
async function installDeepEvalDependencies(folder: vscode.WorkspaceFolder): Promise<boolean> {
	const packageManager = vscode.workspace.getConfiguration('deval').get<string>('packageManager', 'npm');
	const { command, args } = getInstallInvocation(packageManager);
	const install = new vscode.Task(
		{ type: 'deepeval', install: true },
		folder,
		'DeepEval: Install dependencies',
		'DeepEval',
		new vscode.ProcessExecution(command, args, { cwd: folder.uri.fsPath }),
	);
	install.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
	const succeeded = await executeTaskWithReporting(install, 'DeepEval: Install dependencies');
	if (succeeded) {
		// A fresh install ships the broken CLI; repair it before the user runs it.
		applyDeepEvalPatch(folder.uri.fsPath);
	}
	return succeeded;
}

/**
 * Write the capture hook into a workspace so the Local harness records runs.
 *
 * This command exists because the packaged extension deliberately ships no
 * `.github/**` (`.vscodeignore`): a workspace that never received the hook from
 * this repository has nothing to enable, which is exactly what
 * `DeepEval: Evaluate Captured Local Agent Run` used to tell its users. Files
 * whose content already matches are left alone, and a differing file is replaced
 * only after an explicit confirmation, since the hook may have been edited to
 * record other events.
 *
 * Resolves to true when both files are in place afterwards.
 */
async function installCaptureHook(picked?: vscode.WorkspaceFolder): Promise<boolean> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showWarningMessage('Open a workspace folder to install the capture hook into.');
		return false;
	}

	let folder = picked ?? folders[0];
	if (!picked && folders.length > 1) {
		const selected = await vscode.window.showQuickPick(
			folders.map((candidate) => ({ label: candidate.name, candidate })),
			{ placeHolder: 'Select the workspace folder to install the capture hook into' },
		);
		if (!selected) {
			return false;
		}
		folder = selected.candidate;
	}

	for (const file of getCaptureHookFiles()) {
		const target = vscode.Uri.joinPath(folder.uri, ...file.segments);
		if (await fileExists(target)) {
			const existing = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
			if (existing === file.content) {
				continue;
			}
			const overwrite = await vscode.window.showWarningMessage(
				`${vscode.workspace.asRelativePath(target, false)} exists and differs from DeepEval's capture hook. Overwrite it?`,
				{ modal: true },
				'Overwrite',
			);
			if (overwrite !== 'Overwrite') {
				return false;
			}
		}

		try {
			await vscode.workspace.fs.createDirectory(
				vscode.Uri.joinPath(folder.uri, ...file.segments.slice(0, -1)),
			);
			await vscode.workspace.fs.writeFile(target, Buffer.from(file.content, 'utf8'));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Could not install the capture hook: ${message}`);
			return false;
		}
	}

	const hooksDirectory = `${CAPTURE_HOOK_DIRECTORY.join('/')}/`;
	const chat = vscode.workspace.getConfiguration('chat');
	const enable = 'Enable chat hooks';
	const base = `Installed ${hooksDirectory} in "${folder.name}".`;
	const next = chat.get<boolean>('useHooks', false)
		? `${base} Select the Local session target, send one chat turn, then run DeepEval: Evaluate Captured Local Agent Run again.`
		: `${base} Enable chat hooks, select the Local session target, and send one chat turn, then run DeepEval: Evaluate Captured Local Agent Run again.`;
	const choice = chat.get<boolean>('useHooks', false)
		? await vscode.window.showInformationMessage(next)
		: await vscode.window.showInformationMessage(next, enable);

	if (choice === enable) {
		try {
			await chat.update('useHooks', true, vscode.ConfigurationTarget.Global);
		} catch {
			try {
				await chat.update('useHooks', true, vscode.ConfigurationTarget.Workspace);
			} catch {
				// The setting's scope is not one this extension may write to;
				// leaving the user at the setting is still a next step.
				await vscode.commands.executeCommand('workbench.action.openSettings', '@id:chat.useHooks');
			}
		}
	}
	return true;
}

/** True for every form `npx` is invoked through (npx, npx.cmd, full path, quoted). */
function isNpxCommand(command: string): boolean {
	const executable = command.trim().replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? '';
	return executable.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase() === 'npx';
}

/**
 * True when `command` would make npx *download* DeepEval instead of using a
 * workspace install. That copy lands in npm's npx cache — unpinned, outside the
 * workspace, and never patched — and the suite still needs the workspace's own
 * Vitest, so the run must install dependencies first. Exported for tests.
 */
export function requiresLocalDeepEvalInstall(command: string, projectRoot: string): boolean {
	return isNpxCommand(command) && !hasDeepEvalInstall(projectRoot);
}

function registerCommands(context: vscode.ExtensionContext) {
	const rc = vscode.commands.registerCommand;
	const d1 = rc('deval.runDeepEval', () => runDeepEval());
	const d2 = rc('deval.evaluateAgentRun', () => runDeepEval(true));
	const d3 = rc('deval.scaffoldBenchmark', () => scaffoldBenchmark());
	const d4 = rc('deval.installCaptureHook', () => installCaptureHook());
	context.subscriptions.push(d1, d2, d3, d4);
}

export function activate(context: vscode.ExtensionContext) {
	registerChatParticipant(context);
	registerCommands(context);
}

export function deactivate() {}
