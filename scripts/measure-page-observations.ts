import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { estimateTokenCount } from "../src/agents/prompt-token-estimator.js";
import {
	close,
	launch,
	navigate,
} from "../src/browser/browser.js";
import {
	getPageMarkdownObservation,
	PAGE_OBSERVATION_CHARACTER_BUDGET,
} from "../src/browser/page-markdown-observation.js";
import { getSemanticProjection } from "../src/browser/semantic-projection.js";
import { getSemanticRefTargets } from "../src/browser/semantic-ref-registry.js";

interface PageMetadata {
	links: string[];
	headings: Array<{ level: number; text: string }>;
	tableCells: string[];
	controls: number;
}

interface RepresentationMetrics {
	characters: number;
	tokens: number;
	visibleTextWordRecall: number;
	linkDestinationCoverage: number;
	headingStructureCoverage: number;
	tableStructurePresent: boolean;
	actionableRefCoverage: number;
	allRefCoverage: number;
	actionableRefsPreserved: number;
	allRefsPreserved: number;
}

interface FixtureSpec {
	path: string;
	target?: string;
}

const DEFAULT_FIXTURES: FixtureSpec[] = [
	{
		path: "assets/raw-html-022.html",
		target: '[aria-label="Where from?"]',
	},
	{ path: "assets/markdown-observation-fixture.html", target: "table" },
	{ path: "assets/dropdown-select-fixture.html", target: "#fruit" },
	{ path: "assets/file-picker-fixture.html", target: "main" },
	{ path: "assets/auth-takeover-fixture.html", target: "#login-form" },
	{
		path: "assets/scroll-lazy-fixture.html",
		target: "#lazy-scroll-container",
	},
];

function round(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 1 : round(numerator / denominator);
}

function percentageSaved(candidate: number, baseline: number): number {
	return baseline === 0 ? 0 : round(1 - candidate / baseline);
}

function words(value: string): string[] {
	return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
		(word) => word.length > 1,
	);
}

function multisetRecall(reference: string, candidate: string): number {
	const referenceWords = words(reference);
	if (referenceWords.length === 0) return 1;
	const candidateCounts = new Map<string, number>();
	for (const word of words(candidate)) {
		candidateCounts.set(word, (candidateCounts.get(word) ?? 0) + 1);
	}
	let matched = 0;
	for (const word of referenceWords) {
		const count = candidateCounts.get(word) ?? 0;
		if (count <= 0) continue;
		matched += 1;
		candidateCounts.set(word, count - 1);
	}
	return ratio(matched, referenceWords.length);
}

function stringCoverage(values: string[], candidate: string): number {
	const normalizedValues = [...new Set(values.map((value) => value.trim()))]
		.filter(Boolean);
	if (normalizedValues.length === 0) return 1;
	return ratio(
		normalizedValues.filter((value) => candidate.includes(value)).length,
		normalizedValues.length,
	);
}

function headingCoverage(
	headings: PageMetadata["headings"],
	candidate: string,
): number {
	if (headings.length === 0) return 1;
	let matches = 0;
	for (const heading of headings) {
		const marker = `${"#".repeat(Math.min(6, Math.max(1, heading.level)))} ${heading.text}`;
		if (candidate.includes(marker)) matches += 1;
	}
	return ratio(matches, headings.length);
}

function extractRefs(value: string): Set<string> {
	return new Set(
		[
			...value.matchAll(
				/(?:\bref="?([a-zA-Z0-9_-]+)"?|\[([a-zA-Z0-9_-]+)\])/g,
			),
		].map((match) => match[1] ?? match[2]),
	);
}

