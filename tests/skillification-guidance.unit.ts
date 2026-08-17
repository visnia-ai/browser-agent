import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	findTaskExecutionOverride,
	loadTaskExecutionOverrides,
} from "../src/core/task-execution-overrides.js";
import { buildCompactTrajectoryArtifact } from "../src/trajectory/artifact.js";

describe("skillification guidance", () => {
	it("builds compact stripped trajectory artifacts while preserving currentURL", () => {
		const payload = {
			task: "Find a current price.",
			plan: ["[TODO] open result"],
			checklist: [
				"[DONE] C1 Return the current price.",
				"[TODO] C2 Include the currency.",
			],
			currentURL: "https://example.com/search?q=item",
			projection: 'document ref="r1" name="large page"',
			validRefs: ["r1"],
			interactionErrors: [],
			currentTab: 0,
			openTabs: ["Example"],
			downloadedFiles: [],
			workspaceFiles: [],
			currentPageScreenshotIncludedAsImagePart: true,
			latestUserPromptTokenCount: 123,
		};
		const entry = {
			task: "Find a current price.",
			completed: true,
			successful: true,
			finalResult: "Done",
			successVerification: {
				success: true,
				summary: "ok",
				reasons: [],
				model: "verifier",
				provider: "openai",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
			},
			modelInvocations: [
				{
					stage: "findTargetURL",
					output: { url: "https://example.com" },
				},
				{
					stage: "createChecklist",
					output: {
						items: ["Return the current price.", "Include the currency."],
					},
				},
			],
			steps: [
				{
					step: 1,
					step_kind: "executor_step",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: yaml.dump(payload) },
								{
									type: "image_url",
									image_url: { url: "(base64 omitted)" },
								},
							],
						},
						{
							role: "assistant",
							content: [
								{
									type: "reasoning",
									text: "Inspect the result page.",
									providerOptions: {
										anthropic: { signature: "signature-1" },
									},
								},
								{
									type: "text",
									text: yaml.dump({ tools: [{ click: "a" }] }),
								},
							],
						},
					],
				},
			],
		};

		const artifact = buildCompactTrajectoryArtifact(entry, {
			sourceFile: "steps-task-001.jsonl",
		});

		assert.strictEqual(artifact.sourceStepCount, 1);
		assert.strictEqual(artifact.sourceTargetUrl, "https://example.com");
		assert.notProperty(artifact, "originalPlan");
		assert.deepEqual(artifact.originalChecklist, [
			"Return the current price.",
			"Include the currency.",
		]);
		assert.deepEqual(artifact.finalChecklist, payload.checklist);
		assert.deepEqual(artifact.urlSequence, [
			"https://example.com/search?q=item",
		]);
		assert.strictEqual(
			artifact.steps[0].payload.currentURL,
			"https://example.com/search?q=item",
		);
		assert.notProperty(artifact.steps[0].payload, "projection");
		assert.notProperty(artifact.steps[0].payload, "validRefs");
		assert.notProperty(artifact.steps[0].payload, "task");
		assert.notProperty(
			artifact.steps[0].payload,
			"currentPageScreenshotIncludedAsImagePart",
		);
		assert.notProperty(artifact.steps[0], "done");
		assert.deepEqual(artifact.steps[0].assistant, {
			tools: [{ click: "a" }],
		});
	});

	it("skips non-YAML user text while building compact trajectory artifacts", () => {
		const entry = {
			task: "Finish a task.",
			completed: true,
			successful: true,
			steps: [
				{
					step: 1,
					step_kind: "executor_step",
					messages: [
						{
							role: "user",
							content:
								"Rules for this final step:\n- tools MUST be []\n- done MUST be true",
						},
						{
							role: "assistant",
							content: yaml.dump({
								tools: [],
								done: true,
								result: "Done",
							}),
						},
					],
				},
			],
		};

		const artifact = buildCompactTrajectoryArtifact(entry);

		assert.deepEqual(artifact.steps[0].payload, {});
		assert.strictEqual(artifact.steps[0].done, true);
	});

	it("loads neutral task execution overrides by exact normalized task text", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-overrides-"));
		const overridesPath = path.join(dir, "overrides.json");
		fs.writeFileSync(
			overridesPath,
			JSON.stringify({
				tasks: [
					{
						task: "Look up company info.",
						url: " https://example.com/company ",
						metadata: { source: "test" },
					},
				],
			}),
			"utf-8",
		);

		const index = loadTaskExecutionOverrides(overridesPath);
		const override = findTaskExecutionOverride(
			index,
			"Look   up company info.",
		);

		assert.strictEqual(override?.url, "https://example.com/company");
		assert.deepEqual(override?.metadata, { source: "test" });
	});

	it("rejects removed initial plan overrides", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-overrides-"));
		const overridesPath = path.join(dir, "overrides.json");
		fs.writeFileSync(
			overridesPath,
			JSON.stringify({
				tasks: [
					{
						task: "Look up company info.",
						initialPlanOverride: ["Open the company page"],
					},
				],
			}),
			"utf-8",
		);

		assert.throws(
			() => loadTaskExecutionOverrides(overridesPath),
			"initialPlanOverride has been removed",
		);
	});
});
