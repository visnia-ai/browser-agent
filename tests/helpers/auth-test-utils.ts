import * as crypto from "crypto";
import { authEncryptionKeyEnvName } from "../../src/auth/crypto.js";

export async function withAuthEncryptionKey<T>(
	run: () => Promise<T> | T,
): Promise<T> {
	const envName = authEncryptionKeyEnvName();
	const previousValue = process.env[envName];
	process.env[envName] = crypto.randomBytes(32).toString("base64");
	try {
		return await run();
	} finally {
		if (previousValue === undefined) {
			delete process.env[envName];
			return;
		}
		process.env[envName] = previousValue;
	}
}

export function currentAuthEncryptionKeyOrThrow(): string {
	const envName = authEncryptionKeyEnvName();
	const value = process.env[envName];
	if (!value) {
		throw new Error(`${envName} is not set for this test.`);
	}
	return value;
}
