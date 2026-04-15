import type { TSchema } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ErrorObject } from "ajv";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { fullFormats } from "ajv-formats/dist/formats.js";

// Handle both default and named exports
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types.js";

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

function canUseRuntimeCodegen(): boolean {
	if (isBrowserExtension) {
		return false;
	}

	try {
		new Function("return true;");
		return true;
	} catch {
		return false;
	}
}

function createTypeBoxFormatValidator(format: unknown): ((value: string) => boolean) | null {
	if (format === true) {
		return () => true;
	}

	if (format instanceof RegExp) {
		return (value: string) => format.test(value);
	}

	if (typeof format === "function") {
		const validate = format as (value: unknown) => unknown;
		return (value: string) => Boolean(validate(value));
	}

	if (format && typeof format === "object" && "validate" in format) {
		const validate = (format as { validate: unknown }).validate;
		if (validate instanceof RegExp) {
			return (value: string) => validate.test(value);
		}
		if (typeof validate === "function") {
			const validateFn = validate as (value: unknown) => unknown;
			return (value: string) => {
				const result = validateFn(value);
				return typeof result === "boolean" ? result : false;
			};
		}
	}

	return null;
}

let typeBoxFormatsRegistered = false;

function ensureTypeBoxFormats(): void {
	if (typeBoxFormatsRegistered) {
		return;
	}

	for (const [formatName, formatDefinition] of Object.entries(fullFormats)) {
		const validator = createTypeBoxFormatValidator(formatDefinition);
		if (validator) {
			FormatRegistry.Set(formatName, validator);
		}
	}

	typeBoxFormatsRegistered = true;
}

// Create a singleton AJV instance with formats only when runtime code generation is available.
let ajv: any = null;
if (canUseRuntimeCodegen()) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
			coerceTypes: true,
		});
		addFormats(ajv);
	} catch (_e) {
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const args = structuredClone(toolCall.arguments);
	if (ajv) {
		return validateWithAjv(tool, toolCall, args);
	}
	return validateWithTypeBox(tool, toolCall, args);
}

function validateWithAjv(tool: Tool, toolCall: ToolCall, args: Record<string, unknown>): any {
	const validate = ajv.compile(tool.parameters);

	if (validate(args)) {
		return args;
	}

	const errors = formatAjvErrors(validate.errors);
	throw new Error(formatErrorMessage(toolCall, errors));
}

function validateWithTypeBox(tool: Tool, toolCall: ToolCall, args: Record<string, unknown>): any {
	ensureTypeBoxFormats();

	const coerced = Value.Convert(tool.parameters, args);
	if (Value.Check(tool.parameters, coerced)) {
		return coerced;
	}

	const errors = formatTypeBoxErrors(tool.parameters, coerced);
	throw new Error(formatErrorMessage(toolCall, errors));
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
	if (!errors || errors.length === 0) {
		return "Unknown validation error";
	}

	return errors
		.map((error) => {
			const path = getAjvErrorPath(error);
			return `  - ${path}: ${error.message ?? "Unknown validation error"}`;
		})
		.join("\n");
}

function getAjvErrorPath(error: ErrorObject): string {
	if (error.instancePath) {
		return error.instancePath.substring(1);
	}

	const params = error.params as { missingProperty?: string };
	if (params.missingProperty) {
		return params.missingProperty;
	}

	return "root";
}

function formatTypeBoxErrors(schema: TSchema, value: unknown): string {
	const allErrors = Array.from(Value.Errors(schema, value));
	if (allErrors.length === 0) {
		return "Unknown validation error";
	}

	const lines: string[] = [];
	const seen = new Set<string>();

	for (const error of allErrors) {
		const path = formatJsonPointer(error.path);
		const message = error.message ?? "Unknown validation error";
		const line = `  - ${path}: ${message}`;
		if (seen.has(line)) {
			continue;
		}
		seen.add(line);
		lines.push(line);
	}

	return lines.length > 0 ? lines.join("\n") : "Unknown validation error";
}

function formatJsonPointer(path: string): string {
	if (!path || path === "/") {
		return "root";
	}

	return path.startsWith("/") ? path.substring(1) : path;
}

function formatErrorMessage(toolCall: ToolCall, errors: string): string {
	return `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;
}