function buildMetrics(input: {
	value: string;
	visibleText: string;
	metadata: PageMetadata;
	baselineRefs: Set<string>;
	baselineActionableRefs: Set<string>;
	isMarkdown: boolean;
}): RepresentationMetrics {
	const candidateRefs = extractRefs(input.value);
	const actionableRefsPreserved = [...input.baselineActionableRefs].filter(
		(ref) => candidateRefs.has(ref),
	).length;
	const allRefsPreserved = [...input.baselineRefs].filter((ref) =>
		candidateRefs.has(ref),
	).length;
	return {
		characters: input.value.length,
		tokens: estimateTokenCount(input.value),
		visibleTextWordRecall: multisetRecall(
			input.visibleText,
			input.value,
		),
		linkDestinationCoverage: stringCoverage(
			input.metadata.links,
			input.value,
		),
		headingStructureCoverage: input.isMarkdown
			? headingCoverage(input.metadata.headings, input.value)
			: 0,
		tableStructurePresent:
			input.metadata.tableCells.length === 0 ||
			(input.isMarkdown && /\|[^\n]+\|/.test(input.value)),
		actionableRefCoverage: ratio(
			actionableRefsPreserved,
			input.baselineActionableRefs.size,
		),
		allRefCoverage: ratio(
			allRefsPreserved,
			input.baselineRefs.size,
		),
		actionableRefsPreserved,
		allRefsPreserved,
	};
}

async function findOpenPort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a Chrome debugging port"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

async function getPageMetadata(
	browser: Awaited<ReturnType<typeof launch>>,
	target?: string,
): Promise<PageMetadata> {
	const serializedTarget = JSON.stringify(target ?? null);
	const { result } = await browser.Runtime.evaluate({
		expression: `(() => {
			const target = ${serializedTarget};
			const roots = target
				? [...document.querySelectorAll(target)]
				: [document];
			const query = (selector) => [...new Set(roots.flatMap((root) => [
				...(root.matches && root.matches(selector) ? [root] : []),
				...root.querySelectorAll(selector),
			]))];
			const visible = (element) => {
				const style = getComputedStyle(element);
				return !element.hidden &&
					element.getAttribute("aria-hidden") !== "true" &&
					style.display !== "none" &&
					style.visibility !== "hidden";
			};
			const text = (element) => String(element.innerText || element.textContent || "")
				.replace(/\\s+/g, " ").trim();
			return {
				links: query("a[href]")
					.filter(visible).map((element) => element.href).filter(Boolean),
				headings: query("h1,h2,h3,h4,h5,h6")
					.filter(visible).map((element) => ({
						level: Number(element.tagName.slice(1)),
						text: text(element),
					})).filter((entry) => entry.text),
				tableCells: query("th,td")
					.filter(visible).map(text).filter(Boolean),
				controls: query(
					"a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox],[tabindex]"
				).filter(visible).length,
			};
		})()`,
		returnByValue: true,
	});
	return result.value as PageMetadata;
}

async function getInnerText(
	browser: Awaited<ReturnType<typeof launch>>,
	target?: string,
): Promise<string> {
	const serializedTarget = JSON.stringify(target ?? null);
	const { result } = await browser.Runtime.evaluate({
		expression: `(() => {
			const target = ${serializedTarget};
			const roots = target
				? [...document.querySelectorAll(target)]
				: [document.body || document.documentElement];
			return roots.map((root) =>
				typeof root.innerText === "string"
					? root.innerText
					: String(root.textContent || "")
			).filter(Boolean).join("\\n\\n");
		})()`,
		returnByValue: true,
	});
	return typeof result.value === "string" ? result.value : "";
}

