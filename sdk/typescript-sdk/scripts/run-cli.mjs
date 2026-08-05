#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

export async function resolveInstalledExecutable({
	root = packageRoot,
	platform = process.platform,
} = {}) {
	const suffix = platform === "win32" ? ".exe" : "";
	const executable = path.join(root, "bin", `browser-agent${suffix}`);
	await access(executable, constants.X_OK);
	return executable;
}

export function runCli(
	executable,
	args,
	spawnImplementation = spawn,
) {
	return new Promise((resolve, reject) => {
		const child = spawnImplementation(executable, args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

export async function main({
	args = process.argv.slice(2),
	resolveExecutable = resolveInstalledExecutable,
	run = runCli,
	stderr = process.stderr,
} = {}) {
	try {
		const executable = await resolveExecutable();
		return await run(executable, args);
	} catch (error) {
		stderr.write(
			`Unable to launch the Browser Agent CLI. Reinstall it with "npm install -g @visnia/browser-agent-sdk" and ensure npm lifecycle scripts are enabled. ${
				error instanceof Error ? error.message : String(error)
			}\n`,
		);
		return { code: 1, signal: null };
	}
}

const invokedPath = process.argv[1]
	? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
	: "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	const result = await main();
	if (result.signal) process.kill(process.pid, result.signal);
	else process.exitCode = result.code ?? 1;
}
