import { parse as partialParse } from "partial-json";

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	return parseStreamingJsonWithIndicator(partialJson)[0];
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails + a non empty string of an error if parsing failed due to invalid JSON.
 */
export function parseStreamingJsonWithIndicator<T = any>(partialJson: string | undefined): [T, string | undefined] {
	if (!partialJson || partialJson.trim() === "") {
		return [{} as T, undefined];
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return [JSON.parse(partialJson) as T, undefined];
	} catch (err) {
		const parseError = `${err}` || "invalid json";
		// Try partial-json for incomplete JSON
		try {
			const result = partialParse(partialJson);
			return [(result ?? {}) as T, parseError];
		} catch {
			// If all parsing fails, return empty object
			return [{} as T, parseError];
		}
	}
}
