import type { Browser } from "./types.js";

export interface SemanticRefFingerprint {
	role: string;
	name: string;
	description: string;
	url: string;
}

export interface SemanticRefTarget {
	ref: string;
	backendNodeId: number;
	role: string;
	capabilities: string[];
	fingerprint?: SemanticRefFingerprint;
}

interface SemanticRefSnapshot {
	generation: number;
	targets: Map<string, SemanticRefTarget>;
}

const snapshots = new WeakMap<Browser, SemanticRefSnapshot>();

function normalizedFingerprintText(value: unknown, maximumLength: number): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maximumLength) return normalized;
	return `${normalized.slice(0, maximumLength - 3)}...`;
}

function normalizedFingerprintRole(value: unknown): string {
	const role = normalizedFingerprintText(value, 80).toLowerCase();
	return role === "rootwebarea" || role === "webarea" ? "document" : role;
}

export function createSemanticRefFingerprint(input: {
	role: unknown;
	name?: unknown;
	description?: unknown;
	url?: unknown;
}): SemanticRefFingerprint | undefined {
	const fingerprint = {
		role: normalizedFingerprintRole(input.role),
		name: normalizedFingerprintText(input.name, 600),
		description: normalizedFingerprintText(input.description, 600),
		url: normalizedFingerprintText(input.url, 8_000),
	};
	if (
		!fingerprint.role ||
		(!fingerprint.name && !fingerprint.description && !fingerprint.url)
	) {
		return undefined;
	}
	return fingerprint;
}

function rawAxValue(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	return (value as { value?: unknown }).value;
}

function rawAxProperty(
	properties: unknown,
	name: string,
): unknown {
	if (!Array.isArray(properties)) return undefined;
	const property = properties.find(
		(entry) =>
			Boolean(entry) &&
			typeof entry === "object" &&
			(entry as { name?: unknown }).name === name,
	) as { value?: unknown } | undefined;
	return rawAxValue(property?.value);
}

function samePrimaryFingerprint(
	left: SemanticRefFingerprint,
	right: SemanticRefFingerprint,
): boolean {
	return (
		left.role === right.role &&
		left.name === right.name &&
		left.url === right.url
	);
}

async function recoverSemanticRefTarget(
	browser: Browser,
	target: SemanticRefTarget,
): Promise<SemanticRefTarget | undefined> {
	const fingerprint = target.fingerprint;
	if (!fingerprint || typeof browser.Accessibility?.getFullAXTree !== "function") {
		return undefined;
	}

	const response = await browser.Accessibility.getFullAXTree();
	const primaryMatches = response.nodes
		.filter(
			(node) =>
				node.ignored !== true &&
				typeof node.backendDOMNodeId === "number" &&
				node.backendDOMNodeId > 0,
		)
		.map((node) => ({
			backendNodeId: node.backendDOMNodeId as number,
			fingerprint: createSemanticRefFingerprint({
				role: rawAxValue(node.role),
				name: rawAxValue(node.name),
				description: rawAxValue(node.description),
				url: rawAxProperty(node.properties, "url"),
			}),
		}))
		.filter(
			(candidate): candidate is {
				backendNodeId: number;
				fingerprint: SemanticRefFingerprint;
			} =>
				Boolean(candidate.fingerprint) &&
				samePrimaryFingerprint(
					candidate.fingerprint as SemanticRefFingerprint,
					fingerprint,
				),
		);

	let matches = primaryMatches;
	if (matches.length > 1 && fingerprint.description) {
		matches = matches.filter(
			(candidate) =>
				candidate.fingerprint.description === fingerprint.description,
		);
	}
	if (matches.length !== 1) return undefined;

	const recovered = {
		...target,
		backendNodeId: matches[0].backendNodeId,
	};
	const snapshot = snapshots.get(browser);
	if (snapshot?.targets.get(target.ref) === target) {
		snapshot.targets.set(target.ref, recovered);
	}
	return recovered;
}

async function resolveBackendNode(
	browser: Browser,
	backendNodeId: number,
): Promise<{ nodeId: number; objectId: string } | undefined> {
	await browser.DOM.getDocument();
	const { nodeIds } = await browser.DOM.pushNodesByBackendIdsToFrontend({
		backendNodeIds: [backendNodeId],
	});
	const nodeId = nodeIds[0];
	if (!nodeId) return undefined;
	const { object } = await browser.DOM.resolveNode({ nodeId });
	if (!object.objectId) return undefined;
	if (typeof browser.Runtime?.callFunctionOn === "function") {
		try {
			const { result } = await browser.Runtime.callFunctionOn({
				objectId: object.objectId,
				functionDeclaration: `function() {
					return this instanceof Node ? this.isConnected : true;
				}`,
				returnByValue: true,
			});
			if (result.value === false) return undefined;
		} catch {
			return undefined;
		}
	}
	return { nodeId, objectId: object.objectId };
}

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

	const resolved = await resolveBackendNode(browser, target.backendNodeId);
	if (resolved) {
		return { ...resolved, target };
	}

	const recoveredTarget = await recoverSemanticRefTarget(browser, target);
	if (!recoveredTarget) {
		throw new Error(
			`Semantic ref target is stale in the current page: ref=${normalizedRef}`,
		);
	}
	const recoveredResolution = await resolveBackendNode(
		browser,
		recoveredTarget.backendNodeId,
	);
	if (!recoveredResolution) {
		throw new Error(
			`Semantic ref target is stale in the current page: ref=${normalizedRef}`,
		);
	}
	console.log(
		`    [semantic-ref] recovered ref=${normalizedRef} backendNodeId=${recoveredTarget.backendNodeId}`,
	);
	return { ...recoveredResolution, target: recoveredTarget };
}
