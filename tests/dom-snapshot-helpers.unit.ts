import { assert } from "chai";
import { describe, it } from "mocha";
import {
	buildLayoutByNode,
	createDomSnapshotHelpers,
} from "../src/browser/simplify-dom-utils/dom-snapshot-helpers.js";

interface HelperFixture {
	strings: string[];
	nodes: any;
	layout: any;
	layoutByNode: Map<number, number>;
}

function createHelpers(fixture: HelperFixture) {
	return createDomSnapshotHelpers({
		b: {} as any,
		nodeCount: fixture.nodes.nodeType.length,
		nodeNames: fixture.nodes.nodeName,
		nodes: fixture.nodes as any,
		strings: fixture.strings,
		layout: fixture.layout as any,
		layoutByNode: fixture.layoutByNode,
		clickableSet: new Set(),
	});
}

function makeFixture(params: {
	bounds: [number, number, number, number];
	display: string;
	visibility: string;
	opacity: string;
}): HelperFixture {
	const strings = ["DIV", params.display, params.visibility, params.opacity];
	const nodes = {
		nodeType: [1],
		nodeName: [0],
		attributes: [[]],
	};
	const layout = {
		nodeIndex: [0],
		bounds: [params.bounds],
		styles: [[1, 2, 3]],
	};
	return {
		strings,
		nodes,
		layout,
		layoutByNode: buildLayoutByNode(layout as any),
	};
}

function makeParentChildFixture(params: {
	parent: {
		bounds: [number, number, number, number];
		display: string;
		visibility: string;
		opacity: string;
	};
	child: {
		bounds: [number, number, number, number];
		display: string;
		visibility: string;
		opacity: string;
	};
}): HelperFixture {
	const strings = [
		"DIV",
		params.parent.display,
		params.parent.visibility,
		params.parent.opacity,
		params.child.display,
		params.child.visibility,
		params.child.opacity,
	];
	const nodes = {
		nodeType: [1, 1],
		nodeName: [0, 0],
		parentIndex: [-1, 0],
		attributes: [[], []],
	};
	const layout = {
		nodeIndex: [0, 1],
		bounds: [params.parent.bounds, params.child.bounds],
		styles: [
			[1, 2, 3],
			[4, 5, 6],
		],
	};
	return {
		strings,
		nodes,
		layout,
		layoutByNode: buildLayoutByNode(layout as any),
	};
}

describe("dom-snapshot-helpers hidden classification", () => {
	it("marks display:none as strict hidden", () => {
		const fixture = makeFixture({
			bounds: [0, 0, 100, 40],
			display: "none",
			visibility: "visible",
			opacity: "1",
		});
		const helpers = createHelpers(fixture);
		assert.strictEqual(helpers.isHidden(0), true);
		assert.strictEqual(helpers.couldBeHidden(0), false);
	});

	it("marks opacity:0 as strict hidden", () => {
		const fixture = makeFixture({
			bounds: [0, 0, 100, 40],
			display: "block",
			visibility: "visible",
			opacity: "0",
		});
		const helpers = createHelpers(fixture);
		assert.strictEqual(helpers.isHidden(0), true);
		assert.strictEqual(helpers.couldBeHidden(0), false);
	});

	it("keeps mixed hierarchies as couldBeHidden without promoting to hidden", () => {
		const fixture = makeParentChildFixture({
			parent: {
				bounds: [0, 0, 100, 40],
				display: "block",
				visibility: "hidden",
				opacity: "1",
			},
			child: {
				bounds: [0, 0, 100, 20],
				display: "block",
				visibility: "visible",
				opacity: "1",
			},
		});
		const helpers = createHelpers(fixture);
		assert.strictEqual(helpers.couldBeHidden(0), true);
		assert.strictEqual(helpers.isHidden(0), false);
		assert.strictEqual(helpers.couldBeHidden(1), false);
		assert.strictEqual(helpers.isHidden(1), false);
	});

	it("promotes hierarchy to hidden when all nodes are couldBeHidden", () => {
		const fixture = makeParentChildFixture({
			parent: {
				bounds: [0, 0, 100, 40],
				display: "block",
				visibility: "hidden",
				opacity: "1",
			},
			child: {
				bounds: [0, 0, 0, 0],
				display: "block",
				visibility: "visible",
				opacity: "1",
			},
		});
		const helpers = createHelpers(fixture);
		assert.strictEqual(helpers.couldBeHidden(0), true);
		assert.strictEqual(helpers.couldBeHidden(1), true);
		assert.strictEqual(helpers.isHidden(0), true);
		assert.strictEqual(helpers.isHidden(1), true);
	});

	it("classifies either zero client dimension as couldBeHidden", () => {
		for (const bounds of [
			[0, 0, 0, 40],
			[0, 0, 100, 0],
		]) {
			const fixture = makeFixture({
				bounds,
				display: "block",
				visibility: "visible",
				opacity: "1",
			});
			const helpers = createHelpers(fixture);
			assert.strictEqual(helpers.couldBeHidden(0), true);
			assert.strictEqual(helpers.isHidden(0), true);
		}
	});

	it("treats option as visible when enclosing select is visible (ignores display:none on option)", () => {
		const strings = [
			"SELECT",
			"OPTION",
			"block",
			"visible",
			"1",
			"none",
			"visible",
			"1",
		];
		const nodes = {
			nodeType: [1, 1],
			nodeName: [0, 1],
			parentIndex: [-1, 0],
			attributes: [[], []],
		};
		const layout = {
			nodeIndex: [0, 1],
			bounds: [
				[0, 0, 100, 30],
				[0, 0, 0, 0],
			],
			styles: [
				[2, 3, 4],
				[5, 6, 7],
			],
		};
		const helpers = createDomSnapshotHelpers({
			b: {} as any,
			nodeCount: 2,
			nodeNames: nodes.nodeName,
			nodes: nodes as any,
			strings,
			layout: layout as any,
			layoutByNode: buildLayoutByNode(layout as any),
			clickableSet: new Set(),
		});
		assert.strictEqual(helpers.isHidden(0), false);
		assert.strictEqual(helpers.isHidden(1), false);
	});

	it("marks option hidden when enclosing select is hidden", () => {
		const strings = [
			"SELECT",
			"OPTION",
			"none",
			"visible",
			"1",
			"block",
			"visible",
			"1",
		];
		const nodes = {
			nodeType: [1, 1],
			nodeName: [0, 1],
			parentIndex: [-1, 0],
			attributes: [[], []],
		};
		const layout = {
			nodeIndex: [0, 1],
			bounds: [
				[0, 0, 100, 30],
				[0, 0, 50, 20],
			],
			styles: [
				[2, 3, 4],
				[5, 6, 7],
			],
		};
		const helpers = createDomSnapshotHelpers({
			b: {} as any,
			nodeCount: 2,
			nodeNames: nodes.nodeName,
			nodes: nodes as any,
			strings,
			layout: layout as any,
			layoutByNode: buildLayoutByNode(layout as any),
			clickableSet: new Set(),
		});
		assert.strictEqual(helpers.isHidden(0), true);
		assert.strictEqual(helpers.isHidden(1), true);
	});

	it("finds enclosing select through optgroup", () => {
		const strings = [
			"SELECT",
			"OPTGROUP",
			"OPTION",
			"block",
			"visible",
			"1",
			"none",
			"visible",
			"1",
		];
		const nodes = {
			nodeType: [1, 1, 1],
			nodeName: [0, 1, 2],
			parentIndex: [-1, 0, 1],
			attributes: [[], [], []],
		};
		const layout = {
			nodeIndex: [0, 1, 2],
			bounds: [
				[0, 0, 100, 30],
				[0, 0, 80, 20],
				[0, 0, 0, 0],
			],
			styles: [
				[3, 4, 5],
				[3, 4, 5],
				[6, 7, 8],
			],
		};
		const helpers = createDomSnapshotHelpers({
			b: {} as any,
			nodeCount: 3,
			nodeNames: nodes.nodeName,
			nodes: nodes as any,
			strings,
			layout: layout as any,
			layoutByNode: buildLayoutByNode(layout as any),
			clickableSet: new Set(),
		});
		assert.strictEqual(helpers.isHidden(0), false);
		assert.strictEqual(helpers.isHidden(2), false);
	});
});

