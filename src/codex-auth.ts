import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BROWSER_AGENT_VERSION } from "./version.js";

export interface CodexCredentials {
	accessToken: string;
	accountId: string;
	version: string;
}

export interface CodexAuthBroker {
	readonly cliVersion: string;
	getCredentials(): Promise<CodexCredentials>;
	refreshCredentials(): Promise<CodexCredentials>;
	close(): Promise<void>;
}

interface CodexAuthBrokerDependencies {
	spawnProcess: typeof spawn;
	readCredentialFile: typeof readFile;
	homeDirectory: typeof homedir;
	environment: NodeJS.ProcessEnv;
}

export interface StartCodexAuthBrokerOptions {
	writeStatus?: (message: string) => void;
	/** Dependency overrides are intended for isolated tests. */
	dependencies?: Partial<CodexAuthBrokerDependencies>;
}

export interface CheckCodexLoginOptions {
	/** Dependency overrides are intended for isolated tests. */
	dependencies?: Partial<CodexAuthBrokerDependencies>;
}

interface JsonRpcResponse {
	id: string | number;
	result?: unknown;
	error?: unknown;
}

interface JsonRpcNotification {
	method: string;
	params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

interface PendingRequest {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

interface NotificationWaiter {
	predicate: (params: unknown) => boolean;
	resolve: (params: unknown) => void;
	reject: (error: Error) => void;
}

class CodexAppServerConnection {
	private readonly process: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly queuedNotifications = new Map<string, unknown[]>();
	private readonly notificationWaiters = new Map<
		string,
		NotificationWaiter[]
	>();
	private nextId = 1;
	private stdoutBuffer = "";
	private failure: Error | undefined;
	private exited = false;
	private closing = false;
	private readonly exitedPromise: Promise<void>;
	private resolveExited!: () => void;

	constructor(
		spawnProcess: typeof spawn,
		environment: NodeJS.ProcessEnv,
	) {
		this.exitedPromise = new Promise((resolve) => {
			this.resolveExited = resolve;
		});

		try {
			this.process = spawnProcess(
				"codex",
				[
					"app-server",
					"-c",
					'cli_auth_credentials_store="file"',
					"--stdio",
				],
				{
					stdio: ["pipe", "pipe", "pipe"],
					env: environment,
				},
			);
		} catch {
			throw new Error("Could not start the Codex CLI.");
		}

		this.process.stdout.setEncoding("utf8");
		this.process.stdout.on("data", (chunk: string) => {
			this.receive(chunk);
		});
		// Codex diagnostics are intentionally discarded: they are not needed by
		// callers and may contain local or account-specific information.
		this.process.stderr.on("data", () => undefined);
		this.process.stdin.on("error", () => {
			this.fail(new Error("Lost the connection to the Codex CLI."));
		});
		this.process.once("error", (error: NodeJS.ErrnoException) => {
			this.fail(
				error.code === "ENOENT"
					? new Error(
							"Codex CLI is required but was not found on PATH. Install Codex CLI and try again.",
						)
					: new Error("Could not start the Codex CLI."),
			);
		});
		const handleExit = () => {
			if (this.exited) return;
			this.exited = true;
			this.resolveExited();
			if (!this.closing) {
				this.fail(new Error("Codex CLI exited unexpectedly."));
			}
		};
		this.process.once("exit", handleExit);
		this.process.once("close", handleExit);
	}

