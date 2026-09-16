import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, MessageAdmissionResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

const admitted = (result: MessageAdmissionResult): boolean => result.status === "admitted";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("AgentSession model-turn admission", () => {
	it("forwards typed context stops through the runner and preserves terminal cancellation precedence", async () => {
		const harness = await createHarness({ extensionFactories: [() => {}] });
		harnesses.push(harness);
		const session = harness.session;
		const ctx = session.extensionRunner!.createContext();
		ctx.abort({ kind: "context", reason: "guard", operationId: "pause-1" });
		expect(session.interruption).toMatchObject({
			kind: "context",
			source: "context",
			reason: "guard",
			operationId: "pause-1",
		});
		await session.waitForIdle();
		ctx.abort();
		expect(session.interruption).toMatchObject({ kind: "cancel", source: "extension" });
		ctx.abort({ kind: "context", reason: "late guard" });
		expect(session.interruption).toMatchObject({ kind: "cancel", source: "extension" });
		await session.waitForIdle();
	});

	it("the real interactive binding and queue restoration retain context intent, but execution Escape wins", async () => {
		const harness = await createHarness({ extensionFactories: [() => {}] });
		harnesses.push(harness);
		const session = harness.session;
		const mode = Object.create(InteractiveMode.prototype);
		Object.defineProperty(mode, "session", { value: session });
		Object.assign(mode, {
			createExtensionUIContext: () => ({}),
			setupAutocompleteProvider: () => {},
			setupExtensionShortcuts: () => {},
			showLoadedResources: () => {},
			showStartupNoticesIfNeeded: () => {},
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay: () => {},
		});
		await mode.bindCurrentSessionExtensions();
		const ctx = session.extensionRunner!.createContext();
		ctx.abort({ kind: "context", reason: "guard at 271925" });
		expect(session.interruption).toMatchObject({ kind: "context", source: "context", reason: "guard at 271925" });
		mode.restoreQueuedMessagesToEditor({ abort: true });
		expect(session.interruption).toMatchObject({ kind: "cancel", source: "escape" });
		ctx.abort({ kind: "context", reason: "late guard" });
		expect(session.interruption).toMatchObject({ kind: "cancel", source: "escape" });
	});

	it("serializes concurrent idle producers and preserves admission order", async () => {
		let releasePreflight!: () => void;
		const preflightReleased = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let inputCalls = 0;
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async () => {
						inputCalls++;
						if (inputCalls === 1) await preflightReleased;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);

		const first = extensionApi!.sendUserMessage("first", {
			admissionKey: "producer:first",
		});
		const second = extensionApi!.sendUserMessage("second", {
			deliverAs: "followUp",
			admissionKey: "producer:second",
		});
		const third = extensionApi!.sendUserMessage("third", {
			deliverAs: "followUp",
			admissionKey: "producer:third",
		});

		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(inputCalls).toBe(1);
		releasePreflight();
		const results = await Promise.all([first, second, third]);

		expect(results.every(admitted)).toBe(true);
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["first", "second", "third"]);
	});

	it("queues steer and follow-up notifications while streaming and drains them once", async () => {
		let releaseTool!: () => void;
		const toolReleased = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "wait",
			description: "wait",
			parameters: Type.Object({}),
			execute: async () => {
				await toolReleased;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("current turn"),
			fauxAssistantMessage("follow-up turn"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const current = harness.session.prompt("start");
		await toolStarted;

		const steer = extensionApi!.sendUserMessage("steer", {
			deliverAs: "steer",
			admissionKey: "stream:steer",
		});
		const followUp = extensionApi!.sendUserMessage("follow-up", {
			deliverAs: "followUp",
			admissionKey: "stream:follow-up",
		});
		expect(admitted(await steer)).toBe(true);
		expect(admitted(await followUp)).toBe(true);
		releaseTool();
		await current;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "steer", "follow-up"]);
	});

	it("deduplicates identical admission keys and rejects conflicting payloads", async () => {
		let releasePreflight!: () => void;
		const preflightReleased = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let firstInput = true;
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async () => {
						if (firstInput) {
							firstInput = false;
							await preflightReleased;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		const first = extensionApi!.sendUserMessage("same payload", { admissionKey: "event:1" });
		const duplicate = extensionApi!.sendUserMessage("same payload", { admissionKey: "event:1" });
		const conflict = await extensionApi!.sendUserMessage("different payload", { admissionKey: "event:1" });
		expect(conflict).toMatchObject({ status: "rejected", reason: "integrity" });
		releasePreflight();
		expect(await duplicate).toEqual(await first);
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["same payload"]);
	});

	it("returns a classified rejection when preflight cannot admit a turn", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);

		const result = await extensionApi!.sendUserMessage("cannot run", { admissionKey: "rejected" });
		expect(result.status).toBe("rejected");
		if (result.status === "rejected") expect(result.reason).toBe("preflight");
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("fences an admission after the owning session is disposed", async () => {
		let releasePreflight!: () => void;
		const preflightReleased = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async () => {
						await preflightReleased;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("never admitted")]);

		const pending = extensionApi!.sendUserMessage("stale", { admissionKey: "stale:event" });
		harness.session.dispose();
		const result = await pending;
		expect(result).toMatchObject({ status: "rejected", reason: "session_replaced" });
		releasePreflight();
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("serializes idle triggerTurn custom messages with normal notifications", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("custom turn"), fauxAssistantMessage("normal turn")]);

		const custom = extensionApi!.sendMessage(
			{ customType: "admission-test", content: "custom", display: true, details: {} },
			{ triggerTurn: true, admissionKey: "custom:turn" },
		);
		const normal = extensionApi!.sendUserMessage("normal", {
			deliverAs: "followUp",
			admissionKey: "normal:turn",
		});
		expect(admitted(await custom)).toBe(true);
		expect(admitted(await normal)).toBe(true);
		await harness.session.waitForIdle();
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "admission-test",
			),
		).toBe(true);
		expect(getUserTexts(harness)).toEqual(["normal"]);
	});

	it("initializes custom runs with the base prompt and preserves it across tool turns", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const ordinaryPromptMarker = "ordinary prompt override";
		const stepTool: AgentTool = {
			name: "step",
			label: "Step",
			description: "Run one test step",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "stepped" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [stepTool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("before_agent_start", (event) => ({
						systemPrompt: `${event.systemPrompt}\n\n${ordinaryPromptMarker}`,
					}));
				},
			],
		});
		harnesses.push(harness);

		const providerSystemPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" });
			},
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("ordinary done");
			},
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" });
			},
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("custom done");
			},
		]);

		await harness.session.prompt("ordinary");
		const basePrompt = harness.session.systemPrompt;
		expect(basePrompt).not.toContain(ordinaryPromptMarker);
		await expect(
			extensionApi!.sendMessage(
				{ customType: "admission-test", content: "custom", display: false, details: {} },
				{ triggerTurn: true, admissionKey: "custom:prompt" },
			),
		).resolves.toMatchObject({ status: "admitted" });
		await harness.session.waitForIdle();

		expect(providerSystemPrompts).toHaveLength(4);
		expect(providerSystemPrompts[0]).toContain(ordinaryPromptMarker);
		expect(providerSystemPrompts[1]).toContain(ordinaryPromptMarker);
		expect(providerSystemPrompts[2]).toBe(basePrompt);
		expect(providerSystemPrompts[3]).toBe(basePrompt);
		expect(harness.session.systemPrompt).toBe(basePrompt);
	});
});
