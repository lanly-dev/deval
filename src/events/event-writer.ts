/**
 * Writer for the JSONL captures `src/events/event-log.ts` reads.
 *
 * Like `event-log.ts`, this module is dependency-free: it imports neither
 * `vscode` nor `deepeval`, so the same writer can be used inside the extension
 * host and in a plain Node process.
 *
 * The writer produces the record shape `loadCapturedRun()` consumes for runs
 * the extension itself drives — currently the `@deval` agent loop in
 * `src/agent/loop.ts`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { AgentEvent } from './event-log';

/** A capture file being written. */
export interface CaptureWriter {
	/** The session this writer records. */
	readonly sessionId: string;
	/** Absolute path of the `.jsonl` file being appended to. */
	readonly filePath: string;
	/**
	 * Append one event.
	 *
	 * `session_id` and `timestamp` are filled in when absent, so callers only
	 * pass the hook fields.
	 */
	append(event: Omit<AgentEvent, 'session_id' | 'timestamp'> & { timestamp?: string }): void;
}

/** Make a session id safe to use as a file name. */
export function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Open a capture for writing.
 *
 * The file is `<workspaceDir>/.deval/vscode-agent-events/<sessionId>.jsonl`
 * — the same directory `CAPTURED_RUN_DIRECTORY` points at, so
 * `Deval: Evaluate Captured Agent Run` offers agent-loop runs without
 * any extra wiring. The directory is created on open; each `append` adds one
 * JSON object per line, with mode `0o600`.
 */
export function createCaptureWriter(workspaceDir: string, sessionId: string = randomUUID()): CaptureWriter {
	const safeId = sanitizeSessionId(sessionId);
	const directory = join(workspaceDir, '.deval', 'vscode-agent-events');
	mkdirSync(directory, { recursive: true });
	const filePath = join(directory, `${safeId}.jsonl`);

	return {
		sessionId: safeId,
		filePath,
		append(event) {
			const record: AgentEvent = {
				...event,
				timestamp: event.timestamp ?? new Date().toISOString(),
				session_id: safeId,
			};
			appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
		},
	};
}
