import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "chai";
import { describe, it } from "mocha";

const REPOSITORY_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const CANONICAL_HARNESS_PATHS = [
	"src/agents",
	"src/auth",
	"src/core",
	"src/index.ts",
];
const FORBIDDEN_IMPORT =
	/from\s+["'][^"']*(?:browser\/index\.js|simplify-dom|simplified-dom)["']/;

function typescriptFiles(relativePath: string): string[] {
	const absolutePath = path.join(REPOSITORY_ROOT, relativePath);
	const stat = fs.statSync(absolutePath);
	if (stat.isFile()) return [absolutePath];
	return fs
		.readdirSync(absolutePath, { withFileTypes: true })
		.flatMap((entry) =>
			typescriptFiles(path.join(relativePath, entry.name)),
		)
		.filter((file) => file.endsWith(".ts"));
}

describe("canonical semantic projection boundary", () => {
	it("keeps simplified-DOM modules outside the canonical harness", () => {
		const violations = CANONICAL_HARNESS_PATHS.flatMap(typescriptFiles)
			.map((file) => ({
				file,
				contents: fs.readFileSync(file, "utf-8"),
			}))
			.filter(({ contents }) => FORBIDDEN_IMPORT.test(contents))
			.map(({ file }) => path.relative(REPOSITORY_ROOT, file));

		assert.deepEqual(
			violations,
			[],
			"canonical harness code must not import the mixed browser barrel or simplified-DOM modules",
		);
	});
});
