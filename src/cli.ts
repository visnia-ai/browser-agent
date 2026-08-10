#!/usr/bin/env node

import "dotenv/config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfigFromEnv } from "./runtime/llm-env.js";
import { loadConfig, parseArgs, type Config } from "./utils.js";
import { BROWSER_AGENT_VERSION, RPC_PROTOCOL_VERSION } from "./version.js";
import {
	encryptAuthField,
	generateAuthEncryptionKey,
} from "./auth/crypto.js";
import type {
	CodexCredentials,
	CodexProviderRuntime,
} from "./agents/providers/ai-sdk.js";

export const CLI_HELP = `Usage:
  browser-agent <config.yaml> [--rpc]
  browser-agent codex-login [--check]
  browser-agent generate-key
  browser-agent encrypt "<value>"
  browser-agent --help
  browser-agent --version

Arguments:
  <config.yaml>         YAML configuration path (relative to the current directory)

Commands:
  codex-login           Ensure a ChatGPT OAuth session is available for Codex
  generate-key          Generate a base64-encoded 32-byte auth encryption key
  encrypt <value>       Encrypt one credential field using BROWSER_AGENT_AUTH_ENCRYPTION_KEY

Options:
  --rpc                 Run the JSON-RPC server over stdio
  --check               Report Codex login status as JSON without starting OAuth
  -h, --help            Show this help
  -V, --version         Show the browser-agent version
  --version-json        Show version and RPC protocol metadata as JSON
`;

interface CodexCliAuthBroker extends CodexProviderRuntime {
	readonly cliVersion: string;
	getCredentials(): Promise<CodexCredentials>;
	refreshCredentials(): Promise<CodexCredentials>;
	close(): Promise<void>;
}

interface CodexCliPreparationDependencies {
	startAuthBroker(options: {
		writeStatus?: (message: string) => void;
	}): Promise<CodexCliAuthBroker>;
	setProviderRuntime(runtime: CodexProviderRuntime | null): void;
	writeStatus(message: string): void;
}

type CodexLoginDependencies = Pick<
	CodexCliPreparationDependencies,
	"startAuthBroker" | "writeStatus"
>;

interface RunCliDependencies {
	ensureCodexLogin(): Promise<void>;
	checkCodexLogin(): Promise<boolean>;
}

export function configUsesCodex(config: Config): boolean {
	return Object.values(config.stageLLMs).some(
		(options) => options.provider === "codex",
	);
}

export async function ensureCodexLoginForCli(
	dependencies?: Partial<CodexLoginDependencies>,
): Promise<void> {
	const authModule = dependencies?.startAuthBroker
		? undefined
		: await import("./codex-auth.js");
	const startAuthBroker =
		dependencies?.startAuthBroker ?? authModule!.startCodexAuthBroker;
	const writeStatus =
		dependencies?.writeStatus ??
		((message: string) => process.stderr.write(`${message}\n`));
	const broker = await startAuthBroker({
		writeStatus: (authUrl) => {
			writeStatus(
				`Codex ChatGPT sign-in is required. Open this URL in a browser:\n${authUrl}`,
			);
		},
	});
	await broker.close();
}

export async function prepareCodexProviderForCli(
	config: Config,
	dependencies?: Partial<CodexCliPreparationDependencies>,
): Promise<void | (() => Promise<void>)> {
	if (!configUsesCodex(config)) return;

	const [authModule, providerModule] = await Promise.all([
		dependencies?.startAuthBroker
			? Promise.resolve(undefined)
			: import("./codex-auth.js"),
		dependencies?.setProviderRuntime
			? Promise.resolve(undefined)
			: import("./agents/providers/ai-sdk.js"),
	]);
	const startAuthBroker =
		dependencies?.startAuthBroker ?? authModule!.startCodexAuthBroker;
	const setProviderRuntime =
		dependencies?.setProviderRuntime ?? providerModule!.setCodexProviderRuntime;
	const writeStatus =
		dependencies?.writeStatus ??
		((message: string) => process.stderr.write(`${message}\n`));

	const broker = await startAuthBroker({
		writeStatus: (authUrl) => {
			writeStatus(
				`Codex ChatGPT sign-in is required. Open this URL in a browser:\n${authUrl}`,
			);
		},
	});
	try {
		setProviderRuntime(broker);
	} catch (error) {
		await broker.close();
		throw error;
	}
	let cleanedUp = false;
	return async () => {
		if (cleanedUp) return;
		cleanedUp = true;
		setProviderRuntime(null);
		await broker.close();
	};
}

export async function runCli(
	argv: string[] = process.argv,
	dependencies?: Partial<RunCliDependencies>,
): Promise<void> {
	const args = parseArgs(argv);
	if (args.codexLogin) {
		if (args.codexLoginCheck) {
			const checkCodexLogin =
				dependencies?.checkCodexLogin ??
				(await import("./codex-auth.js")).checkCodexLogin;
			process.stdout.write(
				`${JSON.stringify({ loggedIn: await checkCodexLogin() })}\n`,
			);
			return;
		}
		await (dependencies?.ensureCodexLogin ?? ensureCodexLoginForCli)();
		return;
	}
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
		const config = loadResolvedConfig(args.config);
		const cleanup = await prepareCodexProviderForCli(config);
		try {
			const { main } = await import("./index.js");
			await main(argv, () => config);
		} finally {
			await cleanup?.();
		}
		return;
	}

	const { runRpcStdio } = await import("./rpc.js");
	const succeeded = await runRpcStdio({
		argv,
		configPath: args.config,
		loadConfig: loadResolvedConfig,
		prepareRun: prepareCodexProviderForCli,
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
