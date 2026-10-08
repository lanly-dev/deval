# DeepEval for VS Code

A working starter for evaluating coding agents with [DeepEval](https://deepeval.com/docs/getting-started) TypeScript suites, run from VS Code.

It gives you three things:

1. **A reference agent harness** (`src/agent-harness.ts`) and a benchmark suite that evaluates it — the seam you replace with your own agent.
2. **A capture pipeline** for the VS Code **Local** agent harness (`.github/hooks/`, `.deepeval/vscode-agent-events/*.jsonl`) and a suite that evaluates a captured run.
3. **Commands that run both** and report pass/fail, plus a scaffolder for a new suite.

The bundled suites use **deterministic metrics only**, so they run offline with no API key — locally and in CI.

## Quick start

```sh
npm install
npm run benchmark      # run the bundled DeepEval suites
npm test               # run the extension-host tests
```

Press `F5` to launch the Extension Development Host, then use the Command Palette:

| Command | What it does |
| --- | --- |
| `DeepEval: Run Test Suite` | Pick a `*.test.ts` / `*.spec.ts` suite and run it with `deepeval test run`. |
| `DeepEval: Evaluate Captured Local Agent Run` | Pick a suite **and** a captured `.jsonl`, then run the suite with `DEEPEVAL_VSCODE_EVENTS` pointing at that capture. |
| `DeepEval: Scaffold Sample Benchmark` | Write `benchmarks/my-agent.test.ts` — a self-contained starter suite — into the workspace, open it, and offer to install `deepeval` + `vitest` with `deval.packageManager`. |

Both run commands launch a VS Code task with the workspace folder as its working directory, and report the exit code in a notification when it finishes. They also refuse to launch `npx` in a workspace that has no `deepeval` of its own: npx would download an unpatched copy into its own cache, and the suite would still be missing its `vitest`, so the run offers **Install dependencies** instead of failing.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run check-types` | Type-check the extension (`tsconfig.json`) **and** the benchmarks (`tsconfig.benchmarks.json`). |
| `npm run lint` | ESLint over `src`, `benchmarks`, and the Vitest config. |
| `npm run compile` | Type-check, lint, and bundle to `dist/extension.js`. |
| `npm run benchmark` | `deepeval test run benchmarks` — both bundled suites. |
| `npm run benchmark:todo` | Only the reference-agent suite. |
| `npm run benchmark:captured` | Only the captured-run suite (skips itself if `DEEPEVAL_VSCODE_EVENTS` is unset). |
| `npm test` | Extension-host tests via `@vscode/test-electron`. |
| `npm run package` | Production bundle for packaging. |

## Replace the agent under test

`src/agent-harness.ts` is the only file you need to change to evaluate your own agent. It is deliberately dependency-free — it imports neither `vscode` nor `deepeval` — so the same file loads in the extension host and in the Vitest process that DeepEval spawns.

```ts
export interface AgentRun {
  input: string;                 // the prompt the agent was asked to satisfy
  output: string;                // the artifact the agent produced, as text
  toolsCalled: AgentToolCall[];  // the tools it used, in call order
}
```

Return that shape from your implementation and every suite keeps working. `todoAppAgent` is a deterministic reference implementation that emits a single-file todo app.

## Instrument the agent so metrics can see it

Model-judged and trajectory metrics do not read your return value — they read a **trace**. Wrap the call in `observe(...)` and publish its I/O:

```ts
import { SpanType, observe, updateCurrentSpan, updateCurrentTrace } from 'deepeval/tracing';

const observedAgent = observe({
  type: SpanType.AGENT,
  name: 'my-agent',
  fn: async (input: string) => {
    const run = await runAgent(input);
    const turn = { input: run.input, output: run.output, toolsCalled: run.toolsCalled };
    updateCurrentSpan(turn);    // component scope
    updateCurrentTrace(turn);   // turn scope — this is what ToolCorrectnessMetric reads
    return run.output;
  },
});
```

Then assert against a golden:

```ts
const golden = new Golden({ input: 'Build a todo app.', expectedTools: expectedTodoTools() });

await expect(golden).toPass([structuralChecks(), new ToolCorrectnessMetric({ threshold: 1 })], {
  task: (testCase) => observedAgent(testCase.input),
});
```

`expect(golden).toPass(...)` requires a trace, so a task that is not `observe`d fails with *"ran the callback but no trace was produced"*. If a metric needs `toolsCalled`, publish it with `updateCurrentTrace` — publishing it only on the span is not enough.

## Writing metrics

`benchmarks/metrics/` holds two custom metrics that show the pattern:

- **`ContainsAllMetric`** — required/forbidden substrings; the score is the fraction satisfied. Used for structural checks on generated artifacts.
- **`ToolCallResolutionMetric`** — the share of captured tool calls that returned a result, with a documented tolerance.

Extend `BaseMetric`, set `requiredParams`, compute a `score` in `measure`, and let `isSuccessful()` compare it to the threshold. Deterministic metrics need no key, which is what keeps CI green.

For subjective checks, DeepEval's built-in judge metrics (`TaskCompletionMetric`, `GEval`, `ToolCorrectnessMetric` with `availableTools`, …) work as-is — they need `DEEPEVAL_API_KEY`:

```sh
export DEEPEVAL_API_KEY=...
```

## Capture the VS Code Local harness

This extension ships a Preview Local hook at `.github/hooks/deval.json`. With **Local** selected as the session target, a trusted workspace, and `chat.useHooks` enabled, it records prompt, tool-use, tool-result, and stop events to `.deepeval/vscode-agent-events/<session-id>.jsonl`:

```json
{"timestamp":"...","cwd":"...","session_id":"...","hook_event_name":"PreToolUse","tool_name":"read_file","tool_use_id":"call_...","tool_input":{...}}
```

`DeepEval: Evaluate Captured Local Agent Run` sets `DEEPEVAL_VSCODE_EVENTS` to the selected file's absolute path. A suite reads it with `resolveCapturedRunPath()` / `loadCapturedRun()` from `src/events/event-log.ts`, which parses the JSONL, pairs `PreToolUse` with `PostToolUse`, and summarizes the trajectory.

The hook files are **not** inside the packaged extension: `.vscodeignore` excludes `.github/**`, so only this repository has them, and a workspace that only ever received a scaffolded benchmark has no hook to enable. Run `DeepEval: Install Capture Hook` to write `.github/hooks/deval.json` and `.github/hooks/deval-hook.cjs` into any workspace. The same button is offered by **Evaluate Captured Local Agent Run** when it finds no captures — alongside the exact directory it searched — and by **Scaffold Sample Benchmark** next to **Install dependencies**. Afterwards, enable `chat.useHooks`, confirm discovery with `Chat: Configure Hooks`, and send one turn in a **Local** session.

The captured-run suite evaluates the **trajectory** — prompts, tool names, pairing, completion, destructive-tool policy — because the documented `Stop` payload does not include the response text. A suite that needs the prose must read `transcript_path`, whose format VS Code documents as unstable across releases.

Two behaviours worth knowing:

- A tool call the user **denies** appears as a `PreToolUse` with no matching `PostToolUse`. That is normal, which is why `ToolCallResolutionMetric` allows a small unresolved share instead of failing on any dangling call.
- The Local harness documents eight events — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`. This reader interprets the middle four (`HOOK_EVENT_NAMES`); the rest are written to the capture and ignored, so a run with subagents or compaction still evaluates. Run `Chat: Configure Hooks` to confirm which hook files the harness discovered, and check the **GitHub Copilot Chat Hooks** output channel for hook errors.
- Hooks are Preview and apply only to the VS Code Local harness; Copilot, Claude, and Codex Agent Host sessions have provider-specific hook behaviour.

**Privacy:** captures contain prompts, tool arguments, tool results, and a `transcript_path` into your VS Code history, so `.deepeval/` is Git-ignored. Do not commit it.

## The `@deval` agent

`@deval` is a real tool-calling agent, not just a chat forwarder. When you send it a prompt, it runs an agentic loop against the model selected in Chat:

1. The model decides whether it needs information, and calls a tool.
2. The extension executes the tool and feeds the result back.
3. The loop repeats until the model answers, or stops after 10 turns.

v1 ships three **read-only** tools, so the agent needs no confirmation UX:

| Tool | What it does |
| --- | --- |
| `deval_readFile` | Reads a workspace file's full text. |
| `deval_listFiles` | Lists a workspace directory, non-recursive. |
| `deval_grep` | Searches file contents for a pattern. |

Every run is captured to `.deepeval/vscode-agent-events/<session-id>.jsonl` in the workspace's own capture format — the same format the Local-harness hook writes. That means `DeepEval: Evaluate Captured Local Agent Run` scores the agent's trajectory with no extra wiring, and `benchmarks/agent-loop-benchmark.test.ts` measures the loop itself with a scripted model.

The loop core (`src/agent/loop.ts`) is dependency-free, like `agent-harness.ts`: it takes the model, the tools, and the capture sink as ports, so the same code runs in the extension host (via `src/agent/vscode-adapter.ts`), in unit tests with fakes, and in benchmark suites.

It is an extension-owned agent, not a hook into GitHub Copilot's built-in agent mode. The model comes from the user's Chat model picker via the Language Model API — no API key needed.

## Repository layout

```
src/
  agent-harness.ts               # the agent under test (replace this)
  agent/loop.ts                  # dependency-free agentic loop: model turns, tool dispatch, capture
  agent/tool-schemas.ts          # the read-only tools the @deval agent can call (dependency-free)
  agent/tools.ts                 # vscode.lm tool registration + implementations
  agent/vscode-adapter.ts        # adapts the loop to vscode.lm (messages, tool calls, streaming)
  capture-hook.ts                # the embedded capture hook, written into any workspace
  deepeval-patch.ts              # repairs the deepeval@0.9.22 CLI in any workspace
  events/event-log.ts            # JSONL capture parser + trajectory summarizer
  events/event-writer.ts         # writes captures in the format event-log.ts reads
  extension.ts                   # commands, chat participant, task runner, scaffolder
  test/                          # extension-host tests (Mocha, via `npm test`)
benchmarks/
  todo-benchmark.test.ts         # evaluates the reference agent through a trace
  captured-run-benchmark.test.ts # evaluates a captured Local-harness run
  agent-loop-benchmark.test.ts   # evaluates the @deval agent loop with a scripted model
  metrics/                       # custom deterministic metrics
scripts/patch-deepeval.mjs       # see "Known upstream issue" below
```

`vitest.config.mts` limits Vitest to `benchmarks/**` on purpose: `src/test/**` holds the Mocha suites, which import `vscode` and would fail inside Vitest.

## Known upstream issue

`deepeval@0.9.22` — the current latest release — ships a stale `dist/telemetry.js` that shadows its own `dist/telemetry/` directory. Node resolves the CLI's `require("../telemetry")` to that file, so every command fails with either `Cannot find module '@sentry/node'` (the stray file's only use of an undeclared dependency) or `captureCliCommand is not a function`.

Two things repair it, so this is handled for you:

- In **this repository**, `scripts/patch-deepeval.mjs` runs on `postinstall` and renames the shadowing files. `@sentry/node` is also listed as a devDependency so an install with `--ignore-scripts` still loads.
- In **any other workspace** — including one you just scaffolded — the extension renames the same files in-process (see `src/deepeval-patch.ts`) before every run, and again after **Install dependencies**. A packaged extension ships without `scripts/`, which is why this is done in-process rather than by spawning a script.

A read-only `node_modules` or a future fixed release is tolerated; the patch is never the reason a run fails. Remove all of this once upstream publishes a fix.

### The `npm-cache\_npx` failure

If the stack points at `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\deepeval\dist\telemetry.js`, the workspace had **no local install** for npx to use, so npx downloaded DeepEval itself. That copy is unpatchable from inside the extension (it lives in npm's cache, outside the workspace) and the suite would fail regardless, because `vitest` is missing too. Both run commands detect this via `requiresLocalDeepEvalInstall()` and offer **Install dependencies** rather than starting a run that cannot succeed. To repair a cached or global copy by hand, point the postinstall script at it:

```sh
node scripts/patch-deepeval.mjs "%LOCALAPPDATA%\npm-cache\_npx\<hash>"
```

## Verification

Run the checks locally — no CI, no secrets needed (the suites are deterministic):

```sh
npm run check-types   # type-check the extension and the benchmarks
npm run lint          # ESLint over src, benchmarks, and the Vitest config
npm run benchmark     # run the DeepEval suites
npm test              # extension-host tests (needs a display; use xvfb-run headless)
```

## Settings

- `deval.deepevalCommand`: executable used to launch the DeepEval runner. Defaults to `npx`.
- `deval.packageManager`: package manager the scaffolder installs with — `npm`, `pnpm`, `yarn`, or `bun`. Defaults to `npm`, and is used only by **Install dependencies** on the scaffold notification.

These are deliberately separate settings. `deval.deepevalCommand` names the *runner* (`npx deepeval test run …`), so it cannot be reused to install: `npx install --save-dev deepeval vitest` makes npx look for an executable called `install` and fail with `could not determine executable to run`.