	request(method: string, params: unknown): Promise<unknown> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
			this.write({ id, method, params });
		});
	}

	notify(method: string): void {
		if (this.failure) {
			throw this.failure;
		}
		this.write({ method });
	}

	waitForNotification(
		method: string,
		predicate: (params: unknown) => boolean,
	): Promise<unknown> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}

		const queued = this.queuedNotifications.get(method) ?? [];
		const index = queued.findIndex(predicate);
		if (index >= 0) {
			const [params] = queued.splice(index, 1);
			return Promise.resolve(params);
		}

		return new Promise((resolve, reject) => {
			const waiters = this.notificationWaiters.get(method) ?? [];
			waiters.push({ predicate, resolve, reject });
			this.notificationWaiters.set(method, waiters);
		});
	}

	async close(): Promise<void> {
		if (this.closing) {
			await this.exitedPromise;
			return;
		}
		this.closing = true;
		this.fail(new Error("Codex authentication was closed."));
		if (this.exited) return;

		try {
			this.process.stdin.end();
		} catch {
			// The process may already have closed its input after a startup error.
		}
		try {
			this.process.kill("SIGTERM");
		} catch {
			// The process may already have exited between the checks above.
		}
		let timedOut = false;
		await Promise.race([
			this.exitedPromise,
			new Promise<void>((resolve) => {
				setTimeout(() => {
					timedOut = true;
					resolve();
				}, 1_000).unref();
			}),
		]);
		if (timedOut && !this.exited) {
			try {
				this.process.kill("SIGKILL");
			} catch {
				// There is nothing left to terminate.
			}
		}
	}

	private write(message: Record<string, unknown>): void {
		try {
			this.process.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {
			this.fail(new Error("Could not communicate with the Codex CLI."));
		}
	}

	private receive(chunk: string): void {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			try {
				const message = JSON.parse(line) as JsonRpcMessage;
				this.handleMessage(message);
			} catch {
				this.fail(new Error("Codex CLI returned an invalid response."));
			}
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		if ("id" in message) {
			const id = typeof message.id === "number" ? message.id : Number.NaN;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (message.error !== undefined) {
				pending.reject(
					new Error(`Codex CLI could not complete ${pending.method}.`),
				);
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (typeof message.method !== "string") return;
		const waiters = this.notificationWaiters.get(message.method) ?? [];
		const index = waiters.findIndex((waiter) =>
			waiter.predicate(message.params),
		);
		if (index >= 0) {
			const [waiter] = waiters.splice(index, 1);
			waiter.resolve(message.params);
			return;
		}
		// Only the login completion can legitimately arrive before its waiter is
		// registered. Discard all other app-server notifications so account or
		// machine metadata is never retained by this authentication bridge.
		if (message.method !== "account/login/completed") return;
		const queued = this.queuedNotifications.get(message.method) ?? [];
		queued.push(message.params);
		this.queuedNotifications.set(message.method, queued);
	}

	private fail(error: Error): void {
		if (!this.failure) this.failure = error;
		for (const pending of this.pending.values()) pending.reject(this.failure);
		this.pending.clear();
		for (const waiters of this.notificationWaiters.values()) {
			for (const waiter of waiters) waiter.reject(this.failure);
		}
		this.notificationWaiters.clear();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isChatGptAccountResponse(value: unknown): boolean {
	return (
		isRecord(value) &&
		isRecord(value.account) &&
		value.account.type === "chatgpt"
	);
}

function parseCliVersion(initializeResult: unknown): string {
	if (!isRecord(initializeResult) || typeof initializeResult.userAgent !== "string") {
		throw new Error("Codex CLI returned an invalid initialization response.");
	}
	const version = initializeResult.userAgent.match(/^[^/\s]+\/([^\s]+)/)?.[1];
	if (!version) {
		throw new Error("Could not determine the Codex CLI version.");
	}
	return version;
}

function validateAuthUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") throw new Error("unsupported protocol");
		return url.toString();
	} catch {
		throw new Error("Codex CLI returned an invalid ChatGPT sign-in URL.");
	}
}

async function readCredentials(
	readCredentialFile: typeof readFile,
	authPath: string,
	version: string,
): Promise<CodexCredentials> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readCredentialFile(authPath, "utf8"));
	} catch {
		throw new Error(
			"Could not read Codex OAuth credentials. Sign in with Codex CLI and try again.",
		);
	}

	if (!isRecord(parsed) || !isRecord(parsed.tokens)) {
		throw new Error("Codex OAuth credential cache is invalid.");
	}
	const accessToken = parsed.tokens.access_token;
	const accountId = parsed.tokens.account_id;
	if (
		typeof accessToken !== "string" ||
		accessToken.length === 0 ||
		typeof accountId !== "string" ||
		accountId.length === 0
	) {
		throw new Error("Codex OAuth credential cache is invalid.");
	}
	return { accessToken, accountId, version };
}

function resolveDependencies(
	dependencies: Partial<CodexAuthBrokerDependencies> | undefined,
): CodexAuthBrokerDependencies {
	return {
		spawnProcess: dependencies?.spawnProcess ?? spawn,
		readCredentialFile: dependencies?.readCredentialFile ?? readFile,
		homeDirectory: dependencies?.homeDirectory ?? homedir,
		environment: dependencies?.environment ?? process.env,
	};
}

