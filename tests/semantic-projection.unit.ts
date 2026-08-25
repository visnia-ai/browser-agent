import { assert } from "chai";
import { describe, it } from "mocha";
import { getSemanticProjection } from "../src/browser/semantic-projection.js";
import { getSemanticRefTargets } from "../src/browser/semantic-ref-registry.js";
import type { Browser } from "../src/browser/types.js";

function axValue(value: string) {
	return { type: "computedString", value } as const;
}

function makeBrowser(nodes: unknown[]): Browser {
	return {
		Accessibility: {
			getFullAXTree: async () => ({ nodes }),
		},
	} as unknown as Browser;
}

describe("semantic projection", () => {
	it("extracts a requested child frame and records relocation metadata", async () => {
		let receivedFrameId: string | undefined;
		const browser = {
			Runtime: {
				evaluate: async () => {
					throw new Error("frame projection must not inspect the parent runtime");
				},
			},
			Accessibility: {
				getFullAXTree: async (params?: { frameId?: string }) => {
					receivedFrameId = params?.frameId;
					return {
						nodes: [
							{
								nodeId: "1",
								backendDOMNodeId: 101,
								role: axValue("RootWebArea"),
								name: axValue("OnePick"),
								childIds: ["2"],
							},
							{
								nodeId: "2",
								backendDOMNodeId: 102,
								role: axValue("dialog"),
								name: axValue("Insert file"),
								childIds: ["3"],
							},
							{
								nodeId: "3",
								backendDOMNodeId: 103,
								role: axValue("button"),
								name: axValue("Browse"),
							},
						],
					};
				},
			},
		} as unknown as Browser;

		const projection = await getSemanticProjection(browser, {
			frameId: "frame-picker",
		});

		assert.strictEqual(receivedFrameId, "frame-picker");
		assert.include(projection, 'button ref="r2v" name="Browse"');
		const browseTarget = getSemanticRefTargets(browser).find(
			(target) => target.name === "Browse",
		);
		assert.deepInclude(browseTarget, {
			role: "button",
			name: "Browse",
			frameId: "frame-picker",
		});
		assert.deepEqual(browseTarget?.ancestorSignature, [
			"document(OnePick)",
			"dialog(Insert file)",
		]);
	});

	it("bypasses full AX extraction only for large native plain-text documents", async () => {
		let fullAXTreeCalls = 0;
		const browser = {
			Runtime: {
				evaluate: async () => ({
					result: {
						value: {
							contentType: "text/plain",
							nativePlainTextShape: true,
							characterCount: 3_864_805,
							preview: "a\naa\naaa\naah\n",
						},
					},
				}),
			},
			Accessibility: {
				getFullAXTree: async () => {
					fullAXTreeCalls += 1;
					return { nodes: [] };
				},
			},
		} as unknown as Browser;

		const projection = await getSemanticProjection(browser);

		assert.equal(fullAXTreeCalls, 0);
		assert.equal(
			projection,
			[
				"projection semantic-v1 refs=0",
				'document name="Large plain-text resource" value="3864805 characters"',
				'  text name="a aa aaa aah"',
				'  text name="[remaining plain text omitted from semantic projection]"',
			].join("\n"),
		);
		assert.deepEqual(getSemanticRefTargets(browser), []);
	});

	it("retains full AX extraction for large HTML and ambiguous document probes", async () => {
		for (const probeValue of [
			{
				contentType: "text/html",
				nativePlainTextShape: true,
				characterCount: 3_864_805,
			},
			{
				contentType: "text/plain",
				nativePlainTextShape: false,
				characterCount: 3_864_805,
			},
			{ contentType: "" },
		]) {
			let fullAXTreeCalls = 0;
			const browser = {
				Runtime: {
					evaluate: async () => ({ result: { value: probeValue } }),
				},
				Accessibility: {
					getFullAXTree: async () => {
						fullAXTreeCalls += 1;
						return {
							nodes: [
								{
									nodeId: "1",
									backendDOMNodeId: 1,
									role: {
										type: "role",
										value: "RootWebArea",
									},
									name: {
										type: "computedString",
										value: "Rich source",
									},
								},
							],
						};
					},
				},
			} as unknown as Browser;

			const projection = await getSemanticProjection(browser);

			assert.equal(fullAXTreeCalls, 1);
			assert.include(
				projection,
				'document ref="r1" name="Rich source"',
			);
		}
	});

	it("retains full AX extraction for small native plain-text documents", async () => {
		let fullAXTreeCalls = 0;
		const browser = {
			Runtime: {
				evaluate: async () => ({
					result: {
						value: {
							contentType: "text/plain",
							nativePlainTextShape: true,
							characterCount: 10_000,
							preview: "short document",
						},
					},
				}),
			},
			Accessibility: {
				getFullAXTree: async () => {
					fullAXTreeCalls += 1;
					return { nodes: [] };
				},
			},
		} as unknown as Browser;

		await getSemanticProjection(browser);

		assert.equal(fullAXTreeCalls, 1);
	});

	it("is stable across identical snapshots and removes duplicated control text", async () => {
		const browser = {
			Accessibility: {
				getFullAXTree: async () => ({
					nodes: [
						{
							nodeId: "1",
							backendDOMNodeId: 1,
							role: { type: "role", value: "RootWebArea" },
							name: { type: "computedString", value: "Example" },
							childIds: ["2"],
						},
						{
							nodeId: "2",
							backendDOMNodeId: 2,
							role: { type: "role", value: "button" },
							name: { type: "computedString", value: "Run" },
							childIds: ["3"],
						},
						{
							nodeId: "3",
							backendDOMNodeId: 3,
							role: { type: "role", value: "StaticText" },
							name: { type: "computedString", value: "Run" },
						},
					],
				}),
			},
		} as unknown as Browser;

		const first = await getSemanticProjection(browser);
		const second = await getSemanticProjection(browser);

		assert.equal(first, second);
		assert.include(first, 'document ref="r1" name="Example"');
		assert.include(first, 'button ref="r2" name="Run"');
		assert.notInclude(first, "statictext");
	});

	it("retains long hrefs for extraction snapshots", async () => {
		const longHref = `https://example.test/items?cursor=${"x".repeat(700)}`;
		const browser = makeBrowser([
			{
				nodeId: "1",
				backendDOMNodeId: 1,
				role: axValue("RootWebArea"),
				name: axValue("Example"),
				childIds: ["2"],
			},
			{
				nodeId: "2",
				backendDOMNodeId: 2,
				role: axValue("link"),
				name: axValue("Next"),
				properties: [{ name: "url", value: axValue(longHref) }],
			},
		]);

		const canonical = await getSemanticProjection(browser, {
			omitHrefs: false,
		});
		const extraction = await getSemanticProjection(browser, {
			omitHrefs: false,
			preserveFullHrefs: true,
		});

		assert.notInclude(canonical, longHref);
		assert.include(extraction, longHref);
	});

	it("canonicalizes passive structure and native options without hiding actionable refs", async () => {
		const browser = makeBrowser([
			{
				nodeId: "1",
				backendDOMNodeId: 1,
				role: axValue("RootWebArea"),
				name: axValue("Example"),
				childIds: ["2", "6", "9"],
			},
			{
				nodeId: "2",
				backendDOMNodeId: 2,
				role: axValue("combobox"),
				name: axValue("Fruit"),
				value: axValue("Apple"),
				childIds: ["3", "4"],
			},
			{
				nodeId: "3",
				backendDOMNodeId: 3,
				role: axValue("option"),
				name: axValue("Apple"),
			},
			{
				nodeId: "4",
				backendDOMNodeId: 4,
				role: axValue("option"),
				name: axValue("Banana"),
			},
			{
				nodeId: "6",
				role: axValue("paragraph"),
				childIds: ["7", "8"],
			},
			{
				nodeId: "7",
				role: axValue("StaticText"),
				name: axValue("Ready"),
			},
			{
				nodeId: "8",
				role: axValue("StaticText"),
				name: axValue("\uE05E"),
			},
			{
				nodeId: "9",
				backendDOMNodeId: 9,
				role: axValue("heading"),
				name: axValue("Expandable"),
				properties: [
					{
						name: "focusable",
						value: { type: "boolean", value: true },
					},
				],
			},
		]);

		const projection = await getSemanticProjection(browser);
		assert.include(
			projection,
			'combobox ref="r2" name="Fruit" value="Apple" options=["Apple","Banana"]',
		);
		assert.notInclude(projection, 'option ref="r3"');
		assert.notInclude(projection, 'option ref="r4"');
		assert.include(projection, 'text name="Ready"');
		assert.notInclude(projection, "\uE05E");
		assert.include(projection, 'heading ref="r9" name="Expandable"');

		const exposedTargets = getSemanticRefTargets(browser);
		assert.sameMembers(
			exposedTargets.map((target) => target.ref),
			["r1", "r2", "r9"],
		);
	});
});
