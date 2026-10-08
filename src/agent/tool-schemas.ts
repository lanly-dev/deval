/**
 * The tools the `@deval` agent can call, as dependency-free schemas.
 *
 * This module imports neither `vscode` nor `deepeval`, so the schemas can be
 * shared between the extension host (tool registration in `tools.ts`), the
 * agent loop (`loop.ts`), and the benchmark suites.
 *
 * v1 is deliberately read-only: no tool here can modify the workspace, so the
 * agent needs no confirmation UX. Write and execute tools belong in a v2 behind
 * an explicit user confirmation.
 */

/** A tool the agent loop can offer to the model. */
export interface DevalToolSchema {
	/** Unique tool name, also used for `vscode.lm.registerTool`. */
	name: string;
	/** What the tool does, shown to the model. */
	description: string;
	/** JSON schema for the tool's input. */
	inputSchema: object;
}

export const READ_FILE_TOOL = 'deval_readFile';
export const LIST_FILES_TOOL = 'deval_listFiles';
export const GREP_TOOL = 'deval_grep';

/** Every tool the v1 agent loop offers, in the order they are presented. */
export const DEVAL_TOOL_SCHEMAS: DevalToolSchema[] = [
	{
		name: READ_FILE_TOOL,
		description:
			'Reads the full text contents of a file in the workspace. ' +
			'Use this to inspect code, docs, or configuration before answering.',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Workspace-relative path of the file to read, e.g. "src/extension.ts".',
				},
			},
			required: ['path'],
		},
	},
	{
		name: LIST_FILES_TOOL,
		description:
			'Lists the files and directories directly inside a workspace folder, non-recursive. ' +
			'Use this to discover what exists before reading.',
		inputSchema: {
			type: 'object',
			properties: {
				directory: {
					type: 'string',
					description: 'Workspace-relative directory to list. Defaults to the workspace root.',
				},
			},
			required: [],
		},
	},
	{
		name: GREP_TOOL,
		description:
			'Searches file contents for a text pattern across the workspace and returns matching lines. ' +
			'Use this to find where something is defined or used.',
		inputSchema: {
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description: 'The text or regular expression to search for.',
				},
				directory: {
					type: 'string',
					description: 'Workspace-relative directory to search. Defaults to the workspace root.',
				},
			},
			required: ['pattern'],
		},
	},
];
