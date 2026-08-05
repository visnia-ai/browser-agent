import * as fs from "fs";
import * as path from "path";
import { assert } from "chai";
import { describe, it } from "mocha";
import { pathToFileURL } from "url";
import {
	launch,
	navigate,
	getSimplifiedDOM,
	close,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";
import { getRawMainDocumentHTML } from "../src/browser/browser.js";

const GOOGLE_FLIGHTS_URL = pathToFileURL(
	path.join(process.cwd(), "assets", "raw-html-022.html"),
).href;
const ASSETS_DIR = path.join(process.cwd(), "assets");
const HTML_OUTPUT = path.join(ASSETS_DIR, "google-flights-main.html");
const SIMPLIFIED_OUTPUT = path.join(
	ASSETS_DIR,
	"google-flights-main.simplified.yaml",
);

interface ParsedNode {
	tag: string;
	attrs: Array<[string, string]>;
	text: string;
	children: ParsedNode[];
}

function extractBidsFromSimplifiedDOM(simplifiedDOM: string): Set<string> {
	const bids = new Set<string>();
	const regex = /\bbid="([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(simplifiedDOM)) !== null) {
		const bidChain = match[1]?.trim();
		if (!bidChain) continue;
		for (const bid of bidChain.split(",")) {
			const normalized = bid.trim();
			if (!normalized) continue;
			bids.add(normalized);
		}
	}
	return bids;
}

async function getRealDOMBids(browser: Browser): Promise<Set<string>> {
	const { result } = await browser.Runtime.evaluate({
		expression: `(() => {
      const bids = new Set();
      for (const el of document.querySelectorAll('[data-bid]')) {
        const bid = el.getAttribute('data-bid');
        if (typeof bid === 'string' && bid.trim()) bids.add(bid.trim());
      }
      return Array.from(bids);
    })()`,
		returnByValue: true,
	});

	const values = Array.isArray(result.value) ? result.value : [];
	return new Set(values.filter((v): v is string => typeof v === "string"));
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function parseHead(head: string): {
	tag: string;
	attrs: Array<[string, string]>;
} {
	const trimmed = head.trim();
	const firstSpace = trimmed.indexOf(" ");
	if (firstSpace === -1) return { tag: trimmed, attrs: [] };
	const tag = trimmed.slice(0, firstSpace);
	const attrsText = trimmed.slice(firstSpace + 1);
	const attrs: Array<[string, string]> = [];
	const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
	let match: RegExpExecArray | null;
	while ((match = attrRegex.exec(attrsText)) !== null) {
		attrs.push([match[1], match[2]]);
	}
	return { tag, attrs };
}

function parseSimplifiedToTree(simplified: string): ParsedNode[] {
	const roots: ParsedNode[] = [];
	const stack: Array<{ depth: number; node: ParsedNode }> = [];
	for (const rawLine of simplified.split("\n")) {
		if (!rawLine.trim()) continue;
		const indentMatch = rawLine.match(/^ */);
		const indent = indentMatch ? indentMatch[0].length : 0;
		const depth = Math.floor(indent / 2);
		const line = rawLine.trim();
		const lineMatch = line.match(/^(.+?)(?::\s*(.*))?$/);
		if (!lineMatch) continue;
		const head = lineMatch[1];
		const text = (lineMatch[2] || "").trim();
		const { tag, attrs } = parseHead(head);
		const node: ParsedNode = { tag, attrs, text, children: [] };

		while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
			stack.pop();
		}
		if (stack.length === 0) roots.push(node);
		else stack[stack.length - 1].node.children.push(node);
		stack.push({ depth, node });
	}
	return roots;
}

function nodeToHtml(node: ParsedNode): string {
	const mappedAttrs = node.attrs.map(
		([k, v]) => [k === "bid" ? "data-bid" : k, v] as const,
	);
	const attrsText = mappedAttrs
		.map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
		.join("");
	const text = node.text ? escapeHtml(node.text) : "";
	const children = node.children.map(nodeToHtml).join("");
	return `<${node.tag}${attrsText}>${text}${children}</${node.tag}>`;
}

function simplifiedToHtmlDocument(simplified: string): string {
	const roots = parseSimplifiedToTree(simplified);
	const body = roots.map(nodeToHtml).join("");
	return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

function normalizeForCompare(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function comparePasses(pass1: string, pass2: string): string {
	const n1 = normalizeForCompare(String(pass1 ?? ""));
	const n2 = normalizeForCompare(String(pass2 ?? ""));
	const exactMatch = n1 === n2;
	const p1Lines = new Set(n1.split("\n").filter(Boolean));
	const p2Lines = new Set(n2.split("\n").filter(Boolean));
	const onlyPass1 = [...p1Lines].filter((line) => !p2Lines.has(line));
	const onlyPass2 = [...p2Lines].filter((line) => !p1Lines.has(line));
	return [
		`exactMatch: ${exactMatch}`,
		`pass1Length: ${n1.length}`,
		`pass2Length: ${n2.length}`,
		`linesOnlyInPass1: ${onlyPass1.length}`,
		`linesOnlyInPass2: ${onlyPass2.length}`,
		`sampleOnlyInPass1: ${onlyPass1.slice(0, 20).join(" || ")}`,
		`sampleOnlyInPass2: ${onlyPass2.slice(0, 20).join(" || ")}`,
	].join("\n");
}

describe("simplify-dom e2e", function () {
	this.timeout(90_000);

	it("captures simplified DOM with valid bid references after pruning", async () => {
		let browser: Browser | null = null;
		try {
			fs.mkdirSync(ASSETS_DIR, { recursive: true });

			browser = await launch(undefined, true);
			await navigate(browser, GOOGLE_FLIGHTS_URL);

			// Ensure runtime works.
			const html = await getRawMainDocumentHTML(browser);
			assert(
				html.length > 0,
				"Runtime check failed: fetched HTML is empty.",
			);
			fs.writeFileSync(HTML_OUTPUT, html, "utf-8");

			// Save simplified DOM to disk for manual inspection.
			const simplifiedDOM = await getSimplifiedDOM(browser);
			assert(
				simplifiedDOM.trim().length > 0,
				"Simplified DOM output is empty.",
			);
			assert.notMatch(
				simplifiedDOM,
				/^</,
				"Simplified DOM should not use compact bracket minified format.",
			);
			assert.include(
				simplifiedDOM,
				"\n",
				"Simplified DOM should remain multiline plain format.",
			);
			fs.writeFileSync(SIMPLIFIED_OUTPUT, simplifiedDOM, "utf-8");

			// Pruned hidden hierarchies may omit live-DOM bids. Every bid that
			// remains in simplified DOM must still reference a live element.
			const realDOMBids = await getRealDOMBids(browser);
			const simplifiedBids = extractBidsFromSimplifiedDOM(simplifiedDOM);
			const unknownBids = [...simplifiedBids].filter(
				(bid) => !realDOMBids.has(bid),
			);
			assert.isAbove(
				simplifiedBids.size,
				0,
				"Simplified DOM should contain actionable bid references.",
			);
			assert(
				unknownBids.length === 0,
				`Found ${unknownBids.length} bid(s) in simplified DOM that are missing from the real DOM. Sample: ${unknownBids.slice(0, 20).join(", ")}`,
			);
		} finally {
			if (browser) {
				await close(browser);
			}
		}
	});
});
