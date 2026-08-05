import assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
	enableBrowserClientDomains,
	type BrowserClientDomains,
} from "../src/browser/client-setup.js";

function createFakeClient() {
	let dialogHandler:
		| ((dialog: { type: string; message?: string }) => void)
		| undefined;
	const handleCalls: Array<{ accept: boolean; promptText: string }> = [];
	const enabled: string[] = [];

	const domains: BrowserClientDomains = {
		Page: {
			enable: async () => {
				enabled.push("Page");
			},
			javascriptDialogOpening: (handler) => {
				dialogHandler = handler as typeof dialogHandler;
			},
			handleJavaScriptDialog: async (input) => {
				handleCalls.push(
					input as { accept: boolean; promptText: string },
				);
			},
		} as unknown as BrowserClientDomains["Page"],
		Runtime: {
			enable: async () => {
				enabled.push("Runtime");
			},
		} as unknown as BrowserClientDomains["Runtime"],
		DOM: {
			enable: async () => {
				enabled.push("DOM");
			},
		} as unknown as BrowserClientDomains["DOM"],
		DOMSnapshot: {
			enable: async () => {
				enabled.push("DOMSnapshot");
			},
		} as unknown as BrowserClientDomains["DOMSnapshot"],
		Input: {} as BrowserClientDomains["Input"],
		Target: {
			setDiscoverTargets: async () => {
				enabled.push("Target");
			},
		} as unknown as BrowserClientDomains["Target"],
		Accessibility: {
			enable: async () => {
				enabled.push("Accessibility");
			},
		} as unknown as BrowserClientDomains["Accessibility"],
	};

	return {
		client: domains as unknown as Parameters<
			typeof enableBrowserClientDomains
		>[0],
		domains,
		enabled,
		getDialogHandler: () => dialogHandler,
		handleCalls,
	};
}

describe("enableBrowserClientDomains", () => {
	it("installs JavaScript dialog auto-accept handling on initialized clients", async () => {
		const fake = createFakeClient();

		const domains = await enableBrowserClientDomains(fake.client);

		assert.equal(domains.Page, fake.domains.Page);
		assert.deepEqual([...fake.enabled].sort(), [
			"Accessibility",
			"DOM",
			"DOMSnapshot",
			"Page",
			"Runtime",
			"Target",
		]);
		assert.ok(fake.getDialogHandler());

		fake.getDialogHandler()?.({
			type: "beforeunload",
			message: "Changes you made may not be saved.",
		});
		await Promise.resolve();

		assert.deepEqual(fake.handleCalls, [
			{
				accept: true,
				promptText: "",
			},
		]);
	});
});
