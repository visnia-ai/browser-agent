import * as fs from "node:fs";
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

function getPrintDialogFixtureFileUrl(): string {
	const fixturePath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"assets",
		"print-dialog-fixture.html",
	);
	return pathToFileURL(fixturePath).href;
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

describe("print dialog e2e", function () {
	this.timeout(90_000);

	it("does not let the print page block agent execution after clicking print", async () => {
		const downloadDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-print-"),
		);
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
			summary: "The print button was clicked and execution continued.",
			reasons: ["The mocked agent reached the post-click step."],
			model: "mock",
			provider: "openai",
			reasoningEffort: "low",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
			},
		});

		const port = 9487;
		const fixtureUrl = getPrintDialogFixtureFileUrl();
		const stageLLM = {
			provider: "openai" as const,
			model: "mock",
			reasoningEffort: "low" as const,
		};
		let postPrintDownloadedFiles: string[] = [];

		const runPromise = runAgent(deps, {
			session: {
				port,
				headless: false,
				url: fixtureUrl,
				downloadDir,
				forceRestart: true,
			},
			task: "Click the Open print button. The task is complete only after the agent has continued running after the print page opens.",
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
				const sawPrintClick = projection.includes("print-clicked");
				const printLine = projection
					.split("\n")
					.find((line) => line.includes('name="Open print"'));
				const printRef = /\bref="([^"]+)"/.exec(printLine ?? "")?.[1];
				if (!sawPrintClick && !printRef) {
					throw new Error(
						`semantic projection did not expose the print button: ${projection}`,
					);
				}
				if (sawPrintClick) {
					postPrintDownloadedFiles = Array.isArray(
						promptPayload.downloadedFiles,
					)
						? promptPayload.downloadedFiles.filter(
								(entry): entry is string => typeof entry === "string",
							)
						: [];
				}
				const memoryContentAvailable =
					typeof promptPayload.memoryContent === "string";
				return {
					data: !sawPrintClick
						? {
								thinking: "Click the print button.",
								actions: [{ type: "click", ref: printRef }],
							}
						: !memoryContentAvailable
							? {
									thinking:
										"The print button click registered and the agent can continue.",
									actions: [{ type: "memory_read" }],
								}
							: {
									thinking: "Return the verified print-dialog result.",
									actions: [
										{
											type: "return_results",
											results: [
												{
													link: String(promptPayload.currentURL ?? ""),
													summary: "continued after print",
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
			const result = await withTimeout(
				runPromise,
				30_000,
				"agent run after print click",
			);

			assert.isTrue(result.completed);
			assert.deepEqual(yaml.load(result.result ?? ""), [
				{
					link: fixtureUrl,
					summary: "continued after print",
				},
			]);
			assert.isAtLeast(result.steps.length, 3);
			assert.isTrue(
				postPrintDownloadedFiles.some((entry) =>
					/^\[NEW\] \.\/print-Print Dialog Fixture-\d+\.pdf$/.test(entry),
				),
				`expected generated print PDF in downloadedFiles, got ${JSON.stringify(postPrintDownloadedFiles)}`,
			);

			const pdfFiles = fs
				.readdirSync(downloadDir)
				.filter((entry) => entry.endsWith(".pdf"));
			assert.lengthOf(pdfFiles, 1);
			assert.match(pdfFiles[0], /^print-Print Dialog Fixture-\d+\.pdf$/);

			const session = deps.registry.get(port);
			assert.isDefined(session);
			const { result: evalResult } = await session!.browser.Runtime.evaluate({
				expression: `(() => ({
						printClickCount: window.__printClickCount || 0,
						status: document.getElementById("status")?.textContent || ""
					}))()`,
				returnByValue: true,
			});
			const dom = (evalResult.value ?? {}) as {
				printClickCount?: number;
				status?: string;
			};
			assert.strictEqual(dom.printClickCount, 1);
			assert.strictEqual(dom.status, "print-clicked");
		} finally {
			if (deps.registry.get(port)) {
				await closeSession(deps, port);
			}
			fs.rmSync(downloadDir, { recursive: true, force: true });
		}
	});
});
