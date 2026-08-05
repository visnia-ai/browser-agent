import { expect } from "chai";
import type { Browser } from "../src/browser/types.js";
import { click } from "../src/browser/interaction/click.js";
import { type as typeInto } from "../src/browser/interaction/type.js";
import { replaceSemanticRefSnapshot } from "../src/browser/semantic-ref-registry.js";

type StubOptions = Partial<{
	scrollFailFirst: boolean;
	focusFailFirst: boolean;
}>;

function createBrowserStub(
	overrides: StubOptions = {},
): Browser & { _staleNodeState: ReturnType<typeof createState> } {
	const state = createState();

	const dom: Browser["DOM"] = {
		async getDocument() {
			state.queryCall += 1;
			return {
				root: {
					nodeId: 0,
					children: [
						{ nodeId: 101, attributes: ["data-bid", "bid-1"] },
					],
				},
			};
		},
		async pushNodesByBackendIdsToFrontend() {
			return { nodeIds: [101] };
		},
		async resolveNode({ nodeId }: { nodeId: number }) {
			return { object: { objectId: "object-" + nodeId } };
		},
		async scrollIntoViewIfNeeded() {
			state.scrollCalls += 1;
			if (overrides.scrollFailFirst && state.scrollCalls === 1) {
				throw new Error("Could not find node with given id");
			}
		},
		async focus() {
			state.focusCalls += 1;
			if (overrides.focusFailFirst && state.focusCalls === 1) {
				throw new Error("Could not find node with given id");
			}
		},
		async getBoxModel() {
			return { model: { content: [0, 0, 0, 0, 20, 20] } };
		},
		async describeNode() {
			return { node: { nodeName: "INPUT" } };
		},
	};

	const input: Browser["Input"] = {
		async dispatchMouseEvent() {
			return;
		},
		async dispatchKeyEvent() {
			return;
		},
	};

	const runtime: Browser["Runtime"] = {
		async callFunctionOn(params) {
			const declaration = params.functionDeclaration || "";
			if (declaration.includes("__baClickProbeStore")) {
				// Simulate a successful click probe readback.
				return { result: { value: true } };
			}
			return { result: { value: null } };
		},
		async evaluate() {
			return { result: { value: null } };
		},
	};

	const browser = {
		DOM: dom,
		Input: input,
		Runtime: runtime,
		async close() {},
		async isConnected() {
			return true;
		},
		async enable() {},
		_staleNodeState: state,
	} as Browser & { _staleNodeState: ReturnType<typeof createState> };
	replaceSemanticRefSnapshot(browser, [
		{
			ref: "r1",
			backendNodeId: 1010,
			role: "textbox",
			capabilities: ["click", "type"],
		},
	]);

	return browser;
}

function createState() {
	return {
		queryCall: 0,
		nodeIds: [1, 2],
		scrollCalls: 0,
		focusCalls: 0,
	};
}

describe("stale-node interaction retries", () => {
	it("retries click when scrollIntoView fails first", async () => {
		const browser = createBrowserStub({ scrollFailFirst: true });
		await click(browser, "r1");
		expect(browser._staleNodeState.scrollCalls).to.equal(2);
		expect(browser._staleNodeState.queryCall).to.be.greaterThan(1);
	});

	it("retries typing when focus initially fails", async () => {
		const browser = createBrowserStub({ focusFailFirst: true });
		await typeInto(browser, "r1", "value");
		expect(browser._staleNodeState.focusCalls).to.equal(2);
		expect(browser._staleNodeState.queryCall).to.be.greaterThan(1);
	});
});
