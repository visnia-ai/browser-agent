import { assert } from "chai";
import { describe, it } from "mocha";
import { serializeSimplifiedNode } from "../src/browser/simplify-dom-utils/serialize-simplified-node.js";
import type { SimplifiedNode } from "../src/browser/simplify-dom-utils/simplified-node.js";

describe("serialize-simplified-node", () => {
	it("emits couldBeHidden once per hierarchy without repeating on descendants", () => {
		const tree: SimplifiedNode = {
			tag: "div",
			attrs: [],
			text: "",
			children: [
				{
					tag: "span",
					attrs: [["bid", "1"]],
					text: "candidate",
					children: [],
					isHidden: false,
					couldBeHidden: true,
					isInteractive: false,
				},
			],
			isHidden: false,
			couldBeHidden: false,
			isInteractive: false,
		};

		const serialized = serializeSimplifiedNode(tree, 0);
		assert.strictEqual(
			serialized,
			`div:
  couldBeHidden
    bid="1": "candidate"`,
		);
		assert.notInclude(serialized, "\nhidden:");
	});

	it("applies couldBeHidden once to a full hierarchy while preserving hidden grouping", () => {
		const tree: SimplifiedNode = {
			tag: "div",
			attrs: [["bid", "mh"]],
			text: "",
			children: [
				{
					tag: "region",
					attrs: [],
					text: "Filters",
					children: [
						{
							tag: "fieldset",
							attrs: [],
							text: "",
							children: [
								{
									tag: "div",
									attrs: [],
									text: "",
									children: [
										{
											tag: "label",
											attrs: [
												["bid", "lm"],
												["for", ":rm8:"],
											],
											text: "",
											children: [
												{
													tag: "div",
													attrs: [["bid", "ll"]],
													text: "",
													children: [],
													isHidden: false,
													couldBeHidden: true,
													isInteractive: false,
												},
												{
													tag: "div",
													attrs: [],
													text: "",
													children: [
														{
															tag: "div",
															attrs: [],
															text: "Hotels, 790",
															children: [],
															isHidden: false,
															isInteractive: false,
														},
													],
													isHidden: true,
													isInteractive: false,
												},
											],
											isHidden: false,
											couldBeHidden: true,
											isInteractive: false,
										},
									],
									isHidden: false,
									couldBeHidden: true,
									isInteractive: false,
								},
							],
							isHidden: false,
							couldBeHidden: true,
							isInteractive: false,
						},
					],
					isHidden: false,
					couldBeHidden: true,
					isInteractive: false,
				},
			],
			isHidden: false,
			couldBeHidden: true,
			isInteractive: false,
		};

		const serialized = serializeSimplifiedNode(tree, 0);
		assert.strictEqual(
			serialized,
			`couldBeHidden
  bid="mh":
    region: "Filters"
      fieldset:
        div:
          label bid="lm" for=":rm8:":
            bid="ll"
            hidden:
              div:
                "Hotels, 790"`,
		);
	});

	it("serializes scroll markers as bare tokens with deterministic order", () => {
		const node: SimplifiedNode = {
			tag: "div",
			attrs: [["bid", "sc1"]],
			text: "Scrollable container",
			children: [],
			isHidden: false,
			isInteractive: true,
			noClickAllowed: true,
			scrollEnabled: true,
			scrollable: true,
		};

		const serialized = serializeSimplifiedNode(node, 0);
		assert.strictEqual(
			serialized,
			`bid="sc1" no-click-allowed scroll-enabled scrollable: "Scrollable container"`,
		);
	});

	it("omits configured tag names for attribute-bearing nodes", () => {
		const node: SimplifiedNode = {
			tag: "p",
			attrs: [
				["bid", "1a"],
				["href", "/sample"],
			],
			text: "hello",
			children: [],
			isHidden: false,
			isInteractive: false,
		};

		const serialized = serializeSimplifiedNode(node, 0);
		assert.strictEqual(serialized, `bid="1a" href="/sample": "hello"`);
	});

	it("rewrites bid-only anchor text subtrees", () => {
		const tree: SimplifiedNode = {
			tag: "a",
			attrs: [
				["bid", "43"],
				["href", "/en/train-times/london-to-edinburgh"],
			],
			text: "",
			children: [
				{
					tag: "div",
					attrs: [["bid", "3z"]],
					text: "",
					children: [
						{
							tag: "div",
							attrs: [["bid", "3r,3q"]],
							text: "to",
							children: [
								{
									tag: "div",
									attrs: [["bid", "3o"]],
									text: "London",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
								{
									tag: "div",
									attrs: [["bid", "3p"]],
									text: "Edinburgh",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
							],
							isHidden: false,
							isInteractive: false,
						},
						{
							tag: "div",
							attrs: [["bid", "3y,3x"]],
							text: "",
							children: [
								{
									tag: "div",
									attrs: [["bid", "3t,3s"]],
									text: "from",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
								{
									tag: "div",
									attrs: [["bid", "3w,3v,3u"]],
									text: "40.73 €",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
							],
							isHidden: false,
							isInteractive: false,
						},
					],
					isHidden: false,
					isInteractive: false,
				},
				{
					tag: "div",
					attrs: [["bid", "42,41,40"]],
					text: "",
					children: [],
					isHidden: false,
					isInteractive: false,
				},
			],
			isHidden: false,
			isInteractive: true,
		};

		const serialized = serializeSimplifiedNode(tree, 0);
		assert.strictEqual(
			serialized,
			`a bid="43,3z,42,41,40,3r,3q,3o,3p,3y,3x,3t,3s,3w,3v,3u" href="/en/train-times/london-to-edinburgh":
  - "to":
    - "London"
    - "Edinburgh"
  - "from":
    - "40.73 €"`,
		);
	});

	it("rewrites bid-only anchor text subtrees for london-to-liverpool variant", () => {
		const tree: SimplifiedNode = {
			tag: "a",
			attrs: [
				["bid", "37"],
				["href", "/en/train-times/london-to-liverpool"],
			],
			text: "",
			children: [
				{
					tag: "div",
					attrs: [["bid", "33"]],
					text: "",
					children: [
						{
							tag: "div",
							attrs: [["bid", "2v,2u"]],
							text: "to",
							children: [
								{
									tag: "div",
									attrs: [["bid", "2s"]],
									text: "London",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
								{
									tag: "div",
									attrs: [["bid", "2t"]],
									text: "Liverpool",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
							],
							isHidden: false,
							isInteractive: false,
						},
						{
							tag: "div",
							attrs: [["bid", "32,31"]],
							text: "",
							children: [
								{
									tag: "div",
									attrs: [["bid", "2x,2w"]],
									text: "from",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
								{
									tag: "div",
									attrs: [["bid", "30,2z,2y"]],
									text: "16.82 €",
									children: [],
									isHidden: false,
									isInteractive: false,
								},
							],
							isHidden: false,
							isInteractive: false,
						},
					],
					isHidden: false,
					isInteractive: false,
				},
				{
					tag: "div",
					attrs: [["bid", "36,35,34"]],
					text: "",
					children: [],
					isHidden: false,
					isInteractive: false,
				},
			],
			isHidden: false,
			isInteractive: true,
		};

		const serialized = serializeSimplifiedNode(tree, 0);
		assert.strictEqual(
			serialized,
			`a bid="37,33,36,35,34,2v,2u,2s,2t,32,31,2x,2w,30,2z,2y" href="/en/train-times/london-to-liverpool":
  - "to":
    - "London"
    - "Liverpool"
  - "from":
    - "16.82 €"`,
		);
	});

	it("serializes long href attributes as bare href", () => {
		const longHref = `https://example.com/${"a".repeat(160)}`;
		const node: SimplifiedNode = {
			tag: "a",
			attrs: [
				["bid", "1"],
				["href", longHref],
			],
			text: "open link",
			children: [],
			isHidden: false,
			isInteractive: true,
		};

		const serialized = serializeSimplifiedNode(node, 0);
		assert.strictEqual(serialized, `bid="1" href: "open link"`);
	});

	it("preserves long href values when full href serialization is requested", () => {
		const longHref = `https://example.com/${"a".repeat(160)}`;
		const node: SimplifiedNode = {
			tag: "a",
			attrs: [
				["bid", "1"],
				["href", longHref],
			],
			text: "open link",
			children: [],
			isHidden: false,
			isInteractive: true,
		};

		const serialized = serializeSimplifiedNode(node, 0, false, false, {
			preserveFullHrefs: true,
		});
		assert.strictEqual(
			serialized,
			`bid="1" href="${longHref}": "open link"`,
		);
	});

	it("omits href attributes while preserving anchor semantics and bids", () => {
		const makeNode = (href: string): SimplifiedNode => ({
			tag: "a",
			attrs: [
				["bid", "1"],
				["href", href],
			],
			text: "open link",
			children: [],
			isHidden: false,
			isInteractive: true,
		});

		for (const href of [
			"/sample",
			"",
			`https://example.com/${"a".repeat(160)}`,
		]) {
			const serialized = serializeSimplifiedNode(
				makeNode(href),
				0,
				false,
				false,
				{ omitHrefs: true, preserveFullHrefs: true },
			);
			assert.strictEqual(serialized, `a bid="1": "open link"`);
			assert.notInclude(serialized, "href");
			assert.notInclude(serialized, href || "href");
		}
	});

	it("keeps href value when length is 150 characters or less", () => {
		const href150 = `https://example.com/${"a".repeat(130)}`;
		const node: SimplifiedNode = {
			tag: "a",
			attrs: [
				["bid", "1"],
				["href", href150],
			],
			text: "open link",
			children: [],
			isHidden: false,
			isInteractive: true,
		};

		const serialized = serializeSimplifiedNode(node, 0);
		assert.strictEqual(
			serialized,
			`bid="1" href="${href150}": "open link"`,
		);
	});

	it('serializes empty href values as href=""', () => {
		const node: SimplifiedNode = {
			tag: "a",
			attrs: [
				["bid", "1"],
				["href", ""],
			],
			text: "open link",
			children: [],
			isHidden: false,
			isInteractive: true,
		};

		const serialized = serializeSimplifiedNode(node, 0);
		assert.strictEqual(serialized, `bid="1" href="": "open link"`);
	});

	it("compresses repeated escape-character runs in text values", () => {
		const node: SimplifiedNode = {
			tag: "section",
			attrs: [],
			text: `prefix${"\n".repeat(41)}suffix`,
			children: [],
			isHidden: false,
			isInteractive: false,
		};

		const serialized = serializeSimplifiedNode(node, 0);
		assert.strictEqual(serialized, 'section: "prefix{ \\\\n * 41 }suffix"');
	});

	it("serializes each option on its own line instead of merging text-only leaves", () => {
		const tree: SimplifiedNode = {
			tag: "select",
			attrs: [
				["bid", "n"],
				["name", "track_id"],
			],
			text: "",
			children: [
				{
					tag: "option",
					attrs: [["value", ""]],
					text: "Choose Track",
					children: [],
					isHidden: false,
					couldBeHidden: false,
					isInteractive: false,
				},
				{
					tag: "option",
					attrs: [["value", "1"]],
					text: "Full Stack",
					children: [],
					isHidden: false,
					isInteractive: false,
				},
			],
			isHidden: false,
			isInteractive: true,
		};
		const serialized = serializeSimplifiedNode(tree, 0);
		assert.notInclude(serialized, "Choose Track, Full Stack");
		assert.notInclude(serialized, "couldBeHidden");
		assert.include(serialized, `option value="": "Choose Track"`);
		assert.include(serialized, `option value="1": "Full Stack"`);
	});

	it('serializes image src as compact img="..." without an img tag name', () => {
		const node: SimplifiedNode = {
			tag: "img",
			attrs: [
				["bid", "1a"],
				["src", "logo.png"],
			],
			text: "",
			children: [],
			isHidden: false,
			isInteractive: true,
		};

		const serialized = serializeSimplifiedNode(node, 0);
		assert.strictEqual(serialized, `bid="1a" img="logo.png"`);
		assert.notInclude(serialized, `src="logo.png"`);
		assert.notMatch(serialized, /^img\b/);
	});
});
