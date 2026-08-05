import { assert } from "chai";
import { describe, it } from "mocha";
import { extractSimplifiedDomRegion } from "../src/browser/simplify-dom-utils/extract-simplified-dom-region.js";

const dom = [
	'main ncid="!root": Results',
	'  section ncid="!products": Products',
	'    article bid="a": First',
	'      a bid="a-link" href="https://example.com/a": First link',
	"      span: $1",
	'    article bid="b,legacy-b": Second',
	'      a bid="b-link" href="/b": Second link',
	"      span: $2",
	'  aside ncid="!aside": Filters',
	'    button bid="filter": Apply',
	'  footer ncid="!footer": Done',
].join("\n");

describe("extractSimplifiedDomRegion", () => {
	it("selects a complete root subtree by bid and strips identifiers", () => {
		assert.strictEqual(
			extractSimplifiedDomRegion({ simplifiedDom: dom, root: "b" }),
			[
				"article: Second",
				'  a href="/b": Second link',
				"  span: $2",
			].join("\n"),
		);
	});

	it("selects a root subtree by ncid with normalized indentation", () => {
		assert.strictEqual(
			extractSimplifiedDomRegion({
				simplifiedDom: dom,
				root: "!products",
			}),
			[
				"section: Products",
				"  article: First",
				'    a href="https://example.com/a": First link',
				"    span: $1",
				"  article: Second",
				'    a href="/b": Second link',
				"    span: $2",
			].join("\n"),
		);
	});

	it("deduplicates aliases that resolve to the same root", () => {
		assert.strictEqual(
			extractSimplifiedDomRegion({
				simplifiedDom: dom,
				root: "b,legacy-b",
			}),
			[
				"article: Second",
				'  a href="/b": Second link',
				"  span: $2",
			].join("\n"),
		);
	});

	it("emits multiple sibling roots once in document order", () => {
		assert.strictEqual(
			extractSimplifiedDomRegion({
				simplifiedDom: dom,
				root: "b,a",
			}),
			[
				"article: First",
				'  a href="https://example.com/a": First link',
				"  span: $1",
				"article: Second",
				'  a href="/b": Second link',
				"  span: $2",
			].join("\n"),
		);
	});

	it("collapses selected descendants into their selected ancestor", () => {
		const products = extractSimplifiedDomRegion({
			simplifiedDom: dom,
			root: "!products",
		});
		assert.strictEqual(
			extractSimplifiedDomRegion({
				simplifiedDom: dom,
				root: "a,!products,a-link",
			}),
			products,
		);
	});

	it("strips leading and identifier-only attributes without leaving syntax debris", () => {
		const attributeFirstDom = [
			'ncid="!wrapper":',
			'  bid="item" href="/item": Product',
			'    ncid="!inner":',
			'      bid="label": "Details"',
		].join("\n");
		assert.strictEqual(
			extractSimplifiedDomRegion({
				simplifiedDom: attributeFirstDom,
				root: "!wrapper",
			}),
			['href="/item": Product', '  "Details"'].join("\n"),
		);
	});

	it("normalizes each selected root and strips identifiers", () => {
		assert.strictEqual(
			extractSimplifiedDomRegion({
				simplifiedDom: dom,
				root: "filter,a",
			}),
			[
				"article: First",
				'  a href="https://example.com/a": First link',
				"  span: $1",
				"button: Apply",
			].join("\n"),
		);
	});

	it("fails the whole selection when any requested root is missing", () => {
		assert.throws(
			() => extractSimplifiedDomRegion({ simplifiedDom: dom }),
			/requires.*root/i,
		);
		assert.throws(
			() =>
				extractSimplifiedDomRegion({
					simplifiedDom: dom,
					root: "a,missing",
				}),
			/missing.*not found|not found.*missing/i,
		);
	});
});
