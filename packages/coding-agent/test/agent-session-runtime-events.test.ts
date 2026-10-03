import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("rejects unqualified maintenance before interruption, cleanup, or owner replacement", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		await runtimeHost.session.prompt("saved session");
		const session = runtimeHost.session;
		const entries = session.sessionManager.getEntries();
		const abort = vi.spyOn(session, "abort");
		const request = vi.spyOn(session, "requestMaintenance");
		const beforeReplace = vi.fn();
		const withSession = vi.fn();
		for (const streaming of [false, true, true]) {
			const status = vi.spyOn(session, "isStreaming", "get").mockReturnValue(streaming);
			await expect(
				runtimeHost.switchSession(session.sessionFile!, {
					maintenance: {
						token: {
							maintenanceId: "same-request",
							ownerEpoch: "same-owner",
							sessionId: session.sessionId,
							sessionFile: session.sessionFile,
							branchAnchor: session.sessionManager.getLeafId(),
						},
						beforeReplace,
					},
					withSession,
				}),
			).rejects.toThrow("durable ownership marker");
			status.mockRestore();
		}
		expect(abort).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
		expect(beforeReplace).not.toHaveBeenCalled();
		expect(withSession).not.toHaveBeenCalled();
		expect(runtimeHost.session).toBe(session);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		abort.mockRestore();
		request.mockRestore();
	});

	it("validates marker lineage then seals the drained anchor before no-change release", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const session = runtimeHost.session;
		const sm = session.sessionManager;
		sm.appendCustomEntry("maintenance_begin", {});
		const token = {
			maintenanceId: "anchor-test",
			ownerEpoch: "owner",
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			branchAnchor: sm.getLeafId(),
		};
		let drainedAnchor: string | null;
		const abort = vi.spyOn(session, "abort").mockImplementation(async () => {
			drainedAnchor = sm.appendCustomEntry("maintenance_paused", {});
		});
		const release = vi.fn(() => {
			sm.appendCustomEntry("maintenance_resume", {});
		});
		const beforeReplace = vi.fn(() => {
			expect(sm.getLeafId()).toBe(drainedAnchor);
			expect(drainedAnchor).not.toBe(token.branchAnchor);
			return { replace: false, afterNoReplace: release };
		});
		// Invalid public ownership is tested above; qualify the drain boundary separately.
		await expect(
			(runtimeHost as any).runMaintenance(session.sessionFile!, {
				maintenance: { token, beforeReplace },
			}),
		).resolves.toEqual({ cancelled: false });
		expect(release).toHaveBeenCalledOnce();
		expect(runtimeHost.session).toBe(session);
		abort.mockRestore();
	});

	it("an idle session-only release marker acknowledges historical core cancellation, not a later cancellation", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const session = runtimeHost.session;
		await session.prompt("saved session");
		const sm = session.sessionManager;
		session.requestCancellation("task_cancel", "historical cancellation");
		const cancellation = { version: 1, kind: "cancellation_requested", eventId: "cancel-old" };
		sm.appendCustomEntry("task-outcome/v1", cancellation);
		const token = {
			maintenanceId: "session-only",
			ownerEpoch: "new-owner",
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			branchAnchor: sm.getLeafId(),
		};
		const marker = {
			kind: "maintenance_begin",
			maintenance: { ...token },
			releasedCancellationEventId: "cancel-old",
		};
		token.branchAnchor = sm.appendCustomEntry("task-outcome/v1", marker);
		const beforeReplace = vi.fn(() => ({ replace: false as const }));
		await expect(
			runtimeHost.switchSession(session.sessionFile!, {
				maintenance: { token, beforeReplace },
			}),
		).resolves.toEqual({ cancelled: false });
		expect(beforeReplace).toHaveBeenCalledOnce();
		expect(session.interruption?.kind).toBe("maintenance");
		expect(
			sm.getBranch().find((entry) => entry.type === "custom" && (entry.data as any)?.eventId === "cancel-old"),
		).toMatchObject({ data: cancellation });
		session.requestCancellation("task_cancel", "later cancellation");
		sm.appendCustomEntry("task-outcome/v1", { ...cancellation, eventId: "cancel-new" });
		session.requestMaintenance(token);
		expect(session.interruption).toMatchObject({ kind: "cancel", reason: "later cancellation" });
	});

	it("cancellation while draining supersedes maintenance before cleanup", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const session = runtimeHost.session;
		session.sessionManager.appendCustomEntry("maintenance_begin", {});
		const beforeReplace = vi.fn();
		const abort = vi.spyOn(session, "abort").mockImplementation(async () => {
			session.requestCancellation("task_cancel", "human cancelled");
		});
		await expect(
			(runtimeHost as any).runMaintenance(session.sessionFile!, {
				maintenance: {
					token: {
						maintenanceId: "cancel",
						ownerEpoch: "owner",
						sessionId: session.sessionId,
						branchAnchor: session.sessionManager.getLeafId(),
					},
					beforeReplace,
				},
			}),
		).rejects.toThrow("superseded by cancellation");
		expect(beforeReplace).not.toHaveBeenCalled();
		expect(session.interruption?.kind).toBe("cancel");
		expect(runtimeHost.session).toBe(session);
		abort.mockRestore();
	});

	it("rejects cleanup branch mutation before releasing a no-change lease", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const session = runtimeHost.session;
		const sm = session.sessionManager;
		sm.appendCustomEntry("maintenance_begin", {});
		const release = vi.fn();
		await expect(
			(runtimeHost as any).runMaintenance(session.sessionFile!, {
				maintenance: {
					token: {
						maintenanceId: "mutation",
						ownerEpoch: "owner",
						sessionId: session.sessionId,
						branchAnchor: sm.getLeafId(),
					},
					beforeReplace: () => {
						sm.appendCustomEntry("unexpected", {});
						return { replace: false, afterNoReplace: release };
					},
				},
			}),
		).rejects.toThrow("session branch changed during maintenance cleanup");
		expect(release).not.toHaveBeenCalled();
		expect(runtimeHost.session).toBe(session);
	});

	it("refreshes the same live manager, extension runtime and TUI once, restoring the sealed leaf", async () => {
		const lifecycle = vi.fn();
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_start", lifecycle);
			pi.on("session_shutdown", lifecycle);
		});
		lifecycle.mockClear();
		const old = runtimeHost.session;
		const sm = old.sessionManager;
		const runner = old.extensionRunner;
		const dispose = vi.spyOn(old, "dispose");
		const create = vi.spyOn(runtimeHost as any, "createRuntime");
		const rebuild = vi.fn();
		const host = { isInitialized: true, footer: { invalidate() {} }, rebuildChatFromMessages: rebuild };
		old.subscribe((event) => {
			if (event.type === "session_refreshed") void (InteractiveMode.prototype as any).handleEvent.call(host, event);
		});
		sm.appendMessage(fauxAssistantMessage("saved locally"));
		const token = {
			maintenanceId: "enabled",
			ownerEpoch: "owner",
			sessionId: old.sessionId,
			sessionFile: old.sessionFile,
			branchAnchor: undefined as string | null | undefined,
		};
		sm.appendCustomEntry("task-outcome/v1", { kind: "maintenance_begin", maintenance: { ...token } });
		token.branchAnchor = sm.getLeafId();
		runtimeHost.setRebindSession((session) => session.bindExtensions({}));
		const callback = vi.fn(async (ctx) => {
			expect(sm.getLeafId()).toBe(token.branchAnchor);
			expect(JSON.stringify(old.messages)).toContain("cleaned locally");
			expect(ctx.sessionManager).toBe(sm);
		});
		await expect(
			runtimeHost.switchSession(old.sessionFile!, {
				maintenance: {
					token,
					beforeReplace: () => {
						writeFileSync(
							old.sessionFile!,
							readFileSync(old.sessionFile!, "utf8").replace("saved locally", "cleaned locally"),
						);
						appendFileSync(
							old.sessionFile!,
							`${JSON.stringify({ type: "custom", id: "later", parentId: token.branchAnchor, timestamp: new Date().toISOString(), customType: "later", data: {} })}\n`,
						);
						return { replace: true };
					},
				},
				withSession: callback,
			}),
		).resolves.toEqual({ cancelled: false });
		expect(callback).toHaveBeenCalledOnce();
		expect(runtimeHost.session).toBe(old);
		expect(old.sessionManager).toBe(sm);
		expect(old.extensionRunner).toBe(runner);
		expect(sm.getEntry("later")).toBeDefined();
		expect(rebuild).toHaveBeenCalledOnce();
		expect(lifecycle).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(runtimeHost.session.sessionId).toBe(token.sessionId);
		runtimeHost.session.sessionManager.appendCustomEntry("usable", {});
		expect(runtimeHost.session.sessionManager.getLeafEntry()?.type).toBe("custom");
		expect(
			runtimeHost.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "session-maintenance/v1"),
		).toBe(false);
	});

	it("coalesces repeated concurrent maintenance against the same live owner", async () => {
		const lifecycle = vi.fn();
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_start", lifecycle);
			pi.on("session_shutdown", lifecycle);
		});
		const session = runtimeHost.session;
		const sm = session.sessionManager;
		sm.appendMessage(fauxAssistantMessage("saved"));
		lifecycle.mockClear();
		const token = {
			maintenanceId: "concurrent",
			ownerEpoch: "owner",
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			branchAnchor: undefined as string | null | undefined,
		};
		sm.appendCustomEntry("task-outcome/v1", { kind: "maintenance_begin", maintenance: { ...token } });
		token.branchAnchor = sm.getLeafId();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let beforeCount = 0;
		let afterNoReplaceCount = 0;
		const options = {
			maintenance: {
				token,
				beforeReplace: async () => {
					beforeCount++;
					await held;
					return {
						replace: false as const,
						afterNoReplace: () => {
							afterNoReplaceCount++;
						},
					};
				},
			},
		};
		const first = runtimeHost.switchSession(session.sessionFile!, options);
		while (beforeCount === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		const second = runtimeHost.switchSession(session.sessionFile!, options);
		// async switchSession wraps the shared operation in distinct promises.
		// The callback counts below prove the operation itself is coalesced.
		release();
		await expect(Promise.all([first, second])).resolves.toEqual([{ cancelled: false }, { cancelled: false }]);
		expect(beforeCount).toBe(1);
		expect(afterNoReplaceCount).toBe(1);
		expect(lifecycle).not.toHaveBeenCalled();
	});

	it("restores an explicitly empty cursor on repeated refresh without a host", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const session = runtimeHost.session;
		const sm = session.sessionManager;
		sm.appendMessage(fauxAssistantMessage("physically present"));
		sm.resetLeaf();
		const token = { maintenanceId: "empty", ownerEpoch: "owner", sessionId: session.sessionId, branchAnchor: null };
		for (let i = 0; i < 2; i++) {
			await (runtimeHost as any).runMaintenance(session.sessionFile!, { maintenance: { token } });
			expect(runtimeHost.session).toBe(session);
			expect(sm.getLeafId()).toBeNull();
			expect(session.messages).toEqual([]);
		}
	});

	it.each(["header", "anchor", "read"])(
		"keeps the live runtime authoritative on %s refresh failure",
		async (phase) => {
			const quits = vi.fn();
			const { runtimeHost } = await createRuntimeHost((pi) => {
				pi.on("session_shutdown", (event) => {
					if (event.reason === "quit") quits();
				});
			});
			const old = runtimeHost.session;
			const sm = old.sessionManager;
			sm.appendMessage(fauxAssistantMessage("saved without a provider request"));
			sm.appendCustomEntry("maintenance_begin", {});
			const file = old.sessionFile!;
			const token = {
				maintenanceId: `failure-${phase}`,
				ownerEpoch: "owner",
				sessionId: old.sessionId,
				sessionFile: file,
				branchAnchor: sm.getLeafId(),
				jobId: "job",
				attemptId: "attempt",
				reportPath: "/tmp/report",
			};
			const disposed = vi.spyOn(old, "dispose");
			const original = readFileSync(file, "utf8");
			const reload =
				phase === "read"
					? vi.spyOn(sm, "setSessionFile").mockImplementation(() => {
							throw new Error("injected read failure");
						})
					: undefined;
			await expect(
				(runtimeHost as any).runMaintenance(file, {
					maintenance: {
						token,
						beforeReplace: () => {
							const rows = original
								.trim()
								.split("\n")
								.map((line) => JSON.parse(line));
							if (phase === "header") rows[0].cwd = "/changed";
							writeFileSync(
								file,
								`${rows
									.filter((row) => phase !== "anchor" || row.id !== token.branchAnchor)
									.map((row) => JSON.stringify(row))
									.join("\n")}\n`,
							);
						},
					},
				}),
			).rejects.toThrow();
			expect(disposed).not.toHaveBeenCalled();
			expect(runtimeHost.session).toBe(old);
			expect(old.sessionManager).toBe(sm);
			expect(sm.getLeafId()).toBe(token.branchAnchor);
			expect(quits).not.toHaveBeenCalled();
			reload?.mockRestore();
			writeFileSync(file, original);
			await expect((runtimeHost as any).runMaintenance(file, { maintenance: { token } })).resolves.toEqual({
				cancelled: false,
			});
		},
	);

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
