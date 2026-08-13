import { assert } from "chai";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { close, launch, navigate } from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";
import { compileCustomTools } from "../src/custom-tools.js";

describe("custom tool page execution e2e", function () {
	this.timeout(90_000);

	it("runs an SDK-injected async function in the active page", async () => {
		let browser: Browser | null = null;
		try {
			const debuggingPort = 44_000 + (process.pid % 1_000);
			browser = await launch(debuggingPort, true);
			await navigate(
				browser,
				`data:text/html,${encodeURIComponent("<!doctype html><title>custom tool</title><div id='value'>before</div>")}`,
			);
			const tools = compileCustomTools([
				{
					name: "set_page_value",
					description: "Set and return the page value.",
					arguments: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
					javascript:
						"async (args) => { document.querySelector('#value').textContent = args.value; return { value: document.querySelector('#value').textContent, title: document.title }; }",
				},
			]);
			const execution = await executeActions({
				b: browser,
				actions: [
					{
						type: "custom_tool",
						name: "set_page_value",
						arguments: { value: "after" },
					},
				],
				openTabs: [],
				memoryFile: "/tmp/browser-agent-custom-tool-e2e-memory",
				customTools: tools,
			});
			assert.deepEqual(execution.interactionErrors, []);
			assert.include(
				execution.toolObservations[0],
				'"value":"after"',
			);
			const { result } = await browser.Runtime.evaluate({
				expression: "document.querySelector('#value').textContent",
				returnByValue: true,
			});
			assert.equal(result.value, "after");
		} finally {
			if (browser) await close(browser);
		}
	});
});
