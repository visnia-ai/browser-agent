import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { BrowserAgentError, redact } from "./errors.js";
import type {
	BrowserAgentCustomTool,
	BrowserAgentLogEntry,
	BrowserAgentTask,
} from "./types.js";

export type RpcMessage = {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: unknown; message?: unknown; data?: { code?: unknown } };
};
export type AgentProcess = {
	child: ChildProcessWithoutNullStreams;
	messages: AsyncIterable<RpcMessage>;
	logs: AsyncIterable<string>;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};
async function* lines(stream: NodeJS.ReadableStream) {
	const reader = readline.createInterface({
		input: stream,
		crlfDelay: Infinity,
	});
	try {
		for await (const line of reader) yield line;
	} finally {
		reader.close();
	}
}

async function* messages(stream: NodeJS.ReadableStream) {
	for await (const line of lines(stream)) {
		if (!line.trim()) continue;
		let value: RpcMessage;
		try {
			value = JSON.parse(line) as RpcMessage;
		} catch {
			throw new BrowserAgentError(
				"PROTOCOL_ERROR",
				"CLI emitted malformed JSON-RPC.",
			);
		}
		if (!value || typeof value !== "object" || value.jsonrpc !== "2.0")
			throw new BrowserAgentError(
				"PROTOCOL_ERROR",
				"CLI emitted an invalid JSON-RPC message.",
			);
		yield value;
	}
}
export function startAgentProcess(
	executable: string,
	configPath: string,
	environment: NodeJS.ProcessEnv,
): AgentProcess {
	const child = spawn(executable, [configPath, "--rpc"], {
		env: environment,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exit = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		child.once("error", (cause) =>
			reject(
				new BrowserAgentError(
					"PROCESS_START_FAILED",
					"browser-agent process could not be started.",
					{ cause },
				),
			),
		);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	return {
		child,
		messages: messages(child.stdout),
		logs: lines(child.stderr),
		exit,
	};
}
export function requestRun(
	process: AgentProcess,
	tasks: readonly BrowserAgentTask[] = [],
	customTools: readonly BrowserAgentCustomTool[] = [],
): void {
	const rpcTasks = tasks.map((task) =>
		task.credentials ? { credentials: task.credentials } : {},
	);
	const params = {
		...(rpcTasks.some((task) => "credentials" in task)
			? { tasks: rpcTasks }
			: {}),
		...(customTools.length ? { custom_tools: customTools } : {}),
	};
	process.child.stdin.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "browser-agent/run",
			params,
		})}\n`,
	);
}
export async function terminateProcess(
	process: AgentProcess,
	graceMs = 5_000,
): Promise<void> {
	if (process.child.exitCode !== null || process.child.signalCode !== null)
		return;
	process.child.kill("SIGTERM");
	const exited = await Promise.race([
		process.exit.then(
			() => true,
			() => true,
		),
		new Promise<false>((resolve) =>
			setTimeout(() => resolve(false), graceMs),
		),
	]);
	if (!exited && process.child.exitCode === null) {
		process.child.kill("SIGKILL");
		await process.exit.catch(() => undefined);
	}
}
export async function consumeLogs(
	process: AgentProcess,
	runId: string,
	callback: ((entry: BrowserAgentLogEntry) => void) | undefined,
	secrets: string[],
	paths: string[],
): Promise<void> {
	for await (const line of process.logs) {
		try {
			callback?.({
				runId,
				message: redact(line, secrets, paths),
				timestamp: new Date(),
				source: "stderr",
			});
		} catch {}
	}
}
