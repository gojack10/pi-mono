import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
	it.each([false, true])(
		"initializes custom-run instructions and preserves them through completion (warmup=%s)",
		async (warmup) => {
			let enabled = true;
			const prompts: string[] = [];
			const hookPrompts: string[] = [];
			const contexts: Context[] = [];
			let extensionApi: ExtensionAPI | undefined;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						extensionApi = pi;
						pi.on("before_agent_start", (event) => {
							hookPrompts.push(event.prompt);
							if (event.prompt === "start goal") {
								expect(event.images).toEqual(
									warmup ? [{ type: "image", data: "test", mimeType: "image/png" }] : undefined,
								);
							}
							if (!enabled) return;
							return {
								systemPrompt: `${event.systemPrompt}\nPONYTAIL TEST INSTRUCTIONS`,
								message: { customType: "run-context", content: "injected once", display: false },
							};
						});
						pi.registerTool({
							name: "finish_goal",
							label: "finish_goal",
							description: "Complete the goal and queue its completion event",
							parameters: Type.Object({}),
							async execute() {
								await pi.sendMessage({ customType: "goal-event", content: "goal complete", display: true });
								return { content: [{ type: "text", text: "complete" }], details: {} };
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const base = harness.session.systemPrompt;
			const capture = (context: Context) => {
				prompts.push(context.systemPrompt ?? "");
				contexts.push({ ...context, messages: structuredClone(context.messages), tools: context.tools?.slice() });
				return fauxAssistantMessage("done");
			};
			if (warmup) {
				harness.setResponses([capture]);
				await harness.session.prompt("ordinary warmup");
			}
			harness.setResponses([
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("finish_goal", {}), { stopReason: "toolUse" });
				},
				capture,
			]);
			await harness.session.sendCustomMessage(
				{
					customType: "goal-event",
					content: warmup
						? [
								{ type: "text", text: "start goal" },
								{ type: "image", data: "test", mimeType: "image/png" },
							]
						: "start goal",
					display: true,
				},
				{ triggerTurn: true },
			);
			expect(hookPrompts).toEqual(warmup ? ["ordinary warmup", "start goal"] : ["start goal"]);
			expect(prompts).toEqual(Array(warmup ? 3 : 2).fill(`${base}\nPONYTAIL TEST INSTRUCTIONS`));
			const last = contexts.at(-1)!;
			expect(last.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "goal complete" }],
			});
			expect(last.tools).toEqual(contexts.at(-2)!.tools);
			expect(
				harness.session.messages.filter((m) => m.role === "custom" && m.customType === "run-context"),
			).toHaveLength(warmup ? 2 : 1);

			// Reinitialize from extension state, rather than carrying or duplicating a stale override.
			enabled = false;
			harness.setResponses([capture]);
			await extensionApi!.sendMessage(
				{ customType: "goal-event", content: "another goal", display: true },
				{ triggerTurn: true },
			);
			await harness.session.waitForIdle();
			expect(prompts.at(-1)).toBe(base);
			harness.setResponses([capture]);
			enabled = true;
			await harness.session.prompt("ordinary after goal");
			expect(prompts.at(-1)).toBe(`${base}\nPONYTAIL TEST INSTRUCTIONS`);
		},
	);

	it("rechecks custom admission after asynchronous before_agent_start hooks", async () => {
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let valid = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						entered();
						await blocked;
						return { systemPrompt: `${event.systemPrompt}\nstale instructions` };
					});
				},
			],
		});
		harnesses.push(harness);
		const base = harness.session.systemPrompt;
		const pending = harness.session.sendCustomMessage(
			{ customType: "test", content: "custom", display: false },
			{ triggerTurn: true, admissionGuard: () => valid },
		);
		const rejected = expect(pending).rejects.toThrow("notification became final");
		await started;
		valid = false;
		release();
		await rejected;
		expect(harness.session.messages).toEqual([]);
		expect(harness.session.systemPrompt).toBe(base);
		expect(harness.session.isIdle).toBe(true);
	});

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
});
