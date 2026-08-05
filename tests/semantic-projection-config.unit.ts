import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
	resolveConfigFromEnv,
	SEMANTIC_PROJECTION_HISTORY_ENV,
} from "../src/runtime/llm-env.js";

const ORIGINAL_VALUE = process.env[SEMANTIC_PROJECTION_HISTORY_ENV];

function configFixture() {
	const llm = {
		provider: "vllm",
		model: "test-model",
		reasoningEffort: "high",
		endpointUrl: "http://127.0.0.1:8000/v1",
	};
	return {
		stageLLMs: {
			findTargetURL: llm,
			createChecklist: llm,
			createChecklist: llm,
			runAgent: llm,
			dataExtraction: llm,
			verifySuccess: llm,
		},
		featureFlags: {
			semanticProjectionHistory: "current",
		},
	} as any;
}

describe("semantic projection config", () => {
	afterEach(() => {
		if (ORIGINAL_VALUE === undefined) {
			delete process.env[SEMANTIC_PROJECTION_HISTORY_ENV];
		} else {
			process.env[SEMANTIC_PROJECTION_HISTORY_ENV] = ORIGINAL_VALUE;
		}
	});

	it("selects cumulative history from the benchmark environment", () => {
		process.env[SEMANTIC_PROJECTION_HISTORY_ENV] = "cumulative";
		const resolved = resolveConfigFromEnv(configFixture());
		assert.strictEqual(
			resolved.featureFlags.semanticProjectionHistory,
			"cumulative",
		);
	});

	it("rejects unknown history strategies", () => {
		process.env[SEMANTIC_PROJECTION_HISTORY_ENV] = "legacy";
		assert.throws(
			() => resolveConfigFromEnv(configFixture()),
			`${SEMANTIC_PROJECTION_HISTORY_ENV} must be`,
		);
	});
});
