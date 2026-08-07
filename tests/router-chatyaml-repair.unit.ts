import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { chatYAML } from "../src/agents/providers/router.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";

describe("router chatYAML parse repair", () => {
	afterEach(() => {
		__setProviderOverrideForTests("openai", null);
	});

	it("repairs unquoted colon-containing text fields in otherwise valid YAML", async () => {
		__setProviderOverrideForTests("openai", async () => ({
			content: `<yaml>
thinking: "test"
tools:
  - type: click
    bid: iq,ip,io
  - type: type
    bid: g9
    text: Cheapest Round-Trip Flight: New York to Paris (May 4-11, 2026)
    enter: false
  - type: type
    bid: gd
    text: "Dear Recipient,\\n\\nBest regards"
    enter: false
done: false`,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
			},
			reasoning_tokens: "",
		}));

		const result = await chatYAML<any>(
			[{ role: "user", content: "test" }],
			{
				provider: "openai",
				model: "gpt-5.2-mini",
			},
			"router-repair-test",
		);

		assert.strictEqual(result.data.done, false);
		assert.strictEqual(
			result.data.tools[1].text,
			"Cheapest Round-Trip Flight: New York to Paris (May 4-11, 2026)",
		);
		assert.strictEqual(
			result.data.tools[2].text,
			"Dear Recipient,\n\nBest regards",
		);
		assert.include(
			result.raw_response ?? "",
			"text: Cheapest Round-Trip Flight:",
		);
		assert.notInclude(
			result.raw_response ?? "",
			'text: "Cheapest Round-Trip Flight:',
		);
	});

	it("repairs unquoted action-context summary fields without affecting canonical fields", async () => {
		__setProviderOverrideForTests("openai", async () => ({
			content: `<yaml>
previousStepStatus: progressed
previousStepOutcome: Found live orbital metrics on the tracking page.
currentStateObservation: Live data shows ALT: 427.74 km and SPD: 7.65 km/s for ISS.
nextActionRationale: Task is complete because all required values are visible.
tools: []
done: true
result:
  - link: "https://www.n2yo.com/satellite/?s=25544"
    summary: "ISS orbital data captured."
`,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
			},
			reasoning_tokens: "",
		}));

		const result = await chatYAML<any>(
			[{ role: "user", content: "test" }],
			{
				provider: "openai",
				model: "gpt-5.2-mini",
			},
			"router-action-context-repair-test",
		);

		assert.strictEqual(result.data.done, true);
		assert.deepEqual(result.data.tools, []);
		assert.strictEqual(
			result.data.currentStateObservation,
			"Live data shows ALT: 427.74 km and SPD: 7.65 km/s for ISS.",
		);
	});

	it("strips malformed advisory action-context fields and still parses canonical fields", async () => {
		__setProviderOverrideForTests("openai", async () => ({
			content: `<yaml>
previousStepStatus: progressed
previousStepOutcome: "Opened ISS tracking details
currentStateObservation: "Live data shows ALT: 427.74 km and SPD: 7.65 km/s for ISS.
nextActionRationale: "Task is complete because all required values are visible.
tools: []
done: true
result:
  - link: "https://www.n2yo.com/satellite/?s=25544"
    summary: "ISS orbital data captured."
`,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
			},
			reasoning_tokens: "",
		}));

		const result = await chatYAML<any>(
			[{ role: "user", content: "test" }],
			{
				provider: "openai",
				model: "gpt-5.2-mini",
			},
			"router-action-context-strip-test",
		);

		assert.strictEqual(result.data.done, true);
		assert.deepEqual(result.data.tools, []);
		assert.strictEqual(result.data.previousStepStatus, "progressed");
		assert.strictEqual(
			result.data.currentStateObservation,
			`"Live data shows ALT: 427.74 km and SPD: 7.65 km/s for ISS.`,
		);
	});
});
