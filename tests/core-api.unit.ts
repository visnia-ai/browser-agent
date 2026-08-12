import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { Message } from "../src/agents/types.js";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { CONTEXT_DIR, STEPS_DIR } from "../src/browser/constants.js";
import {
	NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
	OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
} from "../src/agents/executor-context-policy.js";
import { resetStepsDir, setRuntimeOptions } from "../src/runtime-options.js";
import {
	closeSession,
	createPromptForStep,
	createSession,
	ModelStepActionContractError,
	processModelOutputAndBrowse,
	runAgent,
	step,
} from "../src/core/index.js";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value?: T) => void;
} {
	let resolve!: (value?: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("core-api", () => {
	const originalCumulativeProjectionHistory =
		configFeatureFlags.semanticProjectionHistory;
	const originalExtractDataWholeContext =
		configFeatureFlags.extractDataWholeContext;

	afterEach(() => {
		configFeatureFlags.semanticProjectionHistory =
			originalCumulativeProjectionHistory;
		configFeatureFlags.extractDataWholeContext =
			originalExtractDataWholeContext;
		__setProviderOverrideForTests("vllm", null);
		__setProviderOverrideForTests("together", null);
	});

	it("createSession stores session and returns current url", async () => {
		const deps = createMockCoreDeps();
		const result = await createSession(deps, {
			port: 9222,
			headless: true,
			url: "https://example.com/start",
		});

		assert.strictEqual(result.currentUrl, "https://example.com/start");
		assert.isDefined(deps.registry.get(9222));
	});

	it("createSession passes through an explicit userDataDir", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, {
			port: 9333,
			headless: true,
			userDataDir: "/tmp/workflow-profile",
		});

		assert.strictEqual(
			deps.registry.get(9333)?.browser.userDataDir,
			"/tmp/workflow-profile",
		);
	});

	it("step(create_prompt_for_step) returns prompt and context", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, { port: 9222, headless: true });

		const result = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9222,
			userTask: "task",
			stepsHistory: [],
		});
		assert.strictEqual(result.mode, "create_prompt_for_step");
		if (result.mode === "create_prompt_for_step") {
			assert.isArray(result.prompt.messages);
			assert.isNumber(result.context.latest_user_prompt_token_count);
		}
	});

	it("step(create_prompt_for_step) strips legacy plan payloads but preserves model-emitted assistant fields", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, { port: 9222, headless: true });

		const result = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9222,
			userTask: "task",
			stepsHistory: [
				{
					payload: {
						task: "old task",
						plan: ["old plan"],
						html: "old html",
					},
					assistant: {
						previousStepPlanUpdate: [{ index: 0, status: "done" }],
						tools: [],
						done: false,
					},
				},
			],
		});

		assert.strictEqual(result.mode, "create_prompt_for_step");
		if (result.mode === "create_prompt_for_step") {
			assert.notProperty(result.prompt.payload, "plan");
			const serializedMessages = JSON.stringify(result.prompt.messages);
			assert.notInclude(serializedMessages, "old plan");
			assert.include(serializedMessages, "previousStepPlanUpdate");
		}
	});

	it("step(create_prompt_for_step) emits timing logs above threshold", async () => {
		const logs: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		};
		try {
			const deps = createMockCoreDeps({
				getPageProjection: async () => {
					await new Promise((resolve) => setTimeout(resolve, 510));
					return 'div ref="1": hello';
				},
			});
			await createSession(deps, { port: 9222, headless: true });

			const result = await step(deps, {
				mode: "create_prompt_for_step",
				port: 9222,
				userTask: "task",
				stepsHistory: [],
				stepNumber: 1,
			});

			assert.strictEqual(result.mode, "create_prompt_for_step");
			assert.isTrue(
				logs.some(
					(entry) =>
						entry.includes("[step 1 state-extraction]") &&
						entry.includes("getPageProjection") &&
						entry.includes("duration_ms="),
				),
				"missing slow getPageProjection timing log",
			);
			assert.isFalse(
				logs.some(
					(entry) =>
						entry.includes("[step 1 state-extraction]") &&
						entry.includes("buildHistoryMessages") &&
						entry.includes("duration_ms="),
				),
				"fast buildHistoryMessages timing log should be suppressed",
			);
		} finally {
			console.log = originalConsoleLog;
		}
	});

	it("step(create_prompt_for_step) recovers when semantic projection resolution throws stale node", async () => {
		const logs: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		};
		let domAttempts = 0;
		try {
			const deps = createMockCoreDeps({
				getPageProjection: async () => {
					domAttempts += 1;
					throw new Error("Could not find node with given id");
				},
			});
			await createSession(deps, { port: 9222, headless: true });

			const result = await step(deps, {
				mode: "create_prompt_for_step",
				port: 9222,
				userTask: "task",
				stepsHistory: [],
				stepNumber: 1,
			});

			assert.strictEqual(domAttempts, 2);
			assert.strictEqual(result.mode, "create_prompt_for_step");
			if (result.mode === "create_prompt_for_step") {
				assert.strictEqual(result.prompt.payload.projection, "");
				assert.isUndefined(result.prompt.payload.validRefs);
				assert.include(
					JSON.stringify(result.prompt.payload.interactionErrors ?? []),
					"context(projection): Could not find node with given id",
				);
			}
			assert.isTrue(
				logs.some(
					(entry) =>
						entry.includes("getPageProjection:retry") &&
						entry.includes("duration_ms="),
				),
				"missing stale DOM retry timing log",
			);
		} finally {
			console.log = originalConsoleLog;
		}
	});

	it("step(create_prompt_for_step) retries pre-step screenshot capture on stale-node errors", async () => {
		const originalFlag = configFeatureFlags.preStepScreenshotInLatestUserPrompt;
		setConfigFeatureFlags({ preStepScreenshotInLatestUserPrompt: true });
		try {
			let screenshotAttempts = 0;
			const deps = createMockCoreDeps({
				capturePreStepScreenshotDataUrl: async () => {
					screenshotAttempts += 1;
					if (screenshotAttempts === 1) {
						throw new Error("Could not find node with given id");
					}
					return "data:image/jpeg;base64,AAAA";
				},
			});
			await createSession(deps, { port: 9222, headless: true });

			const result = await step(deps, {
				mode: "create_prompt_for_step",
				port: 9222,
				userTask: "task",
				stepsHistory: [],
			});

			assert.strictEqual(result.mode, "create_prompt_for_step");
			assert.strictEqual(screenshotAttempts, 2);
			if (result.mode === "create_prompt_for_step") {
				assert.strictEqual(
					result.prompt.payload.currentPageScreenshotIncludedAsImagePart,
					true,
				);
				assert.notInclude(
					JSON.stringify(result.prompt.payload.interactionErrors ?? []),
					"context(pre_step_screenshot)",
				);
			}
		} finally {
			setConfigFeatureFlags({
				preStepScreenshotInLatestUserPrompt: originalFlag,
			});
		}
	});

	it("step(create_prompt_for_step) skips screenshot capture when disabled", async () => {
		const originalFlag = configFeatureFlags.preStepScreenshotInLatestUserPrompt;
		setConfigFeatureFlags({ preStepScreenshotInLatestUserPrompt: false });
		try {
			let screenshotCalls = 0;
			const deps = createMockCoreDeps({
				capturePreStepScreenshotDataUrl: async () => {
					screenshotCalls += 1;
					return "data:image/jpeg;base64,AAAA";
				},
			});
			await createSession(deps, { port: 9222, headless: true });

			const result = await step(deps, {
				mode: "create_prompt_for_step",
				port: 9222,
				userTask: "task",
				stepsHistory: [],
			});

			assert.strictEqual(result.mode, "create_prompt_for_step");
			assert.strictEqual(screenshotCalls, 0);
			if (result.mode === "create_prompt_for_step") {
				assert.notProperty(
					result.prompt.payload,
					"currentPageScreenshotIncludedAsImagePart",
				);
				assert.isFalse(
					result.prompt.messages.some((message) =>
						Array.isArray(message.content)
							? message.content.some((part) => part.type === "image_url")
							: false,
					),
				);
			}
		} finally {
			setConfigFeatureFlags({
				preStepScreenshotInLatestUserPrompt: originalFlag,
			});
		}
	});

	it("step(create_prompt_for_step) ignores legacy plan history and protects auth context even if domain decryption fails", async () => {
		await withAuthEncryptionKey(async () => {
			let screenshotCalls = 0;
			let domainCandidateChecks = 0;
			let domOptions: Record<string, unknown> | undefined;
			const deps = createMockCoreDeps({
				getCurrentURL: async () => "https://example.com/dashboard",
				getPageProjection: async (_browser, options) => {
					domOptions = { ...(options ?? {}) };
					return 'div ref="1": secure';
				},
				capturePreStepScreenshotDataUrl: async () => {
					screenshotCalls += 1;
					return "data:image/jpeg;base64,AAAA";
				},
			});
			await createSession(deps, { port: 9222, headless: true });
			const session = deps.registry.get(9222)!;
			session.authTakeover = {
				enabled: true,
				requestAuthDomainCandidates: async () => {
					domainCandidateChecks += 1;
					throw new Error("domain callback failed");
				},
				requestAuthIdentifierForDomain: async () => undefined,
				requestAuthPasswordForDomain: async () => undefined,
				protectedRefs: new Set(["u1", "p1"]),
				suppressScreenshots: true,
			};

			const result = await step(deps, {
				mode: "create_prompt_for_step",
				port: 9222,
				userTask: "Continue securely",
				stepsHistory: [
					{
						payload: {
							plan: ["Step from history", 123, null],
						},
						assistant: { done: false, actions: [] },
					},
				],
			});

			assert.strictEqual(result.mode, "create_prompt_for_step");
			assert.deepEqual(domOptions, {
				omitHrefs: true,
				redactInputRefs: ["u1", "p1"],
				redactPasswordInputs: true,
			});
			assert.strictEqual(domainCandidateChecks, 1);
			assert.strictEqual(screenshotCalls, 0);
			if (result.mode === "create_prompt_for_step") {
				assert.notProperty(result.prompt.payload, "plan");
			}
		});
	});

	it("step(create_prompt_for_step) auto-switches to the first newly opened tab when enabled", async () => {
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search Form",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-2",
				title: "Results",
				url: "https://example.com/results",
			},
		];
		let currentTargetId = "tab-1";
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () =>
				currentTargetId === "tab-1"
					? 'div ref="1": search'
					: 'div ref="2": results',
			listTabs: async () => tabs,
			getNewlyOpenedTabs: (previousTabs, currentTabs) => {
				const previousTargetIds = new Set(
					(previousTabs ?? []).map((tab) => tab.targetId),
				);
				return currentTabs.filter(
					(tab) => !previousTargetIds.has(tab.targetId),
				);
			},
			resolveCurrentTabIndex: async () =>
				tabs.findIndex((tab) => tab.targetId === currentTargetId),
			switchTab: async (_browser, targetId) => {
				currentTargetId = targetId;
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = [tabs[0]];

		const result = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9222,
			userTask: "task",
			stepsHistory: [],
			autoSwitchToNewTab: true,
		});

		assert.strictEqual(result.mode, "create_prompt_for_step");
		if (result.mode === "create_prompt_for_step") {
			assert.strictEqual(result.prompt.payload.currentURL, tabs[1].url);
			assert.strictEqual(result.prompt.payload.currentTab, 1);
			assert.strictEqual(
				result.prompt.payload.autoTabSwitchNote,
				"Auto-switched to first newly opened tab.",
			);
			assert.deepEqual(result.prompt.payload.newlyOpenedTabs, ["Results"]);
			assert.strictEqual(
				result.prompt.payload.projection,
				'div ref="2": results',
			);
		}
		assert.strictEqual(currentTargetId, "tab-2");
	});

	it("step(create_prompt_for_step) auto-switches tabs by default", async () => {
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search Form",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-2",
				title: "Results",
				url: "https://example.com/results",
			},
		];
		let currentTargetId = "tab-1";
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () =>
				currentTargetId === "tab-1"
					? 'div ref="1": search'
					: 'div ref="2": results',
			listTabs: async () => tabs,
			getNewlyOpenedTabs: (previousTabs, currentTabs) => {
				const previousTargetIds = new Set(
					(previousTabs ?? []).map((tab) => tab.targetId),
				);
				return currentTabs.filter(
					(tab) => !previousTargetIds.has(tab.targetId),
				);
			},
			resolveCurrentTabIndex: async () =>
				tabs.findIndex((tab) => tab.targetId === currentTargetId),
			switchTab: async (_browser, targetId) => {
				currentTargetId = targetId;
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = [tabs[0]];

		const result = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9222,
			userTask: "task",
			stepsHistory: [],
		});

		assert.strictEqual(result.mode, "create_prompt_for_step");
		if (result.mode === "create_prompt_for_step") {
			assert.strictEqual(result.prompt.payload.currentURL, tabs[1].url);
			assert.strictEqual(result.prompt.payload.currentTab, 1);
			assert.strictEqual(
				result.prompt.payload.autoTabSwitchNote,
				"Auto-switched to first newly opened tab.",
			);
			assert.deepEqual(result.prompt.payload.newlyOpenedTabs, ["Results"]);
			assert.strictEqual(
				result.prompt.payload.projection,
				'div ref="2": results',
			);
		}
		assert.strictEqual(currentTargetId, "tab-2");
	});

	it("step(create_prompt_for_step) skips auto-switch when explicitly disabled", async () => {
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search Form",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-2",
				title: "Results",
				url: "https://example.com/results",
			},
		];
		let currentTargetId = "tab-1";
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () =>
				currentTargetId === "tab-1"
					? 'div ref="1": search'
					: 'div ref="2": results',
			listTabs: async () => tabs,
			getNewlyOpenedTabs: (previousTabs, currentTabs) => {
				const previousTargetIds = new Set(
					(previousTabs ?? []).map((tab) => tab.targetId),
				);
				return currentTabs.filter(
					(tab) => !previousTargetIds.has(tab.targetId),
				);
			},
			resolveCurrentTabIndex: async () =>
				tabs.findIndex((tab) => tab.targetId === currentTargetId),
			switchTab: async (_browser, targetId) => {
				currentTargetId = targetId;
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = [tabs[0]];

		const result = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9222,
			userTask: "task",
			stepsHistory: [],
			autoSwitchToNewTab: false,
		});

		assert.strictEqual(result.mode, "create_prompt_for_step");
		if (result.mode === "create_prompt_for_step") {
			assert.strictEqual(result.prompt.payload.currentURL, tabs[0].url);
			assert.strictEqual(result.prompt.payload.currentTab, 0);
			assert.isUndefined(result.prompt.payload.autoTabSwitchNote);
			assert.strictEqual(
				result.prompt.payload.projection,
				'div ref="1": search',
			);
		}
		assert.strictEqual(currentTargetId, "tab-1");
	});

	it("step(create_prompt_for_step) downloads a newly opened PDF without switching into its viewer", async () => {
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-pdf",
				title: "report.pdf",
				url: "https://example.com/report.pdf",
			},
		];
		let currentTargetId = "tab-1";
		const downloadedUrls: string[] = [];
		const switchedTargets: string[] = [];
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () => 'a ref="1": Open report',
			listTabs: async () => tabs,
			getNewlyOpenedTabs: (previousTabs, currentTabs) => {
				const previousTargetIds = new Set(
					(previousTabs ?? []).map((tab) => tab.targetId),
				);
				return currentTabs.filter(
					(tab) => !previousTargetIds.has(tab.targetId),
				);
			},
			resolveCurrentTabIndex: async () => 0,
			downloadFileFromUrl: async (_browser, url) => {
				downloadedUrls.push(url);
				return "/tmp/report.pdf";
			},
			switchTab: async (_browser, targetId) => {
				switchedTargets.push(targetId);
				currentTargetId = targetId;
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = [tabs[0]];

		const result = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9222,
			userTask: "read the report",
			stepsHistory: [],
		});

		assert.strictEqual(result.mode, "create_prompt_for_step");
		if (result.mode === "create_prompt_for_step") {
			assert.strictEqual(
				result.prompt.payload.currentURL,
				"https://example.com/search",
			);
			assert.include(
				result.prompt.payload.interactionErrors,
				"Downloaded newly opened PDF; stayed on source tab.",
			);
		}
		assert.deepEqual(downloadedUrls, ["https://example.com/report.pdf"]);
		assert.deepEqual(switchedTargets, []);
		assert.strictEqual(currentTargetId, "tab-1");
	});

	it("step(create_prompt_for_step) retries a blank semantic projection before continuing", async () => {
		let domCalls = 0;
		const deps = createMockCoreDeps({
			getPageProjection: async () => {
				domCalls += 1;
				return domCalls < 3 ? "   " : 'div ref="1": ready';
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;

		const result = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9222,
			userTask: "task",
			stepsHistory: [],
		});

		assert.strictEqual(result.mode, "create_prompt_for_step");
		assert.strictEqual(domCalls, 3);
		if (result.mode === "create_prompt_for_step") {
			assert.strictEqual(
				result.prompt.payload.projection,
				'div ref="1": ready',
			);
		}
	});

	it("step throws when the session does not exist", async () => {
		const deps = createMockCoreDeps();

		try {
			await step(deps, {
				mode: "browse",
				port: 9999,
				generatedActions: [],
			});
			assert.fail("Expected SessionNotFoundError");
		} catch (error) {
			assert.instanceOf(error, Error);
			assert.include(
				String((error as Error).message),
				"No active browser session found",
			);
		}
	});

	it("step(browse) executes actions and refreshes context", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, { port: 9222, headless: true });

		const result = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: [{ click: "1" }],
		});
		assert.strictEqual(result.mode, "browse");
		if (result.mode === "browse") {
			assert.strictEqual(result.execution.pending_memory_read, true);
			assert.isArray(result.context.valid_refs);
			assert.isArray(result.context.downloaded_files);
		}
		assert.strictEqual(deps.registry.get(9222)?.pendingMemoryRead, true);
	});

	it("step(browse) updates focused browser context after switch_tab", async () => {
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-2",
				title: "Results",
				url: "https://example.com/results",
			},
		];
		let currentTargetId = "tab-1";
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () =>
				currentTargetId === "tab-1"
					? 'div ref="1": search'
					: 'div ref="2": results',
			listTabs: async () => tabs,
			resolveCurrentTabIndex: async () =>
				tabs.findIndex((tab) => tab.targetId === currentTargetId),
			switchTab: async (_browser, targetId) => {
				currentTargetId = targetId;
			},
			executeActions: async ({ actions, openTabs }) => {
				const action = actions[0];
				assert.strictEqual(action?.type, "switch_tab");
				await deps.switchTab(
					deps.registry.get(9222)!.browser,
					openTabs[(action as { index: number }).index].targetId,
				);
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = tabs;
		session.browser.currentTargetId = currentTargetId;

		const result = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: [{ type: "switch_tab", index: 1 }],
		});

		assert.strictEqual(result.mode, "browse");
		if (result.mode === "browse") {
			assert.strictEqual(
				result.context.current_url,
				"https://example.com/results",
			);
			assert.strictEqual(result.context.current_tab, 1);
			assert.strictEqual(result.context.projection, 'div ref="2": results');
		}
		assert.strictEqual(currentTargetId, "tab-2");
	});

	it("step(browse) auto-switches to a newly opened tab before refreshing DOM context", async () => {
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-2",
				title: "Results",
				url: "https://example.com/results",
			},
		];
		let currentTargetId = "tab-1";
		let listTabsCalls = 0;
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () =>
				currentTargetId === "tab-1"
					? 'div ref="1": search'
					: 'div ref="2": results',
			listTabs: async () => {
				listTabsCalls += 1;
				return listTabsCalls <= 2 ? tabs : tabs;
			},
			getNewlyOpenedTabs: (previousTabs, currentTabs) => {
				const previousTargetIds = new Set(
					(previousTabs ?? []).map((tab) => tab.targetId),
				);
				return currentTabs.filter(
					(tab) => !previousTargetIds.has(tab.targetId),
				);
			},
			resolveCurrentTabIndex: async () =>
				tabs.findIndex((tab) => tab.targetId === currentTargetId),
			switchTab: async (browser, targetId) => {
				currentTargetId = targetId;
				browser.currentTargetId = targetId;
			},
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
			}),
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = [tabs[0]];
		session.browser.currentTargetId = currentTargetId;

		const result = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: [],
			autoSwitchToNewTab: true,
		});

		assert.strictEqual(result.mode, "browse");
		if (result.mode === "browse") {
			assert.strictEqual(
				result.context.current_url,
				"https://example.com/results",
			);
			assert.strictEqual(result.context.current_tab, 1);
			assert.strictEqual(result.context.projection, 'div ref="2": results');
		}
		assert.strictEqual(currentTargetId, "tab-2");
	});

	it("step(browse) saves a newly opened PDF and keeps source context", async () => {
		const downloadDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-pdf-tab-download-"),
		);
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-pdf",
				title: "report.pdf",
				url: "https://example.com/report.pdf",
			},
		];
		let currentTargetId = "tab-1";
		const switchedTargets: string[] = [];
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () => 'a ref="1": Open report',
			listTabs: async () => tabs,
			getNewlyOpenedTabs: (previousTabs, currentTabs) => {
				const previousTargetIds = new Set(
					(previousTabs ?? []).map((tab) => tab.targetId),
				);
				return currentTabs.filter(
					(tab) => !previousTargetIds.has(tab.targetId),
				);
			},
			resolveCurrentTabIndex: async () => 0,
			downloadFileFromUrl: async () => {
				const destination = path.join(downloadDir, "report.pdf");
				fs.writeFileSync(destination, "%PDF-1.7");
				return destination;
			},
			switchTab: async (_browser, targetId) => {
				switchedTargets.push(targetId);
				currentTargetId = targetId;
			},
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
			}),
		});
		await createSession(deps, {
			port: 9222,
			headless: true,
			downloadDir,
		});
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = [tabs[0]];
		session.browser.currentTargetId = currentTargetId;
		session.browser.downloadDir = downloadDir;
		session.downloadedFileSignatures = new Map();
		session.downloadedNewFilePaths = new Set();

		try {
			const result = await step(deps, {
				mode: "browse",
				port: 9222,
				generatedActions: [{ click: "1" }],
			});

			assert.strictEqual(result.mode, "browse");
			if (result.mode === "browse") {
				assert.strictEqual(
					result.context.current_url,
					"https://example.com/search",
				);
				assert.strictEqual(
					result.context.projection,
					'a ref="1": Open report',
				);
				assert.deepEqual(result.context.downloaded_files, [
					"[NEW] ./report.pdf",
				]);
				assert.include(
					result.execution.interaction_errors,
					"Downloaded newly opened PDF; stayed on source tab.",
				);
			}
			assert.deepEqual(switchedTargets, []);
			assert.strictEqual(currentTargetId, "tab-1");
		} finally {
			fs.rmSync(downloadDir, { recursive: true, force: true });
		}
	});

	it("step(browse) ignores blank download tabs and restores source tab context", async () => {
		const downloadDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-blank-tab-download-"),
		);
		const tabs = [
			{
				targetId: "tab-1",
				title: "Fiscalité - My SPEDIDAM",
				url: "https://myspedidam.fr/Fiscalite",
			},
			{
				targetId: "tab-2",
				title: "New tab",
				url: "about:blank",
			},
		];
		let currentTargetId = "tab-1";
		const switchedTargets: string[] = [];
		const deps = createMockCoreDeps({
			getCurrentURL: async () =>
				tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
			getPageProjection: async () =>
				currentTargetId === "tab-1" ? 'a ref="1": Relevé fiscal' : "",
			listTabs: async () => tabs,
			getNewlyOpenedTabs: (previousTabs, currentTabs) => {
				const previousTargetIds = new Set(
					(previousTabs ?? []).map((tab) => tab.targetId),
				);
				return currentTabs.filter(
					(tab) => !previousTargetIds.has(tab.targetId),
				);
			},
			resolveCurrentTabIndex: async () =>
				tabs.findIndex((tab) => tab.targetId === currentTargetId),
			switchTab: async (browser, targetId) => {
				switchedTargets.push(targetId);
				currentTargetId = targetId;
				browser.currentTargetId = targetId;
			},
			executeActions: async () => {
				currentTargetId = "tab-2";
				fs.writeFileSync(path.join(downloadDir, "37747.pdf"), "pdf");
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});
		await createSession(deps, {
			port: 9222,
			headless: true,
			downloadDir,
		});
		const session = deps.registry.get(9222)!;
		session.previousStepTabs = [tabs[0]];
		session.browser.currentTargetId = currentTargetId;
		session.browser.downloadDir = downloadDir;
		session.downloadedFileSignatures = new Map();
		session.downloadedNewFilePaths = new Set();

		try {
			const result = await step(deps, {
				mode: "browse",
				port: 9222,
				generatedActions: [{ click: "1" }],
				autoSwitchToNewTab: true,
			});

			assert.strictEqual(result.mode, "browse");
			if (result.mode === "browse") {
				assert.strictEqual(
					result.context.current_url,
					"https://myspedidam.fr/Fiscalite",
				);
				assert.strictEqual(result.context.current_tab, 0);
				assert.strictEqual(
					result.context.projection,
					'a ref="1": Relevé fiscal',
				);
				assert.deepEqual(result.context.open_tabs, [
					"Fiscalité - My SPEDIDAM",
					"New tab",
				]);
				assert.deepEqual(result.context.downloaded_files, [
					"[NEW] ./37747.pdf",
				]);
				assert.include(
					result.execution.interaction_errors,
					"Ignored blank download tab; stayed on source tab.",
				);
			}
			assert.deepEqual(switchedTargets, ["tab-1"]);
			assert.strictEqual(currentTargetId, "tab-1");
		} finally {
			fs.rmSync(downloadDir, { recursive: true, force: true });
		}
	});

	it("step(browse) surfaces malformed action normalization diagnostics", async () => {
		let executedActions: unknown[] | null = null;
		const deps = createMockCoreDeps({
			executeActions: async (params) => {
				executedActions = params.actions;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});
		await createSession(deps, { port: 9222, headless: true });

		const result = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: {
				actions: [
					{
						type: "user_takeover",
						category: "authentication",
						reason: "Use secure authentication handling.",
					},
				],
			},
		});

		assert.isNull(executedActions);
		assert.strictEqual(result.mode, "browse");
		if (result.mode === "browse") {
			assert.include(
				result.execution.interaction_errors.join(" | "),
				'action_normalization: actions[0]: user_takeover requires a non-empty "request" string',
			);
		}
	});

	it("step(browse) tolerates execution/context refresh failures and falls back to safe defaults", async () => {
		let failCurrentUrl = false;
		const deps = createMockCoreDeps({
			listTabs: async () => [
				{
					targetId: "tab-1",
					title: "Home",
					url: "https://fallback.example",
				},
			],
			executeActions: async () => {
				throw new Error("action runner exploded");
			},
			getCurrentURL: async () => {
				if (failCurrentUrl) {
					throw new Error("url unavailable");
				}
				return "https://example.com";
			},
			resolveCurrentTabIndex: async () => {
				throw new Error("tab unavailable");
			},
			getPageProjection: async () => {
				throw new Error("dom unavailable");
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		failCurrentUrl = true;

		const result = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: { actions: [{ click: "1" }] },
		});
		assert.strictEqual(result.mode, "browse");
		if (result.mode === "browse") {
			assert.deepEqual(result.context.valid_refs, []);
			assert.strictEqual(
				result.context.current_url,
				"https://fallback.example",
			);
			assert.include(
				result.execution.interaction_errors.join(" | "),
				"execute_actions: action runner exploded",
			);
			assert.include(
				result.execution.interaction_errors.join(" | "),
				"context(projection): dom unavailable",
			);
		}
	});

	it("step(browse) records tab refresh failures before and after execution", async () => {
		let listTabsCallCount = 0;
		const deps = createMockCoreDeps({
			listTabs: async () => {
				listTabsCallCount += 1;
				if (listTabsCallCount === 1) {
					throw new Error("tabs before unavailable");
				}
				throw new Error("tabs after unavailable");
			},
			executeActions: async (params) => {
				const automatedResult = await params.attemptAutomatedAuthTakeover?.({});
				assert.deepEqual(automatedResult, { handled: false });
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});
		await createSession(deps, { port: 9222, headless: true });
		const session = deps.registry.get(9222)!;
		session.authTakeover = {
			enabled: false,
			requestAuthDomainCandidates: undefined,
			requestAuthIdentifierForDomain: undefined,
			requestAuthPasswordForDomain: undefined,
			protectedRefs: new Set<string>(),
			suppressScreenshots: false,
		};

		const result = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: [],
		});
		assert.strictEqual(result.mode, "browse");
		if (result.mode === "browse") {
			assert.include(
				result.execution.interaction_errors.join(" | "),
				"context(open_tabs:before): tabs before unavailable",
			);
			assert.include(
				result.execution.interaction_errors.join(" | "),
				"context(open_tabs:after): tabs after unavailable",
			);
		}
	});

	it("step(browse) stringifies non-Error failures in interaction refresh paths", async () => {
		const deps = createMockCoreDeps({
			executeActions: async () => {
				throw "string failure";
			},
		});
		await createSession(deps, { port: 9222, headless: true });

		const result = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: [],
		});
		assert.strictEqual(result.mode, "browse");
		if (result.mode === "browse") {
			assert.include(
				result.execution.interaction_errors.join(" | "),
				"execute_actions: string failure",
			);
		}
	});

	it("step(browse) handles shorthand tool/action inputs, invalid tab indices, and valid-ref extraction failures", async () => {
		const deps = createMockCoreDeps({
			getCurrentURL: async () => "",
			listTabs: async () => [
				{
					targetId: "tab-1",
					title: "Fallback",
					url: "https://fallback.example",
				},
			],
			resolveCurrentTabIndex: async () => 99,
			getPageProjection: async () => 'div ref="1": hello',
			extractValidRefs: () => {
				throw new Error("bad bids");
			},
		});
		await createSession(deps, { port: 9222, headless: true });

		const toolsResult = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: { tools: [{ click: "1" }] },
		});
		assert.strictEqual(toolsResult.mode, "browse");
		if (toolsResult.mode === "browse") {
			assert.strictEqual(toolsResult.context.current_tab, 0);
			assert.strictEqual(
				toolsResult.context.current_url,
				"https://fallback.example",
			);
			assert.deepEqual(toolsResult.context.valid_refs, []);
			assert.include(
				toolsResult.execution.interaction_errors.join(" | "),
				"context(valid_refs): bad bids",
			);
		}

		const passthroughResult = await step(deps, {
			mode: "browse",
			port: 9222,
			generatedActions: "not-an-action-array",
		});
		assert.strictEqual(passthroughResult.mode, "browse");
	});

	it("step(process_model_step_output) normalizes model output and appends stripped history", async () => {
		const deps = createMockCoreDeps();
		const stepsHistory: Array<{
			payload: Record<string, unknown>;
			assistant: unknown;
		}> = [];

		const result = await step(deps, {
			mode: "process_model_step_output",
			rawStepOutput: {
				thinking: "plan",
				tools: [{ click: "1" }],
				done: false,
				result: { foo: "bar" },
			},
			promptPayload: {
				task: "task",
				plan: ["Step 1"],
				projection: "<div>dom</div>",
				validRefs: ["1"],
				currentURL: "https://example.com",
			},
			stepsHistory,
		});

		assert.strictEqual(result.mode, "process_model_step_output");
		if (result.mode === "process_model_step_output") {
			assert.strictEqual(result.step.done, false);
			assert.strictEqual(result.step.actions.length, 1);
			assert.notProperty(result.step, "previousStepStatus");
			assert.notProperty(result.step, "previousStepOutcome");
			assert.notProperty(result.step, "currentStateObservation");
			assert.notProperty(result.step, "nextActionRationale");
		}
		assert.strictEqual(stepsHistory.length, 1);
		assert.deepEqual(stepsHistory[0].payload, {
			currentURL: "https://example.com",
		});
		assert.isString(stepsHistory[0].assistant);
		const assistant = yaml.load(String(stepsHistory[0].assistant)) as Record<
			string,
			unknown
		>;
		assert.strictEqual(assistant.thinking, "plan");
		assert.deepEqual(assistant.tools, [{ click: "1" }]);
		assert.strictEqual(assistant.done, false);
		assert.deepEqual(assistant.result, { foo: "bar" });
		assert.notProperty(assistant, "previousStepStatus");
		assert.notProperty(assistant, "previousStepOutcome");
	});

	it("rejects a malformed action list before mutating checklist or history", async () => {
		const checklist = [
			{
				id: "C1",
				requirement: "Submit the form.",
				status: "TODO" as const,
			},
		];
		const stepsHistory: Array<{
			payload: Record<string, unknown>;
			assistant: unknown;
		}> = [];

		let thrown: unknown;
		try {
			await step(createMockCoreDeps(), {
				mode: "process_model_step_output",
				rawStepOutput: {
					checklistUpdate: { C1: "done" },
					tools: [{ click: "r1" }, { type: { text: "missing ref" } }],
				},
				promptPayload: { task: "task" },
				stepsHistory,
				sessionChecklist: checklist,
			});
		} catch (error) {
			thrown = error;
		}

		assert.instanceOf(thrown, ModelStepActionContractError);
		assert.deepEqual(checklist, [
			{
				id: "C1",
				requirement: "Submit the form.",
				status: "TODO",
			},
		]);
		assert.deepEqual(stepsHistory, []);
	});

	it("step(process_model_step_output) restores OpenAI action context when enabled", async () => {
		const result = await step(createMockCoreDeps(), {
			mode: "process_model_step_output",
			rawStepOutput: {
				previousStepStatus: "progressed",
				previousStepOutcome: "Opened the form.",
				currentStateObservation: "The form is visible.",
				nextActionRationale: "Fill the form.",
				actions: [],
				done: false,
			},
			promptPayload: { currentURL: "https://example.com" },
			stepsHistory: [],
			executorContextPolicy: OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
		});

		assert.strictEqual(result.mode, "process_model_step_output");
		if (result.mode === "process_model_step_output") {
			assert.deepInclude(result.step, {
				previousStepStatus: "progressed",
				previousStepOutcome: "Opened the form.",
				currentStateObservation: "The form is visible.",
				nextActionRationale: "Fill the form.",
			});
			const historyAssistant = yaml.load(
				String(result.history_entry.assistant),
			) as Record<string, unknown>;
			assert.deepInclude(historyAssistant, {
				previousStepStatus: "progressed",
				previousStepOutcome: "Opened the form.",
				currentStateObservation: "The form is visible.",
				nextActionRationale: "Fill the form.",
			});
		}
	});

	it("step(process_model_step_output) retains reasoning with current context", async () => {
		configFeatureFlags.semanticProjectionHistory = "current";
		const stepsHistory: Array<{
			payload: Record<string, unknown>;
			assistant: unknown;
			reasoningTokens?: string;
		}> = [];

		await step(createMockCoreDeps(), {
			mode: "process_model_step_output",
			rawStepOutput: {
				actions: [],
				done: false,
			},
			promptPayload: {
				task: "task",
				currentURL: "https://example.com",
			},
			stepsHistory,
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
			openAIEncryptedResponses: false,
			reasoningTokens: "  Persist this trace.  ",
		});

		assert.lengthOf(stepsHistory, 1);
		assert.strictEqual(stepsHistory[0].reasoningTokens, "Persist this trace.");
		assert.deepEqual(yaml.load(String(stepsHistory[0].assistant)), {
			actions: [],
			done: false,
		});
	});

	it("step(process_model_step_output) retains reasoning with cumulative context", async () => {
		configFeatureFlags.semanticProjectionHistory = "cumulative";
		const stepsHistory: Array<{
			payload: Record<string, unknown>;
			assistant: unknown;
			reasoningTokens?: string;
		}> = [];

		await step(createMockCoreDeps(), {
			mode: "process_model_step_output",
			rawStepOutput: {
				actions: [],
				done: false,
			},
			promptPayload: {
				task: "task",
				currentURL: "https://example.com",
				projectionContextMode: "reset",
				projection: "<main>current</main>",
			},
			stepsHistory,
			executorContextPolicy: OPENAI_EXECUTOR_CONTEXT_POLICY,
			reasoningTokens: "Keep this reasoning in assistant history.",
		});

		assert.lengthOf(stepsHistory, 1);
		assert.strictEqual(
			stepsHistory[0].reasoningTokens,
			"Keep this reasoning in assistant history.",
		);
	});

	it("step(process_model_step_output) omits reasoning when disabled", async () => {
		const stepsHistory: Array<{
			payload: Record<string, unknown>;
			assistant: unknown;
			reasoningTokens?: string;
		}> = [];

		await step(createMockCoreDeps(), {
			mode: "process_model_step_output",
			rawStepOutput: { actions: [], done: false },
			promptPayload: {
				task: "task",
				currentURL: "https://example.com",
			},
			stepsHistory,
			executorContextPolicy: NON_OPENAI_EXECUTOR_CONTEXT_POLICY,
			reasoningTokens: "Do not retain this trace.",
		});

		assert.notProperty(stepsHistory[0], "reasoningTokens");
	});

	it("processModelOutputAndBrowse does not complete from model-authored result", async () => {
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
		});
		await createSession(deps, { port: 9222, headless: true });
		const stepsHistory: Array<{
			payload: Record<string, unknown>;
			assistant: unknown;
		}> = [];

		const result = await processModelOutputAndBrowse(deps, 9222, {
			mode: "process_model_step_output",
			rawStepOutput: {
				thinking: "Done",
				done: true,
				result: "Success",
			},
			promptPayload: {
				task: "task",
				currentURL: "https://example.com",
			},
			stepsHistory,
		});

		assert.isFalse(result.step.done);
		assert.isFalse(result.successful);
		assert.isUndefined(result.step.result);
		assert.isDefined(result.browse);
		const assistant = yaml.load(
			String(stepsHistory[0]?.assistant),
		) as Record<string, unknown>;
		assert.strictEqual(assistant.thinking, "Done");
		assert.strictEqual(assistant.done, true);
		assert.strictEqual(assistant.result, "Success");
	});

	it("processModelOutputAndBrowse preserves verifier-fail state after return_results", async () => {
		const deps = createMockCoreDeps({
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				returnedResult: "Upload initiated.",
			}),
			verifyTaskSuccess: async () => ({
				success: false,
				summary: "Upload did not actually finish.",
				reasons: ["The final step admitted the upload required manual action."],
				model: "gpt-test",
				provider: "openai",
				usage: {
					input_tokens: 2,
					output_tokens: 1,
					total_tokens: 3,
				},
			}),
		});
		await createSession(deps, { port: 9222, headless: true });

		const result = await processModelOutputAndBrowse(deps, 9222, {
			mode: "process_model_step_output",
			rawStepOutput: {
				thinking: "Done",
				actions: [{ type: "return_results" }],
			},
			promptPayload: {
				task: "Upload the file and confirm it is present.",
				currentURL: "https://example.com",
			},
			stepsHistory: [],
		});

		assert.isTrue(result.step.done);
		assert.isFalse(result.successful);
		assert.strictEqual(
			result.successVerification?.summary,
			"Upload did not actually finish.",
		);
		assert.deepEqual(result.successVerification?.reasons, [
			"The final step admitted the upload required manual action.",
		]);
		assert.isDefined(result.browse);
	});

	it("processModelOutputAndBrowse passes stripped prior step history to the verifier", async () => {
		let capturedHistory: import("../src/agents/types.js").Message[] | undefined;
		const deps = createMockCoreDeps({
			verifyTaskSuccess: async (input) => {
				capturedHistory = input.historyMessages;
				return {
					success: true,
					summary: "Verified in test fixture.",
					reasons: [],
					model: "gpt-test",
					provider: "openai",
					usage: {
						input_tokens: 2,
						output_tokens: 1,
						total_tokens: 3,
					},
				};
			},
		});
		await createSession(deps, { port: 9222, headless: true });

		const result = await processModelOutputAndBrowse(deps, 9222, {
			mode: "process_model_step_output",
			rawStepOutput: {
				thinking: "Done",
				actions: [{ type: "return_results" }],
			},
			promptPayload: {
				task: "task",
				currentURL: "https://example.com/final",
			},
			stepsHistory: [
				{
					payload: {
						currentURL: "https://example.com/previous",
						plan: ["Step 1"],
					},
					assistant: {
						thinking: "Click the button",
						tools: [{ click: "1" }],
						done: false,
					},
				},
			],
		});

		assert.isTrue(result.successful);
		assert.isArray(capturedHistory);
		assert.lengthOf(capturedHistory ?? [], 4);
		assert.strictEqual(capturedHistory?.[0]?.role, "user");
		assert.include(String(capturedHistory?.[0]?.content ?? ""), "currentURL:");
		assert.include(
			String(capturedHistory?.[0]?.content ?? ""),
			"https://example.com/previous",
		);
		assert.strictEqual(capturedHistory?.[1]?.role, "assistant");
		assert.include(String(capturedHistory?.[1]?.content ?? ""), "tools:");
		assert.include(String(capturedHistory?.[1]?.content ?? ""), "thinking:");
		assert.strictEqual(capturedHistory?.[2]?.role, "user");
		assert.strictEqual(capturedHistory?.[3]?.role, "assistant");
		assert.include(
			String(capturedHistory?.[3]?.content ?? ""),
			"return_results",
		);
	});

	it("processModelOutputAndBrowse preserves thinking in verifier history", async () => {
		let capturedHistory: Array<{ role: string; content: unknown }> | null =
			null;
		const deps = createMockCoreDeps({
			verifyTaskSuccess: async (input) => {
				capturedHistory = input.historyMessages.map((message) => ({
					role: message.role,
					content: message.content,
				}));
				return {
					success: true,
					summary: "Verifier saw history.",
					reasons: [],
					model: "gpt-test",
					provider: "openai",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				};
			},
		});

		await createSession(deps, { port: 9222, headless: true });
		await processModelOutputAndBrowse(deps, 9222, {
			mode: "process_model_step_output",
			rawStepOutput: {
				thinking: "Done",
				actions: [{ type: "return_results" }],
			},
			promptPayload: {
				task: "task",
				currentURL: "https://example.com/final",
			},
			stepsHistory: [
				{
					payload: {
						currentURL: "https://example.com/previous",
						plan: ["Step 1"],
					},
					assistant: {
						thinking: "Click the button",
						tools: [{ click: "1" }],
						done: false,
					},
				},
			],
		});

		assert.strictEqual(capturedHistory?.[1]?.role, "assistant");
		assert.include(String(capturedHistory?.[1]?.content ?? ""), "thinking:");
	});

	it("processModelOutputAndBrowse browses when the model step is not done", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, { port: 9222, headless: true });

		const result = await processModelOutputAndBrowse(deps, 9222, {
			mode: "process_model_step_output",
			rawStepOutput: {
				thinking: "Click",
				tools: [{ click: "1" }],
				done: false,
			},
			promptPayload: {
				task: "task",
				currentURL: "https://example.com",
			},
			stepsHistory: [],
		});

		assert.isFalse(result.step.done);
		assert.isDefined(result.browse);
	});

	it("closeSession removes session", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, { port: 9222, headless: true });

		await closeSession(deps, 9222);
		assert.isUndefined(deps.registry.get(9222));
	});

	it("runAgent executes the full loop in one call", async () => {
		const deps = createMockCoreDeps();
		let callCount = 0;

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
				pinnedMemoryContent: "Prepared context",
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 3,
			generateStep: async ({ stepNumber, messages }) => {
				callCount += 1;
				assert.isAtLeast(messages.length, 2);
				if (stepNumber === 1) {
					return {
						data: {
							thinking: "Click the result",
							actions: [{ type: "click", ref: "1" }],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}

				return {
					data: {
						thinking: "Task is complete",
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.strictEqual(callCount, 2);
		assert.isTrue(result.completed);
		assert.isTrue(result.successful);
		assert.strictEqual(result.result, "Success");
		assert.notProperty(result.preprocess, "plan");
		assert.lengthOf(result.steps, 2);
		assert.strictEqual(result.steps[0].model.done, false);
		assert.strictEqual(result.steps[1].model.done, true);
		assert.strictEqual(result.tokenTotals.input_tokens, 18);
		assert.strictEqual(result.tokenTotals.output_tokens, 7);
		assert.strictEqual(result.tokenTotals.total_tokens, 25);
		assert.strictEqual(result.stepsHistory.length, 2);
		assert.isUndefined(deps.registry.get(9222));
	});

	it("runAgent permanently omits planning surfaces", async () => {
		const observedPayloads: Record<string, unknown>[] = [];
		const observedMessages: unknown[] = [];
		const deps = createMockCoreDeps();

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 1,
			generateStep: async ({ promptPayload, messages }) => {
				observedPayloads.push(promptPayload);
				observedMessages.push(messages);
				return {
					data: {
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.notProperty(result.preprocess, "plan");
		assert.lengthOf(observedPayloads, 1);
		assert.notProperty(observedPayloads[0], "plan");
		assert.notInclude(
			JSON.stringify(observedMessages),
			"previousStepPlanUpdate",
		);
		assert.notInclude(JSON.stringify(observedMessages), "regenerate_plan");
		assert.notMatch(JSON.stringify(observedMessages), /\bplan/i);
	});

	it("runAgent forwards the configured reasoning effort to every executor step", async () => {
		const reasoningByStep: string[] = [];
		const deps = createMockCoreDeps();

		await runAgent(deps, {
			session: {
				port: 9236,
				headless: true,
				forceRestart: true,
				url: "https://example.com",
			},
			task: "Finish",
			stageLLMs: {
				findTargetURL: {
					provider: "openai",
					model: "gpt-5.4",
					reasoningEffort: "low",
				},
				createChecklist: {
					provider: "openai",
					model: "gpt-5.4",
					reasoningEffort: "low",
				},
				runAgent: {
					provider: "together",
					model: "zai-org/GLM-5.2",
					reasoningEffort: "max",
				},
				dataExtraction: {
					provider: "openai",
					model: "gpt-5.4",
					reasoningEffort: "low",
				},
			},
			featureFlags: {
				...deps.featureFlags,
			},
			maxSteps: 3,
			generateStep: async ({ stepNumber, llmOptions }) => {
				reasoningByStep.push(llmOptions.reasoningEffort);
				return {
					data: {
						actions: [],
						done: stepNumber === 3,
						result: stepNumber === 3 ? "done" : undefined,
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

		assert.deepEqual(reasoningByStep, ["max", "max", "max"]);
	});

	it("runAgent exposes pinned memory only after memory_read and keeps memory_write scoped to the scratchpad", async () => {
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
		});
		const observedMemoryContent: unknown[] = [];

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
				pinnedMemoryContent: "Pinned workspace context",
			},
			task: "Use pinned context",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 5,
			generateStep: async ({ stepNumber, promptPayload }) => {
				observedMemoryContent.push(promptPayload.memoryContent);
				assert.include(
					String(promptPayload.memoryAvailable),
					"Prepared workspace/file context is available to the executor through memory_read.",
				);
				if (stepNumber === 1) {
					assert.isUndefined(promptPayload.memoryContent);
					return {
						data: {
							thinking: "Read preloaded memory",
							actions: [
								{
									type: "memory_read",
								},
							],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}

				if (stepNumber === 2) {
					assert.strictEqual(
						promptPayload.memoryContent,
						[
							"Runtime-pinned workspace/file context:",
							"Pinned workspace context",
							"",
							"Mutable browser scratchpad:",
							"(empty)",
							"",
							"Extracted page data/result memory:",
							"(empty)",
						].join("\n"),
					);
					return {
						data: {
							thinking: "Write scratchpad",
							actions: [
								{
									type: "memory_write",
									content: "Mutable scratch note",
								},
							],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}

				if (stepNumber === 3) {
					assert.isUndefined(promptPayload.memoryContent);
					return {
						data: {
							thinking: "Read updated memory",
							actions: [
								{
									type: "memory_read",
								},
							],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}

				assert.strictEqual(
					promptPayload.memoryContent,
					[
						"Runtime-pinned workspace/file context:",
						"Pinned workspace context",
						"",
						"Mutable browser scratchpad:",
						"Mutable scratch note",
						"",
						"Extracted page data/result memory:",
						"(empty)",
					].join("\n"),
				);
				return {
					data: {
						thinking: "Task is complete",
						actions: [
							{
								type: "return_results",
								results: [
									{
										link: "https://target.example",
										summary: "Success",
									},
								],
							},
						],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.deepEqual(observedMemoryContent, [
			undefined,
			[
				"Runtime-pinned workspace/file context:",
				"Pinned workspace context",
				"",
				"Mutable browser scratchpad:",
				"(empty)",
				"",
				"Extracted page data/result memory:",
				"(empty)",
			].join("\n"),
			undefined,
			[
				"Runtime-pinned workspace/file context:",
				"Pinned workspace context",
				"",
				"Mutable browser scratchpad:",
				"Mutable scratch note",
				"",
				"Extracted page data/result memory:",
				"(empty)",
			].join("\n"),
		]);
		assert.isTrue(result.completed);
		assert.deepEqual(yaml.load(result.result ?? ""), [
			{
				link: "https://target.example",
				summary: "Success",
			},
		]);
	});

	it("runAgent can return extracted-data memory after memory_read", async () => {
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
			getPageProjection: async () =>
				[
					'main ref="r1": Results',
					'  article ref="r2": First line. Second line.',
				].join("\n"),
			extractDataResultsFromSnapshot: async ({
				currentUrl,
				pageProjection,
			}) => {
				assert.strictEqual(currentUrl, "https://target.example");
				assert.strictEqual(
					pageProjection,
					'article ref="r2": First line. Second line.',
				);
				return {
					items: [
						{
							link: "https://example.com/snapshot-result",
							summary: "First line. Second line.",
						},
					],
				};
			},
			createChecklist: async () => ({ items: ["Collect result"] }),
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Return the stored result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 4,
			generateStep: async ({ stepNumber, promptPayload }) => {
				if (stepNumber === 1) {
					assert.notProperty(promptPayload, "extractDataUrlsByRef");
					return {
						data: {
							thinking: "Extract result-ready content",
							actions: [
								{
									type: "extract_data",
									root: "r2",
								},
							],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}
				if (stepNumber === 2) {
					assert.isUndefined(promptPayload.memoryContent);
					return {
						data: {
							thinking: "Read memory",
							actions: [{ type: "memory_read" }],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}

				assert.isString(promptPayload.memoryContent);
				return {
					data: {
						thinking: "Return stored result",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 10,
						output_tokens: 4,
						total_tokens: 14,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.isTrue(result.completed);
		assert.deepStrictEqual(yaml.load(result.result ?? ""), [
			{
				link: "https://example.com/snapshot-result",
				summary: "First line. Second line.",
			},
		]);
		assert.isTrue(result.steps.at(-1)?.model.done);
		for (const historyEntry of result.stepsHistory) {
			const assistant = yaml.load(
				String(historyEntry.assistant),
			) as Record<string, unknown>;
			assert.property(assistant, "thinking");
			assert.property(assistant, "actions");
			assert.strictEqual(assistant.done, false);
			assert.notProperty(assistant, "result");
		}
		for (const loopEntry of result.mainLoopEntries) {
			const assistant = yaml.load(
				String(loopEntry.messages.at(-1)?.content ?? ""),
			) as Record<string, unknown>;
			assert.property(assistant, "thinking");
			assert.property(assistant, "actions");
			assert.strictEqual(assistant.done, false);
			assert.notProperty(assistant, "result");
		}
	});

	it("runAgent advances to the next step while memory_read waits for extract_data", async () => {
		const extractionStarted = deferred();
		const releaseExtraction = deferred();
		const secondStepGenerated = deferred();
		let extractionFinished = false;
		const generatedSteps: number[] = [];
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
			getPageProjection: async () =>
				['main ref="r1": Results', '  article ref="r2": Extracted note.'].join(
					"\n",
				),
			extractDataResultsFromSnapshot: async ({ pageProjection }) => {
				extractionStarted.resolve();
				await releaseExtraction.promise;
				extractionFinished = true;
				assert.strictEqual(pageProjection, 'article ref="r2": Extracted note.');
				return {
					items: [
						{
							link: "https://example.com/item",
							summary: "item extracted note",
						},
					],
				};
			},
			createChecklist: async () => ({ items: ["Collect result"] }),
		});

		const resultPromise = runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Return extracted result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 6,
			generateStep: async ({ stepNumber, promptPayload }) => {
				generatedSteps.push(stepNumber);
				if (stepNumber === 1) {
					return {
						data: {
							thinking: "Extract result",
							actions: [
								{
									type: "extract_data",
									root: "r2",
								},
							],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}
				if (stepNumber === 2) {
					assert.isFalse(extractionFinished);
					assert.isUndefined(promptPayload.memoryContent);
					assert.deepEqual(promptPayload.toolObservations, [
						"extract_data was launched asynchronously (root=r2). The runtime will persist it before memory_read or return_results executes. Do not repeat this extraction unless that memory is intentionally cleared or replaced after this call.",
					]);
					secondStepGenerated.resolve();
					return {
						data: {
							thinking: "Read completed extracted data",
							actions: [{ type: "memory_read" }],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}
				assert.isString(promptPayload.memoryContent);
				return {
					data: {
						thinking: "Return completed extracted data",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 10,
						output_tokens: 4,
						total_tokens: 14,
					},
					reasoning_tokens: "",
				};
			},
		});

		await extractionStarted.promise;
		await secondStepGenerated.promise;
		assert.deepEqual(generatedSteps, [1, 2]);
		assert.isFalse(extractionFinished);
		releaseExtraction.resolve();
		const result = await resultPromise;

		assert.isTrue(result.completed);
		assert.deepStrictEqual(yaml.load(result.result ?? ""), [
			{
				link: "https://example.com/item",
				summary: "item extracted note",
			},
		]);
	});

	it("injects background extraction failures into the next step context", async () => {
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
			getPageProjection: async () => 'article ref="item": Broken extraction',
			extractDataResultsFromSnapshot: async () => {
				throw new Error("provider unavailable");
			},
		});
		await createSession(deps, { port: 9555, headless: true });

		await step(deps, {
			mode: "browse",
			port: 9555,
			generatedActions: [{ type: "extract_data", root: "item" }],
			userTask: "Extract the result",
			dataExtractionLLMOptions: {
				provider: "openai",
				model: "gpt-test",
			},
		});
		await Promise.resolve();

		const prompt = await step(deps, {
			mode: "create_prompt_for_step",
			port: 9555,
			userTask: "Extract the result",
			stepsHistory: [],
		});
		assert.strictEqual(prompt.mode, "create_prompt_for_step");
		assert.include(
			JSON.stringify(prompt.prompt.payload.interactionErrors),
			"extract_data(root=item): provider unavailable",
		);
		await closeSession(deps, 9555);
	});

	it("waits for extraction before forced finalization memory is built", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, { port: 9666, headless: true });
		const session = deps.registry.get(9666)!;
		const releaseExtraction = deferred();
		session.dataExtractionCoordinator.launch({
			root: "item",
			run: async () => {
				await releaseExtraction.promise;
				return {
					items: [
						{
							link: "https://example.com/item",
							summary: "forced finalization result",
						},
					],
				};
			},
		});

		let promptSettled = false;
		const promptPromise = step(deps, {
			mode: "create_prompt_for_step",
			port: 9666,
			userTask: "Return the result",
			stepsHistory: [],
			forceMemoryContent: true,
		}).finally(() => {
			promptSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.isFalse(promptSettled);

		releaseExtraction.resolve();
		const prompt = await promptPromise;
		assert.strictEqual(prompt.mode, "create_prompt_for_step");
		assert.include(
			String(prompt.prompt.payload.memoryContent),
			"forced finalization result",
		);
		await closeSession(deps, 9666);
	});

	it("session close discards a late extraction without recreating memory", async () => {
		const deps = createMockCoreDeps();
		await createSession(deps, { port: 9777, headless: true });
		const session = deps.registry.get(9777)!;
		const extractDataMemoryFile = session.extractDataMemoryFile;
		const releaseExtraction = deferred();
		session.dataExtractionCoordinator.launch({
			root: "item",
			run: async () => {
				await releaseExtraction.promise;
				return {
					items: [
						{
							link: "https://example.com/late",
							summary: "late result",
						},
					],
				};
			},
		});

		await closeSession(deps, 9777);
		assert.isFalse(fs.existsSync(extractDataMemoryFile));
		releaseExtraction.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.isFalse(fs.existsSync(extractDataMemoryFile));
	});

	it("does not complete return_results before memory_read", async () => {
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
		});
		await createSession(deps, { port: 9444, headless: true });

		const result = await processModelOutputAndBrowse(deps, 9444, {
			rawStepOutput: {
				thinking: "Return too early",
				actions: [{ type: "return_results" }],
				done: false,
			},
			promptPayload: {
				task: "Return the stored result",
				downloadedFiles: [],
				workspaceFiles: [],
			},
			stepsHistory: [],
		});

		assert.isFalse(result.step.done);
		assert.include(
			result.browse?.execution.interaction_errors.join(" | "),
			"return_results requires completed extract_data",
		);
	});

	it("runAgent can return extracted data written by extract_data", async () => {
		const secondMarkdown = "## Second item\n\nPrice: $20";
		let extractionCalls = 0;
		const projectionOptions: Array<
			| import("../src/browser/semantic-projection.js").SemanticProjectionOptions
			| undefined
		> = [];
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
			getPageProjection: async (_browser, options) => {
				projectionOptions.push(options);
				return [
					'main ref="r1": Results',
					'  article ref="r2": First product',
					'    a ref="r3": Open',
					"    span: Price $12",
					'  article ref="r4": Second product',
					"    span: Price $20",
				].join("\n");
			},
			extractDataResultsFromSnapshot: async ({
				currentUrl,
				pageProjection,
				llmOptions,
				task,
			}) => {
				extractionCalls += 1;
				assert.strictEqual(task, "Return extracted result");
				assert.strictEqual(currentUrl, "https://target.example");
				assert.deepStrictEqual(llmOptions, {
					provider: "openai",
					model: "gpt-test",
				});
				assert.strictEqual(
					pageProjection,
					[
						'main ref="r1": Results',
						'  article ref="r2": First product',
						'    a ref="r3": Open',
						"    span: Price $12",
						'  article ref="r4": Second product',
						"    span: Price $20",
					].join("\n"),
				);
				return {
					items: [
						{
							link: "https://example.com/item",
							summary: "## Extracted item\n\nOpen\n\nPrice: $12",
						},
						{
							link: "https://example.com/current",
							summary: secondMarkdown,
						},
					],
				};
			},
			createChecklist: async () => ({ items: ["Extract result"] }),
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Return extracted result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 4,
			generateStep: async ({ stepNumber, promptPayload }) => {
				if (stepNumber === 1) {
					return {
						data: {
							thinking: "Extract the result",
							actions: [
								{
									type: "extract_data",
									root: "r1",
								},
							],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}
				if (stepNumber === 2) {
					assert.isUndefined(promptPayload.memoryContent);
					return {
						data: {
							thinking: "Read extracted result",
							actions: [{ type: "memory_read" }],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}
				assert.isString(promptPayload.memoryContent);
				return {
					data: {
						thinking: "Return extracted result",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 10,
						output_tokens: 4,
						total_tokens: 14,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.isTrue(result.completed);
		assert.strictEqual(extractionCalls, 1);
		assert.isTrue(
			projectionOptions.some(
				(options) =>
					options?.preserveFullHrefs === true && options.omitHrefs === false,
			),
		);
		assert.isTrue(
			projectionOptions.some((options) => options?.preserveFullHrefs !== true),
		);
		const parsed = yaml.load(result.result ?? "");
		assert.deepStrictEqual(parsed, [
			{
				link: "https://example.com/item",
				summary: "## Extracted item\n\nOpen\n\nPrice: $12",
			},
			{
				link: "https://example.com/current",
				summary: secondMarkdown,
			},
		]);
	});

	it("uses rootless whole-context extraction with full hrefs in the extraction snapshot", async () => {
		setConfigFeatureFlags({ extractDataWholeContext: true });
		const domOptions: Array<
			| import("../src/browser/semantic-projection.js").SemanticProjectionOptions
			| undefined
		> = [];
		let executionDom: string | undefined;
		const deps = createMockCoreDeps({
			getPageProjection: async (_browser, options) => {
				domOptions.push(options);
				return 'main: Results\n  ref="a" href="/product": Product';
			},
			executeActions: async (params) => {
				executionDom = params.pageProjection;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});
		await createSession(deps, { port: 9229, headless: true });

		const prompt = await createPromptForStep(deps, {
			port: 9229,
			userTask: "Extract the product",
			stepsHistory: [],
		});
		await processModelOutputAndBrowse(deps, 9229, {
			rawStepOutput: {
				thinking: "Extract the page",
				actions: [{ type: "extract_data" }],
				done: false,
			},
			promptPayload: prompt.prompt.payload,
			stepsHistory: [],
		});

		assert.strictEqual(
			executionDom,
			'main: Results\n  ref="a" href="/product": Product',
		);
		assert.isTrue(
			domOptions.some(
				(options) =>
					options?.preserveFullHrefs === true && options.omitHrefs === false,
			),
		);
	});

	it("runAgent reserves the final allowed step for return_results-only finalization", async () => {
		const observedCallers: Array<string | undefined> = [];
		const observedStepKinds: Array<string | undefined> = [];
		let actionCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async ({ actions, memoryFile }) => {
				actionCalls += 1;
				fs.writeFileSync(memoryFile, "remembered note", "utf-8");
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					...(actions.some((action) => action.type === "return_results")
						? { returnedResult: "Recovered result" }
						: {}),
				};
			},
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 2,
			generateStep: async ({
				stepNumber,
				messages,
				promptPayload,
				caller,
				stepKind,
			}) => {
				observedCallers.push(caller);
				observedStepKinds.push(stepKind);
				if (stepNumber === 1) {
					return {
						data: {
							thinking: "Explore first",
							actions: [{ type: "click", ref: "1" }],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}

				assert.strictEqual(caller, "runAgent:maxStepFinalization");
				assert.strictEqual(stepKind, "max_step_finalization");
				assert.strictEqual(promptPayload.maxStepFinalization, true);
				assert.strictEqual(promptPayload.remainingSteps, 0);
				assert.strictEqual(
					promptPayload.memoryContent,
					[
						"Mutable browser scratchpad:",
						"remembered note",
						"",
						"Extracted page data/result memory:",
						"(empty)",
					].join("\n"),
				);
				assert.isAtLeast(messages.length, 3);
				assert.deepEqual(messages[messages.length - 1], {
					role: "user",
					content:
						"This is the final allowed step because the step budget is exhausted.\n\nNo more browser actions may be executed after this response.\n\nUse only the evidence already gathered in the current payload, attached images, prior history, downloads, workspace files, and memoryContent if present (including runtime-pinned workspace/file context).\n\nComplete the task through the runtime-managed result path.\n\nUse bare return_results for completed extract_data memory, or provide the final result list under return_results when it is already grounded in the current payload or memoryContent. Do not invent missing evidence.\n\nRules for this final step:\n- tools MUST contain exactly one return_results call\n- do not include done or result",
				});

				return {
					data: {
						thinking: "Return the gathered result",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.strictEqual(actionCalls, 2);
		assert.deepEqual(observedCallers, [
			undefined,
			"runAgent:maxStepFinalization",
		]);
		assert.deepEqual(observedStepKinds, [
			"executor_step",
			"max_step_finalization",
		]);
		assert.isTrue(result.completed);
		assert.isTrue(result.successful);
		assert.strictEqual(result.result, "Recovered result");
		assert.lengthOf(result.steps, 2);
		assert.isDefined(result.steps[0].browse);
		assert.isDefined(result.steps[1].browse);
		assert.strictEqual(
			result.mainLoopEntries[1]?.step_kind,
			"max_step_finalization",
		);
		const finalAssistant = yaml.load(
			String(result.mainLoopEntries[1]?.messages.at(-1)?.content ?? ""),
		) as Record<string, unknown>;
		assert.strictEqual(finalAssistant.done, false);
		assert.notProperty(finalAssistant, "result");
	});

	it("runAgent treats invalid max-step finalization output as incomplete without browsing", async () => {
		let actionCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async () => {
				actionCalls += 1;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
				};
			},
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 1,
			generateStep: async ({ caller, stepKind }) => {
				assert.strictEqual(caller, "runAgent:maxStepFinalization");
				assert.strictEqual(stepKind, "max_step_finalization");
				return {
					data: {
						thinking: "Keep browsing",
						actions: [{ type: "click", ref: "1" }],
						done: false,
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.strictEqual(actionCalls, 0);
		assert.isFalse(result.completed);
		assert.isFalse(result.successful);
		assert.lengthOf(result.steps, 1);
		assert.isUndefined(result.steps[0].browse);
		assert.strictEqual(
			result.mainLoopEntries[0]?.step_kind,
			"max_step_finalization",
		);
		assert.lengthOf(result.stepsHistory, 0);
	});

	it("runAgent retries a transient step failure and succeeds", async () => {
		const deps = createMockCoreDeps();
		let generateCalls = 0;

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 1,
			generateStep: async () => {
				generateCalls += 1;
				if (generateCalls === 1) {
					throw new Error("transient model failure");
				}
				return {
					data: {
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.isTrue(result.completed);
		assert.strictEqual(generateCalls, 2);
		assert.lengthOf(result.steps, 1);
	});

	it("runAgent fails after exhausting step retries", async () => {
		const deps = createMockCoreDeps();
		let generateCalls = 0;
		try {
			await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Find a result",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 1,
				generateStep: async () => {
					generateCalls += 1;
					throw new Error("permanent model failure");
				},
			});
			assert.fail("Expected runAgent to throw");
		} catch (error) {
			assert.include(
				String((error as Error).message),
				"permanent model failure",
			);
			assert.strictEqual(generateCalls, 3);
		}
	});

	it("runAgent aborts pending step generation without retrying", async () => {
		const deps = createMockCoreDeps();
		const controller = new AbortController();
		let generateCalls = 0;
		let forwardedSignal: AbortSignal | undefined;
		let resolveGenerateStarted!: () => void;
		const generateStarted = new Promise<void>((resolve) => {
			resolveGenerateStarted = resolve;
		});

		const runPromise = runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			abortSignal: controller.signal,
			maxSteps: 1,
			generateStep: async ({ abortSignal }) => {
				generateCalls += 1;
				forwardedSignal = abortSignal;
				resolveGenerateStarted();
				await new Promise<never>(() => {});
			},
		});

		await generateStarted;
		controller.abort();

		try {
			await runPromise;
			assert.fail("Expected runAgent to abort");
		} catch (error) {
			assert.strictEqual((error as Error).name, "AbortError");
			assert.strictEqual(generateCalls, 1);
			assert.strictEqual(forwardedSignal, controller.signal);
		}
	});

	it("runAgent retries fatal action execution errors at the step level", async () => {
		let actionCalls = 0;
		let generateCalls = 0;
		const deps = createMockCoreDeps({
			executeActions: async ({ actions }) => {
				actionCalls += 1;
				if (actionCalls === 1) {
					throw new Error("browser crashed");
				}
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					...(actions.some((action) => action.type === "return_results")
						? { returnedResult: "Success" }
						: {}),
				};
			},
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 2,
			generateStep: async ({ stepNumber }) => {
				generateCalls += 1;
				if (stepNumber === 1) {
					return {
						data: {
							actions: [{ type: "click", ref: "1" }],
							done: false,
						},
						usage: {
							input_tokens: 10,
							output_tokens: 4,
							total_tokens: 14,
						},
						reasoning_tokens: "",
					};
				}
				return {
					data: {
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.isTrue(result.completed);
		assert.strictEqual(actionCalls, 3);
		assert.strictEqual(generateCalls, 3);
	});

	it("runAgent auto-switches to a new tab by default and respects explicit disable", async () => {
		const tabs = [
			{
				targetId: "tab-1",
				title: "Search Form",
				url: "https://example.com/search",
			},
			{
				targetId: "tab-2",
				title: "Results",
				url: "https://example.com/results",
			},
		];
		let currentTargetId = "tab-1";
		let listTabsCalls = 0;
		const buildDeps = () =>
			createMockCoreDeps({
				getCurrentURL: async () =>
					tabs.find((tab) => tab.targetId === currentTargetId)?.url ?? "",
				getPageProjection: async () =>
					currentTargetId === "tab-1"
						? 'div ref="1": search'
						: 'div ref="2": results',
				listTabs: async () => {
					listTabsCalls += 1;
					return listTabsCalls === 1 ? [tabs[0]] : tabs;
				},
				getNewlyOpenedTabs: (previousTabs, currentTabs) => {
					const previousTargetIds = new Set(
						(previousTabs ?? []).map((tab) => tab.targetId),
					);
					return currentTabs.filter(
						(tab) => !previousTargetIds.has(tab.targetId),
					);
				},
				resolveCurrentTabIndex: async () =>
					tabs.findIndex((tab) => tab.targetId === currentTargetId),
				switchTab: async (_browser, targetId) => {
					currentTargetId = targetId;
				},
			});

		const defaultPlans: string[] = [];
		currentTargetId = "tab-1";
		listTabsCalls = 0;
		await runAgent(buildDeps(), {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: createMockCoreDeps().featureFlags,
			maxSteps: 1,
			generateStep: async ({ promptPayload }) => {
				defaultPlans.push(String(promptPayload.currentURL ?? ""));
				return {
					data: {
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		const disabledPlans: string[] = [];
		currentTargetId = "tab-1";
		listTabsCalls = 0;
		await runAgent(buildDeps(), {
			session: {
				port: 9333,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: createMockCoreDeps().featureFlags,
			autoSwitchToNewTab: false,
			maxSteps: 1,
			generateStep: async ({ promptPayload }) => {
				disabledPlans.push(String(promptPayload.currentURL ?? ""));
				return {
					data: {
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				};
			},
		});

		assert.deepEqual(defaultPlans, ["https://example.com/results"]);
		assert.deepEqual(disabledPlans, ["https://example.com/search"]);
	});

	it("runAgent uses the fixed delay after non-terminal steps and emits timing logs above threshold", async () => {
		const logs: string[] = [];
		const originalConsoleLog = console.log;
		let settleCalls = 0;
		console.log = (...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		};
		try {
			const deps = createMockCoreDeps({
				waitForAllOpenTabsToSettle: async () => {
					settleCalls += 1;
					await new Promise((resolve) => setTimeout(resolve, 510));
				},
			});

			await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Find a result",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 2,
				generateStep: async ({ stepNumber }) =>
					stepNumber === 1
						? {
								data: {
									previousStepStatus: "none",
									previousStepOutcome: "",
									currentStateObservation: "",
									nextActionRationale: "",
									actions: [{ type: "click", ref: "1" }],
									done: false,
								},
								usage: {
									input_tokens: 10,
									output_tokens: 4,
									total_tokens: 14,
									time_to_first_token_ms: 20,
									generation_time_ms: 600,
								},
								reasoning_tokens: "",
							}
						: {
								data: {
									previousStepStatus: "progressed",
									previousStepOutcome: "Clicked the result.",
									currentStateObservation: "Result content is visible.",
									nextActionRationale: "Return the requested result.",
									actions: [{ type: "return_results" }],
								},
								usage: {
									input_tokens: 8,
									output_tokens: 3,
									total_tokens: 11,
									time_to_first_token_ms: 10,
									generation_time_ms: 25,
								},
								reasoning_tokens: "",
							},
			});

			assert.strictEqual(settleCalls, 0);
			assert.isTrue(
				logs.some(
					(entry) =>
						entry.includes("[step 1 timings]") &&
						entry.includes("wait_for_settle="),
				),
				"missing fixed-delay step timing log",
			);
			assert.isFalse(logs.some((entry) => entry.includes("token-timing")));
		} finally {
			console.log = originalConsoleLog;
		}
	});

	it("runAgent persists step context artifacts when save_steps_context is enabled", async () => {
		const deps = createMockCoreDeps();
		try {
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();

			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Find a result",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: {
					...deps.featureFlags,
					preStepScreenshotInLatestUserPrompt: true,
				},
				maxSteps: 1,
				generateStep: async () => ({
					data: {
						thinking: "Task is complete",
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				}),
			});

			assert.isTrue(result.completed);
			assert.isTrue(fs.existsSync(path.join(CONTEXT_DIR, "context-001.yaml")));
			assert.isTrue(
				fs.existsSync(path.join(STEPS_DIR, "step-001.projection.txt")),
			);
			assert.isTrue(
				fs.existsSync(
					path.join(
						CONTEXT_DIR,
						"screenshots",
						"step-001",
						"pre-step-current-page.jpg",
					),
				),
			);
		} finally {
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();
		}
	});

	it("runAgent persists step context artifacts in explicit artifact directories", async () => {
		const deps = createMockCoreDeps();
		const artifactsRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-artifacts-"),
		);
		const contextDir = path.join(artifactsRoot, "context");
		const stepsDir = path.join(artifactsRoot, "steps");
		try {
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();

			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Find a result",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 1,
				artifactDirectories: {
					contextDir,
					stepsDir,
				},
				generateStep: async () => ({
					data: {
						thinking: "Task is complete",
						actions: [{ type: "return_results" }],
					},
					usage: {
						input_tokens: 8,
						output_tokens: 3,
						total_tokens: 11,
					},
					reasoning_tokens: "",
				}),
			});

			assert.isTrue(result.completed);
			assert.isTrue(fs.existsSync(path.join(contextDir, "context-001.yaml")));
			assert.isTrue(
				fs.existsSync(path.join(stepsDir, "step-001.projection.txt")),
			);
			assert.isFalse(fs.existsSync(path.join(CONTEXT_DIR, "context-001.yaml")));
			assert.isFalse(
				fs.existsSync(path.join(STEPS_DIR, "step-001.projection.txt")),
			);
		} finally {
			fs.rmSync(artifactsRoot, { recursive: true, force: true });
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();
		}
	});

	it("runAgent persists pre and post memory snapshots with step context artifacts", async () => {
		const deps = createMockCoreDeps({
			executeActions: async (params) => await executeActions(params),
			getPageProjection: async () =>
				[
					'main ref="root": Results',
					'  article ref="result": extracted note',
				].join("\n"),
			extractDataResultsFromSnapshot: async () => ({
				items: [
					{
						link: "https://example.com/extracted",
						summary: "extracted note",
					},
				],
			}),
		});
		const artifactsRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-memory-artifacts-"),
		);
		const contextDir = path.join(artifactsRoot, "context");
		const stepsDir = path.join(artifactsRoot, "steps");
		try {
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();

			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Remember this",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 3,
				artifactDirectories: {
					contextDir,
					stepsDir,
				},
				generateStep: async ({ stepNumber }) => {
					if (stepNumber === 1) {
						return {
							data: {
								thinking: "Write memory",
								actions: [
									{
										type: "memory_write",
										content: "remembered note",
									},
									{
										type: "extract_data",
										root: "result",
									},
								],
								done: false,
							},
							usage: {
								input_tokens: 10,
								output_tokens: 4,
								total_tokens: 14,
							},
							reasoning_tokens: "",
						};
					}
					return {
						data: {
							thinking: stepNumber === 2 ? "Read memory" : "Done",
							actions: [
								{
									type: stepNumber === 2 ? "memory_read" : "return_results",
								},
							],
							done: false,
						},
						usage: {
							input_tokens: 8,
							output_tokens: 3,
							total_tokens: 11,
						},
						reasoning_tokens: "",
					};
				},
			});

			assert.isTrue(result.completed);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "memory-001.pre-llm.txt"),
					"utf-8",
				),
				"",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "memory-001.post-actions.txt"),
					"utf-8",
				),
				"remembered note",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-001.pre-llm.txt"),
					"utf-8",
				),
				"",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-001.post-actions.txt"),
					"utf-8",
				),
				"",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "memory-002.pre-llm.txt"),
					"utf-8",
				),
				"remembered note",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-002.pre-llm.txt"),
					"utf-8",
				),
				"",
			);
			assert.include(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-002.post-actions.txt"),
					"utf-8",
				),
				"extracted note",
			);
		} finally {
			fs.rmSync(artifactsRoot, { recursive: true, force: true });
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();
		}
	});

	it("runAgent saves the exact step input messages passed to the model", async () => {
		const deps = createMockCoreDeps();
		const exactFirstAssistant = [
			"<yaml>",
			'previousStepStatus: "progressed"',
			'previousStepOutcome: "Entered the departure details."',
			'currentStateObservation: "The search form is populated."',
			'nextActionRationale: "Submit the search to load results."',
			"actions: []",
			"done: false",
		].join("\n");
		const originalPreStepScreenshot =
			configFeatureFlags.preStepScreenshotInLatestUserPrompt;
		let capturedStepTwoMessages: Array<{
			role: string;
			content: unknown;
			reasoning_tokens?: string;
		}> | null = null;
		try {
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();
			setConfigFeatureFlags({
				preStepScreenshotInLatestUserPrompt: false,
			});

			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Find a result",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					verifySuccess: { provider: "openai", model: "gpt-test" },
				},
				dataExtraction: { provider: "openai", model: "gpt-test" },
				featureFlags: {
					...deps.featureFlags,
					preStepScreenshotInLatestUserPrompt: false,
					enableExecutorActionContextFieldsForOpenAI: true,
				},
				maxSteps: 3,
				generateStep: async ({ stepNumber, messages }) => {
					if (stepNumber === 2) {
						capturedStepTwoMessages = messages.map((message) => ({
							role: message.role,
							content: message.content,
							...(typeof message.reasoning_tokens === "string"
								? { reasoning_tokens: message.reasoning_tokens }
								: {}),
						}));
					}
					if (stepNumber === 1) {
						return {
							data: {
								previousStepStatus: "progressed",
								previousStepOutcome: "Entered the departure details.",
								currentStateObservation: "The search form is populated.",
								nextActionRationale: "Submit the search to load results.",
								actions: [],
								done: false,
							},
							usage: {
								input_tokens: 8,
								output_tokens: 3,
								total_tokens: 11,
							},
							reasoning_tokens: "Inspect the flight form.",
							raw_response: exactFirstAssistant,
						};
					}
					return {
						data: {
							previousStepStatus: "progressed",
							previousStepOutcome: "Submitted the search.",
							currentStateObservation: "Results are available.",
							nextActionRationale: "Return the requested result.",
							actions: [{ type: "return_results" }],
						},
						usage: {
							input_tokens: 7,
							output_tokens: 2,
							total_tokens: 9,
						},
						reasoning_tokens: "",
					};
				},
			});

			assert.isTrue(result.completed);
			assert.isNotNull(capturedStepTwoMessages);
			const contextFile = path.join(CONTEXT_DIR, "context-002.yaml");
			assert.isTrue(fs.existsSync(contextFile));
			const savedContext = yaml.load(
				fs.readFileSync(contextFile, "utf-8"),
			) as Array<{
				role: string;
				content: unknown;
				reasoning_tokens?: string;
			}>;
			assert.deepEqual(savedContext, capturedStepTwoMessages);
			assert.strictEqual(
				savedContext.at(-2)?.reasoning_tokens,
				"Inspect the flight form.",
			);
			assert.strictEqual(savedContext.at(-2)?.content, exactFirstAssistant);
			const serializedContext = savedContext
				.map((message) => String(message.content ?? ""))
				.join("\n");
			for (const field of [
				"previousStepStatus",
				"previousStepOutcome",
				"currentStateObservation",
				"nextActionRationale",
			]) {
				assert.include(serializedContext, field);
			}
		} finally {
			setConfigFeatureFlags({
				preStepScreenshotInLatestUserPrompt: originalPreStepScreenshot,
			});
			setRuntimeOptions({ saveStepsContext: true });
			resetStepsDir();
		}
	});

	it("runAgent includes reasoning as a previous assistant message field", async () => {
		let capturedStepTwoMessages: Message[] | null = null;
		const deps = createMockCoreDeps({
			executeActions: async ({ actions }) => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				...(actions.some((action) => action.type === "return_results")
					? { returnedResult: "Success" }
					: {}),
			}),
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Find a result",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openrouter", model: "openai/gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
				verifySuccess: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 3,
			generateStep: async ({ stepNumber, messages }) => {
				if (stepNumber === 2) capturedStepTwoMessages = messages;
				return stepNumber === 1
					? {
							data: { actions: [], done: false },
							usage: {
								input_tokens: 8,
								output_tokens: 3,
								total_tokens: 11,
							},
							reasoning_tokens: "Inspect page:\nstatus: ready",
						}
					: {
							data: {
								actions: [{ type: "return_results" }],
								done: false,
							},
							usage: {
								input_tokens: 7,
								output_tokens: 2,
								total_tokens: 9,
							},
							reasoning_tokens: "Return stored results.",
						};
			},
		});

		assert.isTrue(result.completed);
		assert.strictEqual(
			result.stepsHistory[0]?.reasoningTokens,
			"Inspect page:\nstatus: ready",
		);
		assert.isNotNull(capturedStepTwoMessages);
		const systemContent = String(capturedStepTwoMessages?.[0]?.content ?? "");
		const previousAssistantContent = String(
			capturedStepTwoMessages?.at(-2)?.content ?? "",
		);
		assert.strictEqual(
			capturedStepTwoMessages?.at(-2)?.reasoning_tokens,
			"Inspect page:\nstatus: ready",
		);
		assert.notInclude(systemContent, "previousStepStatus");
		assert.notInclude(previousAssistantContent, "<think>");
		assert.notInclude(previousAssistantContent, "Inspect page:");
		assert.notInclude(previousAssistantContent, "previousStepStatus");
		assert.notInclude(previousAssistantContent, "previousStepOutcome");
		assert.notInclude(previousAssistantContent, "currentStateObservation");
		assert.notInclude(previousAssistantContent, "nextActionRationale");
	});

	it("runAgent logs enabled OpenAI action-context fields before action execution lines", async () => {
		const logs: string[] = [];
		const originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map((value) => String(value)).join(" "));
		};
		try {
			const deps = createMockCoreDeps({
				executeActions: async ({ actions }) => {
					for (const action of actions ?? []) {
						if (action.type === "click") {
							console.log(`    -> click(ref=${action.ref})`);
						}
					}
					return {
						pendingMemoryRead: false,
						interactionErrors: [],
						...(actions.some((action) => action.type === "return_results")
							? { returnedResult: "Success" }
							: {}),
					};
				},
			});

			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Find a result",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openrouter", model: "openai/gpt-test" },
					verifySuccess: { provider: "openai", model: "gpt-test" },
				},
				dataExtraction: { provider: "openai", model: "gpt-test" },
				featureFlags: {
					...deps.featureFlags,
					enableExecutorActionContextFieldsForOpenAI: true,
				},
				maxSteps: 2,
				generateStep: async ({ stepNumber }) => {
					if (stepNumber === 1) {
						return {
							data: {
								previousStepStatus: "progressed",
								previousStepOutcome: "Filled the departure station.",
								currentStateObservation:
									"The search form is partially populated.",
								nextActionRationale: "Click search to load the results page.",
								actions: [{ type: "click", ref: "24" }],
								done: false,
							},
							usage: {
								input_tokens: 8,
								output_tokens: 3,
								total_tokens: 11,
							},
							reasoning_tokens: "",
						};
					}
					return {
						data: {
							previousStepStatus: "progressed",
							previousStepOutcome: "Results loaded.",
							currentStateObservation: "The target fare is visible.",
							nextActionRationale: "Return the final answer.",
							actions: [{ type: "return_results" }],
						},
						usage: {
							input_tokens: 7,
							output_tokens: 2,
							total_tokens: 9,
						},
						reasoning_tokens: "",
					};
				},
			});

			assert.isTrue(result.completed);
			const outcomeIndex = logs.findIndex((message) =>
				message.includes("previousStepOutcome: Filled the departure station."),
			);
			const stateIndex = logs.findIndex((message) =>
				message.includes(
					"currentStateObservation: The search form is partially populated.",
				),
			);
			const rationaleIndex = logs.findIndex((message) =>
				message.includes(
					"nextActionRationale: Click search to load the results page.",
				),
			);
			const clickIndex = logs.findIndex((message) =>
				message.includes("-> click(ref=24)"),
			);
			assert.isAtLeast(outcomeIndex, 0);
			assert.isAtLeast(stateIndex, 0);
			assert.isAtLeast(rationaleIndex, 0);
			assert.isAtLeast(clickIndex, 0);
			assert.isBelow(outcomeIndex, clickIndex);
			assert.isBelow(stateIndex, clickIndex);
			assert.isBelow(rationaleIndex, clickIndex);
		} finally {
			console.log = originalConsoleLog;
		}
	});

	it("runAgent returns successful=false when return_results fails verification", async () => {
		const deps = createMockCoreDeps({
			verifyTaskSuccess: async () => ({
				success: false,
				summary: "Task stopped before the required upload completed.",
				reasons: ["The final result described a partial/manual outcome."],
				model: "gpt-test",
				provider: "openai",
				usage: {
					input_tokens: 4,
					output_tokens: 2,
					total_tokens: 6,
				},
			}),
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Upload the file and confirm it is present.",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 1,
			generateStep: async () => ({
				data: {
					thinking: "I reached the upload dialog.",
					actions: [{ type: "return_results" }],
				},
				usage: {
					input_tokens: 10,
					output_tokens: 4,
					total_tokens: 14,
				},
				reasoning_tokens: "",
			}),
		});

		assert.isTrue(result.completed);
		assert.isFalse(result.successful);
		assert.strictEqual(
			result.successVerification?.summary,
			"Task stopped before the required upload completed.",
		);
		assert.deepEqual(result.successVerification?.reasons, [
			"The final result described a partial/manual outcome.",
		]);
	});

	it("runAgent accepts auth callbacks through input", async () => {
		const deps = createMockCoreDeps({
			featureFlags: {
				preStepScreenshotInLatestUserPrompt: false,
				userTakeoverTool: true,
				authTakeover: true,
				agentTakeoverTool: false,
			},
		});
		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Sign in",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			requestAuthDomainCandidates: async () => ["https://example.com/login"],
			requestAuthIdentifierForDomain: async () => "user@example.com",
			requestAuthPasswordForDomain: async () => "secret",
			maxSteps: 1,
			keepSessionOpen: true,
			generateStep: async () => ({
				data: {
					thinking: "Task is complete",
					actions: [{ type: "return_results" }],
				},
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
				reasoning_tokens: "",
			}),
		});

		assert.isTrue(result.completed);
		const session = deps.registry.get(9222);
		assert.isDefined(session?.authTakeover);
		assert.isDefined(session?.authTakeover?.requestAuthDomainCandidates);
		assert.isDefined(session?.authTakeover?.requestAuthIdentifierForDomain);
		assert.isDefined(session?.authTakeover?.requestAuthPasswordForDomain);
		await closeSession(deps, 9222);
	});

	it("runAgent surfaces user takeover as userActionRequired", async () => {
		const deps = createMockCoreDeps({
			userActionBehavior: "return",
			executeActions: async () => ({
				pendingMemoryRead: false,
				interactionErrors: [],
				userTakeover: {
					reason: "Enter the OTP code.",
				},
			}),
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				forceRestart: true,
			},
			task: "Log in and continue",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			userActionBehavior: "return",
			maxSteps: 2,
			generateStep: async () => ({
				data: {
					thinking: "Login requires OTP",
					actions: [
						{
							type: "user_takeover",
							request: "Enter the OTP code.",
						},
					],
					done: false,
				},
				usage: {
					input_tokens: 10,
					output_tokens: 4,
					total_tokens: 14,
				},
				reasoning_tokens: "",
			}),
		});

		assert.isFalse(result.completed);
		assert.isNull(result.result);
		assert.deepEqual(result.userActionRequired, {
			kind: "browser_user_takeover",
			reason: "Enter the OTP code.",
			category: "otp",
		});
	});

	it("runAgent continues when authentication takeover is handled automatically", async () => {
		const originalFeatureFlags = { ...configFeatureFlags };
		const deps = createMockCoreDeps({
			featureFlags: {
				preStepScreenshotInLatestUserPrompt: false,
				userTakeoverTool: true,
				authTakeover: true,
				agentTakeoverTool: false,
			},
			executeActions: async (params) =>
				params.actions.some((action) => action.type === "return_results")
					? {
							pendingMemoryRead: false,
							interactionErrors: [],
							returnedResult: "Success",
						}
					: await executeActions({
							...params,
							attemptAutomatedAuthTakeover: async () => ({
								handled: true,
							}),
						}),
		});
		let callCount = 0;

		try {
			setConfigFeatureFlags(deps.featureFlags);
			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Log in and continue",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 2,
				generateStep: async ({ stepNumber }) => {
					callCount += 1;
					if (stepNumber === 1) {
						return {
							data: {
								thinking: "The page needs credentials.",
								actions: [
									{
										type: "user_takeover",
										category: "authentication",
										request: "Enter your login credentials.",
									},
								],
								done: false,
							},
							usage: {
								input_tokens: 10,
								output_tokens: 4,
								total_tokens: 14,
							},
							reasoning_tokens: "",
						};
					}
					return {
						data: {
							thinking: "Task is complete",
							actions: [{ type: "return_results" }],
						},
						usage: {
							input_tokens: 8,
							output_tokens: 3,
							total_tokens: 11,
						},
						reasoning_tokens: "",
					};
				},
			});

			assert.strictEqual(callCount, 2);
			assert.isTrue(result.completed);
			assert.strictEqual(result.result, "Success");
			assert.isUndefined(result.userActionRequired);
		} finally {
			setConfigFeatureFlags(originalFeatureFlags);
		}
	});

	it("runAgent surfaces split probe/result auth takeover attempts in order", async () => {
		const originalFeatureFlags = { ...configFeatureFlags };
		const deps = createMockCoreDeps({
			featureFlags: {
				preStepScreenshotInLatestUserPrompt: false,
				userTakeoverTool: true,
				authTakeover: true,
				agentTakeoverTool: false,
			},
			executeActions: async (params) =>
				await executeActions({
					...params,
					attemptAutomatedAuthTakeover: async () => ({
						handled: true,
						traceEntries: [
							{
								step_kind: "auth_takeover_attempt",
								step: 2,
								attempt: 1,
								stage: "probe",
								decisionAction: "submit_credentials",
								selectedRefsPresent: {
									username: true,
									password: true,
									submit: true,
									continue: false,
									stayLoggedInCheckbox: false,
								},
								messages: [
									{ role: "system", content: "probe-system" },
									{ role: "user", content: "probe-user" },
									{
										role: "assistant",
										content: "probe-assistant",
									},
								],
								token_usage: {
									input_tokens: 11,
									output_tokens: 5,
									total_tokens: 16,
								},
								outcome: "submitted_credentials",
								outcomeReason: "credentials_submitted",
							},
							{
								step_kind: "auth_takeover_attempt",
								step: 3,
								attempt: 1,
								stage: "result",
								decisionAction: "submit_credentials",
								selectedRefsPresent: {
									username: true,
									password: true,
									submit: true,
									continue: false,
									stayLoggedInCheckbox: false,
								},
								messages: [
									{
										role: "system",
										content: "result-system",
									},
									{ role: "user", content: "result-user" },
									{
										role: "assistant",
										content: "result-assistant",
									},
								],
								token_usage: {
									input_tokens: 7,
									output_tokens: 3,
									total_tokens: 10,
								},
								outcome: "success_or_redirect",
								outcomeReason: "dashboard visible",
							},
						],
					}),
				}),
		});

		try {
			setConfigFeatureFlags(deps.featureFlags);
			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Log in and continue",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 2,
				generateStep: async ({ stepNumber }) => {
					if (stepNumber === 1) {
						return {
							data: {
								thinking: "Needs auth",
								actions: [
									{
										type: "user_takeover",
										category: "authentication",
										request: "Enter your login credentials.",
									},
								],
								done: false,
							},
							usage: {
								input_tokens: 10,
								output_tokens: 4,
								total_tokens: 14,
							},
							reasoning_tokens: "",
						};
					}
					return {
						data: {
							thinking: "Done",
							actions: [{ type: "return_results" }],
						},
						usage: {
							input_tokens: 8,
							output_tokens: 3,
							total_tokens: 11,
						},
						reasoning_tokens: "",
					};
				},
			});

			const attempts =
				result.steps[0]?.browse?.execution.auth_takeover_attempts ?? [];
			assert.lengthOf(attempts, 2);
			assert.deepEqual(
				attempts.map((entry) => entry.step),
				[2, 3],
			);
			assert.deepEqual(
				attempts.map((entry) => entry.stage),
				["probe", "result"],
			);
			assert.deepEqual(
				(attempts[0]?.messages ?? []).map(
					(message) => (message as { role?: string }).role,
				),
				["system", "user", "assistant"],
			);
			assert.deepEqual(
				(attempts[1]?.messages ?? []).map(
					(message) => (message as { role?: string }).role,
				),
				["system", "user", "assistant"],
			);
		} finally {
			setConfigFeatureFlags(originalFeatureFlags);
		}
	});

	it("runAgent still uses authentication user_takeover as an automatic-auth trigger when manual takeover is disabled", async () => {
		const originalFeatureFlags = { ...configFeatureFlags };
		const deps = createMockCoreDeps({
			featureFlags: {
				preStepScreenshotInLatestUserPrompt: false,
				userTakeoverTool: false,
				authTakeover: true,
				agentTakeoverTool: false,
			},
			executeActions: async (params) =>
				params.actions.some((action) => action.type === "return_results")
					? {
							pendingMemoryRead: false,
							interactionErrors: [],
							returnedResult: "Success",
						}
					: await executeActions({
							...params,
							attemptAutomatedAuthTakeover: async () => ({
								handled: true,
							}),
						}),
		});
		let callCount = 0;

		try {
			setConfigFeatureFlags(deps.featureFlags);
			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Log in and continue",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 2,
				generateStep: async ({ stepNumber }) => {
					callCount += 1;
					if (stepNumber === 1) {
						return {
							data: {
								thinking: "The page needs credentials.",
								actions: [
									{
										type: "user_takeover",
										category: "authentication",
										request: "Enter your login credentials.",
									},
								],
								done: false,
							},
							usage: {
								input_tokens: 10,
								output_tokens: 4,
								total_tokens: 14,
							},
							reasoning_tokens: "",
						};
					}
					return {
						data: {
							thinking: "Task is complete",
							actions: [{ type: "return_results" }],
						},
						usage: {
							input_tokens: 8,
							output_tokens: 3,
							total_tokens: 11,
						},
						reasoning_tokens: "",
					};
				},
			});

			assert.strictEqual(callCount, 2);
			assert.isTrue(result.completed);
			assert.strictEqual(result.result, "Success");
			assert.isUndefined(result.userActionRequired);
		} finally {
			setConfigFeatureFlags(originalFeatureFlags);
		}
	});

	it("runAgent suppresses manual takeover when automatic authentication is not handled and manual takeover is disabled", async () => {
		const originalFeatureFlags = { ...configFeatureFlags };
		const deps = createMockCoreDeps({
			featureFlags: {
				preStepScreenshotInLatestUserPrompt: false,
				userTakeoverTool: false,
				authTakeover: true,
				agentTakeoverTool: false,
			},
			executeActions: async (params) =>
				await executeActions({
					...params,
					attemptAutomatedAuthTakeover: async () => ({
						handled: false,
					}),
				}),
		});

		try {
			setConfigFeatureFlags(deps.featureFlags);
			const result = await runAgent(deps, {
				session: {
					port: 9222,
					headless: true,
					forceRestart: true,
				},
				task: "Log in and continue",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				maxSteps: 2,
				generateStep: async () => ({
					data: {
						thinking: "The page needs credentials.",
						actions: [
							{
								type: "user_takeover",
								category: "authentication",
								request: "Enter your login credentials.",
							},
						],
						done: false,
					},
					usage: {
						input_tokens: 10,
						output_tokens: 4,
						total_tokens: 14,
					},
					reasoning_tokens: "",
				}),
			});

			assert.isFalse(result.completed);
			assert.isUndefined(result.userActionRequired);
			assert.include(
				result.steps[0]?.browse?.execution.interaction_errors.join(" | ") ?? "",
				"automated auth not handled and manual takeover disabled",
			);
		} finally {
			setConfigFeatureFlags(originalFeatureFlags);
		}
	});

	it("runAgent bypasses findTargetURL when a session url is provided", async () => {
		let findTargetURLCalls = 0;
		const providedUrl = "https://example.com/provided";
		const deps = createMockCoreDeps({
			findTargetURL: async () => {
				findTargetURLCalls += 1;
				return "https://target.example";
			},
		});

		const result = await runAgent(deps, {
			session: {
				port: 9222,
				headless: true,
				url: providedUrl,
				forceRestart: true,
			},
			task: "Use the provided url",
			stageLLMs: {
				findTargetURL: { provider: "openai", model: "gpt-test" },
				createChecklist: { provider: "openai", model: "gpt-test" },
				runAgent: { provider: "openai", model: "gpt-test" },
				dataExtraction: { provider: "openai", model: "gpt-test" },
			},
			featureFlags: deps.featureFlags,
			maxSteps: 1,
			generateStep: async () => ({
				data: {
					thinking: "Task is complete",
					actions: [{ type: "return_results" }],
				},
				usage: {
					input_tokens: 8,
					output_tokens: 3,
					total_tokens: 11,
				},
				reasoning_tokens: "",
			}),
		});

		assert.strictEqual(findTargetURLCalls, 0);
		assert.strictEqual(result.preprocess.target_url, providedUrl);
		assert.strictEqual(result.preprocess.final_url, providedUrl);
	});
});
