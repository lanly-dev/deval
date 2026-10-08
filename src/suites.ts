// The `Deval: Evaluate Captured Agent Run` command: pick (or create) a
// captured `@deval` run, score its trajectory, and report the result —
// plus the shared DeepEval dependency-install flow the model benchmark uses.
import * as vscode from 'vscode';

import { hasDeepEvalInstall, patchDeepEvalInstall } from './deepeval-patch';
import { loadCapturedRun } from './events/event-log';
import { scoreCapturedTrajectory, type TrajectoryCheck } from './events/score-trajectory';
import { appendScore } from './scores';
import { runDevalAgentHeadless } from './agent/participant';

/** Folder the agent loop writes captures into, relative to the workspace root. */
export const CAPTURED_RUN_DIRECTORY = ['.deval', 'vscode-agent-events'];

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

/** The `.deval/` directory in the workspace: every artifact the extension writes lives here. */
export function devalDirectoryUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(workspaceFolder.uri, '.deval');
}

/**
 * Make sure DeepEval can run for `workspaceFolder`: reuse the workspace's own
 * install when there is one, otherwise reuse (or offer to create) the
 * extension-managed install in the workspace's `.deval/` directory — never
 * the workspace root — and repair the known-broken CLI there.
 *
 * Resolves to the runner command plus the directory to run it from, or
 * `undefined` when the user declined the install.
 */
export async function ensureDeepEvalReady(
	workspaceFolder: vscode.WorkspaceFolder,
	reason: string,
): Promise<{ command: string; cwd: string } | undefined> {
	const command = vscode.workspace.getConfiguration('deval').get<string>('deepevalCommand', 'npx');
	const workspaceRoot = workspaceFolder.uri.fsPath;
	const devalDir = devalDirectoryUri(workspaceFolder);

	// "Install dependencies" puts DeepEval into .deval/, so an install there
	// satisfies npx just like one in the workspace root.
	const needsInstall =
		requiresLocalDeepEvalInstall(command, workspaceRoot) && requiresLocalDeepEvalInstall(command, devalDir.fsPath);
	if (!needsInstall) {
		// Prefer the workspace's own install; otherwise run from the .deval/
		// install. (When the runner isn't npx at all, keep the old behavior
		// and run from the workspace root.)
		const root = hasDeepEvalInstall(workspaceRoot)
			? workspaceRoot
			: hasDeepEvalInstall(devalDir.fsPath)
				? devalDir.fsPath
				: workspaceRoot;
		applyDeepEvalPatch(root);
		return { command, cwd: root };
	}

	// npx would download DeepEval into npm's cache: unpinned, outside the
	// workspace, and unusable here because the suite also needs Vitest.
	// Install into `.deval/` instead, so the user's project stays untouched.
	const install = 'Install dependencies';
	const choice = await vscode.window.showWarningMessage(
		`DeepEval is not installed in "${workspaceFolder.name}", so npx would download a copy that cannot run ${reason}. Install it into the workspace's .deval/ folder?`,
		{ modal: true },
		install,
	);
	if (choice !== install || !(await installDeepEvalDependencies(workspaceFolder, devalDir))) {
		return undefined;
	}
	return { command, cwd: devalDir.fsPath };
}

/**
 * Evaluate a captured `@deval` run: pick a capture (or create one when none
 * exists), score its trajectory deterministically, and report the checks.
 *
 * No suite files and no DeepEval install needed — the scoring lives in the
 * extension and is shared with `benchmarks/captured-run-benchmark.test.ts`.
 */
export async function evaluateAgentRun(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		void vscode.window.showWarningMessage('Open a workspace folder to evaluate a captured agent run.');
		return;
	}
	const workspaceFolder = folders[0];

	const captureUri = await selectDeepEvalRun(workspaceFolder);
	if (!captureUri) {
		return;
	}

	let checks: TrajectoryCheck[];
	try {
		const loaded = loadCapturedRun(captureUri.fsPath);
		checks = scoreCapturedTrajectory({
			summary: loaded.summary,
			skippedLines: loaded.parsed.skippedLines,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Could not read the capture: ${message}`);
		return;
	}

	await reportTrajectoryScore(captureUri, checks);

	// Record the score so the scoreboard (command 3) can compare runs side by side.
	const name = captureUri.path.split('/').pop() ?? captureUri.fsPath;
	void appendScore(devalDirectoryUri(workspaceFolder).fsPath, {
		timestamp: new Date().toISOString(),
		kind: 'agent-run',
		label: name,
		checks: checks.map((check) => ({ label: check.label, passed: check.passed, detail: check.detail })),
	});
}

/** Show the trajectory score: a pass/fail notification, with per-check details on demand. */
async function reportTrajectoryScore(captureUri: vscode.Uri, checks: TrajectoryCheck[]): Promise<void> {
	const passed = checks.filter((check) => check.passed).length;
	const name = captureUri.path.split('/').pop() ?? captureUri.fsPath;
	if (passed === checks.length) {
		void vscode.window.showInformationMessage(`Deval: ${name} passed all ${checks.length} checks.`);
		return;
	}

	const show = 'Show details';
	const choice = await vscode.window.showWarningMessage(
		`Deval: ${name} passed ${passed}/${checks.length} checks.`,
		show,
	);
	if (choice === show) {
		await vscode.window.showQuickPick(
			checks.map((check) => ({
				label: `${check.passed ? '$(check)' : '$(error)'} ${check.label}`,
				detail: check.detail,
			})),
			{ placeHolder: `${name}: trajectory checks` },
		);
	}
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
 * Deliberately *not* derived from `deval.devalCommand`: that setting names
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
 * Install DeepEval and Vitest into the workspace's `.deval/` directory, then
 * repair the known-broken upstream CLI. A minimal `package.json` is created
 * first so every package manager has something to install into. Resolves to
 * true only when the install task succeeded.
 */
async function installDeepEvalDependencies(
	workspaceFolder: vscode.WorkspaceFolder,
	devalDir: vscode.Uri,
): Promise<boolean> {
	try {
		await vscode.workspace.fs.createDirectory(devalDir);
		const packageJson = vscode.Uri.joinPath(devalDir, 'package.json');
		try {
			await vscode.workspace.fs.stat(packageJson);
		} catch {
			await vscode.workspace.fs.writeFile(
				packageJson,
				Buffer.from(JSON.stringify({ name: 'deval', private: true }, null, 2), 'utf8'),
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Could not set up the .deval/ folder: ${message}`);
		return false;
	}

	const packageManager = vscode.workspace.getConfiguration('deval').get<string>('packageManager', 'npm');
	const { command, args } = getInstallInvocation(packageManager);
	const install = new vscode.Task(
		{ type: 'deepeval', install: true },
		workspaceFolder,
		'Deval: Install dependencies',
		'Deval',
		new vscode.ProcessExecution(command, args, { cwd: devalDir.fsPath }),
	);
	install.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
	const succeeded = await executeTaskWithReporting(install, 'Deval: Install dependencies');
	if (succeeded) {
		// A fresh install ships the broken CLI; repair it before the user runs it.
		applyDeepEvalPatch(devalDir.fsPath);
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
