import { assert } from "chai";
import { describe, it } from "mocha";
import type { Browser, Tab } from "../src/browser/types.js";
import { resolveCurrentTabIndex } from "../src/agents/executor-utils/step-context.js";

describe("resolveCurrentTabIndex", () => {
	it("prefers the connected target when Chrome reports multiple attached pages", async () => {
		const openTabs: Tab[] = [
			{
				targetId: "responder",
				url: "https://example.test/responder",
				title: "Responder",
			},
			{
				targetId: "editor",
				url: "https://example.test/editor",
				title: "Editor",
			},
		];
		const browser = {
			currentTargetId: "responder",
			Target: {
				getTargets: async () => ({
					targetInfos: [
						{ type: "page", targetId: "editor", attached: true },
						{ type: "page", targetId: "responder", attached: true },
					],
				}),
			},
		} as unknown as Browser;

		assert.strictEqual(
			await resolveCurrentTabIndex({
				b: browser,
				openTabs,
				currentUrl: "https://example.test/responder",
			}),
			0,
		);
	});
});
