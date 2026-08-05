import { assert } from "chai";
import { describe, it } from "mocha";
import { pickMostParentBid } from "../src/browser/browser.js";

describe("find-most-parent-bid", () => {
	it("returns null for empty candidates", () => {
		const result = pickMostParentBid([]);
		assert.strictEqual(result, null, "Expected null for empty candidates.");
	});

	it("prioritizes highest containsCount", () => {
		const result = pickMostParentBid([
			{ bid: "child", containsCount: 0, depth: 6, inputOrder: 0 },
			{ bid: "parent", containsCount: 2, depth: 8, inputOrder: 1 },
			{ bid: "sibling", containsCount: 1, depth: 5, inputOrder: 2 },
		]);
		assert.strictEqual(
			result,
			"parent",
			"Should prioritize highest containsCount (most-parent relationship).",
		);
	});

	it("breaks ties by shallower depth", () => {
		const result = pickMostParentBid([
			{ bid: "a", containsCount: 2, depth: 4, inputOrder: 0 },
			{ bid: "b", containsCount: 2, depth: 2, inputOrder: 1 },
		]);
		assert.strictEqual(
			result,
			"b",
			"Should break ties by shallower depth (closer to document root).",
		);
	});

	it("breaks full ties by input order", () => {
		const result = pickMostParentBid([
			{ bid: "first", containsCount: 1, depth: 3, inputOrder: 0 },
			{ bid: "second", containsCount: 1, depth: 3, inputOrder: 1 },
		]);
		assert.strictEqual(
			result,
			"first",
			"Should break full ties by original input order.",
		);
	});

	it("does not mutate the candidates array", () => {
		const candidates = [
			{ bid: "x", containsCount: 0, depth: 10, inputOrder: 1 },
			{ bid: "y", containsCount: 0, depth: 10, inputOrder: 0 },
		];
		const snapshot = JSON.parse(JSON.stringify(candidates));
		const result = pickMostParentBid(candidates);
		assert.strictEqual(result, "y", "Should still produce deterministic output.");
		assert.deepEqual(
			candidates,
			snapshot,
			"Should not mutate the input candidates array.",
		);
	});
});
