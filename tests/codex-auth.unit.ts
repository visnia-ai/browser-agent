import { EventEmitter } from "node:events";
import type { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import type { spawn } from "node:child_process";
import { assert } from "chai";
import { describe, it } from "mocha";
import {
	checkCodexLogin,
	startCodexAuthBroker,
} from "../src/codex-auth.js";

interface RpcRequest {
	id?: number;
	method: string;
	params?: unknown;
}

class FakeCodexProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly requests: RpcRequest[] = [];
	readonly signals: Array<NodeJS.Signals | number | undefined> = [];
	private input = "";

	constructor(
		private readonly handler: (
			request: RpcRequest,
			respond: (result: unknown) => void,
			notify: (method: string, params: unknown) => void,
		) => void,
	) {
		super();
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				this.input += String(chunk);
				for (;;) {
					const newline = this.input.indexOf("\n");
					if (newline < 0) break;
					const line = this.input.slice(0, newline);
					this.input = this.input.slice(newline + 1);
					const request = JSON.parse(line) as RpcRequest;
					this.requests.push(request);
					this.handler(
						request,
						(result) => {
							this.stdout.write(
								`${JSON.stringify({ id: request.id, result })}\n`,
							);
						},
						(method, params) => {
							this.stdout.write(
								`${JSON.stringify({ method, params })}\n`,
							);
						},
					);
				}
				callback();
			},
		});
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.signals.push(signal);
		queueMicrotask(() => this.emit("exit", 0, signal));
		return true;
	}
}

function createSpawn(
	process: FakeCodexProcess,
	capture?: (command: string, args: readonly string[]) => void,
): typeof spawn {
	return ((command: string, args: readonly string[]) => {
		capture?.(command, args);
		return process;
	}) as unknown as typeof spawn;
}

function createCredentialReader(
	getValue: () => string,
	paths?: string[],
): typeof readFile {
	return (async (path: string) => {
		paths?.push(String(path));
		return getValue();
	}) as unknown as typeof readFile;
}

function initializeResponse() {
	return {
		userAgent:
			"browser-agent/0.144.5 (Ubuntu 22.4.0; x86_64) dumb (browser-agent; 1.0.17)",
		codexHome: "/ignored",
		platformFamily: "unix",
		platformOs: "linux",
	};
}

function chatGptAccount() {
	return {
		account: { type: "chatgpt", email: null, planType: "plus" },
		requiresOpenaiAuth: true,
	};
}

