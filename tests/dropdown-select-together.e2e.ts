import path from "node:path";
import * as net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { config as loadEnv } from "dotenv";
import { assert } from "chai";
import { before, describe, it } from "mocha";
import type { Action } from "../src/agents/types.js";
import {
	configFeatureFlags,
	mergeConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { createDefaultCoreDeps } from "../src/core/deps.js";
import { closeSession, runAgent } from "../src/core/index.js";
import { createPortAllocator } from "../src/port-allocation.js";

loadEnv({
	path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});

const FRUIT_SELECT_BID = "1";
const DRY_SELECT_BID = "2";
const MIX_SELECT_BID = "3";

const EXPECTED_FRUIT_VALUE = "banana";
const EXPECTED_DRY_VALUE = "honey";
const EXPECTED_MIX_VALUE = "chocolate";

/** Third submit control — the only real submit; others are no-click-allowed decoys. */
const REAL_SUBMIT_BID = "12";
const DECOY_SUBMIT_BIDS = ["10", "11", "13"] as const;
const TOGETHER_MODEL = "zai-org/GLM-5.2";

function isDecoySubmitBid(bid: string): boolean {
	return (DECOY_SUBMIT_BIDS as readonly string[]).includes(bid);
}

function getDropdownSelectFixtureFileUrl(): string {
	const fixturePath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"assets",
		"dropdown-select-fixture.html",
	);
	return pathToFileURL(fixturePath).href;
}

function createTestPortAllocator(): ReturnType<typeof createPortAllocator> {
	return createPortAllocator({
		minPort: 9266,
		maxPort: 9366,
		isPortInUse: async (port) =>
			await new Promise<boolean>((resolve) => {
				const server = net.createServer();
				server.once("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "EADDRINUSE") {
						resolve(true);
						return;
					}
					resolve(false);
				});
				server.once("listening", () => {
					server.close(() => resolve(false));
				});
				server.listen(port, "127.0.0.1");
			}),
	});
}

