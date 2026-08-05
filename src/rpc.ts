import crypto from "node:crypto";
import * as readline from "node:readline";
import util from "node:util";
import yaml from "js-yaml";
import {
	ChromeExecutableNotFoundError,
	resolveChromeExecutablePath,
} from "./browser/index.js";
import { main, type MainLifecycleCallbacks } from "./index.js";
import { normalizeAuthCredentialsForStorage } from "./auth/crypto.js";
import type {
	PlaintextAuthCredentialsInput,
	StoredEncryptedAuthCredentials,
} from "./auth/types.js";
import type { Config } from "./utils.js";

type JsonRpcId = string | number;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

interface RpcCredential {
	username: string;
	password: string;
	domain: string;
}

function writeMessage(
	output: NodeJS.WritableStream,
	message: Record<string, unknown>,
): void {
	output.write(`${JSON.stringify(message)}\n`);
}

function sendError(
	output: NodeJS.WritableStream,
	id: JsonRpcId | null,
	code: number,
	message: string,
	data?: Record<string, unknown>,
): void {
	writeMessage(output, {
		jsonrpc: "2.0",
		id,
		error: { code, message, ...(data ? { data } : {}) },
	});
}

function parseResultData(result: string | null): unknown {
	if (result === null) return null;
	try {
		return yaml.load(result) ?? null;
	} catch {
		return null;
	}
}

function sendNotification(
	output: NodeJS.WritableStream,
	method: string,
	params: Record<string, unknown>,
): void {
	writeMessage(output, {
		jsonrpc: "2.0",
		method,
		params,
	});
}

function redirectConsoleToStderr(
	errorStream: NodeJS.WritableStream,
): () => void {
	const original = {
		log: console.log,
		info: console.info,
		debug: console.debug,
		warn: console.warn,
		error: console.error,
	};
	const write = (...args: unknown[]) => {
		errorStream.write(`${util.format(...args)}\n`);
	};
	console.log = write;
	console.info = write;
	console.debug = write;
	console.warn = write;
	console.error = write;
	return () => {
		console.log = original.log;
		console.info = original.info;
		console.debug = original.debug;
		console.warn = original.warn;
		console.error = original.error;
	};
}

function parseRequest(line: string): JsonRpcRequest {
	const parsed = JSON.parse(line) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid JSON-RPC request.");
	}
	const request = parsed as Record<string, unknown>;
	if (
		request.jsonrpc !== "2.0" ||
		(typeof request.id !== "string" && typeof request.id !== "number") ||
		typeof request.method !== "string"
	) {
		throw new Error("Invalid JSON-RPC request.");
	}
	return request as unknown as JsonRpcRequest;
}

