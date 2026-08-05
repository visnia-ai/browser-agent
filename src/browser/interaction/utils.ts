import type { Browser } from "../types.js";

import { resolveSemanticRef } from "../semantic-ref-registry.js";

/** Resolve an opaque ref from the current semantic projection without selectors or DOM stamping. */
export async function resolveElement(
	b: Browser,
	ref: string,
): Promise<{ nodeId: number; objectId: string }> {
	const resolved = await resolveSemanticRef(b, ref);
	return { nodeId: resolved.nodeId, objectId: resolved.objectId };
}

export async function checkVisibility(
	b: Browser,
	ref: string,
	objectId: string,
): Promise<void> {
	const { result } = await b.Runtime.callFunctionOn({
		objectId,
		functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return 'zero-size';
      const s = window.getComputedStyle(this);
      if (s.display === 'none') return 'display-none';
      if (s.visibility === 'hidden') return 'visibility-hidden';
      if (s.opacity === '0') return 'opacity-0';
      return '';
    }`,
		returnByValue: true,
	});
	if (result.value) {
		console.log(`    ⚠ ref=${ref} may be invisible (${result.value})`);
	}
}

export function splitRefCandidates(ref: string): string[] {
	return ref
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export function isLikelyNavigationAfterClickError(message: string): boolean {
	return (
		message.includes("Execution context was destroyed") ||
		message.includes("Cannot find context with specified id") ||
		message.includes("Cannot find object with given id") ||
		message.includes("Inspected target navigated or closed")
	);
}

export function isStaleNodeErrorMessage(message: string): boolean {
	return (
		message.includes("Could not find node with given id") ||
		message.includes("Node does not have a layout object") ||
		message.includes("Could not find object with given id")
	);
}

export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
