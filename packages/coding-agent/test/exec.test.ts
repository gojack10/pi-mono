import { describe, expect, it } from "vitest";
import { normalizeErrorRecord } from "../src/core/error-record.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { type CheckedExecResult, type ExecResult, execChecked, execCommand } from "../src/core/exec.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { Failure, Success } from "../src/core/result.ts";

describe("checked execution and error records", () => {
	const isolatedScript = (script: string) => [
		"-e",
		`for (const key of Object.keys(process.env)) delete process.env[key]; ${script}`,
	];

	it("classifies signal termination without changing raw execution", async () => {
		const args = isolatedScript("process.kill(process.pid, 'SIGTERM')");
		const checked = await execChecked(process.execPath, args, process.cwd());
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.error).toMatchObject({ code: 0, killed: false, signal: "SIGTERM" });

		const raw = await execCommand(process.execPath, args, process.cwd());
		expect(raw).toEqual({ stdout: "", stderr: "", code: 0, killed: false });

		let extensionChecked: CheckedExecResult | undefined;
		let extensionRaw: ExecResult | undefined;
		const runtime = createExtensionRuntime();
		runtime.recordError = () => {
			throw new Error("execChecked must not record errors");
		};
		await loadExtensionFromFactory(
			async (pi) => {
				extensionChecked = await pi.execChecked(process.execPath, args);
				extensionRaw = await pi.exec(process.execPath, args);
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		expect(extensionChecked).toMatchObject({ ok: false, error: { code: 0, killed: false, signal: "SIGTERM" } });
		expect(extensionRaw).toEqual({ stdout: "", stderr: "", code: 0, killed: false });
	});

	it("keeps ordinary success, nonzero exits, cancellation, and sanitization compatible", async () => {
		expect(Success(42)).toEqual({ ok: true, value: 42 });
		expect(Failure("nope")).toEqual({ ok: false, error: "nope" });

		const success = await execChecked(process.execPath, isolatedScript("process.stdout.write('ok')"), process.cwd());
		expect(success).toEqual({ ok: true, value: { stdout: "ok", stderr: "", code: 0, killed: false } });

		const result = await execChecked(
			process.execPath,
			[
				...isolatedScript("process.stderr.write('token=secret pane unavailable'); process.exit(23)"),
				"credential-that-must-not-leak",
			],
			process.cwd(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe(23);
		expect(result.error.command).toBe("node");
		expect(result.error.signal).toBeUndefined();
		expect(result.error.diagnostic).toBe("token=[redacted] pane unavailable");
		expect(JSON.stringify(result.error)).not.toContain("credential-that-must-not-leak");
		expect(await execCommand(process.execPath, isolatedScript("process.exit(23)"), process.cwd())).toEqual({
			stdout: "",
			stderr: "",
			code: 23,
			killed: false,
		});

		const controller = new AbortController();
		const aborting = execCommand(process.execPath, isolatedScript("setTimeout(() => {}, 10000)"), process.cwd(), {
			signal: controller.signal,
		});
		controller.abort();
		expect(await aborting).toEqual({ stdout: "", stderr: "", code: 0, killed: true });

		const timedOut = await execCommand(
			process.execPath,
			isolatedScript("setTimeout(() => {}, 10000)"),
			process.cwd(),
			{ timeout: 10 },
		);
		expect(timedOut).toEqual({ stdout: "", stderr: "", code: 0, killed: true });
	});

	it("normalizes only bounded string error records", () => {
		const record = normalizeErrorRecord({
			version: 1,
			source: "subagent",
			operation: "outcome_publication",
			message: "pane\nunavailable",
			correlation: { job_id: "job-1", attempt_id: "attempt-1" },
		});
		expect(record.message).toBe("pane unavailable");
		expect(normalizeErrorRecord({ ...record, message: "token=secret pane unavailable" }).message).toBe(
			"token=[redacted] pane unavailable",
		);
		expect(() =>
			normalizeErrorRecord({
				version: 1,
				source: "subagent",
				operation: "outcome_publication",
				message: "bad",
				correlation: { job_id: "job-1", nested: { secret: "no" } as never },
			}),
		).toThrow();
	});
});
