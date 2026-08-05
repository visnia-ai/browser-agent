export const USER_TAKEOVER_CATEGORIES = [
	"authentication",
	"otp",
	"verification",
	"payment",
	"other",
] as const;

export type UserTakeoverCategory = (typeof USER_TAKEOVER_CATEGORIES)[number];

const AUTHENTICATION_PATTERN =
	/\b(sign[\s-]?in|login|log[\s-]?in|password|username|email)\b/i;
const OTP_PATTERN =
	/\b(otp|2fa|two[-\s]?factor|one[-\s]?time|authenticator|verification code|security code)\b/i;
const VERIFICATION_PATTERN =
	/\b(verification|verify identity|identity check|confirm your identity|captcha)\b/i;
const PAYMENT_PATTERN =
	/\b(payment|card|credit|debit|cvv|checkout|billing|bank|ssn)\b/i;

export function isUserTakeoverCategory(
	value: unknown,
): value is UserTakeoverCategory {
	return (
		typeof value === "string" &&
		(USER_TAKEOVER_CATEGORIES as readonly string[]).includes(value)
	);
}

export function classifyUserTakeoverCategoryFromReason(
	reason: string,
): UserTakeoverCategory {
	if (OTP_PATTERN.test(reason)) {
		return "otp";
	}
	if (VERIFICATION_PATTERN.test(reason)) {
		return "verification";
	}
	if (PAYMENT_PATTERN.test(reason)) {
		return "payment";
	}
	if (AUTHENTICATION_PATTERN.test(reason)) {
		return "authentication";
	}
	return "other";
}

export function normalizeUserTakeoverCategory(input: {
	category?: unknown;
	reason: string;
}): UserTakeoverCategory {
	if (isUserTakeoverCategory(input.category)) {
		return input.category;
	}
	return classifyUserTakeoverCategoryFromReason(input.reason);
}
