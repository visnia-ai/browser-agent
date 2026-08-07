import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import { getExecutorSystem } from "../src/agents/prompts.js";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import { featureFlags } from "../src/featureFlags.js";
import {
	AUTH_TAKEOVER_FORM_SYSTEM,
	AUTH_TAKEOVER_RESULT_SYSTEM,
} from "../src/auth/prompt.js";

describe("executor prompt user_takeover tool", () => {
	it("keeps the system prompt free of the runtime date and time", () => {
		const prompt = getExecutorSystem();

		assert.notInclude(prompt, "Today's date/time is");
		assert.notInclude(prompt, "dd/mm/yyyy hh:mm time zone");
	});

	it("documents user_takeover schema, categories, and sensitive-use guidance", () => {
		const originalUserTakeoverTool = configFeatureFlags.userTakeoverTool;
		const originalAuthTakeover = configFeatureFlags.authTakeover;
		configFeatureFlags.userTakeoverTool = true;
		configFeatureFlags.authTakeover = true;
		try {
			const prompt = getExecutorSystem();
			assert.include(prompt, `### Tool Types & Usage`);
			assert.include(prompt, `click(ref)`);
			assert.include(prompt, `type(ref,text,enter?)`);
			assert.include(prompt, `scroll({ref,deltaX,deltaY})`);
			assert.include(prompt, `dropdown_select({ref,value})`);
			assert.include(prompt, `evaluate(script)`);
			assert.include(prompt, `wait(ms)`);
			assert.include(prompt, `normally <=1000`);
			assert.include(prompt, `navigate(url)`);
			assert.include(prompt, `switch_tab(index)`);
			assert.include(prompt, `download_current_file:`);
			assert.include(prompt, `memory_write:`);
			assert.include(prompt, `memory_read:`);
			assert.include(prompt, `save an inline file`);
			assert.include(prompt, `user_takeover:`);
			assert.include(prompt, `category: "authentication"`);
			assert.include(
				prompt,
				`request: "Sensitive step requiring manual user interaction`,
			);
			assert.include(
				prompt,
				`Use "user_takeover" ONLY for sensitive user-only interactions`,
			);
			assert.include(prompt, `Always include "category"`);
			assert.include(prompt, `"otp"`);
			assert.include(prompt, `"verification"`);
			assert.include(prompt, `"payment"`);
			assert.include(
				prompt,
				`When you use "user_takeover", do not include additional tool calls in the same step`,
			);
			assert.notInclude(
				prompt,
				`- Use "memory_write" to store intermediate findings and "memory_read" to retrieve them before final synthesis.`,
			);
			assert.notInclude(prompt, `The DOM uses a compact bracket format:`);
			assert.notInclude(prompt, `Each node starts with "<".`);
		} finally {
			configFeatureFlags.userTakeoverTool = originalUserTakeoverTool;
			configFeatureFlags.authTakeover = originalAuthTakeover;
		}
	});

	it("keeps authentication user_takeover guidance when manual takeover is disabled but auth takeover is enabled", () => {
		const originalUserTakeoverTool = configFeatureFlags.userTakeoverTool;
		const originalAuthTakeover = configFeatureFlags.authTakeover;
		configFeatureFlags.userTakeoverTool = false;
		configFeatureFlags.authTakeover = true;
		try {
			const prompt = getExecutorSystem();
			assert.include(prompt, `user_takeover:`);
			assert.include(prompt, `category: "authentication"`);
			assert.include(
				prompt,
				`request: "Authentication is required to continue."`,
			);
			assert.include(
				prompt,
				`the runtime may attempt supported authentication automatically`,
			);
			assert.notInclude(prompt, `"otp"`);
			assert.notInclude(prompt, `"payment"`);
		} finally {
			configFeatureFlags.userTakeoverTool = originalUserTakeoverTool;
			configFeatureFlags.authTakeover = originalAuthTakeover;
		}
	});

	it("gates the executor thinking field with an internal feature flag", () => {
		const originalActionContextFields =
			featureFlags.executorActionContextFields;
		const originalExecutorThinkingField = featureFlags.executorThinkingField;
		featureFlags.executorActionContextFields = true;
		try {
			featureFlags.executorThinkingField = false;
			const promptWithoutThinking = getExecutorSystem();
			assert.notInclude(promptWithoutThinking, `thinking: |-`);
			assert.include(
				promptWithoutThinking,
				`Each key (checklistUpdate, previousStepStatus, previousStepOutcome, currentStateObservation, nextActionRationale, tools) must appear once in that order.`,
			);

			featureFlags.executorThinkingField = true;
			const promptWithThinking = getExecutorSystem();
			assert.include(
				promptWithThinking,
				`thinking: |-
  The previous action revealed the search field, so the next useful step is to enter the query.`,
			);
			assert.include(
				promptWithThinking,
				`thinking must always be present, must be used for any kind of reasoning, and MUST use YAML block scalar style: |-`,
			);
			assert.include(
				promptWithThinking,
				`Each key (thinking, checklistUpdate, previousStepStatus, previousStepOutcome, currentStateObservation, nextActionRationale, tools) must appear once in that order.`,
			);
			assert.notInclude(promptWithThinking, "\ndone:");
			assert.include(promptWithThinking, `previousStepStatus must be one of:`);
			assert.notInclude(
				promptWithThinking,
				`PUT ANY THINKING OR REASONING IN THE "thinking" FIELD OF THE YAML.`,
			);
		} finally {
			featureFlags.executorActionContextFields = originalActionContextFields;
			featureFlags.executorThinkingField = originalExecutorThinkingField;
		}
	});

	it("shows one concrete YAML response example bounded by tags", () => {
		const originalActionContextFields =
			featureFlags.executorActionContextFields;
		featureFlags.executorActionContextFields = false;
		try {
			const prompt = getExecutorSystem();
			const exampleMatch = prompt.match(
				/Example response:\n<yaml>\n([\s\S]*?)\n<\/yaml>/,
			);

			assert.isNotNull(exampleMatch);
			const exampleYaml = exampleMatch?.[1] ?? "";
			const example = yaml.load(exampleYaml) as Record<string, unknown>;
			assert.deepInclude(example, {
				tools: [
					{
						click: "r2",
					},
					{
						type: {
							ref: "r5",
							text: "browser automation",
							enter: true,
						},
					},
				],
			});
			for (const field of [
				"previousStepStatus",
				"previousStepOutcome",
				"currentStateObservation",
				"nextActionRationale",
			]) {
				assert.notProperty(example, field);
				assert.notInclude(prompt, field);
			}
			assert.notProperty(example, "previousStepPlanUpdate");
			for (const obsoleteExampleTool of [
				"long_press",
				"download_current_file",
				"return_results",
				"extract_data",
			]) {
				assert.notInclude(exampleYaml, obsoleteExampleTool);
			}
			assert.strictEqual(prompt.split("Example response:").length - 1, 1);
			assert.notInclude(prompt, "### Misc Instructions");
			assert.notInclude(prompt, "regenerate_plan");
		} finally {
			featureFlags.executorActionContextFields = originalActionContextFields;
		}
	});

	it("includes action-context schema alongside omitted thinking", () => {
		const originalActionContextFields =
			featureFlags.executorActionContextFields;
		featureFlags.executorActionContextFields = true;
		try {
			const prompt = getExecutorSystem();
			assert.include(
				prompt,
				`Each key (checklistUpdate, previousStepStatus, previousStepOutcome, currentStateObservation, nextActionRationale, tools) must appear once in that order.`,
			);
			assert.notInclude(prompt, "\ndone:");
			assert.include(prompt, `previousStepStatus: "progressed"`);
			assert.include(
				prompt,
				`previousStepOutcome: |-
  Opened the search form.`,
			);
			assert.include(
				prompt,
				`currentStateObservation: |-
  The search field is visible.`,
			);
			assert.include(
				prompt,
				`nextActionRationale: |-
  Enter the requested query.`,
			);
		} finally {
			featureFlags.executorActionContextFields = originalActionContextFields;
		}
	});

	it("defines dedicated auth takeover form and result prompts", () => {
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`Respond with a single <yaml> marker immediately followed by raw YAML`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`action: "advance_identifier_step" | "select_account" | "submit_credentials" | "cannot_attempt"`,
		);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `usernameRef: "r..."`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `passwordRef: "r..."`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `submitRef: "r..."`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `continueRef: "r..."`);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`stayLoggedInCheckboxRef: "r..."`,
		);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `switchIdentifierRef: "r..."`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `accountRef: "r..."`);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`if an account list contains [AUTH_IDENTIFIER_MATCH]`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`changes the email/username/account before password entry`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`when the matching email is inside a button/link`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`use the parent button/link ref as accountRef`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`You are part of an authentication takeover runtime.`,
		);
		assert.include(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`outcome: "invalid_credentials" | "success_or_redirect" | "requires_user_takeover" | "unknown"`,
		);
		assert.include(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`You classify the result of an attempted login after real credential submission.`,
		);
		assert.include(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`Classify using only the latest projection.`,
		);
		assert.notInclude(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`The DOM uses a compact bracket format:`,
		);
		assert.notInclude(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`The DOM uses a compact bracket format:`,
		);
		assert.notInclude(AUTH_TAKEOVER_FORM_SYSTEM, `Each node starts with "<".`);
		assert.notInclude(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`Each node starts with "<".`,
		);
	});
});
