import { assert } from "chai";
import { describe, it } from "mocha";
import {
	mergeNodeAttrs,
	mergeSingleChildBidChains,
} from "../src/browser/simplify-dom-utils/merge-single-child-bid-chains.js";

describe("merge-single-child-bid-chains", () => {
	it("merges attrs and collapses single-child bid chains", () => {
		{
			const parent: [string, string][] = [
				["bid", "1,2,5"],
				["role", "button"],
			];
			const child: [string, string][] = [
				["bid", "5,6,9,10"],
				["title", "Click me"],
			];

			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[
					["bid", "1,2,5,6,9,10"],
					["role", "button"],
					["title", "Click me"],
				],
				"Should merge bid values in order and deduplicate.",
			);
		}

		{
			const parent: [string, string][] = [["role", "button"]];
			const child: [string, string][] = [
				["bid", "a1"],
				["title", "Child title"],
			];

			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[
					["bid", "a1"],
					["role", "button"],
					["title", "Child title"],
				],
				"Should insert child bid at the beginning when parent has no bid.",
			);
		}

		{
			const parent: [string, string][] = [
				["bid", "k1"],
				["title", ""],
			];
			const child: [string, string][] = [["title", "Filled"]];
			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[
					["bid", "k1"],
					["title", "Filled"],
				],
				"Should fill empty parent non-bid attr from child value.",
			);
		}

		{
			const parent: [string, string][] = [
				["bid", "k1"],
				["title", "Parent title"],
			];
			const child: [string, string][] = [["title", "Child title"]];
			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[
					["bid", "k1"],
					["title", "Parent title"],
					["title", "Child title"],
				],
				"Should keep both parent and child non-bid attrs when values overlap and differ.",
			);
		}

		{
			const parent: [string, string][] = [
				["bid", "r1"],
				["role", "button"],
			];
			const child: [string, string][] = [["role", "link"]];
			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[
					["bid", "r1"],
					["role", "button"],
					["role", "link"],
				],
				"Should keep both parent and child roles when they overlap and differ.",
			);
		}

		{
			const parent: [string, string][] = [
				["bid", "r2"],
				["role", ""],
			];
			const child: [string, string][] = [
				["role", "link"],
				["role", "button"],
			];
			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[
					["bid", "r2"],
					["role", "link"],
					["role", "button"],
				],
				"Should fill empty parent role and keep additional overlapping child roles.",
			);
		}

		{
			const parent: [string, string][] = [
				["bid", "r3"],
				["role", "button"],
			];
			const child: [string, string][] = [["role", "button"]];
			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[
					["bid", "r3"],
					["role", "button"],
				],
				"Should not duplicate overlapping attrs when both values are identical.",
			);
		}

		{
			const parent: [string, string][] = [["bid", " 1 , 2 "]];
			const child: [string, string][] = [["bid", "2, 3 , , 4"]];
			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				merged,
				[["bid", "1,2,3,4"]],
				"Should trim bid parts and ignore empty bid segments.",
			);
		}

		{
			const parent: [string, string][] = [
				["bid", "1,2"],
				["role", ""],
			];
			const child: [string, string][] = [
				["bid", "2,3"],
				["role", "button"],
			];

			const parentBefore = JSON.parse(JSON.stringify(parent));
			const childBefore = JSON.parse(JSON.stringify(child));
			const merged = mergeNodeAttrs(parent, child);
			assert.deepEqual(
				parent,
				parentBefore,
				"Parent attrs should not mutate.",
			);
			assert.deepEqual(
				child,
				childBefore,
				"Child attrs should not mutate.",
			);
			assert.deepEqual(
				merged,
				[
					["bid", "1,2,3"],
					["role", "button"],
				],
				"Should return merged attrs while preserving input arrays.",
			);
		}

		{
			const tree = {
				tag: "div",
				attrs: [["bid", "p1"]] as [string, string][],
				text: "",
				children: [
					{
						tag: "input",
						attrs: [
							["bid", "c1"],
							["type", "text"],
						] as [string, string][],
						text: "",
						children: [],
						isHidden: false,
						isInteractive: true,
					},
				],
				isHidden: false,
				isInteractive: true,
			};

			const merged = mergeSingleChildBidChains(tree);
			assert.deepEqual(
				merged.tag,
				"input",
				"Should merge div/input chain and preserve input tag on the merged node.",
			);
			assert.deepEqual(
				merged.attrs,
				[
					["bid", "p1,c1"],
					["type", "text"],
				],
				"Merged node should keep both bids and input-specific attrs.",
			);
			assert.deepEqual(
				merged.children,
				[],
				"Merged node should absorb child input and keep no remaining children.",
			);
		}

		{
			const tree = {
				tag: "section",
				attrs: [["bid", "s1"]] as [string, string][],
				text: "",
				children: [
					{
						tag: "article",
						attrs: [
							["bid", "a1"],
							["role", "region"],
						] as [string, string][],
						text: "child text",
						children: [],
						isHidden: false,
						isInteractive: false,
					},
				],
				isHidden: false,
				isInteractive: false,
			};

			const merged = mergeSingleChildBidChains(tree);
			assert.deepEqual(
				merged.tag,
				"section",
				"Should merge bid chain for non-whitelisted tags without changing non-input parent tag.",
			);
			assert.deepEqual(
				merged.attrs,
				[
					["bid", "s1,a1"],
					["role", "region"],
				],
				"Should merge bids and keep child attrs for non-whitelisted tag pairs.",
			);
			assert.deepEqual(
				merged.text,
				"child text",
				"Should keep child text when parent text is empty.",
			);
			assert.deepEqual(
				merged.children,
				[],
				"Merged node should absorb child.",
			);
		}

		{
			const tree = {
				tag: "input",
				attrs: [
					["bid", "pi1"],
					["type", "text"],
					["name", "parent-name"],
				] as [string, string][],
				text: "",
				children: [
					{
						tag: "input",
						attrs: [
							["bid", "ci1"],
							["type", "email"],
							["placeholder", "you@example.com"],
						] as [string, string][],
						text: "",
						children: [],
						isHidden: false,
						isInteractive: true,
					},
				],
				isHidden: false,
				isInteractive: true,
			};

			const merged = mergeSingleChildBidChains(tree);
			assert.deepEqual(
				merged.tag,
				"input",
				"Should preserve input tag when both parent and child are input nodes.",
			);
			assert.deepEqual(
				merged.attrs,
				[
					["bid", "pi1,ci1"],
					["type", "text"],
					["name", "parent-name"],
					["type", "email"],
					["placeholder", "you@example.com"],
				],
				"Should merge input/input attrs while keeping overlapping non-bid values.",
			);
			assert.deepEqual(
				merged.children,
				[],
				"Merged input/input node should absorb child and keep no children.",
			);
		}

		{
			const tree = {
				tag: "button",
				attrs: [["bid", "pimg"]] as [string, string][],
				text: "",
				children: [
					{
						tag: "img",
						attrs: [["src", "logo.png"]] as [string, string][],
						text: "",
						children: [],
						isHidden: false,
						isInteractive: false,
					},
				],
				isHidden: false,
				isInteractive: true,
			};

			const merged = mergeSingleChildBidChains(tree);
			assert.deepEqual(
				merged.tag,
				"button",
				"Should keep clickable parent tag when merging a single image child.",
			);
			assert.deepEqual(
				merged.attrs,
				[
					["bid", "pimg"],
					["img", "logo.png"],
				],
				"Should fold child image attrs into parent using compact img attr name.",
			);
			assert.deepEqual(
				merged.children,
				[],
				"Merged clickable/image pair should collapse into one node.",
			);
		}
	});
});