function splitClickBids(bid: string): string[] {
	return bid
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function actionsUsedAnyDecoySubmitBid(actions: Action[]): boolean {
	for (const a of actions) {
		if (a.type === "click") {
			for (const b of splitClickBids(a.bid)) {
				if (isDecoySubmitBid(b)) return true;
			}
		}
	}
	return false;
}

function stepTraceHadDropdownSelectForBidAndValue(params: {
	actions: Action[];
	expectedBid: string;
	expectedValue: string;
}): boolean {
	for (const a of params.actions) {
		if (a.type !== "dropdown_select") continue;
		if (a.value !== params.expectedValue) continue;
		if (splitClickBids(a.bid).includes(params.expectedBid)) return true;
	}
	return false;
}

describe("dropdown_select e2e (Together + GLM-5.2)", function () {
	this.timeout(300_000);

	const togetherApiKey = process.env.TOGETHER_API_KEY;

	before(function () {
		if (!togetherApiKey) {
			this.skip();
		}
	});

	it("selects three dropdowns correctly, submits with Submit 3 only, and never clicks decoy submits", async () => {
		const featureFlags = mergeConfigFeatureFlags(configFeatureFlags, {
			preStepScreenshotInLatestUserPrompt: false,
			userTakeoverTool: false,
		});

		const deps = createDefaultCoreDeps({ featureFlags });
		deps.findTargetURL = async () => {
			throw new Error(
				"findTargetURL must not run when session.url is set; preprocess should use the provided URL only",
			);
		};

		const portAllocator = createTestPortAllocator();
		const port = await portAllocator.acquirePort();
		const fixtureUrl = getDropdownSelectFixtureFileUrl();

		const stageLLM = {
			provider: "together" as const,
			model: TOGETHER_MODEL,
			reasoningEffort: "high" as const,
		};

		try {
			const result = await runAgent(deps, {
				session: {
					port,
					headless: true,
					url: fixtureUrl,
					forceRestart: true,
				},
				task: "On this page, set three native selects using dropdown_select (not by clicking options): Fruit = Banana (bid on Fruit select), Dry ingredient = Honey, Mix-in = Chocolate. Click on Submit to confirm. Success when status shows ok:banana,honey,chocolate (exact comma-separated order). Mark done and summarize including banana, honey, and chocolate.",
				stageLLMs: {
					findTargetURL: stageLLM,
					createChecklist: stageLLM,
					runAgent: stageLLM,
					verifySuccess: stageLLM,
				},
				featureFlags,
				maxSteps: 18,
				keepSessionOpen: true,
			});

			assert.isTrue(
				result.completed,
				`expected completed run, got ${JSON.stringify({
					completed: result.completed,
					result: result.result,
					stepCount: result.steps.length,
				})}`,
			);

			assert.strictEqual(
				result.preprocess.target_url,
				fixtureUrl,
				"target URL should be the session launch URL, not from findTargetURL",
			);

			const resultText = (result.result ?? "").toLowerCase();
			assert.include(resultText, "banana");
			assert.include(resultText, "honey");
			assert.include(resultText, "chocolate");

			const allClicks: string[] = [];
			for (const stepTrace of result.steps) {
				for (const a of stepTrace.model.actions) {
					if (a.type === "click") {
						allClicks.push(...splitClickBids(a.bid));
					}
				}
				assert.isFalse(
					actionsUsedAnyDecoySubmitBid(stepTrace.model.actions),
					`step ${stepTrace.step} should not click decoy submit bids ${DECOY_SUBMIT_BIDS.join(", ")}`,
				);
			}

			const expectedDropdowns: Array<{
				bid: string;
				value: string;
				label: string;
			}> = [
				{
					bid: FRUIT_SELECT_BID,
					value: EXPECTED_FRUIT_VALUE,
					label: "fruit",
				},
				{
					bid: DRY_SELECT_BID,
					value: EXPECTED_DRY_VALUE,
					label: "dry ingredient",
				},
				{
					bid: MIX_SELECT_BID,
					value: EXPECTED_MIX_VALUE,
					label: "mix-in",
				},
			];
			for (const exp of expectedDropdowns) {
				let saw = false;
				for (const stepTrace of result.steps) {
					if (
						stepTraceHadDropdownSelectForBidAndValue({
							actions: stepTrace.model.actions,
							expectedBid: exp.bid,
							expectedValue: exp.value,
						})
					) {
						saw = true;
						break;
					}
				}
				assert.isTrue(
					saw,
					`expected a dropdown_select for ${exp.label} (bid ${exp.bid}, value ${exp.value})`,
				);
			}
			for (const bid of DECOY_SUBMIT_BIDS) {
				assert.notInclude(
					allClicks,
					bid,
					`model should not click decoy submit bid ${bid}`,
				);
			}
			assert.include(
				allClicks,
				REAL_SUBMIT_BID,
				"model should click the real Submit 3 control",
			);

			const session = deps.registry.get(port);
			assert.isDefined(session);
			const { result: evalRes } = await session!.browser.Runtime.evaluate({
				expression: `(() => {
          const fruit = document.getElementById("fruit");
          const dry = document.getElementById("dry-ingredient");
          const mix = document.getElementById("mix-in");
          const status = document.getElementById("status");
          return {
            fruitValue:
              fruit instanceof HTMLSelectElement ? fruit.value : "",
            dryValue:
              dry instanceof HTMLSelectElement ? dry.value : "",
            mixValue:
              mix instanceof HTMLSelectElement ? mix.value : "",
            statusText: status ? status.textContent || "" : "",
          };
        })()`,
				returnByValue: true,
			});
			const dom = (evalRes.value ?? {}) as {
				fruitValue?: string;
				dryValue?: string;
				mixValue?: string;
				statusText?: string;
			};
			assert.strictEqual(dom.fruitValue, EXPECTED_FRUIT_VALUE);
			assert.strictEqual(dom.dryValue, EXPECTED_DRY_VALUE);
			assert.strictEqual(dom.mixValue, EXPECTED_MIX_VALUE);
			assert.strictEqual(
				dom.statusText,
				`ok:${EXPECTED_FRUIT_VALUE},${EXPECTED_DRY_VALUE},${EXPECTED_MIX_VALUE}`,
			);
		} finally {
			if (deps.registry.get(port)) {
				await closeSession(deps, port);
			}
			portAllocator.releasePort(port);
		}
	});
});
