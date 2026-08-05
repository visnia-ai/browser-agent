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
