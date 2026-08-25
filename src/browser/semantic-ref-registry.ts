import type { Browser } from "./types.js";

export interface SemanticRefTarget {
	ref: string;
	backendNodeId: number;
	role: string;
	name?: string;
	ancestorSignature?: string[];
	frameId?: string;
	capabilities: string[];
}

interface SemanticRefSnapshot {
	generation: number;
	targets: Map<string, SemanticRefTarget>;
}

const snapshots = new WeakMap<Browser, SemanticRefSnapshot>();

export function replaceSemanticRefSnapshot(
	browser: Browser,
	targets: Iterable<SemanticRefTarget>,
): number {
	const generation = (snapshots.get(browser)?.generation ?? 0) + 1;
	snapshots.set(browser, {
		generation,
		targets: new Map([...targets].map((target) => [target.ref, target])),
	});
	return generation;
}

export function getSemanticRefSnapshotGeneration(browser: Browser): number {
	return snapshots.get(browser)?.generation ?? 0;
}

export function getSemanticRefTargets(browser: Browser): SemanticRefTarget[] {
	return [...(snapshots.get(browser)?.targets.values() ?? [])];
}

export function getSemanticRefTarget(
	browser: Browser,
	ref: string,
): SemanticRefTarget | undefined {
	return snapshots.get(browser)?.targets.get(ref);
}

export async function resolveSemanticRef(
	browser: Browser,
	ref: string,
): Promise<{ nodeId: number; objectId: string; target: SemanticRefTarget }> {
	const normalizedRef = ref.trim();
	const target = getSemanticRefTarget(browser, normalizedRef);
	if (!target) {
		throw new Error(
			`Semantic ref is not present in the current projection: ref=${normalizedRef}`,
		);
	}

	await browser.DOM.getDocument();
	const { nodeIds } = await browser.DOM.pushNodesByBackendIdsToFrontend({
		backendNodeIds: [target.backendNodeId],
	});
	const nodeId = nodeIds[0];
	if (!nodeId) {
		throw new Error(
			`Semantic ref target is stale in the current page: ref=${normalizedRef}`,
		);
	}
	const { object } = await browser.DOM.resolveNode({ nodeId });
	if (!object.objectId) {
		throw new Error(
			`Semantic ref target could not be resolved: ref=${normalizedRef}`,
		);
	}
	return { nodeId, objectId: object.objectId, target };
}
