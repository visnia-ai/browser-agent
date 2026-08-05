#!/usr/bin/env node

import "dotenv/config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./index.js";
import { runRpcStdio } from "./rpc.js";
import { resolveConfigFromEnv } from "./runtime/llm-env.js";
import { loadConfig, parseArgs } from "./utils.js";
import { BROWSER_AGENT_VERSION, RPC_PROTOCOL_VERSION } from "./version.js";
import {
	encryptAuthField,
	generateAuthEncryptionKey,
} from "./auth/crypto.js";

export const CLI_HELP = `Usage:
  browser-agent <config.yaml> [--rpc]
  browser-agent generate-key
  browser-agent encrypt "<value>"
  browser-agent --help
  browser-agent --version

Arguments:
  <config.yaml>         YAML configuration path (relative to the current directory)

Commands:
  generate-key          Generate a base64-encoded 32-byte auth encryption key
  encrypt <value>       Encrypt one credential field using BROWSER_AGENT_AUTH_ENCRYPTION_KEY

Options:
  --rpc                 Run the JSON-RPC server over stdio
  -h, --help            Show this help
  -V, --version         Show the browser-agent version
  --version-json        Show version and RPC protocol metadata as JSON
`;

export async function runCli(argv: string[] = process.argv): Promise<void> {
	const args = parseArgs(argv);
	if (args.generateKey) {
		process.stdout.write(`${generateAuthEncryptionKey()}\n`);
		return;
	}
	if (args.encryptValue !== undefined) {
		process.stdout.write(`${encryptAuthField(args.encryptValue)}\n`);
		return;
	}
	if (args.help) {
		process.stdout.write(CLI_HELP);
		return;
	}
	if (args.version) {
		process.stdout.write(`${BROWSER_AGENT_VERSION}\n`);
		return;
	}
	if (args.versionJson) {
		process.stdout.write(
			`${JSON.stringify({
				version: BROWSER_AGENT_VERSION,
				rpcProtocolVersion: RPC_PROTOCOL_VERSION,
			})}\n`,
		);
		return;
	}
	if (!args.config) {
		throw new Error(
			"Missing config path. Run 'browser-agent --help' for usage.",
		);
	}
	const loadResolvedConfig = (configPath: string) =>
		resolveConfigFromEnv(loadConfig(configPath));

	if (!args.rpc) {
		await main(argv, loadResolvedConfig);
		return;
	}

	const succeeded = await runRpcStdio({
		argv,
		configPath: args.config,
		loadConfig: loadResolvedConfig,
	});
	if (!succeeded) {
		process.exitCode = 1;
	}
}

function isExecutedDirectly(): boolean {
	const entryArg = process.argv[1];
	if (!entryArg) return false;
	try {
		return (
			realpathSync(fileURLToPath(import.meta.url)) ===
			realpathSync(entryArg)
		);
	} catch {
		return false;
	}
}

if (isExecutedDirectly()) {
	void runCli().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`browser-agent: ${message}\n`);
		process.exitCode = 1;
	});
}