async function initializeConnection(
	dependencies: CodexAuthBrokerDependencies,
): Promise<{ connection: CodexAppServerConnection; cliVersion: string }> {
	const connection = new CodexAppServerConnection(
		dependencies.spawnProcess,
		dependencies.environment,
	);
	try {
		const initializeResult = await connection.request("initialize", {
			clientInfo: {
				name: "browser-agent",
				title: "Browser Agent",
				version: BROWSER_AGENT_VERSION,
			},
		});
		const cliVersion = parseCliVersion(initializeResult);
		connection.notify("initialized");
		return { connection, cliVersion };
	} catch (error) {
		await connection.close();
		throw error;
	}
}

/**
 * Reports whether Codex has a reusable ChatGPT OAuth session without starting
 * an interactive login flow.
 */
export async function checkCodexLogin(
	options: CheckCodexLoginOptions = {},
): Promise<boolean> {
	const dependencies = resolveDependencies(options.dependencies);
	const codexHome =
		dependencies.environment.CODEX_HOME?.trim() ||
		join(dependencies.homeDirectory(), ".codex");
	const authPath = join(codexHome, "auth.json");
	const { connection, cliVersion } = await initializeConnection(dependencies);
	try {
		const account = await connection.request("account/read", {
			refreshToken: true,
		});
		if (!isChatGptAccountResponse(account)) return false;
		await readCredentials(
			dependencies.readCredentialFile,
			authPath,
			cliVersion,
		);
		return true;
	} finally {
		await connection.close();
	}
}

/**
 * Starts Codex app-server, ensures a ChatGPT OAuth session exists, and exposes
 * the file-backed credentials needed by the Codex Responses transport.
 */
export async function startCodexAuthBroker(
	options: StartCodexAuthBrokerOptions = {},
): Promise<CodexAuthBroker> {
	const dependencies = resolveDependencies(options.dependencies);
	const codexHome =
		dependencies.environment.CODEX_HOME?.trim() ||
		join(dependencies.homeDirectory(), ".codex");
	const authPath = join(codexHome, "auth.json");
	const { connection, cliVersion } = await initializeConnection(dependencies);

	try {
		let account = await connection.request("account/read", {
			refreshToken: true,
		});
		if (!isChatGptAccountResponse(account)) {
			const login = await connection.request("account/login/start", {
				type: "chatgpt",
				useHostedLoginSuccessPage: true,
				appBrand: "codex",
			});
			if (
				!isRecord(login) ||
				login.type !== "chatgpt" ||
				typeof login.loginId !== "string" ||
				typeof login.authUrl !== "string"
			) {
				throw new Error("Codex CLI could not start ChatGPT sign-in.");
			}
			const authUrl = validateAuthUrl(login.authUrl);
			try {
				options.writeStatus?.(authUrl);
			} catch {
				throw new Error("Could not display the Codex sign-in URL.");
			}
			const completed = await connection.waitForNotification(
				"account/login/completed",
				(params) => isRecord(params) && params.loginId === login.loginId,
			);
			if (!isRecord(completed) || completed.success !== true) {
				throw new Error("Codex ChatGPT sign-in did not complete successfully.");
			}
			account = await connection.request("account/read", {
				refreshToken: true,
			});
			if (!isChatGptAccountResponse(account)) {
				throw new Error("Codex CLI is not signed in with ChatGPT OAuth.");
			}
		}

		let credentials = await readCredentials(
			dependencies.readCredentialFile,
			authPath,
			cliVersion,
		);
		let refreshInFlight: Promise<CodexCredentials> | undefined;

		return {
			cliVersion,
			async getCredentials() {
				return { ...credentials };
			},
			refreshCredentials() {
				if (!refreshInFlight) {
					refreshInFlight = (async () => {
						const refreshedAccount = await connection.request(
							"account/read",
							{ refreshToken: true },
						);
						if (!isChatGptAccountResponse(refreshedAccount)) {
							throw new Error(
								"Codex CLI is not signed in with ChatGPT OAuth.",
							);
						}
						credentials = await readCredentials(
							dependencies.readCredentialFile,
							authPath,
							cliVersion,
						);
						return { ...credentials };
					})().finally(() => {
						refreshInFlight = undefined;
					});
				}
				return refreshInFlight;
			},
			close: () => connection.close(),
		};
	} catch (error) {
		await connection.close();
		throw error;
	}
}
