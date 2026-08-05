import type {
	CoreDeps,
	PreprocessTaskInput,
	PreprocessTaskResult,
} from "./types.js";
import { SessionNotFoundError } from "./session.js";
import { shouldLogTimingDuration } from "../timing-logs.js";
import {
	createChecklistItems,
	normalizeChecklistDraft,
} from "./checklist-state.js";
import type { ChecklistItem } from "../agents/types.js";

const CREATE_CHECKLIST_MAX_ATTEMPTS = 2;

function getSessionOrThrow(deps: CoreDeps, port: number) {
	const session = deps.registry.get(port);
	if (!session) {
		throw new SessionNotFoundError(port);
	}
	return session;
}

function formatPreprocessLogTimestamp(date: Date): string {
	const pad2 = (value: number) => String(value).padStart(2, "0");
	return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} - ${pad2(
		date.getHours(),
	)}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

async function measureLoggedStage<T>(params: {
	port: number;
	stage: string;
	log?: (message: string) => void;
	run: () => Promise<T>;
}): Promise<T> {
	const startedAt = Date.now();
	try {
		return await params.run();
	} finally {
		const durationMs = Date.now() - startedAt;
		if (params.log && shouldLogTimingDuration(durationMs)) {
			const timestamp = formatPreprocessLogTimestamp(new Date());
			params.log(
				`[${timestamp}] [port ${params.port}] [preprocessTask] ${params.stage} took ${durationMs}ms`,
			);
		}
	}
}

async function createChecklistWithRetry(params: {
	deps: CoreDeps;
	input: PreprocessTaskInput;
}): Promise<ChecklistItem[]> {
	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= CREATE_CHECKLIST_MAX_ATTEMPTS; attempt++) {
		try {
			const raw = await measureLoggedStage({
				port: params.input.port,
				stage: "createChecklist",
				log: params.input.log,
				run: async () =>
					await params.deps.createChecklist(
						params.input.userTask,
						params.input.stageLLMs.createChecklist,
						{
							onTrace: params.input.recordModelInvocation,
							meta: {
								checklistAttempt: attempt,
								phase: "initial_checklist",
							},
						},
					),
			});
			const normalized = normalizeChecklistDraft(raw);
			if (normalized) return createChecklistItems(normalized.items);
			lastError = new Error(
				"expected YAML object with non-empty items: string[]",
			);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
		if (attempt < CREATE_CHECKLIST_MAX_ATTEMPTS) {
			console.warn(
				`[preprocessTask] createChecklist attempt ${attempt} failed: ${lastError.message}. Retrying...`,
			);
		}
	}
	console.warn(
		`[preprocessTask] createChecklist failed after ${CREATE_CHECKLIST_MAX_ATTEMPTS} attempts; using the original task as a fallback checklist item: ${lastError?.message ?? "unknown error"}`,
	);
	return createChecklistItems([params.input.userTask]);
}

export async function preprocessTask(
	deps: CoreDeps,
	input: PreprocessTaskInput,
): Promise<PreprocessTaskResult> {
	const session = getSessionOrThrow(deps, input.port);
	async function findTargetURL(): Promise<string> {
		return await measureLoggedStage({
			port: input.port,
			stage: "findTargetURL",
			log: input.log,
			run: async () =>
				await deps.findTargetURL(
					input.userTask,
					input.stageLLMs.findTargetURL,
					{
						onTrace: input.recordModelInvocation,
					},
				),
		});
	}

	async function navigateToTarget(url: string): Promise<void> {
		await deps.navigateBrowser(session.browser, url);
	}

	const explicitStartUrl = input.url?.trim();
	const targetURL = explicitStartUrl || (await findTargetURL());
	if (!explicitStartUrl) {
		await navigateToTarget(targetURL);
	}
	const checklistPromise = deps.featureFlags.taskChecklist
		? createChecklistWithRetry({
				deps,
				input,
			})
		: Promise.resolve([] as ChecklistItem[]);
	const checklist = await checklistPromise;

	const finalUrl = await deps.getCurrentURL(session.browser);
	const openTabs = await deps.listTabs(session.browser);
	const currentTab = await deps.resolveCurrentTabIndex({
		b: session.browser,
		openTabs,
		currentUrl: finalUrl,
	});

	session.activeChecklist = checklist.map((item) => ({ ...item }));
	session.lastTask = input.userTask;
	session.pendingMemoryRead = false;
	session.previousInteractionErrors = [];
	session.previousToolObservations = [];
	session.previousStepTabs = openTabs;
	session.downloadedFileSignatures = null;
	session.lastActionSignatureWithUrl = null;
	session.lastProgressSignature = null;
	session.sameActionSignatureStreak = 0;
	session.noProgressStreak = 0;

	return {
		target_url: targetURL,
		final_url: finalUrl,
		checklist: checklist.map((item) => ({ ...item })),
		context: {
			current_url: finalUrl,
			open_tabs: openTabs.map((tab) => deps.formatTabTitle(tab)),
			current_tab: currentTab,
		},
	};
}
