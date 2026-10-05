/**
 * The Local-harness capture hook, embedded as text so *any* workspace can get it.
 *
 * `.vscodeignore` excludes `.github/**`, so the packaged extension does not ship
 * the repository's hook files. A workspace scaffolded by `DeepEval: Scaffold
 * Sample Benchmark` therefore has nothing for `DeepEval: Evaluate Captured Local
 * Agent Run` to find, and telling the user to "enable the workspace hook" points
 * them at a file that was never written there. `installCaptureHook` in
 * `extension.ts` writes what this module returns instead of copying from the
 * extension's own install directory, which is the one place the files cannot be
 * read from once packaged.
 *
 * The copies under this repository's `.github/hooks/` remain the reference
 * implementation: `src/test/capture-hook.test.ts` compares both byte for byte,
 * so the embedded text cannot drift from what the repository documents.
 */

/** Events `deval-hook.cjs` records and `deval.json` subscribes the script to. */
export const CAPTURE_HOOK_EVENTS = [
	'UserPromptSubmit',
	'PreToolUse',
	'PostToolUse',
	'Stop',
] as const;

/** Folder holding the hook files, relative to the workspace root. */
export const CAPTURE_HOOK_DIRECTORY = ['.github', 'hooks'] as const;

/** The hook registration file the Local harness discovers. */
export const CAPTURE_HOOK_CONFIG_FILE = 'deval.json';

/** The script every hook action runs. */
export const CAPTURE_HOOK_SCRIPT_FILE = 'deval-hook.cjs';

/** One file `DeepEval: Install Capture Hook` writes into the workspace. */
export interface CaptureHookFile {
	/** Workspace-relative path segments, starting at the workspace root. */
	segments: string[];
	/** The exact file content, newlines included. */
	content: string;
}

/**
 * The command every hook action runs.
 *
 * Built from the path constants so the config cannot name a script the
 * installer writes somewhere else, and so the paths stay forward-slashed the
 * way the harness expects them in JSON.
 */
export const CAPTURE_HOOK_COMMAND = `node ${[...CAPTURE_HOOK_DIRECTORY, CAPTURE_HOOK_SCRIPT_FILE].join('/')}`;

/**
 * `.github/hooks/deval.json` as text.
 *
 * Generated from `CAPTURE_HOOK_EVENTS` rather than pasted, so subscribing a new
 * event is a one-line change here, and stringified with two-space indentation so
 * the result matches the repository's copy byte for byte.
 */
export function getCaptureHookConfigSource(): string {
	const hooks = Object.fromEntries(
		CAPTURE_HOOK_EVENTS.map((event) => [
			event,
			[{ type: 'command', command: CAPTURE_HOOK_COMMAND, cwd: '.', timeout: 10 }],
		]),
	);
	return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

/**
 * `.github/hooks/deval-hook.cjs` as text.
 *
 * The script appends one JSON record per event to
 * `<cwd>/.deepeval/vscode-agent-events/<session-id>.jsonl`, which is exactly
 * where `CAPTURED_RUN_DIRECTORY` points and where `src/events/event-log.ts`
 * reads from, so its constant names are asserted against the real directories in
 * the tests.
 *
 * Written as a template literal with the script's own backticks, `${…}`, and
 * `\n` escaped; the byte-comparison test is what keeps those escapes honest.
 */
export function getCaptureHookScriptSource(): string {
	return `const fs = require('node:fs');
const path = require('node:path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	input += chunk;
});
process.stdin.on('end', () => {
	try {
		const event = JSON.parse(input);
		if (!event || typeof event !== 'object' || Array.isArray(event)) {
			throw new Error('Hook input must be a JSON object.');
		}

		const rawSessionId = typeof event.session_id === 'string' ? event.session_id : 'unknown';
		const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
		const eventFields = [
			'timestamp',
			'cwd',
			'session_id',
			'hook_event_name',
			'transcript_path',
			'prompt',
			'tool_name',
			'tool_input',
			'tool_use_id',
			'tool_response',
			'stop_hook_active',
		];
		const record = Object.fromEntries(
			eventFields
				.filter((field) => Object.hasOwn(event, field))
				.map((field) => [field, event[field]]),
		);
		const outputDirectory = path.join(process.cwd(), '.deepeval', 'vscode-agent-events');
		fs.mkdirSync(outputDirectory, { recursive: true });
		fs.appendFileSync(
			path.join(outputDirectory, \`\${sessionId}.jsonl\`),
			\`\${JSON.stringify(record)}\\n\`,
			{ encoding: 'utf8', mode: 0o600 },
		);
	} catch (error) {
		console.error(\`DeepEval hook could not record the event: \${error.message}\`);
		process.exitCode = 1;
	}
});
`;
}

/** Every file `DeepEval: Install Capture Hook` writes, in write order. */
export function getCaptureHookFiles(): CaptureHookFile[] {
	return [
		{
			segments: [...CAPTURE_HOOK_DIRECTORY, CAPTURE_HOOK_CONFIG_FILE],
			content: getCaptureHookConfigSource(),
		},
		{
			segments: [...CAPTURE_HOOK_DIRECTORY, CAPTURE_HOOK_SCRIPT_FILE],
			content: getCaptureHookScriptSource(),
		},
	];
}
