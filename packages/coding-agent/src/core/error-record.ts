/** Bounded, storage-safe error records for cross-process observation. */

export const ERROR_RECORD_ENTRY = "pi-error/v1";

export interface ErrorRecord {
	version: 1;
	source: string;
	operation: string;
	message: string;
	correlation: Readonly<Record<string, string>>;
}

const MAX_LABEL = 128;
const MAX_MESSAGE = 2048;
const MAX_CORRELATION_ENTRIES = 16;
const MAX_CORRELATION_VALUE = 256;
const SAFE_LABEL = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CORRELATION_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;

const redactSensitiveText = (value: string): string =>
	value.replace(
		/\b(api[_-]?key|token|password|secret|authorization)\b(\s*[:=]\s*)(?:bearer\s+)?\S+/gi,
		"$1$2[redacted]",
	);

const text = (value: unknown, name: string, max: number): string => {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > max ||
		/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
	) {
		throw new Error(`${name} must be a nonempty control-free string of at most ${max} characters`);
	}
	return value.replace(/[\r\n\t]+/g, " ").trim();
};

/** Validate and copy a record before Pi persists it. Raw Error objects are not accepted. */
export function normalizeErrorRecord(record: ErrorRecord): ErrorRecord {
	if (!record || typeof record !== "object" || record.version !== 1) {
		throw new Error("error record version must be 1");
	}
	const source = text(record.source, "error record source", MAX_LABEL);
	const operation = text(record.operation, "error record operation", MAX_LABEL);
	if (!SAFE_LABEL.test(source) || !SAFE_LABEL.test(operation)) {
		throw new Error("error record source and operation must be safe labels");
	}
	const message = redactSensitiveText(text(record.message, "error record message", MAX_MESSAGE));
	if (!record.correlation || typeof record.correlation !== "object" || Array.isArray(record.correlation)) {
		throw new Error("error record correlation must be an object");
	}
	const correlation: Record<string, string> = {};
	for (const [key, value] of Object.entries(record.correlation)) {
		if (Object.keys(correlation).length >= MAX_CORRELATION_ENTRIES) {
			throw new Error(`error record correlation has more than ${MAX_CORRELATION_ENTRIES} entries`);
		}
		if (!SAFE_CORRELATION_KEY.test(key)) throw new Error("error record correlation key is invalid");
		correlation[key] = text(value, `error record correlation ${key}`, MAX_CORRELATION_VALUE);
	}
	return { version: 1, source, operation, message, correlation };
}
