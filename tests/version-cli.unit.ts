import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { CLI_HELP, runCli } from "../src/cli.js";
import { decryptAuthField } from "../src/auth/crypto.js";
import { BROWSER_AGENT_VERSION, RPC_PROTOCOL_VERSION } from "../src/version.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";

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
