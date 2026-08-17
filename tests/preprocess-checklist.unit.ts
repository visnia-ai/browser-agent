import { assert } from "chai";
import { describe, it } from "mocha";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";
import {
	closeSession,
	createSession,
	preprocessTask,
} from "../src/core/index.js";

describe("preprocess task checklist", () => {
	it("omits PDF viewer tabs from context while retaining the raw tab baseline", async () => {
		const tabs = [
			{
				targetId: "tab-source",
				title: "Dashboard",
				url: "https://example.com/dashboard",
			},
			{
				targetId: "tab-pdf",
				title: "report.pdf",
				url: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Fexample.com%2Freport.pdf",
			},
		];
		let resolvedTabs: typeof tabs | undefined;
		const deps = createMockCoreDeps({
			getCurrentURL: async () => tabs[0].url,
			listTabs: async () => tabs,
			resolveCurrentTabIndex: async ({ openTabs }) => {
				resolvedTabs = openTabs;
				return 0;
			},
		});
		await createSession(deps, {
			port: 9391,
			headless: true,
			url: tabs[0].url,
			forceRestart: true,
		});
		try {
			const result = await preprocessTask(deps, {
				port: 9391,
				userTask: "Read the dashboard",
				url: tabs[0].url,
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
				},
			});

			assert.deepEqual(resolvedTabs, [tabs[0]]);
			assert.deepEqual(result.context.open_tabs, ["Dashboard"]);
			assert.strictEqual(result.context.current_tab, 0);
			assert.deepEqual(deps.registry.get(9391)?.previousStepTabs, tabs);
		} finally {
			await closeSession(deps, 9391);
		}
	});

	it("creates a task-only checklist without fetching a planner projection", async () => {
		let projectionCalls = 0;
		const deps = createMockCoreDeps({
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
