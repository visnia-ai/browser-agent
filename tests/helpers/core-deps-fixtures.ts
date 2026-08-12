import fs from "node:fs";
import type { Browser, Tab } from "../../src/browser/types.js";
import type { ConfigFeatureFlags } from "../../src/config-feature-flags.js";
import type { SuccessVerificationResult } from "../../src/agents/types.js";
import type { CoreDeps } from "../../src/core/types.js";
import { SessionRegistry } from "../../src/core/session-registry.js";
import { buildStepPayload as realBuildStepPayload } from "../../src/agents/executor-utils/step-execution.js";
import {
	normalizeActionList,
	normalizeActionListWithDiagnostics,
} from "../../src/agents/executor-utils/action-normalization.js";
export function makeFakeBrowser(port: number): Browser {
	return {
		port,
		client: {} as any,
		chrome: {} as any,
		Page: {} as any,
		Runtime: {} as any,
		DOM: {} as any,
		DOMSnapshot: {} as any,
		Input: {} as any,
		Target: {
			getTargets: async () => ({ targetInfos: [] }),
		} as any,
		Accessibility: {} as any,
		userDataDir: undefined,
	};
}

export function createMockCoreDeps(
	overrides: Partial<CoreDeps> = {},
): CoreDeps {
	const registry = overrides.registry ?? new SessionRegistry();
	const featureFlags: ConfigFeatureFlags = {
		taskChecklist: false,
		preStepScreenshotInLatestUserPrompt: false,
		userTakeoverTool: true,
		authTakeover: false,
		agentTakeoverTool: false,
		extractDataWholeContext: false,
		semanticProjectionHistory: "current",
		enableExecutorActionContextFieldsForOpenAI: false,
		openAIEncryptedResponses: true,
		openAIExplicitPromptCaching: true,
		optimizeExecutorStepDelays: false,
		optimizeTextInput: false,
	};
	const tabs: Tab[] = [
		{ targetId: "tab-1", title: "Home", url: "https://example.com" },
	];
	let currentURL = "https://example.com";

	const deps: CoreDeps = {
		featureFlags,
		userActionBehavior: "block",
		registry,
		isPortInUse: async () => false,
		launchBrowser: async (
			port,
			_headless,
			_proxy,
			_downloadDir,
			userDataDir,
		) => ({
			...makeFakeBrowser(port),
			userDataDir,
		}),
		closeBrowser: async () => undefined,
		navigateBrowser: async (_browser, url) => {
			currentURL = url;
		},
		downloadFileFromUrl: async () => "/tmp/download.pdf",
		getCurrentURL: async () => currentURL,
		getPageProjection: async () =>
			'projection semantic-v1 refs=2\ndocument ref="r1" name="Example"\n  button ref="r2" name="Continue"',
		listTabs: async () => tabs,
		extractValidRefs: () => ["r1", "r2"],
		findTargetURL: async () => "https://target.example",
		createChecklist: async () => ({
			items: ["Complete every explicit task requirement."],
		}),
		buildStepPayload: (params) => realBuildStepPayload(params),
		buildStepMessages: ({ systemPrompt, history, payload }) => [
			{ role: "system", content: systemPrompt },
			...history,
			{ role: "user", content: JSON.stringify(payload) },
		],
		getExecutorSystem: () => "EXECUTOR_SYSTEM",
		normalizeActionList,
		normalizeActionListWithDiagnostics,
		executeActions: async ({ actions }) => {
			return {
				pendingMemoryRead: true,
				interactionErrors: [],
				...(actions.some((action) => action.type === "return_results")
					? { returnedResult: "Success" }
					: {}),
			};
		},
		extractDataResultsFromSnapshot: async () => ({
			items: [
				{
					link: "https://example.com",
					summary: "Extracted fixture data",
				},
			],
		}),
		switchTab: async (_browser, targetId) => {
			const nextTab = tabs.find((tab) => tab.targetId === targetId);
			if (nextTab) {
				currentURL = nextTab.url;
			}
		},
		waitForAllOpenTabsToSettle: async () => undefined,
		resolveCurrentTabIndex: async () => 0,
		getNewlyOpenedTabs: () => [],
		capturePreStepScreenshotDataUrl: async () => "data:image/jpeg;base64,AAAA",
		estimateTokenCount: (text) => text.length,
		formatTabTitle: (tab) => tab.title,
		createSessionMemoryFile: (port) => {
			const filePath = `/tmp/memory-${port}.txt`;
			fs.writeFileSync(filePath, "", "utf-8");
			return filePath;
		},
		createSessionExtractDataMemoryFile: (port) => {
			const filePath = `/tmp/extract-data-memory-${port}.txt`;
			fs.writeFileSync(filePath, "", "utf-8");
			return filePath;
		},
		verifyTaskSuccess: async () =>
			({
				success: true,
				summary: "Verified in test fixture.",
				reasons: [],
				model: "gpt-test",
				provider: "openai",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
			}) satisfies SuccessVerificationResult,
		defaultSuccessVerifierLLMOptions: {
			provider: "openai",
			model: "gpt-5.4",
			reasoningEffort: "low",
		},
	};

	return { ...deps, ...overrides };
}
