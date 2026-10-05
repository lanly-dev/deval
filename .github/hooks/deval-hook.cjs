const fs = require('node:fs');
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
			path.join(outputDirectory, `${sessionId}.jsonl`),
			`${JSON.stringify(record)}\n`,
			{ encoding: 'utf8', mode: 0o600 },
		);
	} catch (error) {
		console.error(`DeepEval hook could not record the event: ${error.message}`);
		process.exitCode = 1;
	}
});