function aggregate(
	rows: Array<{
		pageMetadata: {
			baselineRefs: number;
			baselineActionableRefs: number;
		};
		baseline: RepresentationMetrics;
		innerText: RepresentationMetrics;
		markdown: RepresentationMetrics;
		projected?: {
			tokens: number;
			visibleTextWordRecall: number;
			linkDestinationCoverage: number;
			headingStructureCoverage: number;
			tableStructurePresent: boolean;
		};
	}>,
) {
	const sum = (selector: (row: (typeof rows)[number]) => number): number =>
		rows.reduce((total, row) => total + selector(row), 0);
	const mean = (selector: (row: (typeof rows)[number]) => number): number =>
		round(sum(selector) / Math.max(1, rows.length));
	const baselineTokens = sum((row) => row.baseline.tokens);
	const innerTextTokens = sum((row) => row.innerText.tokens);
	const markdownTokens = sum((row) => row.markdown.tokens);
	const projectedRows = rows.filter(
		(row): row is typeof row & { projected: NonNullable<typeof row.projected> } =>
			Boolean(row.projected),
	);
	const projectedTokens = projectedRows.reduce(
		(total, row) => total + row.projected.tokens,
		0,
	);
	const totalActionableRefs = sum(
		(row) => row.pageMetadata.baselineActionableRefs,
	);
	const totalRefs = sum((row) => row.pageMetadata.baselineRefs);
	return {
		pages: rows.length,
		totalTokens: {
			baseline: baselineTokens,
			innerText16k: innerTextTokens,
			markdown16k: markdownTokens,
		},
		tokenChange: {
			markdownVsBaselineSaved: percentageSaved(
				markdownTokens,
				baselineTokens,
			),
			markdownVsInnerTextSaved: percentageSaved(
				markdownTokens,
				innerTextTokens,
			),
		},
		meanCoverage: {
			innerTextVisibleWords: mean(
				(row) => row.innerText.visibleTextWordRecall,
			),
			markdownVisibleWords: mean(
				(row) => row.markdown.visibleTextWordRecall,
			),
			innerTextLinks: mean(
				(row) => row.innerText.linkDestinationCoverage,
			),
			markdownLinks: mean(
				(row) => row.markdown.linkDestinationCoverage,
			),
			innerTextActionableRefs: mean(
				(row) => row.innerText.actionableRefCoverage,
			),
			markdownActionableRefs: mean(
				(row) => row.markdown.actionableRefCoverage,
			),
			markdownAllRefs: mean(
				(row) => row.markdown.allRefCoverage,
			),
			markdownHeadingStructure: mean(
				(row) => row.markdown.headingStructureCoverage,
			),
		},
		weightedRefCoverage: {
			innerTextActionableRefs: ratio(
				sum((row) => row.innerText.actionableRefsPreserved),
				totalActionableRefs,
			),
			markdownActionableRefs: ratio(
				sum((row) => row.markdown.actionableRefsPreserved),
				totalActionableRefs,
			),
			markdownAllRefs: ratio(
				sum((row) => row.markdown.allRefsPreserved),
				totalRefs,
			),
		},
		projectPage: {
			cases: projectedRows.length,
			totalTokens: projectedTokens,
			vsWholePageInnerTextSaved: percentageSaved(
				projectedTokens,
				innerTextTokens,
			),
			vsWholePageMarkdownSaved: percentageSaved(
				projectedTokens,
				markdownTokens,
			),
			meanVisibleTextWordRecall: round(
				projectedRows.reduce(
					(total, row) =>
						total + row.projected.visibleTextWordRecall,
					0,
				) / Math.max(1, projectedRows.length),
			),
			meanLinkDestinationCoverage: round(
				projectedRows.reduce(
					(total, row) =>
						total + row.projected.linkDestinationCoverage,
					0,
				) / Math.max(1, projectedRows.length),
			),
		},
	};
}

