import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

vi.mock("ajv", () => ({
	default: function AjvMock() {
		throw new Error("AJV unavailable in this test");
	},
}));

afterEach(() => {
	vi.restoreAllMocks();
});

function getValidationErrorMessage(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected validation to throw");
}

describe("validateToolArguments", () => {
	it("coerces and validates arguments when AJV is unavailable", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
				label: Type.String(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number, label: "hello" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toStrictEqual({ count: 42, label: "hello" });

		const invalidCall: ToolCall = {
			type: "toolCall",
			id: "tool-2",
			name: "echo",
			arguments: { count: 42 } as unknown as ToolCall["arguments"],
		};
		const errorMessage = getValidationErrorMessage(() => validateToolArguments(tool, invalidCall));
		expect(errorMessage).toMatch(/^Validation failed for tool "echo":/);
		expect(errorMessage).toContain("label");
	});

	it("validates format constraints when AJV is unavailable", () => {
		const tool: Tool = {
			name: "invite",
			description: "Invite user",
			parameters: Type.Object({
				email: Type.String({ format: "email" }),
				attempts: Type.Number(),
			}),
		};
		const validCall: ToolCall = {
			type: "toolCall",
			id: "tool-3",
			name: "invite",
			arguments: { email: "test@example.com", attempts: "3" as unknown as number },
		};

		const result = validateToolArguments(tool, validCall);
		expect(result).toStrictEqual({ email: "test@example.com", attempts: 3 });

		const invalidCall: ToolCall = {
			type: "toolCall",
			id: "tool-4",
			name: "invite",
			arguments: { email: "not-an-email", attempts: 1 },
		};

		const errorMessage = getValidationErrorMessage(() => validateToolArguments(tool, invalidCall));
		expect(errorMessage).toMatch(/^Validation failed for tool "invite":/);
		expect(errorMessage).toContain("email");
		expect(errorMessage).toContain("Received arguments:");
	});

	it("reports strict-schema errors when AJV is unavailable", () => {
		const tool: Tool = {
			name: "strict",
			description: "Strict validation",
			parameters: Type.Object(
				{
					count: Type.Number(),
					label: Type.String(),
				},
				{ additionalProperties: false },
			),
		};
		const invalidCall: ToolCall = {
			type: "toolCall",
			id: "tool-5",
			name: "strict",
			arguments: { count: "oops", extra: true } as unknown as ToolCall["arguments"],
		};

		const errorMessage = getValidationErrorMessage(() => validateToolArguments(tool, invalidCall));
		expect(errorMessage).toMatch(/^Validation failed for tool "strict":/);
		expect(errorMessage).toContain("label");
		expect(errorMessage).toContain("extra");
		expect(errorMessage).toContain("Received arguments:");
	});
});
