import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import {
	appendHistoryWithStrippedPayload,
	buildMaxStepFinalizationMessages,
	buildStepMessages,
	buildStepPayload,
	formatStepForPrompt,
	logStepActionContext,
	saveStepContextIfNeeded,
	serializeActionsForPrompt,
	serializeMessagesForDisk,
} from "../src/agents/executor-utils/step-execution.js";
import type { Browser } from "../src/browser/types.js";
import {
	OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
	OPENAI_EXECUTOR_CONTEXT_POLICY,
} from "../src/agents/executor-context-policy.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import type { Message, StepResult } from "../src/agents/types.js";

describe("step-execution-messages", () => {
	it("gates action-context serialization and logging", () => {
		const originalConsoleLog = console.log;
		const logs: string[] = [];
		const step: StepResult = {
			thinking: "",
			previousStepStatus: "progressed",
			previousStepOutcome: "Opened the search form.",
			currentStateObservation: "The search field is visible.",
			nextActionRationale: "Enter the requested query.",
			actions: [{ type: "click", ref: "r2" }],
			done: false,
		};
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		try {
			assert.deepEqual(
				formatStepForPrompt(step, OPENAI_EXECUTOR_CONTEXT_POLICY),
				{
				tools: [{ click: "r2" }],
				},
			);
			logStepActionContext(step, OPENAI_EXECUTOR_CONTEXT_POLICY);
			assert.deepEqual(logs, []);

			assert.deepEqual(
				formatStepForPrompt(
					step,
					OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
				),
				{
				previousStepStatus: "progressed",
				previousStepOutcome: "Opened the search form.",
				currentStateObservation: "The search field is visible.",
				nextActionRationale: "Enter the requested query.",
				tools: [{ click: "r2" }],
				},
			);
			logStepActionContext(
				step,
				OPENAI_ACTION_CONTEXT_EXECUTOR_CONTEXT_POLICY,
			);
			assert.lengthOf(logs, 4);
		} finally {
			console.log = originalConsoleLog;
		}
	});

	it("summarizes large action payloads and keeps paste_file by reference", () => {
		const serialized = serializeActionsForPrompt([
			{ type: "type", ref: "r12", text: "x".repeat(1200) },
			{
				type: "paste_file",
				ref: "r12",
				path: "./extracted.txt",
			},
		]);

		assert.deepEqual(serialized[1], {
			paste_file: {
				ref: "r12",
				path: "./extracted.txt",
			},
		});
		assert.deepEqual(serialized[0], {
			type: {
				ref: "r12",
				text: '[omitted 1200 characters; starts with "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]',
			},
		});
	});

	it("serializes extract_data roots", () => {
		assert.deepEqual(
			serializeActionsForPrompt([
				{
					type: "extract_data",
					root: "!a,42,!b",
				},
			]),
			[
				{
					extract_data: "!a,42,!b",
				},
			],
		);
	});

	it("serializes read_file as its scalar model-facing wire form", () => {
		assert.deepEqual(
			serializeActionsForPrompt([
				{ type: "read_file", path: "./downloads/source.pdf" },
			]),
			[{ read_file: "./downloads/source.pdf" }],
		);
	});

	it("serializes whole-context extraction as a bare tool", () => {
		const original = configFeatureFlags.extractDataWholeContext;
		try {
			setConfigFeatureFlags({ extractDataWholeContext: true });
			assert.deepEqual(serializeActionsForPrompt([{ type: "extract_data" }]), [
				"extract_data",
			]);
		} finally {
			setConfigFeatureFlags({ extractDataWholeContext: original });
		}
	});

	it("preserves explicit return_results items in trajectory messages", () => {
		assert.deepEqual(
			serializeActionsForPrompt([
				{
					type: "return_results",
					results: [
						{
							link: "https://example.com/profile",
							summary: "Verified profile",
						},
					],
				},
			]),
			[
				{
					return_results: [
						{
							link: "https://example.com/profile",
							summary: "Verified profile",
						},
					],
				},
			],
		);
	});

	it("includes current-page screenshot marker in payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			url: "https://example.com",
			previousInteractionErrors: [],
			projection: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			currentPageScreenshotIncludedAsImagePart: true,
		});

		assert.strictEqual(payload.currentPageScreenshotIncludedAsImagePart, true);
	});

	it("includes tab titles and newly opened tab titles in payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			url: "https://example.com",
			previousInteractionErrors: [],
			projection: "html",
			currentTab: 1,
			openTabs: ["Home", "Results"],
			newlyOpenedTabs: ["Results"],
			autoTabSwitchNote: "Auto-switched to first newly opened tab.",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
		});

		assert.strictEqual(payload.currentTab, 1);
		assert.deepEqual(payload.openTabs, ["Home", "Results"]);
		assert.deepEqual(payload.newlyOpenedTabs, ["Results"]);
		assert.strictEqual(
			payload.autoTabSwitchNote,
			"Auto-switched to first newly opened tab.",
		);
	});

	it("includes downloaded files in payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			url: "https://example.com",
			previousInteractionErrors: [],
			projection: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			downloadedFiles: [
				"/tmp/downloads/file-a.pdf",
				"[NEW] /tmp/downloads/file-b.pdf",
			],
		});

		assert.deepEqual(payload.downloadedFiles, [
			"/tmp/downloads/file-a.pdf",
			"[NEW] /tmp/downloads/file-b.pdf",
		]);
	});

	it("keeps pinned memory hidden until memory_read is pending", () => {
		const memoryFile = path.join(
			os.tmpdir(),
			"browser-agent-pinned-memory-test.txt",
		);
		fs.writeFileSync(memoryFile, "scratch note", "utf-8");

		const { payload, pendingMemoryRead } = buildStepPayload({
			task: "task",
			url: "https://example.com",
			previousInteractionErrors: [],
			projection: "html",
			pendingMemoryRead: false,
			memoryFile,
			pinnedMemoryContent: "Pinned workspace context",
		});

		assert.strictEqual(pendingMemoryRead, false);
		assert.isUndefined(payload.memoryContent);
		assert.strictEqual(
			payload.memoryAvailable,
			"Prepared workspace/file context is available to the executor through memory_read. The executor should call memory_read before searching for, opening, uploading, or reading local/workspace files online.",
		);
	});

	it("combines pinned memory context with mutable scratchpad after memory_read", () => {
		const memoryFile = path.join(
			os.tmpdir(),
			"browser-agent-pinned-memory-read-test.txt",
		);
		fs.writeFileSync(memoryFile, "scratch note", "utf-8");

		const { payload, pendingMemoryRead } = buildStepPayload({
			task: "task",
			url: "https://example.com",
			previousInteractionErrors: [],
			projection: "html",
			pendingMemoryRead: true,
			memoryFile,
			pinnedMemoryContent: "Pinned workspace context",
		});

		assert.strictEqual(pendingMemoryRead, false);
		assert.strictEqual(
			payload.memoryContent,
			[
				"Runtime-pinned workspace/file context:",
				"Pinned workspace context",
				"",
				"Mutable browser scratchpad:",
				"scratch note",
				"",
				"Extracted page data/result memory:",
				"(empty)",
			].join("\n"),
		);
	});

	it("exposes plain extracted-data memory in memoryContent", () => {
		const memoryFile = path.join(
			os.tmpdir(),
			"browser-agent-memory-result-scratchpad-read-test.txt",
		);
		const extractDataMemoryFile = path.join(
			os.tmpdir(),
			"browser-agent-memory-result-read-test.txt",
		);
		try {
			fs.writeFileSync(memoryFile, "note", "utf-8");
			fs.writeFileSync(
				extractDataMemoryFile,
				[
					'- link: "https://example.com/one"',
					'  summary: "One: quoted"',
					"- link: https://example.com/two",
					"  summary: |",
					"    Two",
					"    lines",
				].join("\n"),
				"utf-8",
			);

			const { payload } = buildStepPayload({
				task: "task",
				url: "https://example.com",
				previousInteractionErrors: [],
				projection: "html",
				pendingMemoryRead: true,
				memoryFile,
				extractDataMemoryFile,
			});

			const content = String(payload.memoryContent);
			assert.include(content, "Extracted page data/result memory:");
			assert.include(content, 'link: "https://example.com/one"');
			assert.include(content, "link: https://example.com/two");
		} finally {
			fs.rmSync(memoryFile, { force: true });
			fs.rmSync(extractDataMemoryFile, { force: true });
		}
	});

	it("builds string content step messages", () => {
		const { payload } = buildStepPayload({
			task: "task",
			url: "https://example.com",
			previousInteractionErrors: [],
			projection: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
		});

		const messages = buildStepMessages({
			systemPrompt: "sys",
			history: [],
			payload,
		});

		assert.strictEqual(messages.length, 2);
		assert.strictEqual(typeof messages[1].content, "string");
		const userPayload = yaml.load(String(messages[1].content)) as Record<
			string,
			unknown
		>;
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		assert.match(
			String(userPayload.currentDateTime),
			/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} .+ \(.+; dd\/mm\/yyyy hh:mm time zone\)$/,
		);
		assert.include(String(userPayload.currentDateTime), timeZone);
	});

	it("includes a clone-safe native screenshot file part in step messages", () => {
		const base64 = Buffer.from("fake-jpeg").toString("base64");
		const messages = buildStepMessages({
			systemPrompt: "sys",
			history: [],
			payload: { task: "task", projection: "dom" },
			currentPageScreenshotDataUrl: "data:image/jpeg;base64," + base64,
		});

		assert.strictEqual(messages.length, 2);
		assert.notStrictEqual(typeof messages[1].content, "string");
		const userContent = messages[1].content as Exclude<
			Message["content"],
			string
		>;
		assert.strictEqual(userContent[0].type, "text");
		assert.strictEqual(userContent[1].type, "file");
		const screenshotPart = userContent[1] as Extract<
			(typeof userContent)[number],
			{ type: "file" }
		>;
		assert.strictEqual(screenshotPart.mediaType, "image/jpeg");
		assert.strictEqual(screenshotPart.data, base64);
		assert.deepEqual(screenshotPart.providerOptions, {
			openai: { imageDetail: "low" },
		});
		assert.doesNotThrow(() => structuredClone(messages));
	});

	it("appends the max-step finalization instruction as a trailing user message", () => {
		const messages = buildMaxStepFinalizationMessages({
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "payload" },
			],
			finalizationInstruction: "finalize now",
		});

		assert.lengthOf(messages, 3);
		assert.deepEqual(messages[2], {
			role: "user",
			content: "finalize now",
		});
	});

	it("omits currentStep from payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			url: "https://example.com",
			previousInteractionErrors: [],
			projection: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
		});

		assert.strictEqual("currentStep" in payload, false);
	});

	it("always strips legacy plans from past-step history payloads", () => {
		const history: Message[] = [];
		appendHistoryWithStrippedPayload({
			history,
			payload: {
				task: "task",
				plan: ["one", "two"],
				currentURL: "https://example.com",
				projection: "dom",
				validRefs: ["ra"],
				currentTab: 0,
				openTabs: ["Home"],
				newlyOpenedTabs: ["Search"],
				autoTabSwitchNote: "Auto-switched to first newly opened tab.",
				interactionErrors: [],
				currentPageScreenshotIncludedAsImagePart: true,
			},
			assistant: {
				thinking: "",
				actions: [],
				done: false,
			},
		});

		assert.strictEqual(history.length, 2);
		const userMessageContent = history[0].content;
		assert.strictEqual(typeof userMessageContent, "string");
		const parsed = yaml.load(userMessageContent as string) as Record<
			string,
			unknown
		>;
		assert.strictEqual("plan" in parsed, false);
		assert.strictEqual("currentStep" in parsed, false);
		assert.strictEqual("currentTab" in parsed, false);
		assert.strictEqual("openTabs" in parsed, false);
		assert.strictEqual("newlyOpenedTabs" in parsed, false);
		assert.strictEqual("autoTabSwitchNote" in parsed, false);
		assert.strictEqual(
			"currentPageScreenshotIncludedAsImagePart" in parsed,
			false,
		);
		const assistant = yaml.load(String(history[1].content)) as Record<
			string,
			unknown
		>;
		assert.strictEqual(assistant.done, false);
		assert.notProperty(assistant, "result");
	});

	it("redacts native file data while preserving its message metadata", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{
						type: "file",
						data: "SECRETDATA",
						mediaType: "image/png",
						providerOptions: {
							openai: { imageDetail: "low" },
						},
					},
				],
			},
		];

		const serialized = serializeMessagesForDisk(messages);
		const serializedUser = serialized[1] as any;
		assert.deepEqual(serializedUser.content[1], {
			type: "file",
			data: "(base64 omitted)",
			mediaType: "image/png",
			providerOptions: {
				openai: { imageDetail: "low" },
			},
		});
	});

	it("persists native reasoning parts and provider metadata", () => {
		const messages: Message[] = [
			{ role: "system" as const, content: "sys" },
			{ role: "user" as const, content: "user" },
			{
				role: "assistant" as const,
				content: [
					{
						type: "reasoning",
						text: "chain of thought sample",
						providerOptions: {
							anthropic: { signature: "signature-1" },
						},
					},
					{ type: "text", text: "done: false" },
				],
			},
		];

		const serialized = serializeMessagesForDisk(messages);
		const serializedAssistant = serialized[2] as Record<string, unknown>;
		assert.notProperty(serialized[0], "reasoning_tokens");
		assert.notProperty(serialized[1], "reasoning_tokens");
		assert.notProperty(serializedAssistant, "reasoning_tokens");
		assert.deepEqual(serializedAssistant.content, messages[2]?.content);
		assert.deepNestedInclude(
			serializedAssistant,
			{
				"content[0].providerOptions.anthropic.signature": "signature-1",
			},
		);
	});

	it("preserves message-level cache breakpoint metadata when serializing", () => {
		const providerOptions = {
			openai: { promptCacheBreakpoint: { mode: "explicit" as const } },
		};
		const serialized = serializeMessagesForDisk([
			{
				role: "system",
				content: "stable system",
				providerOptions,
			},
		]);

		assert.deepEqual(serialized[0].providerOptions, providerOptions);
	});

	it("redacts context YAML and preserves multiline text and memory snapshots", async () => {
		const browser = {
			Runtime: {
				evaluate: async () => ({
					result: { value: "<html><body>ok</body></html>" },
				}),
			},
		} as Browser;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-ctx-test-"));
		const contextDir = path.join(tmpDir, "context");
		const stepsDir = path.join(tmpDir, "steps");
		const memoryFile = path.join(tmpDir, "memory.txt");
		const extractDataMemoryFile = path.join(tmpDir, "extract-data-memory.txt");

		try {
			fs.writeFileSync(memoryFile, "pre memory state", "utf-8");
			fs.writeFileSync(
				extractDataMemoryFile,
				"pre extract data memory state",
				"utf-8",
			);
			await saveStepContextIfNeeded({
				saveStepsContext: true,
				contextDir,
				stepsDir,
				stepNumber: 1,
				messages: [
					{ role: "system", content: "sys" },
					{
						role: "user",
						content: [
							{ type: "text", text: "line one\nline two" },
							{
								type: "file",
								data: "SECRETDATA",
								mediaType: "image/png",
							},
						],
					},
				],
				pageProjection: "dom",
				browser,
				memoryFile,
				extractDataMemoryFile,
				memorySnapshotPhase: "pre-llm",
			});

			const contextYaml = fs.readFileSync(
				path.join(contextDir, "context-001.yaml"),
				"utf-8",
			);
			assert(!contextYaml.includes("SECRETDATA"));
			assert(contextYaml.includes("(base64 omitted)"));
			assert(!contextYaml.includes("line one\\nline two"));
			assert(contextYaml.includes("line one\n"));
			assert(contextYaml.includes("line two"));
			const parsed = yaml.load(contextYaml) as Array<{
				content: Array<{ text?: string } | { data?: string }>;
			}>;
			assert.strictEqual(parsed[1]?.content?.[0]?.text, "line one\nline two");
			assert.strictEqual(parsed[1]?.content?.[1]?.data, "(base64 omitted)");
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "memory-001.pre-llm.txt"),
					"utf-8",
				),
				"pre memory state",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-001.pre-llm.txt"),
					"utf-8",
				),
				"pre extract data memory state",
			);

			fs.writeFileSync(memoryFile, "post memory state", "utf-8");
			fs.writeFileSync(
				extractDataMemoryFile,
				"post extract data memory state",
				"utf-8",
			);
			await saveStepContextIfNeeded({
				saveStepsContext: true,
				contextDir,
				stepsDir,
				stepNumber: 1,
				messages: [],
				pageProjection: "updated projection should not overwrite",
				browser,
				memoryFile,
				extractDataMemoryFile,
				memorySnapshotPhase: "post-actions",
				writeCoreFiles: false,
			});
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "memory-001.post-actions.txt"),
					"utf-8",
				),
				"post memory state",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-001.post-actions.txt"),
					"utf-8",
				),
				"post extract data memory state",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(stepsDir, "step-001.projection.txt"),
					"utf-8",
				),
				"dom",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
