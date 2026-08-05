import type { SimplifiedNode } from "./simplified-node.js";

function canMergeBidChainPair(_parentTag: string, _childTag: string): boolean {
	return true;
}

function getAttrIndex(attrs: [string, string][], name: string): number {
	return attrs.findIndex(([k]) => k === name);
}

function getAttrValue(
	attrs: [string, string][],
	name: string,
): string | undefined {
	const idx = getAttrIndex(attrs, name);
	if (idx < 0) return undefined;
	return attrs[idx][1];
}

function mergeBidValues(parentBid: string, childBid: string): string {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const value of [parentBid, childBid]) {
		for (const part of value.split(",")) {
			const bid = part.trim();
			if (!bid || seen.has(bid)) continue;
			seen.add(bid);
			ordered.push(bid);
		}
	}
	return ordered.join(",");
}

function mapImageAttrsForMergedParent(
	attrs: [string, string][],
): [string, string][] {
	return attrs.map(([name, value]) => [name === "src" ? "img" : name, value]);
}

export function mergeNodeAttrs(
	parentAttrs: [string, string][],
	childAttrs: [string, string][],
): [string, string][] {
	const merged = parentAttrs.map(([k, v]) => [k, v] as [string, string]);

	for (const [name, value] of childAttrs) {
		const existingIdx = getAttrIndex(merged, name);
		if (name === "bid") {
			if (existingIdx >= 0) {
				merged[existingIdx][1] = mergeBidValues(
					merged[existingIdx][1],
					value,
				);
			} else {
				merged.unshift(["bid", value]);
			}
			continue;
		}

		if (existingIdx < 0) {
			merged.push([name, value]);
			continue;
		}
		if (!merged[existingIdx][1] && value) {
			merged[existingIdx][1] = value;
			continue;
		}

		if (
			merged[existingIdx][1] &&
			value &&
			merged[existingIdx][1] !== value
		) {
			merged.push([name, value]);
		}
	}

	return merged;
}

export function mergeSingleChildBidChains(
	node: SimplifiedNode,
): SimplifiedNode {
	node.children = node.children.map(mergeSingleChildBidChains);

	while (node.children.length === 1) {
		const child = node.children[0];
		if (node.outsideViewport || child.outsideViewport) break;
		const canMergeClickableImageChild =
			node.isInteractive && child.tag === "img";
		const parentBid = getAttrValue(node.attrs, "bid");
		const childBid = getAttrValue(child.attrs, "bid");
		const canMerge =
			canMergeClickableImageChild ||
			(canMergeBidChainPair(node.tag, child.tag) &&
				!!parentBid &&
				!!childBid);
		if (!canMerge) break;

		if (child.tag === "input") {
			node.tag = "input";
		}
		node.attrs = mergeNodeAttrs(
			node.attrs,
			canMergeClickableImageChild
				? mapImageAttrsForMergedParent(child.attrs)
				: child.attrs,
		);
		if (!node.text && child.text) {
			node.text = child.text;
		} else if (node.text && child.text) {
			node.text = `${node.text} ${child.text}`;
		}
		node.children = child.children;
		node.isHidden = node.isHidden || child.isHidden;
		node.couldBeHidden =
			!node.isHidden &&
			(Boolean(node.couldBeHidden) || Boolean(child.couldBeHidden));
		node.isInteractive = node.isInteractive || child.isInteractive;
		const mergedNoClick =
			Boolean(node.noClickAllowed) || Boolean(child.noClickAllowed);
		if (mergedNoClick) node.noClickAllowed = true;
		else delete node.noClickAllowed;
	}

	return node;
}
