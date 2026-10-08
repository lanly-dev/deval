import * as assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SHADOWED_FILE_SUFFIX, SHADOWING_DEEPEVAL_FILES, hasDeepEvalInstall, hasVitestInstall, patchDeepEvalInstall } from '../deepeval-patch';

suite('deepeval patch', () => {
	const createdRoots: string[] = [];

	teardown(() => {
		for (const root of createdRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	/** A throwaway project whose deepeval install reproduces the 0.9.22 layout. */
	function createBrokenInstall(): string {
		const projectRoot = mkdtempSync(join(tmpdir(), 'deval-patch-'));
		createdRoots.push(projectRoot);

		const dist = join(projectRoot, 'node_modules', 'deepeval', 'dist');
		mkdirSync(join(dist, 'telemetry'), { recursive: true });
		writeFileSync(join(dist, 'telemetry', 'index.js'), 'exports.captureCliCommand = () => {};');
		for (const name of SHADOWING_DEEPEVAL_FILES) {
			writeFileSync(join(dist, name), `stale build artifact: ${name}`);
		}

		return projectRoot;
	}

	function distOf(projectRoot: string): string {
		return join(projectRoot, 'node_modules', 'deepeval', 'dist');
	}

	test('disables every shadowing file and keeps the real module', () => {
		const projectRoot = createBrokenInstall();
		const dist = distOf(projectRoot);

		const result = patchDeepEvalInstall(projectRoot);

		assert.deepStrictEqual(result.patched, [...SHADOWING_DEEPEVAL_FILES]);
		assert.deepStrictEqual(result.blocked, []);
		for (const name of SHADOWING_DEEPEVAL_FILES) {
			assert.ok(!existsSync(join(dist, name)), `${name} should no longer shadow the directory`);
			assert.ok(existsSync(join(dist, `${name}${SHADOWED_FILE_SUFFIX}`)), `${name} should be renamed`);
		}
		// The real implementation the CLI requires must survive.
		assert.ok(existsSync(join(dist, 'telemetry', 'index.js')));
	});

	test('disabling is idempotent, so repeated runs are free', () => {
		const projectRoot = createBrokenInstall();

		assert.strictEqual(patchDeepEvalInstall(projectRoot).patched.length, SHADOWING_DEEPEVAL_FILES.length);
		const second = patchDeepEvalInstall(projectRoot);

		assert.deepStrictEqual(second.patched, []);
		assert.deepStrictEqual(second.blocked, []);
		for (const name of SHADOWING_DEEPEVAL_FILES) {
			assert.ok(existsSync(join(distOf(projectRoot), `${name}${SHADOWED_FILE_SUFFIX}`)));
			assert.ok(!existsSync(join(distOf(projectRoot), `${name}${SHADOWED_FILE_SUFFIX}.shadowed`)));
		}
	});

	test('is a no-op when deepeval is not installed', () => {
		const projectRoot = mkdtempSync(join(tmpdir(), 'deval-patch-empty-'));
		createdRoots.push(projectRoot);

		const result = patchDeepEvalInstall(projectRoot);

		assert.deepStrictEqual(result, { patched: [], blocked: [] });
		// Nothing may be created as a side effect of a lookup.
		assert.ok(!existsSync(join(projectRoot, 'node_modules')));
	});

	test('leaves a lone telemetry.js alone when nothing shadows it', () => {
		const projectRoot = mkdtempSync(join(tmpdir(), 'deval-patch-lone-'));
		createdRoots.push(projectRoot);
		const dist = distOf(projectRoot);
		mkdirSync(dist, { recursive: true });
		writeFileSync(join(dist, 'telemetry.js'), 'a working module, not a stale artifact');

		const result = patchDeepEvalInstall(projectRoot);

		assert.deepStrictEqual(result, { patched: [], blocked: [] });
		assert.ok(existsSync(join(dist, 'telemetry.js')));
	});

	test('detects a workspace install, which is what npx would run', () => {
		const projectRoot = mkdtempSync(join(tmpdir(), 'deval-detect-'));
		createdRoots.push(projectRoot);

		assert.strictEqual(hasDeepEvalInstall(projectRoot), false);

		const deepEval = join(projectRoot, 'node_modules', 'deepeval');
		mkdirSync(join(deepEval, 'dist'), { recursive: true });
		assert.strictEqual(hasDeepEvalInstall(projectRoot), false, 'dist alone is not an install');

		writeFileSync(join(deepEval, 'package.json'), '{}');
		assert.strictEqual(hasDeepEvalInstall(projectRoot), true);
	});

	test('stays in sync with the postinstall script', () => {
		const scriptPath = join(__dirname, '..', '..', 'scripts', 'patch-deepeval.mjs');
		const script = readFileSync(scriptPath, 'utf8');

		for (const name of SHADOWING_DEEPEVAL_FILES) {
			assert.ok(script.includes(name), `scripts/patch-deepeval.mjs must also disable ${name}`);
		}
		assert.ok(script.includes(SHADOWED_FILE_SUFFIX), 'the script must rename the same way');
		// The script doubles as a manual repair for installs the extension cannot
		// reach, such as npx's cache, so it must accept an explicit target.
		assert.ok(script.includes('process.argv[2]'), 'the script must accept an explicit install to repair');
	});

	test('hasVitestInstall requires node_modules/vitest/package.json', () => {
		const projectRoot = mkdtempSync(join(tmpdir(), 'deval-vitest-'));
		createdRoots.push(projectRoot);

		assert.strictEqual(hasVitestInstall(projectRoot), false);
		mkdirSync(join(projectRoot, 'node_modules', 'vitest'), { recursive: true });
		assert.strictEqual(hasVitestInstall(projectRoot), false);
		writeFileSync(join(projectRoot, 'node_modules', 'vitest', 'package.json'), '{}');
		assert.strictEqual(hasVitestInstall(projectRoot), true);
	});
});