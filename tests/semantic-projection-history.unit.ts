import { assert } from "chai";
import { describe, it } from "mocha";
import { stripPayloadForHistory } from "../src/agents/executor-utils/history-payload.js";
import { resolveProjectionHistoryContext } from "../src/core/projection-history.js";

describe("semantic projection history", () => {
	it("preserves the exact cumulative user payload", () => {
		const payload = {
			task: "test",
			currentURL: "https://example.test",
			projectionContextMode: "delta",
			projection: "@@ -1,1 +1,1 @@\n-button\n+button pressed=true",
			interactionErrors: [],
			latestUserPromptTokenCount: 123,
		};
		assert.deepEqual(
			stripPayloadForHistory({
				payload,
				cumulativeProjectionHistoryEnabled: true,
				projectionContextMode: "delta",
			}),
			payload,
		);
	});

	it("uses a delta after the initial reset even when it is larger than the full projection", () => {
		const context = resolveProjectionHistoryContext({
			previousProjection: 'button ref="r1" name="A"',
			currentProjection:
				'document ref="r9"\n  heading name="A completely different page"',
			maxDiffToFullRatio: Number.POSITIVE_INFINITY,
		});
		assert.equal(context.mode, "diff");
	});
});
