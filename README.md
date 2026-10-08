# deval

A VS Code extension with its own benchmarkable coding agent. Chat with `@deval` and it runs a real tool-calling loop against your Chat model; every run is captured, and DeepEval TypeScript suites score the runs — trajectory and tool use — with deterministic metrics.

It gives you one thing: **an agent you can measure**.

1. **The `@deval` agent** (`src/agent/`) — a tool-calling loop on `vscode.lm` with read-only workspace tools. No API key needed; the model comes from the Chat model picker.
2. **Automatic capture** — every run is written to `.deval/vscode-agent-events/<session-id>.jsonl`.
3. **Benchmarks** — DeepEval suites that score the loop (scripted model) and score real captured runs (trajectory, tool resolution, policy).

The bundled suites use **deterministic metrics only**, so they run offline with no API key.

## Quick start

```sh
npm install
npm run benchmark      # run the bundled DeepEval suites
npm test               # run the extension-host tests
```

Press `F5` to launch the Extension Development Host, then use the Command Palette:

| # | Command | What it does |
| --- | --- | --- |
| 1 | `Deval: Evaluate Captured Agent Run` | Score a captured `.jsonl` trajectory in the extension — no suite files or installs needed. If no capture exists yet, offers to run the Deval agent now and evaluates the run it creates. |
| 2 | `Deval: Benchmark Chat Model` | Benchmark the chat model wired to VS Code with the **built-in** suite — no workspace test files needed. |
| 3 | `Deval: Show Scoreboard` | Compare every recorded run side by side in a scoreboard webview. |

Command 2 launches a VS Code task and reports the exit code in a notification when it finishes. It refuses to launch `npx` in a workspace that has no `deepeval` of its own: npx would download an unpatched copy into its own cache, and the suite would still be missing its `vitest`, so the run offers **Install dependencies** instead of failing. The install goes into the workspace's `.deval/` folder — never into the workspace root — and the suite runs from there.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run check-types` | Type-check the extension (`tsconfig.json`) **and** the benchmarks (`tsconfig.benchmarks.json`). |
| `npm run lint` | ESLint over `src`, `benchmarks`, and the Vitest config. |
| `npm run compile` | Type-check, lint, and bundle to `dist/extension.js`. |
| `npm run benchmark` | `deepeval test run benchmarks` — both bundled suites. |
| `npm run benchmark:captured` | Only the captured-run suite (skips itself if `DEEPEVAL_VSCODE_EVENTS` is unset). |
| `npm test` | Extension-host tests via `@vscode/test-electron`. |
| `npm run package` | Production bundle for packaging. |

## The agent under test

The system under test is the `@deval` agent loop itself (`src/agent/loop.ts`). It is deliberately dependency-free — it imports neither `vscode` nor `deepeval` — so the same loop runs in the extension host (via `src/agent/vscode-adapter.ts`), in unit tests with fake ports, and in the Vitest process that DeepEval spawns.

```ts
export interface AgentRun {
  input: string;                 // the prompt the agent was asked to satisfy
  output: string;                // the artifact the agent produced, as text
  toolsCalled: AgentToolCall[];  // the tools it used, in call order
}
```

`runAgentLoop()` takes the model, the tools, and the capture sink as ports and returns that shape, so every suite keeps working whatever drives the loop. To extend the agent, add a schema in `src/agent/tool-schemas.ts` and an implementation in `src/agent/tools.ts`, then declare it in the `languageModelTools` contribution in `package.json`.

## Instrument the agent so metrics can see it

Model-judged and trajectory metrics do not read your return value — they read a **trace**. Wrap the call in `observe(...)` and publish its I/O:

```ts
import { SpanType, observe, updateCurrentSpan, updateCurrentTrace } from 'deepeval/tracing';

const observedAgentLoop = observe({
  type: SpanType.AGENT,
  name: 'deval-agent-loop',
  fn: async (input: string) => {
    const run = await runAgentLoop(input, ports, { toolSchemas: DEVAL_TOOL_SCHEMAS });
    const turn = { input: run.input, output: run.output, toolsCalled: run.toolsCalled };
    updateCurrentSpan(turn);    // component scope
    updateCurrentTrace(turn);   // turn scope — this is what ToolCorrectnessMetric reads
    return run.output;
  },
});
```

Then assert against a golden:

```ts
const golden = new Golden({ input: 'What does the deval_readFile tool do?', expectedTools: [...] });

await expect(golden).toPass([new ContainsAllMetric({ required: [...] }), new ToolCorrectnessMetric({ threshold: 1 })], {
  task: (testCase) => observedAgentLoop(testCase.input),
});
```

