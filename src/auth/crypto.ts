import * as crypto from "crypto";
import type {
	AuthCredentialInput,
	AuthCredentialsInput,
	PlaintextAuthCredentialsInput,
	RequestAuthDomainCandidates,
	RequestAuthIdentifierForDomain,
	RequestAuthPasswordForDomain,
	SessionAuthTakeoverState,
	StoredEncryptedAuthCredential,
	StoredEncryptedAuthCredentials,
} from "./types.js";
import type { LLMOptions } from "../agents/types.js";
import { authDomainsMatch } from "./domain-match.js";

const AUTH_CIPHERTEXT_PREFIX = "bauth-v1:";
const AUTH_ENCRYPTION_KEY_ENV = "BROWSER_AGENT_AUTH_ENCRYPTION_KEY";
const AUTH_ENCRYPTION_KEY_LENGTH = 32;
const IV_LENGTH = 12;

interface CipherEnvelopeV1 {
	iv: string;
	tag: string;
	ciphertext: string;
}

interface AuthKeyOptions {
	encryptionKey?: string;
}

function parseEncryptionKey(raw: string): Buffer {
	let key: Buffer;
	try {
		key = Buffer.from(raw, "base64");
	} catch {
		throw new Error(
			`${AUTH_ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte key.`,
		);
	}
	if (key.length !== AUTH_ENCRYPTION_KEY_LENGTH) {
		throw new Error(
			`${AUTH_ENCRYPTION_KEY_ENV} must decode to exactly 32 bytes.`,
		);
	}
	return key;
}

export function generateAuthEncryptionKey(): string {
	return crypto.randomBytes(AUTH_ENCRYPTION_KEY_LENGTH).toString("base64");
}

function readEncryptionKey(options?: AuthKeyOptions): Buffer {
	const raw =
		options?.encryptionKey?.trim() || process.env[AUTH_ENCRYPTION_KEY_ENV];
	if (!raw || !raw.trim()) {
		throw new Error(
			`${AUTH_ENCRYPTION_KEY_ENV} is required for authTakeover encryption/decryption.`,
		);
	}
	return parseEncryptionKey(raw.trim());
}

function serializeEnvelope(envelope: CipherEnvelopeV1): string {
	return `${AUTH_CIPHERTEXT_PREFIX}${Buffer.from(
		JSON.stringify(envelope),
		"utf-8",
	).toString("base64")}`;
}

function parseEnvelope(value: string): CipherEnvelopeV1 {
	if (!value.startsWith(AUTH_CIPHERTEXT_PREFIX)) {
		throw new Error("Unsupported auth ciphertext format.");
	}
	const raw = value.slice(AUTH_CIPHERTEXT_PREFIX.length);
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
	} catch {
		throw new Error("Invalid auth ciphertext payload.");
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		typeof (parsed as CipherEnvelopeV1).iv !== "string" ||
		typeof (parsed as CipherEnvelopeV1).tag !== "string" ||
		typeof (parsed as CipherEnvelopeV1).ciphertext !== "string"
	) {
		throw new Error("Invalid auth ciphertext envelope.");
	}
	return parsed as CipherEnvelopeV1;
}

export function encryptAuthField(
	value: string,
	options?: AuthKeyOptions,
): string {
	const key = readEncryptionKey(options);
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(value, "utf-8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return serializeEnvelope({
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	});
}

export function decryptAuthField(
	value: string,
	options?: AuthKeyOptions,
): string {
	const key = readEncryptionKey(options);
	const envelope = parseEnvelope(value);
	const decipher = crypto.createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(envelope.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertext, "base64")),
		decipher.final(),
	]);
	return plaintext.toString("utf-8");
}

function encryptPlaintextCredentials(
	credentials: PlaintextAuthCredentialsInput,
	options?: AuthKeyOptions,
): StoredEncryptedAuthCredential {
	return {
		mode: "encrypted",
		encryptedDomainUrl: encryptAuthField(credentials.domainUrl, options),
		encryptedUsername: encryptAuthField(credentials.username, options),
		encryptedPassword: encryptAuthField(credentials.password, options),
	};
}

function normalizeAuthCredentialsInput(
	input: AuthCredentialsInput,
): AuthCredentialInput[] {
	return Array.isArray(input) ? [...input] : [input];
}

export function normalizeAuthCredentialsForStorage(
	input?: AuthCredentialsInput,
	options?: AuthKeyOptions,
): StoredEncryptedAuthCredentials | undefined {
	if (!input) {
		return undefined;
	}
	const normalized = normalizeAuthCredentialsInput(input);
	if (normalized.length === 0) {
		return undefined;
	}
	return normalized.map((entry) =>
		entry.mode === "encrypted"
			? {
					mode: "encrypted",
					encryptedDomainUrl: entry.encryptedDomainUrl,
					encryptedUsername: entry.encryptedUsername,
					encryptedPassword: entry.encryptedPassword,
				}
			: encryptPlaintextCredentials(entry, options),
	);
}

