import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import type { ModelMessage } from "ai";
import { extractDataResultsFromSnapshot } from "../src/agents/data-extraction.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";

const LLM_OPTIONS = { provider: "openai", model: "gpt-test" } as const;

function collectMessageText(messages: ModelMessage[]): string {
	return messages
		.flatMap((message) => {
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap((part) =>
				"text" in part && typeof part.text === "string" ? [part.text] : [],
			);
		})
		.join("\n");
}

describe("extractDataResultsFromSnapshot", () => {
	async function expectRejection(
		promise: Promise<unknown>,
		expectedMessage?: string,
	): Promise<void> {
		try {
			await promise;
			assert.fail("Expected promise to reject");
		} catch (error) {
			assert.instanceOf(error, Error);
			if (expectedMessage) {
				assert.strictEqual((error as Error).message, expectedMessage);
			}
		}
	}

	function mockResponse(content: string): void {
		__setProviderOverrideForTests("openai", async () => ({
			content,
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			reasoning_tokens: "",
			responseMessages: [{ role: "assistant", content }],
		}));
	}

	afterEach(() => {
		__setProviderOverrideForTests("openai", null);
	});

	it("hides hrefs behind link IDs while preserving runtime URL resolution", async () => {
		let prompt = "";
		__setProviderOverrideForTests("openai", async (args) => {
			prompt = collectMessageText(args.messages);
			return {
				content: [
					"items:",
					"  - link_id: link_1",
					"    summary: First product",
					"  - link_id: link_2",
					"    summary: Second product",
				].join("\n"),
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				reasoning_tokens: "",
				responseMessages: [{ role: "assistant", content: "items" }],
			};
		});

		const result = await extractDataResultsFromSnapshot({
			task: "Extract products",
			currentUrl: "https://example.com/search",
			pageProjection: [
				'article href="/private-one": First product',
				'  a href="https://other.example/private-two": Second product',
			].join("\n"),
			llmOptions: LLM_OPTIONS,
		});

		assert.include(prompt, 'article link_id="link_1": First product');
		assert.include(prompt, 'a link_id="link_2": Second product');
		assert.notInclude(prompt, "href=");
		assert.notInclude(prompt, "/private-one");
		assert.notInclude(prompt, "https://other.example/private-two");
		assert.deepStrictEqual(result.items, [
			{
				link: "https://example.com/private-one",
				summary: "First product",
			},
			{
				link: "https://other.example/private-two",
				summary: "Second product",
			},
		]);
	});

	it("resolves browser URL forms and falls back for unusable hrefs", async () => {
		mockResponse(
			[
				"items:",
				...Array.from({ length: 11 }, (_, index) => [
					`  - link_id: link_${index + 1}`,
					`    summary: Item ${index + 1}`,
				]).flat(),
			].join("\n"),
		);
		const currentUrl = "https://example.com/base/page?old=1#old";
		const hrefs = [
			"https://other.example/item",
			"//cdn.example/item",
			"/root",
			"path",
			"?sort=asc",
			"#details",
			"",
			"http://[invalid",
			"javascript:void(0)",
			"mailto:test@example.com",
			"data:text/plain,test",
		];

		const result = await extractDataResultsFromSnapshot({
			task: "Extract items",
			currentUrl,
			pageProjection: hrefs
				.map(
					(href, index) => `a href=${JSON.stringify(href)}: Item ${index + 1}`,
				)
				.join("\n"),
			llmOptions: LLM_OPTIONS,
		});

		assert.deepStrictEqual(
			result.items.map(({ link }) => link),
			[
				"https://other.example/item",
				"https://cdn.example/item",
				"https://example.com/root",
				"https://example.com/base/path",
				"https://example.com/base/page?sort=asc",
				"https://example.com/base/page?old=1#details",
				currentUrl,
				currentUrl,
				currentUrl,
				currentUrl,
				currentUrl,
			],
		);
	});

	it("supports repeated selection of one ID and link_current for linkless items", async () => {
		mockResponse(
			[
				"items:",
				"  - link_id: link_1",
				"    summary: First observation",
				"  - link_id: link_1",
				"    summary: Second observation",
				"  - link_id: link_current",
				"    summary: Linkless observation",
			].join("\n"),
		);

		const result = await extractDataResultsFromSnapshot({
			task: "Extract observations",
			currentUrl: "https://example.com/current",
			pageProjection: ['a href="/detail": Detail', "p: Linkless fact"].join(
				"\n",
			),
			llmOptions: LLM_OPTIONS,
		});

		assert.deepStrictEqual(result.items, [
			{
				link: "https://example.com/detail",
				summary: "First observation",
			},
			{
				link: "https://example.com/detail",
				summary: "Second observation",
			},
			{
				link: "https://example.com/current",
				summary: "Linkless observation",
			},
		]);
	});

	it("distinguishes semantic link roles from explicit link_id attributes", async () => {
		let prompt = "";
		__setProviderOverrideForTests("openai", async (args) => {
			prompt = collectMessageText(args.messages);
			return {
				content: [
					"items:",
					"  - link_id: link_current",
					"    summary: Delta nonstop flight, €3,277",
				].join("\n"),
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				reasoning_tokens: "",
				responseMessages: [{ role: "assistant", content: "items" }],
			};
		});
		const currentUrl = "https://www.google.com/travel/flights/search";
		const semanticLink =
			'link ref="r2o" name="From 3277 euros round trip total. Nonstop flight with Delta. Select flight"';

		const result = await extractDataResultsFromSnapshot({
			task: "Extract the available flights",
			currentUrl,
			pageProjection: semanticLink,
			llmOptions: LLM_OPTIONS,
		});

		assert.deepStrictEqual(result.items, [
			{
				link: currentUrl,
				summary: "Delta nonstop flight, €3,277",
			},
		]);
		assert.include(prompt, semanticLink);
		const semanticLinkPromptLine = prompt
			.split("\n")
			.find((line) => line.includes(semanticLink));
		assert.isDefined(semanticLinkPromptLine);
		assert.notInclude(semanticLinkPromptLine ?? "", "link_id=");
		assert.include(prompt, "link_id is the only valid projection attribute");
		assert.include(prompt, "including role, name, href, ref, visible text");
		assert.include(
			prompt,
			"Never derive or copy link_id from any other attribute",
		);
		assert.include(prompt, "literal link_current");
		assert.include(prompt, "exactly the two fields link_id and summary");
	});

	it("rejects a semantic link label copied into link_id", async () => {
		const semanticLabel =
			"From 3277 euros round trip total. Nonstop flight with Delta. Select flight";
		mockResponse(
			[
				"items:",
				`  - link_id: ${JSON.stringify(semanticLabel)}`,
				"    summary: Delta nonstop flight, €3,277",
			].join("\n"),
		);

		await expectRejection(
			extractDataResultsFromSnapshot({
				task: "Extract the available flights",
				currentUrl: "https://www.google.com/travel/flights/search",
				pageProjection: `ref="r2o" link: ${JSON.stringify(semanticLabel)}`,
				llmOptions: LLM_OPTIONS,
			}),
			`extract_data item 1 has unknown link_id ${JSON.stringify(semanticLabel)}`,
		);
	});

	for (const testCase of [
		{
			content: "result: invalid",
			message: "extract_data returned an invalid response",
		},
		{ content: "items: []", message: "extract_data returned no items" },
		{
			content: "items:\n  - summary: Product",
			message: "extract_data item 1 has an invalid link_id",
		},
		{
			content: "items:\n  - link_id: ''\n    summary: Product",
			message: "extract_data item 1 has an empty link_id",
		},
		{
			content: "items:\n  - link_id: 1\n    summary: Product",
			message: "extract_data item 1 has an invalid link_id",
		},
		{
			content: "items:\n  - link_id: link_999\n    summary: Product",
			message: 'extract_data item 1 has unknown link_id "link_999"',
		},
		{
			content:
				"items:\n  - link: https://example.com/invented\n    summary: Product",
			message: "extract_data item 1 contains a legacy link field",
		},
		{
			content: "items:\n  - link_id: link_current\n    summary: ''",
			message: "extract_data item 1 has an empty summary",
		},
	] as const) {
		it(`rejects ${testCase.message}`, async () => {
			mockResponse(testCase.content);
			await expectRejection(
				extractDataResultsFromSnapshot({
					task: "Extract products",
					currentUrl: "https://example.com",
					pageProjection: 'a href="/product": Product',
					llmOptions: LLM_OPTIONS,
				}),
				testCase.message,
			);
		});
	}

	it("rejects an empty current URL before calling the model", async () => {
		let called = false;
		__setProviderOverrideForTests("openai", async () => {
			called = true;
			throw new Error("unexpected");
		});
		await expectRejection(
			extractDataResultsFromSnapshot({
				task: "Extract",
				currentUrl: " ",
				pageProjection: "main: Products",
				llmOptions: LLM_OPTIONS,
			}),
			"extract_data requires a non-empty current URL",
		);
		assert.isFalse(called);
	});

	it("forwards abortSignal through chatYAML to the provider", async () => {
		const controller = new AbortController();
		let providerSignal: AbortSignal | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			providerSignal = args.abortSignal;
			return await new Promise((_resolve, reject) => {
				args.abortSignal?.addEventListener(
					"abort",
					() => reject(new Error("provider aborted")),
					{ once: true },
				);
			});
		});

		const extraction = extractDataResultsFromSnapshot({
			task: "Extract",
			currentUrl: "https://example.com",
			pageProjection: "main: Products",
			llmOptions: LLM_OPTIONS,
			abortSignal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.isFalse(providerSignal?.aborted);

		controller.abort(new Error("stop extraction"));
		await expectRejection(extraction, "stop extraction");
		assert.isTrue(providerSignal?.aborted);
	});
});
