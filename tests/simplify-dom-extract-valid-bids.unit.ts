import { assert } from "chai";
import { describe, it } from "mocha";
import { extractValidBids } from "../src/browser/simplify-dom-utils/extract-valid-bids.js";

describe("extract-valid-bids", () => {
	it("keeps visible bids from indented simplified DOM", () => {
		const simplified = `div:
  button bid="v1": Visible One
  hidden:
    button bid="h1": Hidden One
    div:
      input bid="h2" type="text" value="x": x
  section:
    a bid="v2" href="/foo": Visible Two
    hidden:
      button bid="h3": Hidden Three
  input bid="v3" type="text" value="abc": abc
  button bid="v1": Duplicate Visible`;

		const expectedVisibleBids = ["v1", "v2", "v3"];

		assert.deepEqual(
			extractValidBids(simplified),
			expectedVisibleBids,
			"Should only keep visible bids in indented simplified DOM.",
		);
	});

	it("returns an empty list for empty input", () => {
		assert.deepEqual(
			extractValidBids(""),
			[],
			"Should return empty array for empty DOM input.",
		);
	});
});
