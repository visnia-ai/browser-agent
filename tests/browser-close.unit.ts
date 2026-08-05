import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "mocha";
import { close } from "../src/browser/browser.js";
import type { Browser } from "../src/browser/types.js";

function createBrowser(params?: {
	onKill?: (process: ChildProcessStub) => void;
	closeTransport?: () => Promise<void>;
}): {
	browser: Browser;
	process: ChildProcessStub;
	killCalls: { count: number };
	clientCloseCalls: { count: number };
} {
	const process = new ChildProcessStub();
	const killCalls = { count: 0 };
	const clientCloseCalls = { count: 0 };
	const browser: Browser = {
		client: {
			close: async () => {
				clientCloseCalls.count += 1;
			},
		} as Browser["client"],
		chrome: {
			kill: () => {
				killCalls.count += 1;
				params?.onKill?.(process);
			},
			chromeProcess: process,
		} as Browser["chrome"],
		Page: {} as Browser["Page"],
		Runtime: {} as Browser["Runtime"],
		DOM: {} as Browser["DOM"],
		DOMSnapshot: {} as Browser["DOMSnapshot"],
		Input: {} as Browser["Input"],
		Target: {} as Browser["Target"],
		Accessibility: {} as Browser["Accessibility"],
		port: 9222,
		...(params?.closeTransport
			? { closeTransport: params.closeTransport }
			: {}),
	};

	return {
		browser,
		process,
		killCalls,
		clientCloseCalls,
	};
}

class ChildProcessStub extends EventEmitter {
	exitCode: number | null = null;
}

describe("browser.close", () => {
	it("waits for the Chrome process to close before resolving", async () => {
		const fixture = createBrowser({
			onKill: (process) => {
				setTimeout(() => {
					process.exitCode = 0;
					process.emit("close");
				}, 20);
			},
		});

		let resolved = false;
		const closePromise = close(fixture.browser).then(() => {
			resolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(resolved, false);
		assert.equal(fixture.clientCloseCalls.count, 1);
		assert.equal(fixture.killCalls.count, 1);

		await closePromise;
		assert.equal(resolved, true);
	});

	it("resolves after a timeout when Chrome never emits close", async function () {
		this.timeout(7_000);
		const fixture = createBrowser();
		const startedAt = Date.now();

		await close(fixture.browser);

		const elapsedMs = Date.now() - startedAt;
		assert.equal(fixture.clientCloseCalls.count, 1);
		assert.equal(fixture.killCalls.count, 1);
		assert.ok(
			elapsedMs >= 4_500,
			`expected close to wait before timing out, got ${elapsedMs}ms`,
		);
		assert.ok(
			elapsedMs < 6_500,
			`expected close timeout to stay bounded, got ${elapsedMs}ms`,
		);
	});

	it("skips Chrome kill when only a transport connection should close", async () => {
		let transportClosed = 0;
		const fixture = createBrowser({
			closeTransport: async () => {
				transportClosed += 1;
			},
		});

		await close(fixture.browser);

		assert.equal(fixture.clientCloseCalls.count, 1);
		assert.equal(transportClosed, 1);
		assert.equal(fixture.killCalls.count, 0);
	});
});
