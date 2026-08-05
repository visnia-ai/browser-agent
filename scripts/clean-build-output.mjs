import { rmSync } from "node:fs";

const buildTargets = ["dist/scripts", "dist/tests", "dist/server"];

if (process.platform === "win32") {
	for (const target of buildTargets) {
		rmSync(target, { recursive: true, force: true });
	}
	process.exit(0);
}

for (const target of buildTargets) {
	rmSync(target, { recursive: true, force: true });
}
