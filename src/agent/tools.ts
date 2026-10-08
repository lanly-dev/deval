/**
 * The `@deval` agent's tools, implemented for the extension host.
 *
 * Schemas live in the dependency-free `tool-schemas.ts`; this module registers
 * them with `vscode.lm` and implements their bodies. v1 is read-only on
 * purpose: no tool here can modify the workspace, so the agent needs no
 * confirmation UX.
 */

import * as vscode from 'vscode';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import {
	DEVAL_TOOL_SCHEMAS,
	GREP_TOOL,
	LIST_FILES_TOOL,
	READ_FILE_TOOL,
} from './tool-schemas';

/** Largest file the read tool returns before truncating. */
const MAX_FILE_BYTES = 100_000;

/** Most grep matches returned for one call. */
const MAX_GREP_MATCHES = 50;

/** Directories the grep tool never descends into. */
const GREP_IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test', '.deval']);

function workspaceRoot(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('Open a workspace folder to use the deval agent tools.');
	}
	return folder.uri.fsPath;
}

/**
 * Resolve a workspace-relative path, refusing anything that escapes the
 * workspace. The model is not trusted with absolute paths or `..`.
 */
function resolveInWorkspace(root: string, relativePath: string): string {
	const absolute = resolve(root, relativePath);
	if (absolute !== root && !absolute.startsWith(root + sep)) {
		throw new Error(`Path escapes the workspace: ${relativePath}`);
	}
	return absolute;
}

function asStringRecord(input: unknown): Record<string, string> {
	if (typeof input !== 'object' || input === null) {
		return {};
	}
	const record: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === 'string') {
			record[key] = value;
		}
	}
	return record;
}

async function readFileTool(input: unknown): Promise<string> {
	const { path } = asStringRecord(input);
	if (!path) {
		throw new Error('readFile needs a "path".');
	}
	const absolute = resolveInWorkspace(workspaceRoot(), path);
	const content = await readFile(absolute, 'utf8');
	return content.length > MAX_FILE_BYTES
		? `${content.slice(0, MAX_FILE_BYTES)}\n…[truncated after ${MAX_FILE_BYTES} bytes]`
		: content;
}

async function listFilesTool(input: unknown): Promise<string> {
	const { directory } = asStringRecord(input);
	const absolute = resolveInWorkspace(workspaceRoot(), directory || '.');
	const entries = await readdir(absolute, { withFileTypes: true });
	if (!entries.length) {
		return '(empty)';
	}
	return entries.map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`).join('\n');
}

async function grepTool(input: unknown): Promise<string> {
	const { pattern, directory } = asStringRecord(input);
	if (!pattern) {
		throw new Error('grep needs a "pattern".');
	}
	const root = workspaceRoot();
	const start = resolveInWorkspace(root, directory || '.');
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, 'm');
	} catch {
		throw new Error(`Invalid regular expression: ${pattern}`);
	}

	const matches: string[] = [];
	async function walk(dir: string): Promise<void> {
		if (matches.length >= MAX_GREP_MATCHES) {
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (matches.length >= MAX_GREP_MATCHES) {
				return;
			}
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!GREP_IGNORED_DIRS.has(entry.name)) {
					await walk(full);
				}
			} else if (entry.isFile()) {
				let content: string;
				try {
					content = await readFile(full, 'utf8');
				} catch {
					continue;
				}
				if (content.includes('\0')) {
					continue;
				}
				content.split('\n').forEach((line, index) => {
					if (matches.length < MAX_GREP_MATCHES && regex.test(line)) {
						matches.push(`${relative(root, full)}:${index + 1}: ${line.trim().slice(0, 200)}`);
					}
				});
			}
		}
	}
	await walk(start);
	return matches.length ? matches.join('\n') : '(no matches)';
}

function toolResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Register the deval tools with `vscode.lm`.
 *
 * Each tool must also be declared in the `languageModelTools` contribution
 * point in `package.json`; registration here provides the implementation.
 */
export function registerDevalTools(): vscode.Disposable {
	const implementations: Record<string, (input: unknown) => Promise<string>> = {
		[READ_FILE_TOOL]: readFileTool,
		[LIST_FILES_TOOL]: listFilesTool,
		[GREP_TOOL]: grepTool,
	};

	const disposables = DEVAL_TOOL_SCHEMAS.map((schema) =>
		vscode.lm.registerTool(schema.name, {
			prepareInvocation: (options) => ({
				invocationMessage: `deval: ${schema.name}`,
			}),
			invoke: async (options) => toolResult(await implementations[schema.name](options.input)),
		}),
	);
	return vscode.Disposable.from(...disposables);
}
