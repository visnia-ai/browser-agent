import assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
	CLI_HELP,
	ensureCodexLoginForCli,
	prepareCodexProviderForCli,
	runCli,
} from "../src/cli.js";
import { decryptAuthField } from "../src/auth/crypto.js";
import { BROWSER_AGENT_VERSION, RPC_PROTOCOL_VERSION } from "../src/version.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";
import type { Config } from "../src/utils.js";

async function captureStdout(action: () => Promise<void>): Promise<string> {
	const original = process.stdout.write;
	let output = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await action();
	} finally {
		process.stdout.write = original;
	}
	return output;
}

describe("CLI informational options", () => {
	it("runs the standalone Codex login command without a config", async () => {
		let calls = 0;
		await runCli(["node", "browser-agent", "codex-login"], {
			ensureCodexLogin: async () => {
				calls += 1;
			},
		});
		assert.equal(calls, 1);
	});

	it("prints machine-readable Codex login status without interactive login", async () => {
		let interactiveCalls = 0;
		const output = await captureStdout(() =>
			runCli(["node", "browser-agent", "codex-login", "--check"], {
				ensureCodexLogin: async () => {
					interactiveCalls += 1;
				},
				checkCodexLogin: async () => false,
			}),
		);

		assert.deepEqual(JSON.parse(output), { loggedIn: false });
		assert.equal(interactiveCalls, 0);
	});

	it("prints machine-readable versions without starting the agent", async () => {
		const output = await captureStdout(() =>
			runCli(["node", "browser-agent", "--version-json"]),
		);
		assert.deepEqual(JSON.parse(output), {
			version: BROWSER_AGENT_VERSION,
			rpcProtocolVersion: RPC_PROTOCOL_VERSION,
		});
	});

	it("prints help without loading a config", async () => {
		const output = await captureStdout(() =>
			runCli(["node", "browser-agent", "--help"]),
		);
		assert.equal(output, CLI_HELP);
	});

	it("prints the standard plain-text version", async () => {
		const output = await captureStdout(() =>
			runCli(["node", "browser-agent", "--version"]),
		);
		assert.equal(output, `${BROWSER_AGENT_VERSION}\n`);
	});

	it("encrypts one auth field without loading a config", async () => {
		await withAuthEncryptionKey(async () => {
			const plaintext = "value-to-encrypt";
			const output = await captureStdout(() =>
				runCli(["node", "browser-agent", "encrypt", plaintext]),
			);
			const ciphertext = output.trim();
			assert.match(ciphertext, /^bauth-v1:/);
			assert.equal(decryptAuthField(ciphertext), plaintext);
			assert.doesNotMatch(ciphertext, new RegExp(plaintext));
		});
	});

	it("generates an auth encryption key without loading a config", async () => {
		const output = await captureStdout(() =>
			runCli(["node", "browser-agent", "generate-key"]),
		);
		assert.equal(Buffer.from(output.trim(), "base64").length, 32);
	});

	it("requires an explicit config for execution", async () => {
		await assert.rejects(
			runCli(["node", "browser-agent"]),
			/Missing config path/,
		);
	});
});

function providerConfig(provider: "openai" | "codex"): Config {
	const options = {
		provider,
		model: "gpt-5.6-luna",
		reasoningEffort: "low" as const,
	};
	return {
		stageLLMs: {
			findTargetURL: options,
			createChecklist: options,
			runAgent: options,
			dataExtraction: options,
			verifySuccess: options,
		},
	} as Config;
}

describe("CLI Codex authentication preflight", () => {
	it("ensures login and closes the standalone broker", async () => {
		const status: string[] = [];
		let closed = 0;
		await ensureCodexLoginForCli({
			startAuthBroker: async ({ writeStatus }) => {
				writeStatus?.("https://auth.example.test/login");
				return {
					cliVersion: "0.144.5",
					async getCredentials() {
						return {
							accessToken: "access-token",
							accountId: "account-id",
							version: "0.144.5",
						};
					},
					async refreshCredentials() {
						return await this.getCredentials();
					},
					async close() {
						closed += 1;
					},
				};
			},
			writeStatus: (message) => status.push(message),
		});

		assert.equal(closed, 1);
		assert.equal(status.length, 1);
		assert.match(status[0]!, /Open this URL/);
		assert.match(status[0]!, /https:\/\/auth\.example\.test\/login/);
	});

	it("does nothing when no stage uses Codex", async () => {
		let started = false;
		const cleanup = await prepareCodexProviderForCli(providerConfig("openai"), {
			startAuthBroker: async () => {
				started = true;
				throw new Error("should not start");
			},
		});

		assert.equal(cleanup, undefined);
		assert.equal(started, false);
	});

	it("installs the broker, reports the login URL, and cleans up once", async () => {
		const installed: unknown[] = [];
		const status: string[] = [];
		let closed = 0;
		const broker = {
			cliVersion: "0.144.5",
			async getCredentials() {
				return {
					accessToken: "access-token",
					accountId: "account-id",
					version: "0.144.5",
				};
			},
			async refreshCredentials() {
				return await this.getCredentials();
			},
			async close() {
				closed += 1;
			},
		};
		const cleanup = await prepareCodexProviderForCli(providerConfig("codex"), {
			startAuthBroker: async ({ writeStatus }) => {
				writeStatus?.("https://auth.example.test/login");
				return broker;
			},
			setProviderRuntime: (runtime) => installed.push(runtime),
			writeStatus: (message) => status.push(message),
		});

		assert.equal(installed[0], broker);
		assert.match(status[0]!, /Open this URL/);
		assert.match(status[0]!, /https:\/\/auth\.example\.test\/login/);
		await cleanup?.();
		await cleanup?.();
		assert.equal(installed.at(-1), null);
		assert.equal(closed, 1);
	});

	it("closes the broker if provider runtime installation fails", async () => {
		let closed = 0;
		const broker = {
			cliVersion: "0.144.5",
			async getCredentials() {
				return {
					accessToken: "access-token",
					accountId: "account-id",
					version: "0.144.5",
				};
			},
			async refreshCredentials() {
				return await this.getCredentials();
			},
			async close() {
				closed += 1;
			},
		};

		await assert.rejects(
			prepareCodexProviderForCli(providerConfig("codex"), {
				startAuthBroker: async () => broker,
				setProviderRuntime: () => {
					throw new Error("runtime installation failed");
				},
			}),
			/runtime installation failed/,
		);
		assert.equal(closed, 1);
	});
});