`expect(golden).toPass(...)` requires a trace, so a task that is not `observe`d fails with *"ran the callback but no trace was produced"*. If a metric needs `toolsCalled`, publish it with `updateCurrentTrace` — publishing it only on the span is not enough.

## Writing metrics

`benchmarks/metrics/` holds two custom metrics that show the pattern:

- **`ContainsAllMetric`** — required/forbidden substrings; the score is the fraction satisfied. Used for structural checks on generated artifacts.
- **`ToolCallResolutionMetric`** — the share of captured tool calls that returned a result, with a documented tolerance.

Extend `BaseMetric`, set `requiredParams`, compute a `score` in `measure`, and let `isSuccessful()` compare it to the threshold. Deterministic metrics need no key, which is what keeps the suites offline-friendly.

For subjective checks, DeepEval's built-in judge metrics (`TaskCompletionMetric`, `GEval`, `ToolCorrectnessMetric` with `availableTools`, …) work as-is — they need `DEEPEVAL_API_KEY`:

```sh
export DEEPEVAL_API_KEY=...
```

## Captures

Every `@deval` run is captured automatically — no hooks to install, nothing to enable. The agent loop records prompt, tool-use, tool-result, and stop events to `.deval/vscode-agent-events/<session-id>.jsonl`:

```json
{"timestamp":"...","session_id":"...","hook_event_name":"PreToolUse","tool_name":"deval_readFile","tool_use_id":"call_...","tool_input":{...}}
```

Command 1 (`Deval: Evaluate Captured Agent Run`) scores the trajectory **inside the extension** — no suite files, no installs. It runs eight deterministic checks and reports them in a notification, with per-check details on demand:

- the capture holds only valid JSON objects, recorded events, and a session id
- the run finished (a `Stop` event)
- tool calls resolved (at most 5% may stay unresolved)
- no destructive tools were used
- tool names are well-formed
- prompts were recorded

The same checks live in `src/events/score-trajectory.ts`, shared with `benchmarks/captured-run-benchmark.test.ts`, so the command and `npm run benchmark` can never disagree about what a good trajectory looks like.

The captured-run suite evaluates the **trajectory** — prompts, tool names, pairing, completion, destructive-tool policy. A tool call that errored appears as a `PostToolUse` whose response carries the error, so interrupted runs stay evaluable.

**Privacy:** captures contain prompts, tool arguments, and tool results, so `.deval/` is Git-ignored. Do not commit it.

Command 1 (`Deval: Evaluate Captured Agent Run`) offers to run the Deval agent for you when no capture exists yet — you type (or accept) a prompt, the agent runs headlessly with a progress notification, and the run it creates is evaluated straight away.

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

Every run is captured to `.deval/vscode-agent-events/<session-id>.jsonl`. That means `Deval: Evaluate Captured Agent Run` scores the agent's trajectory with no extra wiring, and `benchmarks/agent-loop-benchmark.test.ts` measures the loop itself with a scripted model.

The loop core (`src/agent/loop.ts`) is dependency-free: it takes the model, the tools, and the capture sink as ports, so the same code runs in the extension host (via `src/agent/vscode-adapter.ts`), in unit tests with fakes, and in benchmark suites.

It is an extension-owned agent, not a hook into GitHub Copilot's built-in agent mode. The model comes from the user's Chat model picker via the Language Model API — no API key needed.

## Benchmark the wired chat model

`Deval: Benchmark Chat Model` scores the model behind your VS Code Chat — whatever you have wired up — with a suite that **ships inside the extension**, so it works in any workspace, even one with no test files of its own.

1. It asks `vscode.lm` which chat models are available (letting you pick when there are several) and sends each prompt from `resources/builtin-suites/spec.json` to the model.
2. The responses are recorded to `.deval/model-benchmark/<timestamp>/responses.json`.
3. The built-in suite (`resources/builtin-suites/model-benchmark.test.ts`) is staged into the same folder — it resolves `vitest` from the workspace there — and run with `DEEPEVAL_MODEL_RESPONSES` pointing at the responses file. One run, one folder.

Each of the six cases passes when the response contains the required keywords (case-insensitive) and none of the forbidden ones: factual recall, following an exact-output instruction, arithmetic, a small code task, a formatting constraint, and a one-sentence summary. Deterministic, no API key.

This benchmarks the **model only** — prompt in, response out. It does not exercise VS Code's built-in agent harness: extensions can't drive or observe that loop through a stable API, which is why the fully observable `@deval` agent above exists for trajectory benchmarking.

## Scoreboard

`Deval: Show Scoreboard` compares runs against each other: every column is one run (oldest first), every row is a trajectory check (command 1) or a benchmark case (command 2), and each cell is ✓/✗ — hover it for the detail behind the score.

