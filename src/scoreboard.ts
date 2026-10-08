// Renders the Deval scoreboard: every recorded run as a column, every
// check (command 1) or benchmark case (command 2) as a row, so runs can be
// compared side by side.
//
// Dependency-free so it can be unit-tested without the extension host — and
// so its exact output can be previewed outside VS Code.
import type { ScoreCheck, ScoreRecord } from './scores';

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Union of check labels across runs, in order of first appearance. */
function rowLabels(runs: ScoreRecord[]): string[] {
	const labels: string[] = [];
	const seen = new Set<string>();
	for (const run of runs) {
		for (const check of run.checks) {
			if (!seen.has(check.label)) {
				seen.add(check.label);
				labels.push(check.label);
			}
		}
	}
	return labels;
}

function findCheck(run: ScoreRecord, label: string): ScoreCheck | undefined {
	return run.checks.find((check) => check.label === label);
}

function renderCell(check: ScoreCheck | undefined): string {
	if (!check) {
		return '<td class="na" title="Not measured in this run">—</td>';
	}
	const glyph = check.passed ? '✓' : '✗';
	const cls = check.passed ? 'pass' : 'fail';
	return `<td class="${cls}" title="${escapeHtml(check.detail)}">${glyph}</td>`;
}

function renderTable(title: string, runs: ScoreRecord[]): string {
	const labels = rowLabels(runs);
	const headerCells = runs
		.map((run) => {
			const passed = run.checks.filter((check) => check.passed).length;
			const meta = [run.model, formatTimestamp(run.timestamp), `${passed}/${run.checks.length}`]
				.filter((part): part is string => typeof part === 'string' && part.length > 0)
				.join(' · ');
			return `<th><div class="run-label">${escapeHtml(run.label)}</div><div class="run-meta">${escapeHtml(meta)}</div></th>`;
		})
		.join('');
	const bodyRows = labels
		.map((label) => {
			const cells = runs.map((run) => renderCell(findCheck(run, label))).join('');
			return `<tr><td class="row-label">${escapeHtml(label)}</td>${cells}</tr>`;
		})
		.join('');
	return `<h2>${escapeHtml(title)}</h2><table><thead><tr><th></th>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

/** Full HTML document for the scoreboard webview. */
export function renderScoreboardHtml(records: ScoreRecord[]): string {
	const agentRuns = records.filter((record) => record.kind === 'agent-run');
	const modelRuns = records.filter((record) => record.kind === 'model-benchmark');
	const sections = [
		agentRuns.length ? renderTable('Agent runs', agentRuns) : '',
		modelRuns.length ? renderTable('Model benchmarks', modelRuns) : '',
	].join('');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
:root {
	color-scheme: light dark;
}
body {
	font-family: var(--vscode-font-family, system-ui, sans-serif);
	font-size: var(--vscode-font-size, 13px);
	background: var(--vscode-editor-background, #1e1e1e);
	color: var(--vscode-editor-foreground, #d4d4d4);
	margin: 0;
	padding: 20px 24px 40px;
}
h1 {
	font-size: 18px;
	font-weight: 600;
	margin: 0 0 4px;
}
p.hint {
	opacity: 0.7;
	margin: 0 0 20px;
}
h2 {
	font-size: 14px;
	font-weight: 600;
	margin: 28px 0 8px;
}
table {
	border-collapse: collapse;
}
th, td {
	border: 1px solid var(--vscode-panel-border, #3c3c3c);
	padding: 6px 12px;
	text-align: center;
	white-space: nowrap;
}
th {
	background: var(--vscode-sideBar-background, #252526);
}
.run-label {
	font-weight: 600;
}
.run-meta {
	font-weight: 400;
	opacity: 0.7;
	font-size: 11px;
	margin-top: 2px;
}
td.row-label {
	text-align: left;
	font-weight: 600;
}
td.pass {
	color: var(--vscode-testing-iconPassed, #89d185);
	font-weight: 700;
}
td.fail {
	color: var(--vscode-testing-iconFailed, #f14c4c);
	font-weight: 700;
}
td.na {
	opacity: 0.4;
}
</style>
</head>
<body>
<h1>Deval Scoreboard</h1>
<p class="hint">Every column is one run, oldest first. Hover a cell for the detail behind its score.</p>
${sections}
</body>
</html>`;
}