describe("dom-snapshot-helpers scroll classification", () => {
	it("detects scroll-enabled from overflow styles", () => {
		const strings = [
			"DIV",
			"block",
			"visible",
			"1",
			"default",
			"auto",
			"hidden",
		];
		const nodes = {
			nodeType: [1],
			nodeName: [0],
			attributes: [[]],
			backendNodeId: [101],
		};
		const layout = {
			nodeIndex: [0],
			bounds: [[0, 0, 180, 60]],
			styles: [[1, 2, 3, 4, 5, 6]],
		};
		const helpers = createDomSnapshotHelpers({
			b: {} as any,
			nodeCount: 1,
			nodeNames: nodes.nodeName,
			nodes: nodes as any,
			strings,
			layout: layout as any,
			layoutByNode: buildLayoutByNode(layout as any),
			clickableSet: new Set(),
		});
		assert.strictEqual(helpers.scrollEnabled(0), true);
	});

	it("returns runtime scrollable only for overflow-enabled candidates", async () => {
		const strings = [
			"DIV",
			"block",
			"visible",
			"1",
			"default",
			"auto",
			"hidden",
		];
		const nodes = {
			nodeType: [1, 1],
			nodeName: [0, 0],
			attributes: [[], []],
			backendNodeId: [201, 202],
		};
		const layout = {
			nodeIndex: [0, 1],
			bounds: [
				[0, 0, 200, 80],
				[0, 0, 200, 80],
			],
			styles: [
				[1, 2, 3, 4, 5, 6],
				[1, 2, 3, 4, 6, 6],
			],
		};
		const browser = {
			DOM: {
				pushNodesByBackendIdsToFrontend: async ({
					backendNodeIds,
				}: {
					backendNodeIds: number[];
				}) => {
					assert.deepEqual(backendNodeIds, [201]);
					return { nodeIds: [3001] };
				},
				resolveNode: async ({ nodeId }: { nodeId: number }) => {
					assert.strictEqual(nodeId, 3001);
					return { object: { objectId: "obj-3001" } };
				},
			},
			Runtime: {
				callFunctionOn: async () => ({ result: { value: true } }),
			},
		};
		const helpers = createDomSnapshotHelpers({
			b: browser as any,
			nodeCount: 2,
			nodeNames: nodes.nodeName,
			nodes: nodes as any,
			strings,
			layout: layout as any,
			layoutByNode: buildLayoutByNode(layout as any),
			clickableSet: new Set(),
		});
		const scrollable = await helpers.getScrollableByNodeIndex();
		assert.strictEqual(scrollable.get(0), true);
		assert.strictEqual(scrollable.has(1), false);
		assert.strictEqual(helpers.scrollEnabled(0), true);
		assert.strictEqual(helpers.scrollEnabled(1), false);
	});
});
