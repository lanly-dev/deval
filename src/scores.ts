// Score history for the Deval scoreboard.
//
// Every run of command 1 ("Evaluate Captured Agent Run") or command 2
// ("Benchmark Chat Model") appends one record to `.deval/scores.jsonl`;
// command 3 ("Show Scoreboard") reads the file back and renders the runs
// side by side so agents and models can be compared.
//
// Dependency-free (node:fs only) so the record format can be unit-tested
// without the extension host.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One scored check (command 1) or benchmark case (command 2). */
export interface ScoreCheck {
	label: string;
	passed: boolean;
	/** Human-readable detail, e.g. "0 unresolved tool calls out of 14". */
	detail: string;
}

export type ScoreKind = 'agent-run' | 'model-benchmark';

/** One evaluated run: what it was, when it finished, and how it scored. */
export interface ScoreRecord {
	/** ISO timestamp of when the run finished. */
	timestamp: string;
	kind: ScoreKind;
	/** Short label: the capture filename for command 1, the model name for command 2. */
	label: string;
	/** Chat model behind an agent run, when the capture recorded one. */
	model?: string;
	checks: ScoreCheck[];
}

/** Name of the score history file inside `.deval/`. */
export const SCORES_FILENAME = 'scores.jsonl';

function scoresPath(devalDir: string): string {
	return join(devalDir, SCORES_FILENAME);
}

function sanitizeCheck(check: unknown): ScoreCheck | undefined {
	if (typeof check !== 'object' || check === null) {
		return undefined;
	}
	const { label, passed, detail } = check as Record<string, unknown>;
	if (typeof label !== 'string' || typeof passed !== 'boolean' || typeof detail !== 'string') {
		return undefined;
	}
	return { label, passed, detail };
}

/** Append one run's score to `.deval/scores.jsonl`. Never throws: score history must not break a run's reporting. */
export async function appendScore(devalDir: string, record: ScoreRecord): Promise<void> {
	try {
		await mkdir(devalDir, { recursive: true });
		await appendFile(scoresPath(devalDir), JSON.stringify(record) + '\n', 'utf8');
	} catch {
		// Ignore: losing one history entry is better than failing the command.
	}
}

/** Read every recorded score, oldest first. Returns [] when there is no history yet. Corrupt lines are skipped. */
export async function readScores(devalDir: string): Promise<ScoreRecord[]> {
	let content: string;
	try {
		content = await readFile(scoresPath(devalDir), 'utf8');
	} catch {
		return [];
	}
	const records: ScoreRecord[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as Partial<ScoreRecord>;
			if (typeof parsed.timestamp !== 'string' || !Array.isArray(parsed.checks)) {
				continue;
			}
			const checks: ScoreCheck[] = [];
			for (const check of parsed.checks) {
				const sanitized = sanitizeCheck(check);
				if (sanitized) {
					checks.push(sanitized);
				}
			}
			records.push({
				timestamp: parsed.timestamp,
				kind: parsed.kind === 'model-benchmark' ? 'model-benchmark' : 'agent-run',
				label: typeof parsed.label === 'string' && parsed.label ? parsed.label : 'run',
				model: typeof parsed.model === 'string' && parsed.model ? parsed.model : undefined,
				checks,
			});
		} catch {
			// Skip corrupt lines; keep the rest of the history readable.
		}
	}
	return records;
}
