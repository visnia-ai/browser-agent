import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert } from "chai";
import yaml from "js-yaml";
import { describe, it } from "mocha";
import {
	configFeatureFlags,
	mergeConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { createDefaultCoreDeps } from "../src/core/deps.js";
import { closeSession, runAgent } from "../src/core/index.js";
import { createPortAllocator } from "../src/port-allocation.js";

function getFilePickerFixtureFileUrl(): string {
	const fixturePath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"assets",
		"file-picker-fixture.html",
	);
	return pathToFileURL(fixturePath).href;
}

function createTestPortAllocator(): ReturnType<typeof createPortAllocator> {
	return createPortAllocator({
		minPort: 9490,
		maxPort: 9590,
		isPortInUse: async (port) =>
			await new Promise<boolean>((resolve) => {
				const server = net.createServer();
				server.once("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "EADDRINUSE") {
						resolve(true);
						return;
					}
					resolve(false);
				});
				server.once("listening", () => {
					server.close(() => resolve(false));
				});
				server.listen(port, "127.0.0.1");
			}),
	});
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	});
}

async function runHeadfulFilePickerButtonTest(params: {
	buttonName: string;
	fileName: string;
	task: string;
	result: string;
	timeoutLabel: string;
	expectStoppedPropagation?: boolean;
}): Promise<void> {
	const workspaceDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "browser-agent-file-picker-workspace-"),
	);
	const downloadDir = path.join(workspaceDir, "downloads");
	const uploadPath = path.join(workspaceDir, params.fileName);
	fs.mkdirSync(downloadDir, { recursive: true });
	fs.writeFileSync(uploadPath, "sample upload", "utf-8");

	const featureFlags = mergeConfigFeatureFlags(configFeatureFlags, {
		preStepScreenshotInLatestUserPrompt: false,
		userTakeoverTool: false,
	});
	const deps = createDefaultCoreDeps({ featureFlags });
	deps.findTargetURL = async () => {
		throw new Error("findTargetURL must not run when session.url is set");
	};
	deps.verifyTaskSuccess = async () => ({
		success: true,
		summary: "The sample file was selected.",
		reasons: ["The page status showed the uploaded file name."],
		model: "mock",
		provider: "openai",
		reasoningEffort: "low",
		usage: {
			input_tokens: 1,
			output_tokens: 1,
			total_tokens: 2,
		},
	});

	const portAllocator = createTestPortAllocator();
	const port = await portAllocator.acquirePort();
	const fixtureUrl = getFilePickerFixtureFileUrl();
	const stageLLM = {
		provider: "openai" as const,
		model: "mock",
		reasoningEffort: "low" as const,
	};

	const runPromise = runAgent(deps, {
		session: {
			port,
			headless: false,
			url: fixtureUrl,
			downloadDir,
			fileWorkspaceRoot: workspaceDir,
			forceRestart: true,
		},
		task: params.task,
		stageLLMs: {
			findTargetURL: stageLLM,
			createChecklist: stageLLM,
			runAgent: stageLLM,
			verifySuccess: stageLLM,
		},
		featureFlags,
		maxSteps: 4,
		keepSessionOpen: true,
		generateStep: async ({ promptPayload }) => {
			const projection = String(promptPayload.projection ?? "");
			const sawFileUpload = projection.includes(`selected: ${params.fileName}`);
			const targetLine = projection
				.split("\n")
				.find((line) =>
					line.includes(`name=${JSON.stringify(params.buttonName)}`),
				);
			const targetRef = /\bref="([^"]+)"/.exec(targetLine ?? "")?.[1];
			if (!sawFileUpload && !targetRef) {
				throw new Error(
					`semantic projection did not expose button ${JSON.stringify(params.buttonName)}: ${projection}`,
				);
			}
			const memoryContentAvailable =
				typeof promptPayload.memoryContent === "string";
			return {
				data: !sawFileUpload
					? {
							thinking:
								"Click the button directly. Do not use the upload_files tool.",
							actions: [{ type: "click", ref: targetRef }],
						}
					: !memoryContentAvailable
						? {
								thinking:
									"The expected file was uploaded after clicking the button.",
								actions: [{ type: "memory_read" }],
							}
						: {
								thinking: "Return the verified upload result.",
								actions: [
									{
										type: "return_results",
										results: [
											{
												link: String(promptPayload.currentURL ?? ""),
												summary: params.result,
											},
										],
									},
								],
							},
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
				reasoning_tokens: "",
			};
		},
	});
	runPromise.catch(() => {});

	try {
		const result = await withTimeout(runPromise, 30_000, params.timeoutLabel);

		assert.isTrue(result.completed);
		assert.deepEqual(yaml.load(result.result ?? ""), [
			{
				link: getFilePickerFixtureFileUrl(),
				summary: params.result,
			},
		]);
		assert.isAtLeast(result.steps.length, 3);

		const session = deps.registry.get(port);
		assert.isDefined(session);
		const { result: evalResult } = await session!.browser.Runtime.evaluate({
			expression: `(() => ({
				selectedFileNames: window.__selectedFileNames || [],
				status: document.getElementById("status")?.textContent || "",
				filePickerButtonClicks: window.__filePickerButtonClicks || 0,
				stoppedPropagation: Boolean(window.__stoppedFilePickerPropagation)
			}))()`,
			returnByValue: true,
		});
		const dom = (evalResult.value ?? {}) as {
			selectedFileNames?: string[];
			status?: string;
			filePickerButtonClicks?: number;
			stoppedPropagation?: boolean;
		};
		assert.deepEqual(dom.selectedFileNames, [params.fileName]);
		assert.strictEqual(dom.status, `selected: ${params.fileName}`);
		assert.isAtLeast(dom.filePickerButtonClicks ?? 0, 1);
		if (params.expectStoppedPropagation) {
			assert.isTrue(dom.stoppedPropagation);
		}
	} finally {
		if (deps.registry.get(port)) {
			await closeSession(deps, port);
		}
		portAllocator.releasePort(port);
		fs.rmSync(workspaceDir, { recursive: true, force: true });
	}
}

describe("file picker e2e", function () {
	this.timeout(90_000);

	it("opens a button-triggered file picker without using upload tools in a headful agent session", async () => {
		await runHeadfulFilePickerButtonTest({
			buttonName: "Choose file",
			fileName: "sample-upload.txt",
			task: "Click the Choose file button and select sample-upload.txt from the workspace. NEVER use the upload_files tool or any upload tool. Rely exclusively on clicking the button to open the browser file picker, then continue.",
			result: "selected sample-upload.txt",
			timeoutLabel: "agent run after opening file picker",
		});
	});

	it("opens a picker from a button that immediately stops event propagation in a headful agent session", async () => {
		await runHeadfulFilePickerButtonTest({
			buttonName: "Choose file and stop propagation",
			fileName: "stopped-propagation-upload.txt",
			task: "Click the Choose file and stop propagation button and select stopped-propagation-upload.txt from the workspace. NEVER use the upload_files tool or any upload tool. Rely exclusively on clicking the button to open the browser file picker, then continue.",
			result: "selected stopped-propagation-upload.txt",
			timeoutLabel:
				"agent run after opening file picker with stopped propagation",
			expectStoppedPropagation: true,
		});
	});
});
