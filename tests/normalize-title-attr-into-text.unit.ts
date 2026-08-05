import { assert } from "chai";
import { describe, it } from "mocha";
import { normalizeTitleAttrIntoText } from "../src/browser/simplify-dom-utils/normalize-title-attr-into-text.js";
import type { SimplifiedNode } from "../src/browser/simplify-dom-utils/simplified-node.js";

function cloneNode(node: SimplifiedNode): SimplifiedNode {
	return JSON.parse(JSON.stringify(node)) as SimplifiedNode;
}

describe("normalize-title-attr-into-text", () => {
	it("keeps the longest overlapping value when title contains text", () => {
		const input: SimplifiedNode = {
			tag: "button",
			attrs: [["title", "Duration, Not selected"]],
			text: "Duration",
			children: [],
			isHidden: false,
			isInteractive: true,
		};
		const output = normalizeTitleAttrIntoText(cloneNode(input));
		assert.deepEqual(
			output.text,
			"Duration, Not selected",
			"Should keep the longest overlapping value in text when title contains text.",
		);
		assert.deepEqual(
			output.attrs,
			[],
			"Should remove title when there is a single overlapping title attr.",
		);
	});

	it("keeps longer text when text contains title", () => {
		const input: SimplifiedNode = {
			tag: "button",
			attrs: [["title", "Duration"]],
			text: "Duration, Not selected",
			children: [],
			isHidden: false,
			isInteractive: true,
		};
		const output = normalizeTitleAttrIntoText(cloneNode(input));
		assert.deepEqual(
			output.text,
			"Duration, Not selected",
			"Should keep longer text when text contains title.",
		);
		assert.deepEqual(
			output.attrs,
			[],
			"Should remove redundant single title when it overlaps with text.",
		);
	});

	it("leaves unrelated title attrs untouched", () => {
		const input: SimplifiedNode = {
			tag: "div",
			attrs: [["title", "Completely unrelated"]],
			text: "Duration, Not selected",
			children: [],
			isHidden: false,
			isInteractive: false,
		};
		const output = normalizeTitleAttrIntoText(cloneNode(input));
		assert.deepEqual(
			output,
			input,
			"Should keep title untouched when there is no text/title overlap.",
		);
	});

	it("removes only the overlapping title when multiple titles exist", () => {
		const input: SimplifiedNode = {
			tag: "div",
			attrs: [
				["title", "Duration"],
				["title", "More details tooltip"],
				["role", "button"],
			],
			text: "Duration, Not selected",
			children: [],
			isHidden: false,
			isInteractive: true,
		};
		const output = normalizeTitleAttrIntoText(cloneNode(input));
		assert.deepEqual(
			output.text,
			"Duration, Not selected",
			"Should keep longest overlap between text and overlapping title.",
		);
		assert.deepEqual(
			output.attrs,
			[
				["title", "More details tooltip"],
				["role", "button"],
			],
			"Should remove only the overlapping title when multiple title attrs exist.",
		);
	});

	it("normalizes children recursively", () => {
		const input: SimplifiedNode = {
			tag: "section",
			attrs: [],
			text: "",
			children: [
				{
					tag: "button",
					attrs: [["title", "Continue to payment"]],
					text: "Continue",
					children: [],
					isHidden: false,
					isInteractive: true,
				},
			],
			isHidden: false,
			isInteractive: false,
		};
		const output = normalizeTitleAttrIntoText(cloneNode(input));
		assert.deepEqual(
			output.children[0].text,
			"Continue to payment",
			"Should normalize children recursively.",
		);
		assert.deepEqual(
			output.children[0].attrs,
			[],
			"Should remove overlapping child title after promoting longer text.",
		);
	});
});
