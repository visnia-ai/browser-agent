import { assert } from "chai";
import { describe, it } from "mocha";
import {
	authEncryptionKeyEnvName,
	decryptAuthField,
	decryptStoredAuthDomain,
	findMatchingStoredAuthCredential,
	generateAuthEncryptionKey,
	normalizeAuthCredentialsForStorage,
	encryptAuthField,
} from "../src/auth/crypto.js";
import { withAuthEncryptionKey } from "./helpers/auth-test-utils.js";

describe("auth crypto", () => {
	it("generates base64-encoded 32-byte encryption keys", () => {
		const first = generateAuthEncryptionKey();
		const second = generateAuthEncryptionKey();
		assert.lengthOf(Buffer.from(first, "base64"), 32);
		assert.lengthOf(Buffer.from(second, "base64"), 32);
		assert.notStrictEqual(first, second);
	});

	it("encrypts and decrypts auth fields with AES-256-GCM", async () => {
		await withAuthEncryptionKey(async () => {
			const plaintext = "https://login.example.com";
			const ciphertext = encryptAuthField(plaintext);

			assert.notStrictEqual(ciphertext, plaintext);
			assert.strictEqual(decryptAuthField(ciphertext), plaintext);
		});
	});

	it("fails fast when the auth encryption key is malformed", () => {
		const envName = authEncryptionKeyEnvName();
		const previousValue = process.env[envName];
		process.env[envName] = "invalid";

		try {
			assert.throws(() => encryptAuthField("secret"), /exactly 32 bytes/);
		} finally {
			if (previousValue === undefined) {
				delete process.env[envName];
				return;
			}
			process.env[envName] = previousValue;
		}
	});

	it("uses an explicit encryption key when env is unset", () => {
		const envName = authEncryptionKeyEnvName();
		const previousValue = process.env[envName];
		delete process.env[envName];
		const explicitKey = Buffer.alloc(32, 7).toString("base64");

		try {
			const plaintext = "sensitive";
			const ciphertext = encryptAuthField(plaintext, {
				encryptionKey: explicitKey,
			});
			assert.strictEqual(
				decryptAuthField(ciphertext, {
					encryptionKey: explicitKey,
				}),
				plaintext,
			);
		} finally {
			if (previousValue === undefined) {
				delete process.env[envName];
				return;
			}
			process.env[envName] = previousValue;
		}
	});

	it("rejects malformed auth ciphertext payloads", async () => {
		await withAuthEncryptionKey(async () => {
			assert.throws(
				() => decryptAuthField("bauth-v1:not-base64"),
				/Invalid auth ciphertext payload/,
			);
		});
	});

	it("can decrypt the configured domain without touching other encrypted fields", async () => {
		await withAuthEncryptionKey(async () => {
			const credentials = {
				mode: "encrypted" as const,
				encryptedDomainUrl: encryptAuthField(
					"https://login.example.com/sign-in",
				),
				encryptedUsername: "bad-ciphertext",
				encryptedPassword: "bad-ciphertext",
			};

			assert.strictEqual(
				decryptStoredAuthDomain(credentials),
				"https://login.example.com/sign-in",
			);
		});
	});

	it("normalizes multiple auth credentials for storage and matches by current domain", async () => {
		await withAuthEncryptionKey(async () => {
			const stored = normalizeAuthCredentialsForStorage([
				{
					mode: "plaintext" as const,
					domainUrl: "https://accounts.example.com/login",
					username: "first@example.com",
					password: "first-secret",
				},
				{
					mode: "plaintext" as const,
					domainUrl: "https://console.other.test/sign-in",
					username: "second@example.com",
					password: "second-secret",
				},
			]);

			assert.isDefined(stored);
			assert.lengthOf(stored!, 2);
			const matched = findMatchingStoredAuthCredential({
				credentials: stored!,
				currentUrl: "https://app.other.test/dashboard",
			});
			assert.isDefined(matched);
			assert.strictEqual(
				decryptStoredAuthDomain(matched!),
				"https://console.other.test/sign-in",
			);
		});
	});
});
