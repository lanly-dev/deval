// Everything about running DeepEval TypeScript suites from VS Code: the two
// run commands, suite discovery, the captured-run picker, and the
// dependency-install flow that keeps them working.
import * as vscode from 'vscode';

import { hasDeepEvalInstall, patchDeepEvalInstall } from './deepeval-patch';
import { DEEPEVAL_VSCODE_EVENTS } from './events/event-log';
import { runDevalAgentHeadless } from './agent/participant';

/** Folder the agent loop writes captures into, relative to the workspace root. */
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
export const DEEPEVAL_TEST_EXCLUDES = '**/{node_modules,dist,out,.vscode-test,.deepeval}/**';

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

/**
 * Ask the user which captured `@deval` run to evaluate.
 *
 * When no capture exists yet, offers to run the Deval agent now and evaluates
 * the run it creates. Returns `undefined` when the user declined to create
 * one or cancelled the picker.
 */
export async function selectDeepEvalRun(
	workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri | undefined> {
	const eventsDirectory = vscode.Uri.joinPath(workspaceFolder.uri, ...CAPTURED_RUN_DIRECTORY);
	const runFiles = await listCaptureFiles(eventsDirectory);
	if (!runFiles.length) {
		return createCaptureNow(workspaceFolder);
	}

	const selectedRun = await vscode.window.showQuickPick(
		runFiles.map((uri) => ({ label: uri.path.split('/').pop() ?? uri.fsPath, uri })),
		{ placeHolder: 'Select a captured agent run' },
	);
	if (!selectedRun) {
		return undefined;
	}
	return selectedRun.uri;
}

/** Default prompt for the agent run the evaluate command creates when no capture exists yet. */
export const DEFAULT_EVAL_PROMPT =
	'List the files in the workspace root and summarize what this project is about.';

async function listCaptureFiles(eventsDirectory: vscode.Uri): Promise<vscode.Uri[]> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(eventsDirectory);
	} catch {
		return [];
	}
	return entries
		.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.jsonl'))
		.map(([name]) => vscode.Uri.joinPath(eventsDirectory, name));
}

/**
 * Offer to run the Deval agent now so there is a capture to evaluate.
 *
 * Resolves to the new capture's Uri — used directly, skipping the picker —
 * or `undefined` when the user declined or the run did not complete.
 */
async function createCaptureNow(
	workspaceFolder: vscode.WorkspaceFolder,
): Promise<vscode.Uri | undefined> {
	const runNow = 'Run Deval agent now';
	const choice = await vscode.window.showWarningMessage(
		describeMissingCaptures({
			workspaceName: workspaceFolder.name,
			eventsDirectory: vscode.workspace.asRelativePath(
				vscode.Uri.joinPath(workspaceFolder.uri, ...CAPTURED_RUN_DIRECTORY),
				false,
			),
		}),
		runNow,
	);
	if (choice !== runNow) {
		return undefined;
	}
	const prompt = await vscode.window.showInputBox({
		prompt: 'What should the Deval agent do? Its run will be captured and evaluated.',
		value: DEFAULT_EVAL_PROMPT,
	});
	if (!prompt) {
		return undefined;
	}
	return runDevalAgentHeadless(workspaceFolder, prompt);
}

/**
 * Explain why no captured run could be offered.
 *
 * Captures are written automatically by the `@deval` agent loop, so an empty
 * directory just means the agent has not run yet in this workspace.
 */
export function describeMissingCaptures(details: {
	workspaceName: string;
	eventsDirectory: string;
}): string {
	return (
		`No captured agent runs found in "${details.workspaceName}". ` +
		`Looked in ${details.eventsDirectory}. ` +
		`Chat with @deval first — every run is captured automatically.`
	);
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

/**
 * Make sure DeepEval can run in `workspaceFolder`: refuse an npx download
 * into npm's cache (offering to install instead) and repair the known-broken
 * CLI. Resolves to the configured runner command, or `undefined` when the
 * user declined the install.
 */
export async function ensureDeepEvalReady(
	workspaceFolder: vscode.WorkspaceFolder,
	reason: string,
): Promise<string | undefined> {
	const command = vscode.workspace.getConfiguration('deval').get<string>('deepevalCommand', 'npx');
	if (requiresLocalDeepEvalInstall(command, workspaceFolder.uri.fsPath)) {
		// npx would download DeepEval into npm's cache: unpinned, outside the
		// workspace, and unusable here because the suite also needs Vitest.
		const install = 'Install dependencies';
		const choice = await vscode.window.showWarningMessage(
			`DeepEval is not installed in "${workspaceFolder.name}", so npx would download a copy that cannot run ${reason}.`,
			{ modal: true },
			install,
		);
		if (choice !== install || !(await installDeepEvalDependencies(workspaceFolder))) {
			return undefined;
		}
	}

	// The child process cannot repair its own dependency, so patch first.
	applyDeepEvalPatch(workspaceFolder.uri.fsPath);
	return command;
}

export async function evaluateAgentRun(): Promise<void> {
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

	const command = await ensureDeepEvalReady(
		workspaceFolder,
		vscode.workspace.asRelativePath(selectedFile.uri),
	);
	if (!command) {
		return;
	}

	const eventsFile = await selectDeepEvalRun(workspaceFolder);
	if (!eventsFile) {
		return;
	}

	const relativeTestPath = vscode.workspace.asRelativePath(selectedFile.uri, false);
	const label = `Deval: ${selectedFile.label}`;
	const task = new vscode.Task(
		{ type: 'deepeval', testFile: relativeTestPath },
		workspaceFolder,
		label,
		'Deval',
		new vscode.ProcessExecution(command, ['deepeval', 'test', 'run', relativeTestPath], {
			cwd: workspaceFolder.uri.fsPath,
			env: eventsFile ? { DEEPEVAL_VSCODE_EVENTS: eventsFile.fsPath } : undefined,
		}),
	);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
	await executeTaskWithReporting(task, label);
}

/** Package managers the dependency installer knows how to install with. */
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
 * a typo in a setting should not block the installer.
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
 * Install DeepEval and Vitest into `folder`, then repair the known-broken
 * upstream CLI. Resolves to true only when the install task succeeded.
 */
async function installDeepEvalDependencies(folder: vscode.WorkspaceFolder): Promise<boolean> {
	const packageManager = vscode.workspace.getConfiguration('deval').get<string>('packageManager', 'npm');
	const { command, args } = getInstallInvocation(packageManager);
	const install = new vscode.Task(
		{ type: 'deepeval', install: true },
		folder,
		'Deval: Install dependencies',
		'Deval',
		new vscode.ProcessExecution(command, args, { cwd: folder.uri.fsPath }),
	);
	install.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
	const succeeded = await executeTaskWithReporting(install, 'Deval: Install dependencies');
	if (succeeded) {
		// A fresh install ships the broken CLI; repair it before the user runs it.
		applyDeepEvalPatch(folder.uri.fsPath);
	}
	return succeeded;
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
