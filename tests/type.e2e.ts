import { assert } from "chai";
import { describe, it } from "mocha";
import {
	close,
	getSemanticProjection,
	launch,
	navigate,
	sleep,
	type as typeText,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

function buildEnterTestPageDataUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <input id="search-input" aria-label="Search input" type="text" />
    <div id="commit-target"></div>
    <button id="outside">Outside</button>
    <script>
      const input = document.getElementById("search-input");
      const commitTarget = document.getElementById("commit-target");
      let committedWithEnter = false;

      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        committedWithEnter = true;
        commitTarget.textContent = input.value;
        input.blur();
      });

      input.addEventListener("blur", () => {
        if (!committedWithEnter) {
          input.value = "";
          commitTarget.textContent = "";
        }
      });
    </script>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

function buildContentEditablePageDataUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <div id="editor" aria-label="Editor" contenteditable="true">OLD VALUE</div>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

function buildTextareaPageDataUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <textarea id="notes" aria-label="Notes">OLD VALUE</textarea>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

function buildShadowInputPageDataUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <div id="host"></div>
    <script>
      const host = document.getElementById("host");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<input id="shadow-input" aria-label="Shadow input" type="text" />';
    </script>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

function buildDateInputPageDataUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <input id="date-input" aria-label="Date input" type="date" value="2024-01-15" />
    <script>
      window.dateEvents = [];
      const input = document.getElementById("date-input");
      input.addEventListener("input", (event) => {
        window.dateEvents.push({
          type: event.type,
          value: input.value,
        });
      });
      input.addEventListener("change", (event) => {
        window.dateEvents.push({
          type: event.type,
          value: input.value,
        });
      });
    </script>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

async function getTypePageState(browser: Browser): Promise<{
	activeElementId: string;
	committedValue: string;
	inputValue: string;
}> {
	const { result } = await browser.Runtime.evaluate({
		expression: `(() => {
      const input = document.getElementById("search-input");
      const commitTarget = document.getElementById("commit-target");
      return {
        activeElementId: document.activeElement?.id || "",
        committedValue: commitTarget?.textContent || "",
        inputValue: input?.value || "",
      };
    })()`,
		returnByValue: true,
	});
	const value = (result.value ?? {}) as {
		activeElementId?: string;
		committedValue?: string;
		inputValue?: string;
	};
	return {
		activeElementId: value.activeElementId ?? "",
		committedValue: value.committedValue ?? "",
		inputValue: value.inputValue ?? "",
	};
}

async function refByName(browser: Browser, name: string): Promise<string> {
	const projection = await getSemanticProjection(browser, {
		omitHrefs: false,
	});
	const line = projection
		.split("\n")
		.find(
			(candidate) =>
				candidate.includes(`name=${JSON.stringify(name)}`) &&
				/\bref="/.test(candidate),
		);
	const ref = line && /\bref="([^"]+)"/.exec(line)?.[1];
	assert.isString(
		ref,
		`missing ${name} in semantic projection:\n${projection}`,
	);
	return ref!;
}

