/**
 * Work around two packaging bugs in `deepeval@0.9.22` that break its CLI.
 *
 * `node_modules/deepeval/dist/telemetry.js` is a stale build artifact that
 * shadows the `node_modules/deepeval/dist/telemetry/` directory. Node resolves
 * `require("../telemetry")` — used by `dist/cli/index.js` — to the *file*, so:
 *
 *   1. `captureCliCommand` is undefined (it lives in `dist/telemetry/index.js`),
 *      and every `deepeval` command dies with
 *      "(0 , telemetry_1.captureCliCommand) is not a function".
 *   2. That stray file is the only thing in the package that requires
 *      `@sentry/node`, which `deepeval` does not declare as a dependency, so it
 *      fails with "Cannot find module '@sentry/node'" first.
 *
 * Renaming the shadowing files (rather than deleting them) keeps the install
 * inspectable. The script is intentionally forgiving: a read-only `node_modules`
 * or a future fixed release must not break `npm install`.
 *
 * The extension performs the same rename in-process via `src/deepeval-patch.ts`
 * (a packaged extension does not ship `scripts/`); that module's tests fail if
 * this file's list of shadowing files drifts out of sync.
 */

import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Defaults to this repository. Pass a root to repair another install — an npx
// cache entry or a global prefix, for example: node scripts/patch-deepeval.mjs <root>
const projectRoot = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(projectRoot, 'node_modules', 'deepeval', 'dist');

/** Files that shadow the `dist/telemetry/` directory of the same name. */
const SHADOWING_FILES = ['telemetry.js', 'telemetry.d.ts', 'telemetry.js.map'];

function main() {
	if (!existsSync(distDirectory)) {
		// deepeval is not installed (for example a production-only install).
		return;
	}

	for (const name of SHADOWING_FILES) {
		const shadowing = join(distDirectory, name);
		const disabled = `${shadowing}.shadowed`;

		if (!existsSync(shadowing)) {
			continue;
		}

		try {
			renameSync(shadowing, disabled);
			console.log(`[deval] Patched deepeval: disabled stale dist/${name} (see scripts/patch-deepeval.mjs).`);
		} catch (error) {
			console.warn(`[deval] Could not disable dist/${name}: ${error instanceof Error ? error.message : error}`);
		}
	}
}

main();
