import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { extractValidRefs } from "../src/agents/extract-valid-refs.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import {
	close,
	getPageDocumentIdentity,
	getPageMarkdownObservation,
	isSamePageDocument,
	launch,
	navigate,
	PAGE_OBSERVATION_CHARACTER_BUDGET,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

function fixtureUrl(): string {
	const html = `<!doctype html>
<html><head><title>Markdown observation fixture</title></head><body>
  <header><a href="https://example.test/unrelated">Unrelated link</a></header>
  <main id="region">
    <h1>Results</h1>
    <p id="status">idle</p>
    <button id="run">Run search</button>
    <section class="card"><h2>First card</h2><p>Alpha detail</p></section>
    <section class="card"><h2>Second card</h2><p>Beta detail</p></section>
	<a id="rich-link" href="https://example.test/detail?q=kept&utm_source=trace" title="Verbose link title">
	  <span>Complete anchor label</span><div>retained secondary detail</div>
	</a>
	<a>Anchor without destination</a>
	<span aria-hidden="true">Visually rendered annotation</span>
	<span aria-hidden="true" style="display:none">Visually hidden annotation</span>
	<img alt="Service map" src="data:image/png;base64,AAAA" title="Verbose image title">
    <table><thead><tr><th>Name</th><th>Score</th></tr></thead>
      <tbody><tr><td>Alpha</td><td>42</td></tr></tbody></table>
    <form aria-label="Credentials">
      <input type="password" aria-label="Account" value="SECRET_INPUT_VALUE">
      <textarea aria-label="Notes">SECRET_TEXTAREA_VALUE</textarea>
	  <div contenteditable="true" aria-label="Draft">SECRET_EDITABLE_VALUE</div>
    </form>
    <div role="button" tabindex="0">ARIA action</div>
    <dialog open><h2>Dialog heading</h2><button>Dialog action</button></dialog>
	<iframe title="Nested form" srcdoc="<h2>Frame heading</h2><p>Frame content</p><form><label for='frame-field'>Frame field</label><input id='frame-field' required><button type='submit'>Frame submit</button></form>"></iframe>
    <div id="shadow-host"></div>
  </main>
  <script>
	document.getElementById("shadow-host").attachShadow({mode: "open"}).innerHTML =
	  "<h2>Shadow heading</h2><button>Shadow action</button>";
    document.getElementById("run").addEventListener("click", () => {
      document.getElementById("status").textContent = "complete";
    });
  </script>
</body></html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

function refFor(observation: string, role: string, name: string): string {
	const line = observation
		.split("\n")
		.find(
			(candidate) =>
				candidate.includes(`] ${role} `) &&
				candidate.includes(JSON.stringify(name)),
		);
	const ref = line && /^\[([^\]]+)\]/.exec(line)?.[1];
	assert.isString(ref, `missing ${role} ${name} in:\n${observation}`);
	return ref!;
}

function isSandboxLocalhostPolicyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("Blocked by sandbox network policy") &&
		message.includes("127.0.0.1")
	);
}

describe("Markdown page observation e2e", function () {
	this.timeout(90_000);

	it("preserves Markdown metadata and observes a preceding action", async function () {
		let browser: Browser | null = null;
		const originalMode = configFeatureFlags.pageObservationMode;
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "browser-agent-page-observation-test-"),
		);
		const memoryFile = path.join(tempDir, "memory.txt");
		fs.writeFileSync(memoryFile, "", "utf8");
		try {
			setConfigFeatureFlags({ pageObservationMode: "markdown" });
			browser = await launch(undefined, true);
			await navigate(browser, fixtureUrl());

			const initial = await getPageMarkdownObservation(browser, {
				redactPasswordInputs: true,
			});
			assert.isAtMost(
				initial.content.length,
				PAGE_OBSERVATION_CHARACTER_BUDGET,
			);
			assert.include(initial.content, "# Results");
			assert.include(initial.content, "| Name | Score |");
			assert.include(
				initial.content,
				"https://example.test/unrelated",
			);
			assert.include(initial.content, "Dialog heading");
			assert.include(initial.content, "Frame heading");
			assert.include(initial.content, "Shadow heading");
			assert.include(initial.content, "ARIA action");
			assert.include(initial.content, "Dialog action");
			assert.include(initial.content, "Shadow action");
			assert.include(initial.content, "Complete anchor label retained secondary detail");
			assert.include(initial.content, "Visually rendered annotation");
			assert.notInclude(initial.content, "Visually hidden annotation");
			assert.include(initial.content, "Service map");
			assert.notInclude(initial.content, "data:image/png");
			assert.notInclude(initial.content, "Verbose image title");
			assert.notInclude(initial.content, "Verbose link title");
			assert.notInclude(initial.content, "utm_source");
			assert.include(initial.content, "detail?q=kept");
			assert.include(initial.content, "Anchor without destination");
			assert.notInclude(initial.content, "[Anchor without destination](null)");
			assert.notInclude(initial.content, "SECRET_INPUT_VALUE");
			assert.notInclude(initial.content, "SECRET_TEXTAREA_VALUE");
			assert.notInclude(initial.content, "SECRET_EDITABLE_VALUE");
			assert.notInclude(initial.content, "--- refs ---");
			assert.deepEqual(extractValidRefs(initial.content), []);
			assert.strictEqual(initial.diagnostics.refCount, 0);
			assert.strictEqual(initial.diagnostics.returnedRefCount, 0);
			const originalIdentity = await getPageDocumentIdentity(browser);
			await browser.Runtime.evaluate({ expression: "location.hash = 'x'" });
			const fragmentIdentity = await getPageDocumentIdentity(browser);
			assert.isTrue(isSamePageDocument(originalIdentity, fragmentIdentity));
			await navigate(browser, fixtureUrl());
			const reloadedIdentity = await getPageDocumentIdentity(browser);
			assert.isFalse(isSamePageDocument(originalIdentity, reloadedIdentity));

			const frameProjection = await getPageMarkdownObservation(browser, {
				target: "#frame-field, button",
			});
			assert.include(frameProjection.content, "Frame: Nested form");
			assert.include(frameProjection.content, "Frame field");
			assert.include(frameProjection.content, "Frame submit");
			assert.isAbove(frameProjection.diagnostics.returnedRefCount, 0);

			const searchable = await getPageMarkdownObservation(browser, {
				query: "Alpha detail",
			});
			assert.include(searchable.content, "Alpha detail");
			assert.strictEqual(searchable.diagnostics.matchedNodeCount, 1);
			assert.notInclude(searchable.content, "--- refs ---");

			const editableProjection = await getPageMarkdownObservation(browser, {
				target: "[contenteditable]",
			});
			assert.include(editableProjection.content, "SECRET_EDITABLE_VALUE");
			assert.include(editableProjection.content, "editable=true");

			const actionProjection = await getPageMarkdownObservation(browser, {
				target: "#region",
				redactPasswordInputs: true,
			});
			assert.include(actionProjection.content, "--- refs ---");
			assert.include(actionProjection.content, "[REDACTED]");
			assert.include(actionProjection.content, "Verbose link title");
			assert.include(actionProjection.content, "data:image/png;base64...");
			assert.include(actionProjection.content, "Verbose image title");
			const buttonRef = refFor(
				actionProjection.content,
				"button",
				"Run search",
			);
			await browser.Runtime.evaluate({
				expression: `(() => {
					const original = document.getElementById("run");
					const replacement = original.cloneNode(true);
					replacement.addEventListener("click", () => {
						document.getElementById("status").textContent = "complete";
					});
					original.replaceWith(replacement);
				})()`,
			});
			const execution = await executeActions({
				b: browser,
				actions: [
					{ type: "click", ref: buttonRef },
					{ type: "read_page" },
				],
				openTabs: [],
				memoryFile,
			});
			assert.include(execution.pageObservation, "complete");
			assert.isFalse(execution.pageObservationInvalidated);
			assert.notInclude(execution.pageObservation, "--- refs ---");
			assert.deepEqual(extractValidRefs(execution.pageObservation ?? ""), []);
			assert.deepInclude(execution.pageObservationEvents?.[0], {
				kind: "read_page",
				actionIndex: 2,
				actionCount: 2,
				batchedWithPriorAction: true,
				unchanged: false,
			});

			const duplicateRead = await executeActions({
				b: browser,
				actions: [{ type: "read_page" }],
				openTabs: [],
				memoryFile,
				previousPageObservation: execution.pageObservation,
			});
			assert.deepInclude(duplicateRead.pageObservationEvents?.[0], {
				kind: "read_page",
				actionIndex: 1,
				actionCount: 1,
				batchedWithPriorAction: false,
				unchanged: true,
			});
			assert.include(
				duplicateRead.toolObservations.join("\n"),
				"returned unchanged page content",
			);

			const foundExecution = await executeActions({
				b: browser,
				actions: [{ type: "find_page", query: "complete" }],
				openTabs: [],
				memoryFile,
			});
			assert.include(foundExecution.pageObservation, "complete");
			assert.deepInclude(foundExecution.pageObservationEvents?.[0], {
				kind: "find_page",
				query: "complete",
				actionIndex: 1,
				actionCount: 1,
				batchedWithPriorAction: false,
			});

			const standaloneProjection = await getPageMarkdownObservation(browser, {
				target: "#region",
			});
			const standaloneButtonRef = refFor(
				standaloneProjection.content,
				"button",
				"Run search",
			);
			const standaloneAction = await executeActions({
				b: browser,
				actions: [{ type: "click", ref: standaloneButtonRef }],
				openTabs: [],
				memoryFile,
			});
			assert.isTrue(standaloneAction.pageObservationInvalidated);
			assert.deepEqual(extractValidRefs(standaloneAction.pageObservation ?? ""), []);

			const targeted = await getPageMarkdownObservation(browser, {
				target: "#region",
			});
			assert.include(targeted.content, "# Results");
			assert.include(targeted.content, "complete");
			assert.notInclude(targeted.content, "Unrelated link");
			assert.strictEqual(targeted.diagnostics.matchedNodeCount, 1);
			assert.notInclude(targeted.content, 'link "Unrelated link"');
			assert.notInclude(targeted.content, '] heading "Results"');
			const targetedButtonRef = refFor(
				targeted.content,
				"button",
				"Run search",
			);

			const byRef = await getPageMarkdownObservation(browser, {
				target: targetedButtonRef,
			});
			assert.include(byRef.content, `[${targetedButtonRef}]`);
			assert.include(byRef.content, "Run search");

			await navigate(browser, fixtureUrl());
			const reloadExecution = await executeActions({
				b: browser,
				actions: [
					{ type: "click", ref: targetedButtonRef },
					{ type: "read_page" },
				],
				openTabs: [],
				memoryFile,
			});
			assert.deepEqual(reloadExecution.interactionErrors, []);
			assert.include(reloadExecution.pageObservation, "complete");

			const many = await getPageMarkdownObservation(browser, {
				target: ".card",
			});
			assert.strictEqual(many.diagnostics.matchedNodeCount, 2);
			assert.include(many.content, "First card");
			assert.include(many.content, "Second card");

			const none = await getPageMarkdownObservation(browser, {
				target: "#missing",
			});
			assert.strictEqual(none.diagnostics.matchedNodeCount, 0);
			assert.strictEqual(none.diagnostics.returnedRefCount, 0);

			await browser.Runtime.evaluate({
				expression: `(() => {
					const section = document.createElement("section");
					section.id = "long-region";
					section.innerHTML = "<h2>Long region</h2><p>" +
						"bounded observation ".repeat(10_000) +
						"</p><button>Long-region action</button>";
					document.body.appendChild(section);
				})()`,
			});
			const boundedWholePage = await getPageMarkdownObservation(browser);
			assert.isTrue(boundedWholePage.truncated);
			assert.isAtMost(
				boundedWholePage.content.length,
				PAGE_OBSERVATION_CHARACTER_BUDGET,
			);
			assert.notInclude(boundedWholePage.content, "Long-region action");
			assert.notInclude(boundedWholePage.content, "--- refs ---");
			assert.strictEqual(boundedWholePage.diagnostics.returnedRefCount, 0);

			const boundedProjection = await getPageMarkdownObservation(browser, {
				target: "#long-region",
			});
			assert.isTrue(boundedProjection.truncated);
			assert.isAtMost(
				boundedProjection.content.length,
				PAGE_OBSERVATION_CHARACTER_BUDGET,
			);
			assert.include(boundedProjection.content, "Long-region action");
			assert.include(boundedProjection.content, "--- refs ---");
			assert.isAbove(boundedProjection.diagnostics.returnedRefCount, 0);

			const autoNavigate = await executeActions({
				b: browser,
				actions: [
					{
						type: "navigate",
						url: `data:text/html,${encodeURIComponent("<h1>Automatic destination</h1>")}`,
					},
				],
				openTabs: [],
				memoryFile,
			});
			assert.include(autoNavigate.pageObservation, "Automatic destination");
			assert.deepInclude(autoNavigate.pageObservationEvents?.[0], {
				kind: "read_page",
				automatic: true,
				actionIndex: 1,
				actionCount: 1,
				batchedWithPriorAction: true,
			});
			assert.isFalse(autoNavigate.pageObservationInvalidated);
		} catch (error) {
			if (isSandboxLocalhostPolicyError(error)) {
				this.skip();
				return;
			}
			throw error;
		} finally {
			setConfigFeatureFlags({ pageObservationMode: originalMode });
			if (browser) await close(browser);
		}
	});
});
