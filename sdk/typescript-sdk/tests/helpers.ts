import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserAgent } from "../src/index.js";
import {
	verifyExecutable,
	type ExecutableDependencies,
} from "../src/runtime.js";
import type { BrowserAgentOptions } from "../src/types.js";

export const fakeExecutable = fileURLToPath(
	new URL("../../sdk-test-fixtures/fake-browser-agent.mjs", import.meta.url),
);

const InternalBrowserAgent = BrowserAgent as unknown as new (
	options: BrowserAgentOptions,
	dependencies: ExecutableDependencies,
) => BrowserAgent;

export function createAgent(
	overrides: Partial<BrowserAgentOptions> = {},
	logs: string[] = [],
	dependencies: ExecutableDependencies = {
		resolve: async () => fakeExecutable,
		verify: verifyExecutable,
	},
): BrowserAgent {
	return new InternalBrowserAgent(
		{
			provider: "openai",
			model: "gpt-5.4",
			apiKey: "sdk-secret",
			downloadDirectory: path.join(os.tmpdir(), "sdk-downloads"),
			onLog: (entry) => logs.push(entry.message),
			...overrides,
		},
		dependencies,
	);
}

export async function withMode<T>(
	mode: string,
	callback: () => Promise<T>,
): Promise<T> {
	const previous = process.env.SDK_FAKE_MODE;
	process.env.SDK_FAKE_MODE = mode;
	try {
		return await callback();
	} finally {
		if (previous === undefined) delete process.env.SDK_FAKE_MODE;
		else process.env.SDK_FAKE_MODE = previous;
	}
}

export async function withCapture<T>(
	callback: (capture: string, versions: string) => Promise<T>,
): Promise<T> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-sdk-test-"));
	const capture = path.join(directory, "capture.json");
	const versions = path.join(directory, "versions.txt");
	const oldCapture = process.env.SDK_FAKE_CAPTURE;
	const oldVersions = process.env.SDK_FAKE_VERSION_COUNT;
	process.env.SDK_FAKE_CAPTURE = capture;
	process.env.SDK_FAKE_VERSION_COUNT = versions;
	try {
		return await callback(capture, versions);
	} finally {
		if (oldCapture === undefined) delete process.env.SDK_FAKE_CAPTURE;
		else process.env.SDK_FAKE_CAPTURE = oldCapture;
		if (oldVersions === undefined)
			delete process.env.SDK_FAKE_VERSION_COUNT;
		else process.env.SDK_FAKE_VERSION_COUNT = oldVersions;
		fs.rmSync(directory, { recursive: true, force: true });
	}
}
