import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import type { Browser } from "../src/browser/types.js";
import { type as typeText } from "../src/browser/interaction/type.js";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import { replaceSemanticRefSnapshot } from "../src/browser/semantic-ref-registry.js";

type TypeStubState = {
	dispatchedCharacters: string[];
	insertedTexts: string[];
	value: string;
};

function createBrowserStub(attributes: string[]): Browser & {
	state: TypeStubState;
} {
	const state: TypeStubState = {
		dispatchedCharacters: [],
		insertedTexts: [],
		value: "existing",
	};
	const browser = {
		DOM: {
			getDocument: async () => ({ root: { nodeId: 0 } }),
			pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [1] }),
			resolveNode: async () => ({ object: { objectId: "field-object" } }),
			scrollIntoViewIfNeeded: async () => undefined,
			focus: async () => undefined,
			describeNode: async () => ({
				node: { nodeName: "INPUT", attributes },
			}),
		},
		Input: {
			dispatchKeyEvent: async (event: {
				type: string;
				text?: string;
			}) => {
				if (event.type === "char" && event.text) {
					state.dispatchedCharacters.push(event.text);
					state.value += event.text;
				}
			},
			insertText: async ({ text }: { text: string }) => {
				state.insertedTexts.push(text);
				state.value += text;
			},
		},
		Runtime: {
			callFunctionOn: async (params: {
				functionDeclaration?: string;
			}) => {
				if (
					params.functionDeclaration ===
					"function() { this.value = ''; }"
				) {
					state.value = "";
					return { result: { value: undefined } };
				}
				if (
					params.functionDeclaration?.includes("value === expected")
				) {
					return { result: { value: state.value === "bulk value" } };
				}
				return { result: { value: "" } };
			},
		},
		state,
	} as unknown as Browser & { state: TypeStubState };
	replaceSemanticRefSnapshot(browser, [
		{
			ref: "field",
			backendNodeId: 1,
			role: "textbox",
			capabilities: ["type"],
		},
	]);
	return browser;
}

describe("optimized text input", () => {
	let originalFlag: boolean;

	beforeEach(() => {
		originalFlag = configFeatureFlags.optimizeTextInput;
		configFeatureFlags.optimizeTextInput = true;
	});

	afterEach(() => {
		configFeatureFlags.optimizeTextInput = originalFlag;
	});

	it("bulk inserts ordinary text inputs", async () => {
		const browser = createBrowserStub(["type", "text"]);

		await typeText(browser, "field", "bulk value");

		assert.deepEqual(browser.state.insertedTexts, ["bulk value"]);
		assert.deepEqual(browser.state.dispatchedCharacters, []);
	});

	it("preserves the legacy key-event path while disabled", async () => {
		configFeatureFlags.optimizeTextInput = false;
		const browser = createBrowserStub(["type", "text"]);

		await typeText(browser, "field", "legacy");

		assert.deepEqual(browser.state.insertedTexts, []);
		assert.deepEqual(browser.state.dispatchedCharacters, [
			"l",
			"e",
			"g",
			"a",
			"c",
			"y",
		]);
	});

	it("preserves key events for autocomplete-style inputs", async () => {
		const browser = createBrowserStub([
			"type",
			"text",
			"role",
			"combobox",
			"aria-autocomplete",
			"list",
		]);

		await typeText(browser, "field", "query");

		assert.deepEqual(browser.state.insertedTexts, []);
		assert.deepEqual(browser.state.dispatchedCharacters, [
			"q",
			"u",
			"e",
			"r",
			"y",
		]);
	});

	it("falls back to key events when bulk insertion does not verify", async () => {
		const browser = createBrowserStub(["type", "email"]);

		await typeText(browser, "field", "fallback");

		assert.deepEqual(browser.state.insertedTexts, ["fallback"]);
		assert.deepEqual(browser.state.dispatchedCharacters, [
			"f",
			"a",
			"l",
			"l",
			"b",
			"a",
			"c",
			"k",
		]);
	});
});