- Command 1 appends one record per evaluation to `.deval/scores.jsonl`: the capture filename plus the 8 trajectory checks.
- Command 2 appends one record per successful benchmark: the model name plus one check per built-in case, parsed from DeepEval's own results file.
- The scoreboard reads `.deval/scores.jsonl` and renders agent runs and model benchmarks as two tables. With no history yet, it tells you to run command 1 or 2 first.

So to compare two models, run command 2 once per model and open the scoreboard; to compare agent runs (different prompts, models, or code states), evaluate each capture with command 1 and open the scoreboard.

## Repository layout

```
src/
  agent/loop.ts                  # dependency-free agentic loop: model turns, tool dispatch, capture
  agent/tool-schemas.ts          # the read-only tools the @deval agent can call (dependency-free)
  agent/tools.ts                 # vscode.lm tool registration + implementations
  agent/vscode-adapter.ts        # adapts the loop to vscode.lm (messages, tool calls, streaming)
  agent/participant.ts           # the @deval chat participant + the headless agent run
  chat-models.ts                 # shared chat-model picker (vscode.lm)
  deepeval-patch.ts              # repairs the deepeval@0.9.22 CLI in any workspace
  events/event-log.ts            # JSONL capture parser + trajectory summarizer
  events/event-writer.ts         # writes captures in the format event-log.ts reads
  events/score-trajectory.ts     # deterministic trajectory checks, shared by command 1 and the captured-run suite
  model-benchmark.ts             # the built-in chat-model benchmark command
  scores.ts                      # score history: append/read .deval/scores.jsonl (dependency-free)
  scoreboard.ts                  # renders the scoreboard webview HTML (dependency-free)
  scoreboard-panel.ts            # command 3: opens the scoreboard webview
  suites.ts                      # the evaluate command, capture picker, install flow
  extension.ts                   # thin entry point: registers commands and the participant
  test/                          # extension-host tests (Mocha, via `npm test`)
resources/
  builtin-suites/                # the built-in model benchmark: spec.json + the suite (shipped)
benchmarks/
  captured-run-benchmark.test.ts # evaluates a captured @deval run
  agent-loop-benchmark.test.ts   # evaluates the @deval agent loop with a scripted model
  metrics/                       # custom deterministic metrics
scripts/patch-deepeval.mjs       # see "Known upstream issue" below
```

`vitest.config.mts` limits Vitest to `benchmarks/**` on purpose: `src/test/**` holds the Mocha suites, which import `vscode` and would fail inside Vitest.

## Known upstream issue

`deepeval@0.9.22` — the current latest release — ships a stale `dist/telemetry.js` that shadows its own `dist/telemetry/` directory. Node resolves the CLI's `require("../telemetry")` to that file, so every command fails with either `Cannot find module '@sentry/node'` (the stray file's only use of an undeclared dependency) or `captureCliCommand is not a function`.

Two things repair it, so this is handled for you:

- In **this repository**, `scripts/patch-deepeval.mjs` runs on `postinstall` and renames the shadowing files. `@sentry/node` is also listed as a devDependency so an install with `--ignore-scripts` still loads.
- In **any other workspace**, the extension renames the same files in-process (see `src/deepeval-patch.ts`) before every run, and again after **Install dependencies**. A packaged extension ships without `scripts/`, which is why this is done in-process rather than by spawning a script.

A read-only `node_modules` or a future fixed release is tolerated; the patch is never the reason a run fails. Remove all of this once upstream publishes a fix.

### The `npm-cache\_npx` failure

If the stack points at `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\deepeval\dist\telemetry.js`, the workspace had **no local install** for npx to use, so npx downloaded DeepEval itself. That copy is unpatchable from inside the extension (it lives in npm's cache, outside the workspace) and the suite would fail regardless, because `vitest` is missing too. Command 2 detects this via `requiresLocalDeepEvalInstall()` and offers **Install dependencies** — into `.deval/`, not the workspace root — rather than starting a run that cannot succeed. To repair a cached or global copy by hand, point the postinstall script at it:

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

- `deval.devalCommand`: executable used to launch the DeepEval runner. Defaults to `npx`.
- `deval.packageManager`: package manager used to install `deepeval` + `vitest` — `npm`, `pnpm`, `yarn`, or `bun`. Defaults to `npm`, and is used only by **Install dependencies** when a run needs it.

These are deliberately separate settings. `deval.devalCommand` names the *runner* (`npx deepeval test run …`), so it cannot be reused to install: `npx install --save-dev deepeval vitest` makes npx look for an executable called `install` and fail with `could not determine executable to run`.

