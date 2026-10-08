/**
 * Work around a packaging bug in `deepeval@0.9.22` that breaks its CLI in every
 * workspace that installs it.
 *
 * `node_modules/deepeval/dist/telemetry.js` is a stale build artifact that
 * shadows the `node_modules/deepeval/dist/telemetry/` directory of the same
 * name. Node resolves `require("../telemetry")` — used by `dist/cli/index.js`
 * — to the *file*, so:
 *
 *   1. `captureCliCommand` is undefined (it lives in `dist/telemetry/index.js`),
 *      and every `deepeval` command dies with
 *      "(0 , telemetry_1.captureCliCommand) is not a function".
 *   2. That stray file is the only thing in the package requiring
 *      `@sentry/node`, which `deepeval` does not declare as a dependency, so
 *      the failure is usually "Cannot find module '@sentry/node'" first.
 *
 * Renaming the shadowing files (rather than deleting them) keeps the install inspectable.
 *
 * This runs in-process instead of spawning `scripts/patch-deepeval.mjs`,
 * because a packaged extension ships without `scripts/` and cannot rely on the
 * workspace having it. `scripts/patch-deepeval.mjs` performs the same rename
 * for `npm install` in this repository — keep the two file lists in sync; the
 * `deepeval patch` tests fail if they drift.
 */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Files that shadow the `dist/telemetry/` directory of the same name. */
export const SHADOWING_DEEPEVAL_FILES = ['telemetry.js', 'telemetry.d.ts', 'telemetry.js.map'];

/** Suffix appended to a shadowing file, so the change stays reversible. */
export const SHADOWED_FILE_SUFFIX = '.shadowed';

export interface DeepEvalPatchResult {
	/** Shadowing files that were disabled. */
	patched: string[];
	/** Shadowing files that are still active because the rename failed. */
	blocked: string[];
}

/**
 * True when `projectRoot` has its own DeepEval install — the copy `npx` picks
 * up before falling back to its download cache, and the only copy the patch
 * above can repair from inside the extension.
 */
export function hasDeepEvalInstall(projectRoot: string): boolean {
	return existsSync(join(projectRoot, 'node_modules', 'deepeval', 'package.json'));
}

/**
 * True when `projectRoot` has its own Vitest install. The benchmark suite is
 * a Vitest suite, so DeepEval alone is not a runnable install — a workspace
 * with only `deepeval` would fail the run without ever writing results.
 */
export function hasVitestInstall(projectRoot: string): boolean {
	return existsSync(join(projectRoot, 'node_modules', 'vitest', 'package.json'));
}

/**
 * Disable the files that shadow `node_modules/deepeval/dist/telemetry/`.
 *
 * Never throws and never removes anything: a missing install, an already
 * patched install, a future fixed release, and a read-only `node_modules` are
 * all tolerated, because the patch must not be the reason a run fails.
 */
export function patchDeepEvalInstall(projectRoot: string): DeepEvalPatchResult {
	const result: DeepEvalPatchResult = { patched: [], blocked: [] };
	const distDirectory = join(projectRoot, 'node_modules', 'deepeval', 'dist');
	if (!existsSync(distDirectory)) {
		// deepeval is not installed here (yet), or a production-only install.
		return result;
	}

	for (const name of SHADOWING_DEEPEVAL_FILES) {
		const shadowing = join(distDirectory, name);
		// Only a genuine conflict is patched. `telemetry.js` on its own is not
		// shadowing anything, so renaming it could break a working install.
		const shadowedDirectory = join(distDirectory, name.split('.')[0]);
		if (!existsSync(shadowing) || !existsSync(shadowedDirectory)) {
			continue;
		}

		try {
			renameSync(shadowing, `${shadowing}${SHADOWED_FILE_SUFFIX}`);
			result.patched.push(name);
		} catch (error) {
			result.blocked.push(name);
			console.warn(
				`[deval] Could not disable dist/${name}: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	return result;
}