describe("Codex auth broker", () => {
	it("checks an existing ChatGPT login without starting OAuth", async () => {
		const process = new FakeCodexProcess((request, respond) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") respond(chatGptAccount());
			if (request.method === "account/login/start") {
				assert.fail("status checks must not start login");
			}
		});

		const loggedIn = await checkCodexLogin({
			dependencies: {
				spawnProcess: createSpawn(process),
				readCredentialFile: createCredentialReader(() =>
					JSON.stringify({
						tokens: { access_token: "token", account_id: "account" },
					}),
				),
				environment: { CODEX_HOME: "/codex" },
			},
		});

		assert.equal(loggedIn, true);
		assert.notExists(
			process.requests.find(
				(request) => request.method === "account/login/start",
			),
		);
		assert.deepEqual(process.signals, ["SIGTERM"]);
	});

	it("reports a missing ChatGPT login without starting OAuth", async () => {
		let credentialReads = 0;
		const process = new FakeCodexProcess((request, respond) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") {
				respond({ account: null, requiresOpenaiAuth: true });
			}
			if (request.method === "account/login/start") {
				assert.fail("status checks must not start login");
			}
		});

		const loggedIn = await checkCodexLogin({
			dependencies: {
				spawnProcess: createSpawn(process),
				readCredentialFile: createCredentialReader(() => {
					credentialReads += 1;
					return "{}";
				}),
				environment: { CODEX_HOME: "/codex" },
			},
		});

		assert.equal(loggedIn, false);
		assert.equal(credentialReads, 0);
		assert.deepEqual(process.signals, ["SIGTERM"]);
	});

	it("starts app-server with file credentials and reads an existing OAuth login", async () => {
		const launches: Array<{ command: string; args: readonly string[] }> = [];
		const credentialPaths: string[] = [];
		const process = new FakeCodexProcess((request, respond) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") respond(chatGptAccount());
		});
		const broker = await startCodexAuthBroker({
			dependencies: {
				spawnProcess: createSpawn(process, (command, args) =>
					launches.push({ command, args }),
				),
				readCredentialFile: createCredentialReader(
					() =>
						JSON.stringify({
							tokens: {
								access_token: "access-secret",
								account_id: "account-secret",
								refresh_token: "must-not-be-returned",
							},
						}),
					credentialPaths,
				),
				environment: { CODEX_HOME: "/custom/codex-home" },
			},
		});

		assert.deepEqual(launches, [
			{
				command: "codex",
				args: [
					"app-server",
					"-c",
					'cli_auth_credentials_store="file"',
					"--stdio",
				],
			},
		]);
		assert.deepInclude(process.requests[0], {
			method: "initialize",
		});
		assert.deepEqual(process.requests[1], { method: "initialized" });
		assert.deepEqual(process.requests[2], {
			id: 2,
			method: "account/read",
			params: { refreshToken: true },
		});
		assert.deepEqual(credentialPaths, ["/custom/codex-home/auth.json"]);
		assert.equal(broker.cliVersion, "0.144.5");
		assert.deepEqual(await broker.getCredentials(), {
			accessToken: "access-secret",
			accountId: "account-secret",
			version: "0.144.5",
		});

		await broker.close();
		assert.deepEqual(process.signals, ["SIGTERM"]);
	});

	it("defaults the file credential cache to ~/.codex/auth.json", async () => {
		const credentialPaths: string[] = [];
		const process = new FakeCodexProcess((request, respond) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") respond(chatGptAccount());
		});
		const broker = await startCodexAuthBroker({
			dependencies: {
				spawnProcess: createSpawn(process),
				readCredentialFile: createCredentialReader(
					() =>
						JSON.stringify({
							tokens: { access_token: "token", account_id: "account" },
						}),
					credentialPaths,
				),
				homeDirectory: () => "/home/test-user",
				environment: {},
			},
		});

		assert.deepEqual(credentialPaths, [
			"/home/test-user/.codex/auth.json",
		]);
		await broker.close();
	});

	it("prints the browser OAuth URL and handles a completion notification received eagerly", async () => {
		let accountReads = 0;
		const status: string[] = [];
		const process = new FakeCodexProcess((request, respond, notify) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") {
				accountReads++;
				respond(
					accountReads === 1
						? { account: null, requiresOpenaiAuth: true }
						: chatGptAccount(),
				);
			}
			if (request.method === "account/login/start") {
				respond({
					type: "chatgpt",
					loginId: "login-1",
					authUrl: "https://auth.example.test/oauth?state=sensitive-state",
				});
				// Deliberately sent in the same stdin handler, before the broker has
				// installed its waiter, to cover notification buffering.
				notify("account/login/completed", {
					loginId: "login-1",
					success: true,
					error: null,
				});
			}
		});
		const broker = await startCodexAuthBroker({
			writeStatus: (message) => status.push(message),
			dependencies: {
				spawnProcess: createSpawn(process),
				readCredentialFile: createCredentialReader(() =>
					JSON.stringify({
						tokens: { access_token: "token", account_id: "account" },
					}),
				),
				environment: { CODEX_HOME: "/codex" },
			},
		});

		assert.deepEqual(status, [
			"https://auth.example.test/oauth?state=sensitive-state",
		]);
		assert.deepEqual(
			process.requests.find(
				(request) => request.method === "account/login/start",
			),
			{
				id: 3,
				method: "account/login/start",
				params: {
					type: "chatgpt",
					useHostedLoginSuccessPage: true,
					appBrand: "codex",
				},
			},
		);
		assert.equal(accountReads, 2);
		await broker.close();
	});

	it("coalesces concurrent forced refreshes and reloads auth.json", async () => {
		let accountReads = 0;
		let releaseRefresh: (() => void) | undefined;
		let cache = JSON.stringify({
			tokens: { access_token: "old-token", account_id: "account" },
		});
		const process = new FakeCodexProcess((request, respond) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") {
				accountReads++;
				if (accountReads === 1) respond(chatGptAccount());
				else releaseRefresh = () => respond(chatGptAccount());
			}
		});
		const broker = await startCodexAuthBroker({
			dependencies: {
				spawnProcess: createSpawn(process),
				readCredentialFile: createCredentialReader(() => cache),
				environment: { CODEX_HOME: "/codex" },
			},
		});

		cache = JSON.stringify({
			tokens: { access_token: "new-token", account_id: "account" },
		});
		const first = broker.refreshCredentials();
		const second = broker.refreshCredentials();
		assert.strictEqual(first, second);
		assert.equal(accountReads, 2);
		releaseRefresh?.();
		assert.deepEqual(await first, {
			accessToken: "new-token",
			accountId: "account",
			version: "0.144.5",
		});
		assert.equal(accountReads, 2);
		await broker.close();
	});

	it("rejects a non-ChatGPT account after login without leaking server details", async () => {
		let accountReads = 0;
		const process = new FakeCodexProcess((request, respond, notify) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") {
				accountReads++;
				respond({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
			}
			if (request.method === "account/login/start") {
				respond({
					type: "chatgpt",
					loginId: "login",
					authUrl: "https://auth.example.test/?state=oauth-secret",
				});
				notify("account/login/completed", {
					loginId: "login",
					success: true,
					error: "server-secret",
				});
			}
		});

		let message = "";
		try {
			await startCodexAuthBroker({
				writeStatus: () => undefined,
				dependencies: {
					spawnProcess: createSpawn(process),
					readCredentialFile: createCredentialReader(() => "{}"),
					environment: { CODEX_HOME: "/codex" },
				},
			});
			assert.fail("expected broker startup to fail");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		assert.equal(message, "Codex CLI is not signed in with ChatGPT OAuth.");
		assert.notInclude(message, "oauth-secret");
		assert.notInclude(message, "server-secret");
		assert.equal(accountReads, 2);
	});

	it("rejects malformed credential files without exposing their contents", async () => {
		const process = new FakeCodexProcess((request, respond) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") respond(chatGptAccount());
		});
		const cacheSecret = "cache-secret-value";
		let message = "";
		try {
			await startCodexAuthBroker({
				dependencies: {
					spawnProcess: createSpawn(process),
					readCredentialFile: createCredentialReader(() =>
						JSON.stringify({ tokens: { access_token: cacheSecret } }),
					),
					environment: { CODEX_HOME: "/codex" },
				},
			});
			assert.fail("expected broker startup to fail");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		assert.equal(message, "Codex OAuth credential cache is invalid.");
		assert.notInclude(message, cacheSecret);
	});

	it("reports a missing Codex executable with an actionable sanitized error", async () => {
		const process = new FakeCodexProcess(() => undefined);
		const spawnMissing = (() => {
			queueMicrotask(() => {
				const error = Object.assign(new Error("spawn codex ENOENT"), {
					code: "ENOENT",
				});
				process.emit("error", error);
			});
			return process;
		}) as unknown as typeof spawn;

		let message = "";
		try {
			await startCodexAuthBroker({
				dependencies: {
					spawnProcess: spawnMissing,
					readCredentialFile: createCredentialReader(() => "{}"),
					environment: { CODEX_HOME: "/codex" },
				},
			});
			assert.fail("expected broker startup to fail");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		assert.equal(
			message,
			"Codex CLI is required but was not found on PATH. Install Codex CLI and try again.",
		);
	});

	it("does not include OAuth callback failures in thrown errors", async () => {
		const process = new FakeCodexProcess((request, respond, notify) => {
			if (request.method === "initialize") respond(initializeResponse());
			if (request.method === "account/read") {
				respond({ account: null, requiresOpenaiAuth: true });
			}
			if (request.method === "account/login/start") {
				respond({
					type: "chatgpt",
					loginId: "login",
					authUrl: "https://auth.example.test/?state=oauth-secret",
				});
				notify("account/login/completed", {
					loginId: "login",
					success: false,
					error: "failure-secret",
				});
			}
		});

		let message = "";
		try {
			await startCodexAuthBroker({
				writeStatus: () => undefined,
				dependencies: {
					spawnProcess: createSpawn(process),
					readCredentialFile: createCredentialReader(() => "{}"),
					environment: { CODEX_HOME: "/codex" },
				},
			});
			assert.fail("expected broker startup to fail");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		assert.equal(
			message,
			"Codex ChatGPT sign-in did not complete successfully.",
		);
		assert.notInclude(message, "oauth-secret");
		assert.notInclude(message, "failure-secret");
	});
});