function parseCredential(value: unknown, context: string): RpcCredential {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context} must be an object.`);
	}
	const source = value as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		if (!["username", "password", "domain"].includes(key)) {
			throw new Error(`${context}.${key} is not supported.`);
		}
	}
	const username =
		typeof source.username === "string" ? source.username.trim() : "";
	const domain =
		typeof source.domain === "string" ? source.domain.trim() : "";
	if (!username) throw new Error(`${context}.username must be non-empty.`);
	if (typeof source.password !== "string" || !source.password) {
		throw new Error(`${context}.password must be non-empty.`);
	}
	if (!domain) throw new Error(`${context}.domain must be non-empty.`);
	return { username, password: source.password, domain };
}

function applyRequestCredentials(config: Config, params: unknown): Config {
	if (params === undefined) return config;
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error("browser-agent/run params must be an object.");
	}
	const source = params as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		if (key !== "tasks")
			throw new Error(`browser-agent/run params.${key} is not supported.`);
	}
	if (source.tasks === undefined) return config;
	if (
		!Array.isArray(source.tasks) ||
		source.tasks.length !== config.tasks.length
	) {
		throw new Error(
			"browser-agent/run params.tasks must match the configured task count.",
		);
	}
	const parsed = source.tasks.map((value, taskIndex) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(
				`browser-agent/run params.tasks[${taskIndex}] must be an object.`,
			);
		}
		const task = value as Record<string, unknown>;
		for (const key of Object.keys(task)) {
			if (key !== "credentials") {
				throw new Error(
					`browser-agent/run params.tasks[${taskIndex}].${key} is not supported.`,
				);
			}
		}
		if (task.credentials === undefined) return undefined;
		if (!Array.isArray(task.credentials) || task.credentials.length === 0) {
			throw new Error(
				`browser-agent/run params.tasks[${taskIndex}].credentials must be a non-empty array.`,
			);
		}
		return task.credentials.map((credential, credentialIndex) =>
			parseCredential(
				credential,
				`browser-agent/run params.tasks[${taskIndex}].credentials[${credentialIndex}]`,
			),
		);
	});
	if (!parsed.some(Boolean)) return config;
	const encryptionKey = crypto.randomBytes(32).toString("base64");
	const tasks = config.tasks.map((task, index) => {
		const credentials = parsed[index];
		if (!credentials) return task;
		const plaintext: PlaintextAuthCredentialsInput[] = credentials.map(
			(credential) => ({
				mode: "plaintext",
				domainUrl: credential.domain,
				username: credential.username,
				password: credential.password,
			}),
		);
		return {
			...task,
			authCredentials: normalizeAuthCredentialsForStorage(plaintext, {
				encryptionKey,
			}) as StoredEncryptedAuthCredentials,
			authEncryptionKey: encryptionKey,
		};
	});
	return {
		...config,
		tasks,
		featureFlags: { ...config.featureFlags, authTakeover: true },
	};
}

async function waitForRunRequest(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
): Promise<JsonRpcRequest | null> {
	const rl = readline.createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			if (!line.trim()) continue;
			let request: JsonRpcRequest;
			try {
				request = parseRequest(line);
			} catch (error) {
				if (error instanceof SyntaxError) {
					sendError(output, null, -32700, "Parse error.");
				} else {
					sendError(output, null, -32600, "Invalid request.");
				}
				continue;
			}
			if (request.method !== "browser-agent/run") {
				sendError(output, request.id, -32601, "Method not found.");
				continue;
			}
			return request;
		}
		return null;
	} finally {
		rl.close();
	}
}

export async function runRpcStdio(params: {
	argv: string[];
	configPath: string;
	loadConfig: (configPath: string) => Config;
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	errorStream?: NodeJS.WritableStream;
	mainFn?: typeof main;
	resolveChromePath?: (executablePath?: string) => string;
}): Promise<boolean> {
	const input = params.input ?? process.stdin;
	const output = params.output ?? process.stdout;
	const errorStream = params.errorStream ?? process.stderr;
	const mainFn = params.mainFn ?? main;
	const restoreConsole = redirectConsoleToStderr(errorStream);

	try {
		const request = await waitForRunRequest(input, output);
		if (!request) return false;

		let config: Config;
		try {
			config = params.loadConfig(params.configPath);
		} catch (error) {
			sendError(
				output,
				request.id,
				-32602,
				error instanceof Error ? error.message : String(error),
				{ code: "CONFIG_INVALID" },
			);
			return false;
		}
		if (config.tasks.length === 0) {
			sendError(
				output,
				request.id,
				-32602,
				"RPC mode requires at least one configured task.",
				{ code: "CONFIG_INVALID" },
			);
			return false;
		}
		try {
			config = applyRequestCredentials(config, request.params);
		} catch (error) {
			sendError(
				output,
				request.id,
				-32602,
				error instanceof Error ? error.message : String(error),
				{ code: "CONFIG_INVALID" },
			);
			return false;
		}
		try {
			config = {
				...config,
				executablePath: (
					params.resolveChromePath ?? resolveChromeExecutablePath
				)(config.executablePath),
			};
		} catch (error) {
			const message =
				error instanceof ChromeExecutableNotFoundError
					? error.message
					: "Chrome executable was not found.";
			sendError(output, request.id, -32000, message, {
				code: "CHROME_NOT_FOUND",
			});
			return false;
		}

		writeMessage(output, {
			jsonrpc: "2.0",
			id: request.id,
			result: { accepted: true },
		});

		const lifecycle: MainLifecycleCallbacks = {
			onUserActionRequired: ({ taskId, reason, category }) => {
				sendNotification(output, "browser-agent/status", {
					task_id: taskId,
					status: "user_takeover",
					reason,
					...(category ? { category } : {}),
				});
			},
			onTaskResult: ({ taskId, status, runs, errors }) => {
				sendNotification(output, "browser-agent/task_result", {
					task_id: taskId,
					status,
					runs: runs.map((run) => ({
						run_index: run.runIndex,
						yaml_result: run.result,
						data: parseResultData(run.result),
						completed: run.completed,
						successful: run.successful,
						validator: run.validator,
					})),
					...(errors.length > 0 ? { errors } : {}),
				});
			},
		};

		try {
			await mainFn(params.argv, () => config, undefined, lifecycle);
		} catch (error) {
			sendNotification(output, "browser-agent/error", {
				code: "PROCESS_EXITED",
				message: error instanceof Error ? error.message : String(error),
			});
			return false;
		}

		sendNotification(output, "browser-agent/all_tasks_completed", {});
		return true;
	} finally {
		restoreConsole();
	}
}
