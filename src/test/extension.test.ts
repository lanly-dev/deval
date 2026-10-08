import * as assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	CAPTURED_RUN_DIRECTORY,
	DEEPEVAL_TEST_EXCLUDES,
	PACKAGE_MANAGERS,
	findDeepEvalTestFiles,
	getDeepEvalTestPatterns,
	getInstallInvocation,
	mergeUniqueUris,
	requiresLocalDeepEvalInstall,
} from '../extension';
import { DEEPEVAL_VSCODE_EVENTS } from '../events/event-log';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('DeepEval test discovery includes the supported test patterns', () => {
		const patterns = getDeepEvalTestPatterns();
		assert.ok(patterns.includes('**/*.test.ts'));
		assert.ok(patterns.includes('**/*.spec.ts'));
		assert.ok(patterns.includes('**/benchmarks/**/*.test.ts'));
	});

	test('DeepEval test discovery ignores build output directories', () => {
		assert.ok(DEEPEVAL_TEST_EXCLUDES.includes('node_modules'));
		assert.ok(DEEPEVAL_TEST_EXCLUDES.includes('out'));
		assert.ok(DEEPEVAL_TEST_EXCLUDES.includes('.vscode-test'));
	});

	test('DeepEval test URIs are de-duped', () => {
		const a = vscode.Uri.file('/workspace/a.test.ts');
		const b = vscode.Uri.file('/workspace/src/test/b.test.ts');
		const c = vscode.Uri.file('/workspace/a.test.ts');

		const unique = mergeUniqueUris([a, b], [c]);
		assert.strictEqual(unique.length, 2);
		assert.ok(unique.some((uri) => uri.fsPath.endsWith('a.test.ts')));
		assert.ok(unique.some((uri) => uri.fsPath.endsWith('b.test.ts')));
	});

	test('captured runs live under the documented relative directory', () => {
		assert.deepStrictEqual(CAPTURED_RUN_DIRECTORY, ['.deepeval', 'vscode-agent-events']);
	});

	test('the capture environment variable name matches the hook contract', () => {
		assert.strictEqual(DEEPEVAL_VSCODE_EVENTS, 'DEEPEVAL_VSCODE_EVENTS');
	});

	test('the scaffolder installs with a package manager, never the runner', () => {
		// `npx install --save-dev deepeval vitest` fails with "could not determine
		// executable to run", so the installer must not reuse deval.deepevalCommand.
		assert.deepStrictEqual(getInstallInvocation('npm'), {
			command: 'npm',
			args: ['install', '--save-dev', 'deepeval', 'vitest'],
		});
		assert.deepStrictEqual(getInstallInvocation('pnpm').args, ['add', '--save-dev', 'deepeval', 'vitest']);
		assert.deepStrictEqual(getInstallInvocation('yarn').args, ['add', '--dev', 'deepeval', 'vitest']);
		assert.deepStrictEqual(getInstallInvocation('bun').args, ['add', '--dev', 'deepeval', 'vitest']);
	});

	test('every supported package manager maps to a recognised add-dev command', () => {
		for (const manager of PACKAGE_MANAGERS) {
			const invocation = getInstallInvocation(manager);
			assert.strictEqual(invocation.command, manager);
			assert.ok(invocation.args.includes('deepeval'), `${manager} must install deepeval`);
			assert.ok(invocation.args.includes('vitest'), `${manager} must install vitest`);
			assert.notStrictEqual(invocation.args[0], 'npx');
		}
	});

	test('an unknown package manager falls back to npm instead of failing', () => {
		for (const value of [undefined, '', '   ', 'yarnpkg', 'npm i']) {
			assert.strictEqual(getInstallInvocation(value).command, 'npm', `expected npm for ${String(value)}`);
		}
		// Casing and surrounding whitespace must not defeat the lookup.
		assert.strictEqual(getInstallInvocation('  PNPM  ').command, 'pnpm');
		assert.strictEqual(getInstallInvocation('Yarn').command, 'yarn');
	});

	test('the declared packageManager default drives a working install command', () => {
		const configured = vscode.workspace.getConfiguration('deval').get<string>('packageManager', 'npm');
		assert.ok(PACKAGE_MANAGERS.includes(configured as never), `unknown default: ${configured}`);
		const invocation = getInstallInvocation(configured);
		assert.strictEqual(invocation.command, 'npm');
		assert.deepStrictEqual(invocation.args, ['install', '--save-dev', 'deepeval', 'vitest']);
	});

	test('npx runs are refused until the workspace installs DeepEval', () => {
		const projectRoot = mkdtempSync(join(tmpdir(), 'deval-guard-'));
		try {
			// With no local install npx downloads deepeval into its own cache:
			// unpinned, unpatchable from here, and blind to the suite's vitest.
			assert.strictEqual(requiresLocalDeepEvalInstall('npx', projectRoot), true);
			assert.strictEqual(requiresLocalDeepEvalInstall('npx.cmd', projectRoot), true);
			assert.strictEqual(requiresLocalDeepEvalInstall('Npx.CMD', projectRoot), true);
			assert.strictEqual(
				requiresLocalDeepEvalInstall('C:\\Program Files\\nodejs\\npx.CMD', projectRoot),
				true,
			);
			assert.strictEqual(requiresLocalDeepEvalInstall('"npx"', projectRoot), true);
			// A direct node invocation is a separate concern; do not block it.
			assert.strictEqual(requiresLocalDeepEvalInstall('node', projectRoot), false);

			const deepEval = join(projectRoot, 'node_modules', 'deepeval');
			mkdirSync(join(deepEval, 'dist'), { recursive: true });
			assert.strictEqual(requiresLocalDeepEvalInstall('npx', projectRoot), true, 'dist alone is not an install');
			writeFileSync(join(deepEval, 'package.json'), '{}');
			assert.strictEqual(requiresLocalDeepEvalInstall('npx', projectRoot), false);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test('discovery returns only real files', async () => {
		const files = await findDeepEvalTestFiles();
		for (const file of files) {
			assert.strictEqual(file.scheme, 'file');
			assert.ok(file.fsPath.endsWith('.ts'), `expected a TypeScript file, got ${file.fsPath}`);
		}
	});
});