async function main(): Promise<void> {
	const repositoryRoot = path.resolve(import.meta.dirname, "..");
	const requestedFixtures = process.argv.slice(2);
	const fixtureSpecs = (requestedFixtures.length
		? requestedFixtures.map((fixture) => ({ path: fixture }))
		: DEFAULT_FIXTURES
	).map((fixture) => ({
		...fixture,
		path: path.resolve(repositoryRoot, fixture.path),
	}));
	for (const fixture of fixtureSpecs) {
		const fixturePath = fixture.path;
		if (!fs.existsSync(fixturePath)) {
			throw new Error(`Fixture does not exist: ${fixturePath}`);
		}
	}

	const port = await findOpenPort();
	const browser = await launch(
		port,
		true,
		undefined,
		undefined,
		fs.mkdtempSync(path.join(os.tmpdir(), "browser-agent-markdown-")),
	);
	const rows = [];
	try {
		for (const fixture of fixtureSpecs) {
			const fixturePath = fixture.path;
			await navigate(browser, pathToFileURL(fixturePath).href);
			const baselineValue = await getSemanticProjection(browser, {
				omitHrefs: true,
			});
			const baselineRefs = extractRefs(baselineValue);
			const baselineActionableRefs = new Set(
				getSemanticRefTargets(browser)
					.filter((target) =>
						target.capabilities.some((capability) =>
							["click", "type", "select", "set_value"].includes(
								capability,
							),
						),
					)
					.map((target) => target.ref),
			);
			const observation = await getPageMarkdownObservation(browser);
			const visibleText = await getInnerText(browser);
			const innerTextValue = visibleText.slice(
				0,
				PAGE_OBSERVATION_CHARACTER_BUDGET,
			);
			const metadata = await getPageMetadata(browser);
			const baseline = buildMetrics({
				value: baselineValue,
				visibleText,
				metadata,
				baselineRefs,
				baselineActionableRefs,
				isMarkdown: false,
			});
			const innerText = buildMetrics({
				value: innerTextValue,
				visibleText,
				metadata,
				baselineRefs,
				baselineActionableRefs,
				isMarkdown: false,
			});
			const markdown = buildMetrics({
				value: observation.content,
				visibleText,
				metadata,
				baselineRefs,
				baselineActionableRefs,
				isMarkdown: true,
			});
			const projectedObservation = fixture.target
				? await getPageMarkdownObservation(browser, {
						target: fixture.target,
					})
				: undefined;
			const projectedMetadata = fixture.target
				? await getPageMetadata(browser, fixture.target)
				: undefined;
			const projectedInnerText = fixture.target
				? await getInnerText(browser, fixture.target)
				: undefined;
			const projected =
				projectedObservation &&
				projectedMetadata &&
				projectedInnerText !== undefined
					? {
							target: fixture.target,
							characters: projectedObservation.content.length,
							tokens: estimateTokenCount(
								projectedObservation.content,
							),
							matchedNodeCount:
								projectedObservation.diagnostics.matchedNodeCount,
							returnedRefCount:
								projectedObservation.diagnostics.returnedRefCount,
							visibleTextWordRecall: multisetRecall(
								projectedInnerText,
								projectedObservation.content,
							),
							linkDestinationCoverage: stringCoverage(
								projectedMetadata.links,
								projectedObservation.content,
							),
							headingStructureCoverage: headingCoverage(
								projectedMetadata.headings,
								projectedObservation.content,
							),
							tableStructurePresent:
								projectedMetadata.tableCells.length === 0 ||
								/\|[^\n]+\|/.test(projectedObservation.content),
							tokenChange: {
								vsWholePageInnerTextSaved: percentageSaved(
									estimateTokenCount(
										projectedObservation.content,
									),
									innerText.tokens,
								),
								vsWholePageMarkdownSaved: percentageSaved(
									estimateTokenCount(
										projectedObservation.content,
									),
									markdown.tokens,
								),
							},
						}
					: undefined;
			rows.push({
				fixture: path.relative(repositoryRoot, fixturePath),
				pageMetadata: {
					links: metadata.links.length,
					headings: metadata.headings.length,
					tableCells: metadata.tableCells.length,
					controls: metadata.controls,
					baselineRefs: baselineRefs.size,
					baselineActionableRefs:
						baselineActionableRefs.size,
				},
				observation: {
					truncated: observation.truncated,
					matchedNodeCount:
						observation.diagnostics.matchedNodeCount,
					returnedRefCount:
						observation.diagnostics.returnedRefCount,
				},
				baseline,
				innerText,
				markdown,
				projected,
				tokenChange: {
					markdownVsBaselineSaved: percentageSaved(
						markdown.tokens,
						baseline.tokens,
					),
					markdownVsInnerTextSaved: percentageSaved(
						markdown.tokens,
						innerText.tokens,
					),
				},
			});
		}
	} finally {
		await close(browser);
	}

	process.stdout.write(
		`${JSON.stringify(
			{
				budgetCharacters: PAGE_OBSERVATION_CHARACTER_BUDGET,
				fixtures: rows,
				aggregate: aggregate(rows),
			},
			null,
			2,
		)}\n`,
	);
}

await main();
