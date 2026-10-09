# Deval

A VS Code extension with its own benchmarkable coding agent. Chat with `@deval` and it runs a real tool-calling loop against your Chat model; every run is captured, and DeepEval TypeScript suites score the runs — trajectory and tool use — with deterministic metrics.
<a href="https://marketplace.visualstudio.com/items?itemName=	lanly-dev.deval" target="_blank">
  <img src='https://code.visualstudio.com/favicon.ico' width='10'/>
</a>
<a href="https://open-vsx.org/extension/lanly-dev/deval" target="_blank">
  <img src='https://open-vsx.org/favicon.ico' width='10'/>
</a>

It gives you one thing: **an agent you can measure**.

1. **The `@deval` agent** (`src/agent/`) — a tool-calling loop on `vscode.lm` with read-only workspace tools. No API key needed; the model comes from the Chat model picker.
2. **Automatic capture** — every run is written to `.deval/vscode-agent-events/<session-id>.jsonl`.
3. **Benchmarks** — DeepEval suites that score the loop (scripted model) and score real captured runs (trajectory, tool resolution, policy).

The bundled suites use **deterministic metrics only**, so they run offline with no API key.

## Commands
- `Deval: Evaluate Captured Agent Run` — Evaluate Captured Agent Run tests your `@deval` agent's behavior so it is focus on agent with 8 checks.
- `Deval: Benchmark Chat Model` — Benchmark wired model, focus on llm with 11 cases.
- `Deval: Show Scoreboard` — Show the record runs.

## Settings
- `deval.devalCommand`: executable used to launch the DeepEval runner. Defaults to `npx`.
- `deval.packageManager`: package manager used to install `deepeval` + `vitest` — `npm`, `pnpm`, `yarn`, or `bun`. Defaults to `npm`, and is used only by **Install dependencies** when a run needs it.

These are deliberately separate settings. `deval.devalCommand` names the *runner* (`npx deepeval test run …`), so it cannot be reused to install: `npx install --save-dev deepeval vitest` makes npx look for an executable called `install` and fail with `could not determine executable to run`.

## Release Notes

### 0.0.1
- Initial release of Deval
