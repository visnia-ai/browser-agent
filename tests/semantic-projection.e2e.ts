import { assert } from "chai";
import { describe, it } from "mocha";
import {
	click,
	close,
	dropdownSelect,
	getSemanticProjection,
	launch,
	navigate,
	type as typeText,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

function fixtureUrl(): string {
	const html = `<!doctype html>
<html><body>
  <label>Search <input id="query" aria-label="Search query"></label>
  <button id="submit">Run search</button>
  <label>Fruit <select id="fruit" aria-label="Fruit"><option>Apple</option><option>Banana</option></select></label>
  <p id="status">idle</p>
  <script>
    document.getElementById("submit").addEventListener("click", () => {
      document.getElementById("status").textContent = document.getElementById("query").value;
    });
  </script>
</body></html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

function refFor(projection: string, role: string, name: string): string {
	const line = projection
		.split("\n")
		.find(
			(candidate) =>
				candidate.trimStart().startsWith(`${role} `) &&
				candidate.includes(`name=${JSON.stringify(name)}`),
		);
	const ref = line && /\bref="([^"]+)"/.exec(line)?.[1];
	assert.isString(ref, `missing ${role} named ${name} in:\n${projection}`);
	return ref!;
}

function isSandboxLocalhostPolicyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("Blocked by sandbox network policy") &&
		message.includes("127.0.0.1")
	);
}

describe("semantic projection e2e", function () {
	this.timeout(90_000);

	it("projects AX state and executes ref-only click, type, and select actions", async function () {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, fixtureUrl());

			const projection = await getSemanticProjection(browser, {
				omitHrefs: false,
			});
			assert.match(projection, /^projection semantic-v1 refs=\d+/);
			assert.notInclude(projection, "data-bid");

			const queryRef = refFor(projection, "textbox", "Search query");
			const buttonRef = refFor(projection, "button", "Run search");
			const selectRef = refFor(projection, "combobox", "Fruit");

			await typeText(browser, queryRef, "semantic success");
			await dropdownSelect(browser, selectRef, "Banana");
			await click(browser, buttonRef);

			const { result } = await browser.Runtime.evaluate({
				expression: `({
				  status: document.getElementById("status").textContent,
				  fruit: document.getElementById("fruit").value,
				  stamped: document.querySelectorAll("[data-bid]").length
				})`,
				returnByValue: true,
			});
			assert.deepEqual(result.value, {
				status: "semantic success",
				fruit: "Banana",
				stamped: 0,
			});
		} catch (error) {
			if (isSandboxLocalhostPolicyError(error)) {
				this.skip();
				return;
			}
			throw error;
		} finally {
			if (browser) await close(browser);
		}
	});
});
