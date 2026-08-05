import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distPath = fileURLToPath(new URL("../dist", import.meta.url));

rmSync(distPath, { recursive: true, force: true });
