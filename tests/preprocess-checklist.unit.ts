import { assert } from "chai";
import { describe, it } from "mocha";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";
import {
	closeSession,
	createSession,
	preprocessTask,
} from "../src/core/index.js";

describe("preprocess task checklist", () => {
	it("creates a task-only checklist without fetching a planner projection", async () => {
		let projectionCalls = 0;
		const deps = createMockCoreDeps({
			featureFlags: {
				...createMockCoreDeps().featureFlags,
				taskChecklist: true,
			},
			getPageProjection: async () => {
				projectionCalls += 1;
				return "unexpected";
			},
			createChecklist: async (task) => {
				assert.equal(task, "Return every requested field");
				return { items: ["Return every requested field."] };
			},
		});
		await createSession(deps, {
			port: 9390,
			headless: true,
			url: "https://example.com",
			forceRestart: true,
		});
		try {
			const result = await preprocessTask(deps, {
				port: 9390,
				userTask: "Return every requested field",
				url: "https://example.com",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
				},
			});
			assert.equal(projectionCalls, 0);
			assert.deepEqual(result.checklist, [
				{
					id: "C1",
					requirement: "Return every requested field.",
					status: "TODO",
				},
			]);
		} finally {
			await closeSession(deps, 9390);
		}
	});
});
