import * as net from "net";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
	type ConfigFeatureFlags,
} from "../config-feature-flags.js";
import {
	launch,
	close,
	navigate,
	getURL,
	listTabs,
	switchTab,
	waitForAllOpenTabsToSettle,
	dispatchRemoteInput,
	downloadFileFromUrl,
} from "../browser/browser.js";
import { getSemanticProjection } from "../browser/semantic-projection.js";
import { getPageMarkdownObservation } from "../browser/page-markdown-observation.js";
import { extractDataResultsFromSnapshot } from "../agents/data-extraction.js";
import { extractValidRefs } from "../agents/extract-valid-refs.js";
import { findTargetURL } from "../agents/target-url.js";
import { createChecklist } from "../agents/checklist.js";
import { getExecutorSystem } from "../agents/prompts.js";
import {
	buildStepMessages,
	buildStepPayload,
} from "../agents/executor-utils/step-execution.js";
import {
	normalizeActionList,
	normalizeActionListWithDiagnostics,
} from "../agents/executor-utils/action-normalization.js";
import { executeActions } from "../agents/executor-utils/action-execution.js";
import {
	capturePreStepScreenshotDataUrl,
	estimateTokenCount,
	formatTabTitle,
	getNewlyOpenedTabs,
	resolveCurrentTabIndex,
} from "../agents/executor-utils/step-context.js";
import {
	createSessionExtractDataMemoryFile,
	createSessionMemoryFile,
	SessionRegistry,
} from "./session-registry.js";
import type { CoreDeps } from "./types.js";
import type { LLMOptions } from "../agents/types.js";
import type { UserTakeoverCategory } from "../user-action-types.js";
import { verifyTaskSuccess } from "../agents/success-verifier.js";

async function defaultIsPortInUse(port: number): Promise<boolean> {
	return await new Promise((resolve) => {
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
	});
}

export interface CreateDefaultCoreDepsOptions {
	featureFlags: ConfigFeatureFlags;
	userActionBehavior?: "block" | "return" | "callback";
	onUserActionRequired?: (input: {
		kind: "browser_user_takeover";
		reason: string;
		category?: UserTakeoverCategory;
	}) => Promise<void>;
	requestAgentTakeover?: CoreDeps["requestAgentTakeover"];
	waitForAutomationPermission?: () => Promise<void>;
	defaultAuthProbeLLMOptions?: LLMOptions;
	defaultSuccessVerifierLLMOptions?: LLMOptions;
}

export function createDefaultCoreDeps(
	options: CreateDefaultCoreDepsOptions,
): CoreDeps {
	setConfigFeatureFlags(options.featureFlags);
	const appliedFeatureFlags: ConfigFeatureFlags = {
		...configFeatureFlags,
	};

	return {
		featureFlags: appliedFeatureFlags,
		userActionBehavior: options.userActionBehavior ?? "block",
		onUserActionRequired: options.onUserActionRequired,
		requestAgentTakeover: options.requestAgentTakeover,
		registry: new SessionRegistry(),
		isPortInUse: defaultIsPortInUse,
		launchBrowser: (
			port,
			headless,
			proxy,
			downloadDir,
			userDataDir,
			windowMode,
			executablePath,
		) =>
			launch(
				port,
				headless,
				proxy,
				downloadDir,
				userDataDir,
				windowMode,
				executablePath,
			),
		closeBrowser: close,
		navigateBrowser: navigate,
		downloadFileFromUrl,
		getCurrentURL: getURL,
		getPageProjection: (browser, projectionOptions) =>
			getSemanticProjection(browser, {
				...projectionOptions,
				omitHrefs: projectionOptions?.preserveFullHrefs !== true,
			}),
		getPageObservation: getPageMarkdownObservation,
		listTabs,
		extractValidRefs,
		findTargetURL,
		createChecklist,
		buildStepPayload,
		buildStepMessages,
		getExecutorSystem,
		normalizeActionList,
		normalizeActionListWithDiagnostics,
		executeActions,
		extractDataResultsFromSnapshot,
		switchTab,
		waitForAllOpenTabsToSettle,
		resolveCurrentTabIndex,
		getNewlyOpenedTabs,
		capturePreStepScreenshotDataUrl,
		estimateTokenCount,
		formatTabTitle,
		createSessionMemoryFile,
		createSessionExtractDataMemoryFile,
		waitForAutomationPermission:
			options.waitForAutomationPermission ?? (async () => {}),
		dispatchRemoteInput,
		verifyTaskSuccess,
		defaultAuthProbeLLMOptions: options.defaultAuthProbeLLMOptions,
		defaultSuccessVerifierLLMOptions: options.defaultSuccessVerifierLLMOptions,
	};
}