function getMatchingCredential(params: {
	credentials: StoredEncryptedAuthCredentials;
	currentUrl: string;
	encryptionKey?: string;
}): StoredEncryptedAuthCredential | undefined {
	for (const credential of params.credentials) {
		if (
			authDomainsMatch({
				configuredUrl: decryptStoredAuthDomain(credential, {
					encryptionKey: params.encryptionKey,
				}),
				currentUrl: params.currentUrl,
			})
		) {
			return credential;
		}
	}
	return undefined;
}

export function findMatchingStoredAuthCredential(params: {
	credentials: StoredEncryptedAuthCredentials;
	currentUrl: string;
	encryptionKey?: string;
}): StoredEncryptedAuthCredential | undefined {
	return getMatchingCredential(params);
}

export function createAuthCredentialCallbacksFromInput(params: {
	credentials?: AuthCredentialsInput;
	encryptionKey?: string;
}): {
	requestAuthDomainCandidates: RequestAuthDomainCandidates;
	requestAuthIdentifierForDomain: RequestAuthIdentifierForDomain;
	requestAuthPasswordForDomain: RequestAuthPasswordForDomain;
} | null {
	const stored = normalizeAuthCredentialsForStorage(params.credentials, {
		encryptionKey: params.encryptionKey,
	});
	if (!stored || stored.length === 0) {
		return null;
	}

	const requestAuthDomainCandidates: RequestAuthDomainCandidates = async (
		currentUrl,
	) => {
		const matches = new Set<string>();
		for (const credential of stored) {
			const domainUrl = decryptStoredAuthDomain(credential, {
				encryptionKey: params.encryptionKey,
			});
			if (authDomainsMatch({ configuredUrl: domainUrl, currentUrl })) {
				matches.add(domainUrl);
			}
		}
		return [...matches];
	};

	const requestAuthIdentifierForDomain: RequestAuthIdentifierForDomain =
		async (currentUrl) => {
			const matched = getMatchingCredential({
				credentials: stored,
				currentUrl,
				encryptionKey: params.encryptionKey,
			});
			if (!matched) {
				return undefined;
			}
			return decryptStoredAuthUsername(matched, {
				encryptionKey: params.encryptionKey,
			});
		};

	const requestAuthPasswordForDomain: RequestAuthPasswordForDomain = async (
		currentUrl,
	) => {
		const matched = getMatchingCredential({
			credentials: stored,
			currentUrl,
			encryptionKey: params.encryptionKey,
		});
		if (!matched) {
			return undefined;
		}
		return decryptStoredAuthPassword(matched, {
			encryptionKey: params.encryptionKey,
		});
	};

	return {
		requestAuthDomainCandidates,
		requestAuthIdentifierForDomain,
		requestAuthPasswordForDomain,
	};
}

export function createSessionAuthTakeoverState(params: {
	enabled: boolean;
	authProbeLLM?: LLMOptions;
	requestAuthDomainCandidates?: RequestAuthDomainCandidates;
	requestAuthIdentifierForDomain?: RequestAuthIdentifierForDomain;
	requestAuthPasswordForDomain?: RequestAuthPasswordForDomain;
}): SessionAuthTakeoverState | undefined {
	if (
		!params.enabled &&
		!params.requestAuthDomainCandidates &&
		!params.requestAuthIdentifierForDomain &&
		!params.requestAuthPasswordForDomain
	) {
		return undefined;
	}
	return {
		enabled: params.enabled,
		authProbeLLM: params.authProbeLLM,
		requestAuthDomainCandidates: params.requestAuthDomainCandidates,
		requestAuthIdentifierForDomain: params.requestAuthIdentifierForDomain,
		requestAuthPasswordForDomain: params.requestAuthPasswordForDomain,
		protectedRefs: new Set<string>(),
		suppressScreenshots: false,
	};
}

export function decryptStoredAuthDomain(
	credentials: StoredEncryptedAuthCredential,
	options?: AuthKeyOptions,
): string {
	return decryptAuthField(credentials.encryptedDomainUrl, options);
}

export function decryptStoredAuthUsername(
	credentials: StoredEncryptedAuthCredential,
	options?: AuthKeyOptions,
): string {
	return decryptAuthField(credentials.encryptedUsername, options);
}

export function decryptStoredAuthPassword(
	credentials: StoredEncryptedAuthCredential,
	options?: AuthKeyOptions,
): string {
	return decryptAuthField(credentials.encryptedPassword, options);
}

export function authEncryptionKeyEnvName(): string {
	return AUTH_ENCRYPTION_KEY_ENV;
}
