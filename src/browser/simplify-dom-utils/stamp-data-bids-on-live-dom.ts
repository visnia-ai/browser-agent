import type { Browser } from "../types.js";
import { isStaleNodeErrorMessage } from "../interaction/utils.js";

export type BidStamp = { backendNodeId: number; bid: string };
export type NonClickableIdStamp = {
	backendNodeId: number;
	nonClickableId: string;
};

async function stampDataAttributeOnLiveDom(
	b: Browser,
	params: {
		backendNodeIds: number[];
		attributeName: string;
		attributeValues: string[];
	},
): Promise<void> {
	if (params.backendNodeIds.length === 0) return;

	await b.DOM.getDocument();
	let nodeIds: Array<number | undefined> = [];
	try {
		({ nodeIds } = await b.DOM.pushNodesByBackendIdsToFrontend({
			backendNodeIds: params.backendNodeIds,
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isStaleNodeErrorMessage(message)) {
			return;
		}
		throw error;
	}
	for (let i = 0; i < params.backendNodeIds.length; i++) {
		const nodeId = nodeIds[i];
		if (!nodeId) continue;
		try {
			await b.DOM.setAttributeValue({
				nodeId,
				name: params.attributeName,
				value: params.attributeValues[i],
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			if (isStaleNodeErrorMessage(message)) {
				continue;
			}
			throw error;
		}
	}
}

export async function stampDataBidsOnLiveDom(
	b: Browser,
	bidStamps: BidStamp[],
): Promise<void> {
	if (bidStamps.length === 0) return;

	await stampDataAttributeOnLiveDom(b, {
		backendNodeIds: bidStamps.map((s) => s.backendNodeId),
		attributeName: "data-bid",
		attributeValues: bidStamps.map((s) => s.bid),
	});
}

export async function stampDataNonClickableIdsOnLiveDom(
	b: Browser,
	nonClickableIdStamps: NonClickableIdStamp[],
): Promise<void> {
	if (nonClickableIdStamps.length === 0) return;

	await stampDataAttributeOnLiveDom(b, {
		backendNodeIds: nonClickableIdStamps.map((s) => s.backendNodeId),
		attributeName: "data-nonclickableid",
		attributeValues: nonClickableIdStamps.map((s) => s.nonClickableId),
	});
}
