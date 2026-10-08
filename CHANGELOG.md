# Change Log

All notable changes to the `deval` extension are documented here.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- `@deval` is now a real tool-calling agent instead of a chat forwarder. It runs an agentic loop (`src/agent/loop.ts`) against the Chat model with three read-only tools — `deval_readFile`, `deval_listFiles`, `deval_grep` — declared in `package.json` and registered via `vscode.lm`.
- `src/events/event-writer.ts` — writes agent-loop runs as JSONL captures in the format `event-log.ts` reads, so `DeepEval: Evaluate Captured Agent Run` scores the agent's trajectory with no extra wiring.
- `benchmarks/agent-loop-benchmark.test.ts` — deterministic suite driving the loop with a scripted model through `observe()`, asserting with `ContainsAllMetric` and `ToolCorrectnessMetric`.
- Unit tests for the loop core (fake model/tool ports) and the capture writer.

### Removed

- The reference agent (`src/agent-harness.ts`, `benchmarks/todo-benchmark.test.ts`) — the `@deval` agent loop is the system under test now. The `AgentRun` contract moved into `src/agent/loop.ts`.
- The Local-harness capture pipeline: `src/capture-hook.ts`, `.github/hooks/`, and the `DeepEval: Install Capture Hook` command. Captures are written automatically by the agent loop.
- The `DeepEval: Scaffold Sample Benchmark` command.
- The GitHub Actions CI workflow; the README documents the local verification commands instead.

## [0.1.0]

First complete starter release.

### Added

- `src/agent-harness.ts` — a dependency-free reference agent (`todoAppAgent`) with the `AgentRun` contract that benchmark suites consume.
- `src/events/event-log.ts` — JSONL capture reader that pairs `PreToolUse`/`PostToolUse` events and summarizes a Local-harness run into prompts, tool invocations, and completion.
- `src/deepeval-patch.ts` — in-process repair of the `deepeval@0.9.22` telemetry shadowing bug, applied before every run and after every scaffold install, so a scaffolded workspace is usable without the repository's `postinstall` script.
- `DeepEval: Install Capture Hook` command and `src/capture-hook.ts`, which embeds `.github/hooks/deval.json` and `.github/hooks/deval-hook.cjs` so any workspace can acquire the capture pipeline (the packaged extension ships no `.github/**`). A hook file that already matches is left alone; one that was edited is replaced only after confirmation, and the command then offers to enable `chat.useHooks`.
- Reference benchmark `benchmarks/todo-benchmark.test.ts`, driving the harness through a DeepEval `observe`d span and asserting with deterministic metrics only.
- Benchmark `benchmarks/captured-run-benchmark.test.ts`, which evaluates a captured run selected via `DEEPEVAL_VSCODE_EVENTS` and skips itself when the variable is unset.
- Custom deterministic metrics: `ContainsAllMetric` and `ToolCallResolutionMetric`.
- `DeepEval: Scaffold Sample Benchmark` command, which writes a self-contained starter suite into the workspace.
- Failure reporting for task runs: the exit code of each `deepeval test run` is surfaced as a notification instead of only appearing in the task panel.
- `tsconfig.benchmarks.json`, so the benchmark suites are type-checked (they were previously excluded from type checking entirely).
- `vitest.config.mts`, scoping Vitest to `benchmarks/**` so the Mocha extension-host suites are not picked up.
- `scripts/patch-deepeval.mjs`, a `postinstall` workaround for the `deepeval@0.9.22` telemetry shadowing bug that breaks its CLI.
- Extension-host tests for capture parsing, the scaffold content, and discovery excludes.
- GitHub Actions CI: type-check, lint, bundle, DeepEval suites, and extension-host tests under `xvfb`.
- Packaging metadata: description, license, publisher, repository, categories, and keywords.

### Changed

- `selectDeepEvalRun` is exported and returns `vscode.Uri | undefined`; the captured-run directory is a named constant.
- Test discovery now also excludes `.vscode-test`, and the test file patterns are exported as `DEEPEVAL_TEST_PATTERNS`.
- Task launches set an explicit `cwd` on the spawned process.
- `.gitignore` ignores all of `.deepeval/` and tracks `package-lock.json` so `npm ci` works in CI.

### Fixed

- `README.md` referenced `../src/agent-harness`, which did not exist.
- The sample suite returned a hardcoded string and never invoked an agent, so it could not have evaluated anything.
- **Install dependencies** on the scaffold notification reused `deval.deepevalCommand` as the installer, so it ran `npx install --save-dev deepeval vitest` and failed with `could not determine executable to run`. It now uses the new `deval.packageManager` setting (`npm install --save-dev …`, or the matching `add` command for pnpm, yarn, and bun).
- `README.md` claimed the Local harness emits four hook events; it documents eight. The four extras are now listed as ignored rather than missing.
- A scaffolded workspace could not actually run anything: the extension told users to install `deepeval@0.9.22`, whose CLI is broken out of the box, and this repository's `postinstall` repair does not apply elsewhere. The extension now repairs the install itself before every run and after **Install dependencies**.
- Running a suite in a workspace with no local `deepeval` let `npx` fetch one into npm's cache (`…\npm-cache\_npx\<hash>\…`), where it fails with `Cannot find module '@sentry/node'`, cannot be patched by the extension, and cannot resolve the suite's `vitest`. Both run commands now detect the missing workspace install (`requiresLocalDeepEvalInstall`) and offer **Install dependencies** — reusing the same install-and-repair path as the scaffolder — instead of launching a run that cannot succeed. `scripts/patch-deepeval.mjs` additionally accepts an explicit root, so a cached or global copy can be repaired by hand.
- `DeepEval: Evaluate Captured Local Agent Run` answered "Enable the workspace hook and run the Local harness first" in workspaces that never had a hook, because `.github/hooks/` exists only in this repository and is excluded from the package — there was nothing to enable. The message now names the directory it searched, states whether `.github/hooks/deval.json` is installed, and offers **Install Capture Hook**; the scaffold notification offers the same button.
