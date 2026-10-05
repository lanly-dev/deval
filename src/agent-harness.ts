/**
 * The system under test.
 *
 * This module is deliberately dependency-free: it imports neither `vscode` nor
 * `deepeval`, so the same harness can be loaded inside the extension host and
 * inside a Vitest process started by `npx deepeval test run`.
 *
 * Replace `todoAppAgent` with your own implementation to evaluate a real agent.
 * Everything else (the benchmark suites, the metrics, the hook pipeline) stays
 * the same, because the suites only depend on the `AgentRun` shape below.
 */

/** A tool invocation an agent made while producing its artifact. */
export interface AgentToolCall {
	name: string;
	inputParameters?: Record<string, unknown>;
	output?: unknown;
}

/** One completed agent run, in the shape the benchmark suites consume. */
export interface AgentRun {
	/** The prompt the agent was asked to satisfy. */
	input: string;
	/** The artifact the agent produced, as text. */
	output: string;
	/** The tools the agent used to get there, in call order. */
	toolsCalled: AgentToolCall[];
}

/** A swappable agent implementation. */
export interface AgentHarness {
	readonly name: string;
	run(input: string): Promise<AgentRun>;
}

export const TODO_AGENT_NAME = 'todo-app-agent';

/** Escape a prompt so it can be embedded in markup without breaking it. */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** The tools every `todo-app-agent` run is expected to call, in order. */
export function expectedTodoTools(): AgentToolCall[] {
	return [
		{ name: 'create_file', inputParameters: { path: 'index.html' } },
		{ name: 'read_file', inputParameters: { path: 'index.html' } },
	];
}

/**
 * Produce the single-file todo app the reference agent emits.
 *
 * The output is deterministic for a given prompt, except for the prompt marker
 * echoed into `data-prompt`, which keeps runs input-dependent on purpose.
 */
export function createTodoArtifact(prompt: string): AgentRun {
	const output = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Todo</title>
</head>
<body data-prompt="${escapeHtml(prompt)}">
<h1>Todo</h1>
<form id="todo-form">
<input id="todo-input" type="text" placeholder="What needs doing?" required />
<button type="submit">Add task</button>
</form>
<ul id="todo-list"></ul>
<script>
const STORAGE_KEY = 'deval.todos';
let tasks = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');

function save() {
localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function render() {
const list = document.getElementById('todo-list');
list.replaceChildren();
for (const task of tasks) {
const item = document.createElement('li');
item.className = task.done ? 'done' : '';
const label = document.createElement('label');
const toggle = document.createElement('input');
toggle.type = 'checkbox';
toggle.checked = task.done;
toggle.addEventListener('change', () => completeTask(task.id));
label.append(toggle, task.title);
const remove = document.createElement('button');
remove.type = 'button';
remove.textContent = 'Delete';
remove.addEventListener('click', () => removeTask(task.id));
item.append(label, remove);
list.append(item);
}
}

function addTask(title) {
tasks.push({ id: crypto.randomUUID(), title, done: false });
save();
render();
}

function completeTask(id) {
const task = tasks.find((candidate) => candidate.id === id);
if (!task) return;
task.done = !task.done;
save();
render();
}

function removeTask(id) {
tasks = tasks.filter((task) => task.id !== id);
save();
render();
}

document.getElementById('todo-form').addEventListener('submit', (event) => {
event.preventDefault();
const input = document.getElementById('todo-input');
if (!input.value.trim()) return;
addTask(input.value.trim());
input.value = '';
});

render();
</script>
</body>
</html>
`;

	return {
		input: prompt,
		output,
		toolsCalled: expectedTodoTools(),
	};
}

/** The reference agent. Swap this out to evaluate your own implementation. */
export const todoAppAgent: AgentHarness = {
	name: TODO_AGENT_NAME,
	async run(input: string): Promise<AgentRun> {
		return createTodoArtifact(input);
	},
};

/** The harness used when a caller does not name one. */
export const defaultHarness: AgentHarness = todoAppAgent;

/** Run the harness under evaluation and return its artifact. */
export async function runAgent(input: string, harness: AgentHarness = defaultHarness): Promise<AgentRun> {
	return harness.run(input);
}