describe("type interaction e2e", function () {
	this.timeout(90_000);

	it("clears typed text on blur when enter is not used", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildEnterTestPageDataUrl());

			await typeText(
				browser,
				await refByName(browser, "Search input"),
				"hello",
			);
			await browser.Runtime.evaluate({
				expression: `(() => {
          const outside = document.getElementById("outside");
          if (outside instanceof HTMLElement) outside.focus();
        })()`,
			});

			const state = await getTypePageState(browser);
			assert.strictEqual(state.inputValue, "");
			assert.strictEqual(state.committedValue, "");
			assert.notStrictEqual(state.activeElementId, "search-input");
		} finally {
			if (browser) await close(browser);
		}
	});

	it("types text with enter and submits, blurs input, and commits value", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildEnterTestPageDataUrl());

			await typeText(
				browser,
				await refByName(browser, "Search input"),
				"world",
				true,
			);

			const state = await getTypePageState(browser);
			assert.strictEqual(state.inputValue, "world");
			assert.strictEqual(state.committedValue, "world");
			assert.notStrictEqual(state.activeElementId, "search-input");
		} finally {
			if (browser) await close(browser);
		}
	});

	it("replaces existing contenteditable text when typing", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildContentEditablePageDataUrl());

			await typeText(
				browser,
				await refByName(browser, "Editor"),
				"new text",
			);

			const { result } = await browser.Runtime.evaluate({
				expression: `(() => {
          const editor = document.getElementById("editor");
          return editor?.textContent || "";
        })()`,
				returnByValue: true,
			});
			const value = typeof result.value === "string" ? result.value : "";
			assert.strictEqual(value, "new text");
		} finally {
			if (browser) await close(browser);
		}
	});

	it("preserves embedded newlines for contenteditable editors", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildContentEditablePageDataUrl());

			await typeText(
				browser,
				await refByName(browser, "Editor"),
				"Dear Denis,\n\nBest regards,\nJohn",
			);

			const { result } = await browser.Runtime.evaluate({
				expression: `(() => {
          const editor = document.getElementById("editor");
          return editor instanceof HTMLElement
            ? { innerText: editor.innerText, innerHTML: editor.innerHTML }
            : { innerText: "", innerHTML: "" };
        })()`,
				returnByValue: true,
			});
			const value = (result.value ?? {}) as {
				innerText?: string;
				innerHTML?: string;
			};
			assert.strictEqual(
				value.innerHTML ?? "",
				"Dear Denis,<div><br></div><div>Best regards,</div><div>John</div>",
			);
			assert.include(value.innerText ?? "", "Best regards,");
		} finally {
			if (browser) await close(browser);
		}
	});

	it("preserves embedded newlines for textarea fields", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildTextareaPageDataUrl());

			await typeText(
				browser,
				await refByName(browser, "Notes"),
				"Line one\nLine two",
			);

			const { result } = await browser.Runtime.evaluate({
				expression: `(() => {
          const textarea = document.getElementById("notes");
          return textarea instanceof HTMLTextAreaElement ? textarea.value : "";
        })()`,
				returnByValue: true,
			});
			const value = typeof result.value === "string" ? result.value : "";
			assert.strictEqual(value, "Line one\nLine two");
		} finally {
			if (browser) await close(browser);
		}
	});

	it("types into an input inside an open shadow root", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildShadowInputPageDataUrl());

			await typeText(
				browser,
				await refByName(browser, "Shadow input"),
				"shadow value",
			);

			const { result } = await browser.Runtime.evaluate({
				expression: `(() => {
          const host = document.getElementById("host");
          const input = host?.shadowRoot?.getElementById("shadow-input");
          return input instanceof HTMLInputElement ? input.value : "";
        })()`,
				returnByValue: true,
			});
			const value = typeof result.value === "string" ? result.value : "";
			assert.strictEqual(value, "shadow value");
		} finally {
			if (browser) await close(browser);
		}
	});

	it("sets an input[type=date] with an exact ISO value and emits events", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildDateInputPageDataUrl());

			await typeText(
				browser,
				await refByName(browser, "Date input"),
				"1990-01-01",
			);

			const { result } = await browser.Runtime.evaluate({
				expression: `({
          value: document.getElementById("date-input")?.value || "",
          events: window.dateEvents,
        })`,
				returnByValue: true,
			});
			const state = result.value as {
				value: string;
				events: Array<{ type: string; value: string }>;
			};
			assert.strictEqual(state.value, "1990-01-01");
			assert.deepStrictEqual(state.events, [
				{ type: "input", value: "1990-01-01" },
				{ type: "change", value: "1990-01-01" },
			]);
		} finally {
			if (browser) await close(browser);
		}
	});

	it("rejects malformed or impossible ISO dates without changing the field", async () => {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildDateInputPageDataUrl());
			const dateRef = await refByName(browser, "Date input");

			for (const invalidDate of ["01/31/1990", "2025-02-30"]) {
				let error: unknown;
				try {
					await typeText(browser, dateRef, invalidDate);
				} catch (caught) {
					error = caught;
				}
				assert.instanceOf(error, Error);
				assert.include((error as Error).message, "YYYY-MM-DD");
			}

			const { result } = await browser.Runtime.evaluate({
				expression:
					'document.getElementById("date-input")?.value || ""',
				returnByValue: true,
			});
			assert.strictEqual(result.value, "2024-01-15");
		} finally {
			if (browser) await close(browser);
		}
	});
});
