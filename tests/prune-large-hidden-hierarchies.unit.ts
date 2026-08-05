import { assert } from "chai";
import { describe, it } from "mocha";
import { pruneLargeHiddenHierarchies } from "../src/browser/simplify-dom-utils/prune-large-hidden-hierarchies.js";

describe("prune-large-hidden-hierarchies", () => {
	it("removes an entire hidden hierarchy without bid when requested", () => {
		const input = `div:
  hidden:
    div:
      "Details"
  button bid="a1": "Open"`;

		assert.strictEqual(
			pruneLargeHiddenHierarchies(input, 1, true),
			`div:
  button bid="a1": "Open"`,
		);
	});

	it("keeps a hidden hierarchy without bid when not requested", () => {
		const input = `div:
  hidden:
    div:
      "Details"
  button bid="a1": "Open"`;

		assert.strictEqual(pruneLargeHiddenHierarchies(input, 1, false), input);
	});

	it("keeps hidden hierarchy content when that hierarchy has a bid", () => {
		const input = `div:
  hidden:
    button bid="h1": "Hidden CTA"
    div:
      "Details"
  button bid="a1": "Open"`;

		assert.strictEqual(pruneLargeHiddenHierarchies(input, 1, true), input);
	});
});
