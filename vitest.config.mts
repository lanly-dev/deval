import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the DeepEval suites.
 *
 * The `.mts` extension keeps Node from loading this ESM file as CommonJS.
 *
 * `include` covers `benchmarks/**` plus staged copies of the built-in
 * suite (`.deval/model-benchmark/**`): `src/test/**` holds the
 * extension-host suites, which run under Mocha via `npm test` and would fail
 * inside Vitest (they import `vscode` and use `suite`/`test` globals).
 */
export default defineConfig({
	test: {
		include: ['benchmarks/**/*.test.ts', '.deval/model-benchmark/**/*.test.ts'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
