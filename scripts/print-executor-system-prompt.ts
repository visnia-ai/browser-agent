import { getExecutorSystem } from "../src/agents/prompts.js";
import { setConfigFeatureFlags } from "../src/config-feature-flags.js";
import { estimateTokenCount } from "../src/agents/executor-utils/step-context.js";
import { loadConfig } from "../src/utils.js";

const configPath = process.argv[2];

if (!configPath) {
	console.error(
		"Usage: tsx scripts/print-executor-system-prompt.ts <config.yaml>",
	);
	process.exit(1);
}

const config = loadConfig(configPath);
setConfigFeatureFlags(config.featureFlags);

const prompt = getExecutorSystem({
	provider: config.stageLLMs.runAgent.provider,
});

console.log(prompt);
console.log(`\nEstimated tokens: ${estimateTokenCount(prompt)}`);
