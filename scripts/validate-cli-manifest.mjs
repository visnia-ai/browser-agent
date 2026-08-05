import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_PLATFORMS } from "./sdk-platforms.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.join(root, "sdk", "typescript-sdk");
const packageManifest = JSON.parse(
	fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"),
);
const cliManifest = JSON.parse(
	fs.readFileSync(path.join(sdkRoot, "cli-manifest.json"), "utf8"),
);

assert.equal(cliManifest.version, packageManifest.version);
assert.equal(cliManifest.repository, "visnia-ai/browser-agent");
assert.deepEqual(
	Object.keys(cliManifest.platforms).sort(),
	SDK_PLATFORMS.map(({ key }) => key).sort(),
);
for (const target of SDK_PLATFORMS) {
	const entry = cliManifest.platforms[target.key];
	assert.equal(entry.asset, target.asset);
	assert.equal(
		entry.url,
		`https://github.com/visnia-ai/browser-agent/releases/download/browser-agent-cli-v${cliManifest.version}/${target.asset}`,
	);
	assert.match(entry.sha256, /^[a-f0-9]{64}$/);
}

console.log(`Validated CLI manifest for ${cliManifest.version}.`);
