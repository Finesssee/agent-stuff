import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readOrchestratorModeConfig, type OrchestratorModeConfig, type RoleProfile } from "./orchestrator-mode.ts";
import {
	buildOrchestratorWidgetLines,
	finalizeRun,
	getOrchestratorRunJsonPath,
	getOrchestratorRunMarkdownPath,
	readOrchestratorRuntimeState,
	type OrchestratorRunRecord,
	type OrchestratorRunVerdict,
	upsertActiveRun,
} from "./orchestrator-runtime.ts";

const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";
export const ORCHESTRATOR_MESSAGE_TYPE = "orchestrator-controller";
const ORCHESTRATOR_PLANNER_AGENT = "orchestrator-planner";

const MISSION_CONTROL_LAUNCH_REQUEST_EVENT = "mission-control:launch-request";
const MISSION_CONTROL_LAUNCH_RESPONSE_EVENT = "mission-control:launch-response";

type DelegationContext = "fresh" | "fork";
type MissionLaunchMode = "lightweight" | "full";

type DelegationTask = {
	agent: string;
	task: string;
	model?: string;
};

type DelegationRequest = {
	requestId: string;
	agent: string;
	task: string;
	tasks?: DelegationTask[];
	context: DelegationContext;
	model: string;
	cwd: string;
};

type DelegationParallelResult = {
	agent: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
};

type DelegationResponse = DelegationRequest & {
	messages: unknown[];
	parallelResults?: DelegationParallelResult[];
	isError: boolean;
	errorText?: string;
};

type MissionLaunchRequest = {
	requestId: string;
	source: "orchestrator";
	goal: string;
	cwd: string;
	preferredMode: "auto" | MissionLaunchMode;
	entryMode: "promote" | "fork";
	title: string;
	featureDescription: string;
	expectedBehavior: string;
	verificationSteps: string[];
	missionDoc: string;
	validationContract: string;
	extraDocs: string[];
};

type MissionLaunchResponse = {
	requestId: string;
	ok: boolean;
	missionId?: string;
	mode?: MissionLaunchMode;
	status?: string;
	error?: string;
};

type WorkerRun = {
	agent: string;
	task: string;
	output: string;
	isError: boolean;
	errorText?: string;
};

export type OrchestratorPlan = {
	summary: string;
	workerTasks: string[];
	reviewFocus: string[];
	missionHint: boolean;
	missionMode?: MissionLaunchMode;
	missionReason?: string;
};

export type OrchestratorReview = {
	verdict: "approved" | "revise";
	summary: string;
	blockingFindings: string[];
	repairTasks: string[];
};

export type OrchestratorExecutionDetails = {
	runId: string;
	approved: boolean;
	reviewCycles: number;
	workerCount: number;
	missionHint: boolean;
	verdict: OrchestratorRunVerdict;
	missionId?: string;
	missionMode?: MissionLaunchMode;
};

function formatRoleOverride(profile: RoleProfile): string {
	return `${profile.provider}/${profile.modelId}`;
}

function truncateText(value: string, maxLength = 96): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return trimmed.length > maxLength ? `${trimmed.slice(0, Math.max(0, maxLength - 3))}...` : trimmed;
}

function normalizeMissionMode(value: unknown): MissionLaunchMode | undefined {
	return value === "lightweight" || value === "full" ? value : undefined;
}

export function extractJsonObject(text: string): unknown | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fencedMatch?.[1]) {
		try {
			return JSON.parse(fencedMatch[1]);
		} catch {
			// fall through
		}
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		// fall through
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace === -1 || lastBrace <= firstBrace) return null;
	try {
		return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
	} catch {
		return null;
	}
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean)
		.slice(0, maxItems);
}

export function normalizeOrchestratorPlan(
	value: unknown,
	fallbackTask: string,
	maxWorkers: number,
	fallbackSummary?: string,
): OrchestratorPlan {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const workerTasks = normalizeStringArray(record.workerTasks, maxWorkers);
	return {
		summary: typeof record.summary === "string" && record.summary.trim()
			? record.summary.trim()
			: (fallbackSummary?.trim() || "Planner did not provide a structured summary."),
		workerTasks: workerTasks.length > 0 ? workerTasks : [fallbackTask.trim()],
		reviewFocus: normalizeStringArray(record.reviewFocus, 6),
		missionHint: record.missionHint === true,
		missionMode: normalizeMissionMode(record.missionMode),
		missionReason: typeof record.missionReason === "string" && record.missionReason.trim()
			? record.missionReason.trim()
			: undefined,
	};
}

export function normalizeOrchestratorReview(
	value: unknown,
	fallbackSummary: string,
	maxWorkers: number,
): OrchestratorReview {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const blockingFindings = normalizeStringArray(record.blockingFindings, 8);
	const repairTasks = normalizeStringArray(record.repairTasks, maxWorkers);
	const rawVerdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
	const verdict = rawVerdict === "approved"
		? "approved"
		: rawVerdict === "revise" || blockingFindings.length > 0 || repairTasks.length > 0
			? "revise"
			: "approved";
	return {
		verdict,
		summary: typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : fallbackSummary,
		blockingFindings,
		repairTasks,
	};
}

function extractFinalAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if ((part as { type?: unknown }).type !== "text") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) return text.trim();
		}
	}
	return "";
}

export function shouldAutoRouteOrchestratorTask(
	text: string,
	triggerPolicy: OrchestratorModeConfig["triggerPolicy"],
): boolean {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
	if (triggerPolicy === "always") return true;

	const normalized = trimmed.replace(/\s+/g, " ").trim();
	const lower = normalized.toLowerCase();
	const words = normalized.split(" ").filter(Boolean);
	const wordCount = words.length;
	const lineCount = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).length;
	const directQuestion = /^(what|why|how|when|where|who|which|is|are|can|could|should|do|does|did)\b/i.test(normalized);
	const quickCheck = /^(status|time|date|pwd|ls|help|version|explain|summarize|show)\b/i.test(lower);
	const workSignal =
		/\b(implement|fix|refactor|review|audit|trace|investigate|compare|debug|test|tests|build|lint|setup|configure|install|repo|file|files|extension|mission|route)\b/i
			.test(normalized);
	const multiStepSignal =
		lineCount > 1 ||
		wordCount >= 18 ||
		/\b(and|then|also|plus|along with|across)\b/i.test(normalized) ||
		/[:;]/.test(normalized);

	if (directQuestion && wordCount <= 10 && !workSignal) return false;
	if (quickCheck && wordCount <= 8 && !workSignal) return false;
	if (wordCount <= 4) return false;
	return workSignal || multiStepSignal;
}

function buildPlannerTask(task: string, maxWorkers: number): string {
	return [
		"Decompose the user's request into an execution-ready orchestration plan.",
		`Use between 1 and ${maxWorkers} worker tasks.`,
		"Return ONLY valid JSON with this exact shape:",
		'{"summary":"...","workerTasks":["..."],"reviewFocus":["..."],"missionHint":false,"missionMode":"lightweight|full","missionReason":"optional"}',
		"Rules:",
		"- workerTasks must be disjoint and execution-ready",
		"- reviewFocus should highlight the most important risks for the reviewer",
		"- set missionHint=true only if the task is clearly detached/long-running/mission-shaped",
		"- include missionMode only when missionHint=true and you have a clear preference",
		"",
		"User task:",
		task.trim(),
	].join("\n");
}

function buildWorkerTask(
	userTask: string,
	planSummary: string,
	workItem: string,
	reviewSummary?: string,
	blockingFindings: string[] = [],
): string {
	const lines = [
		`Overall user task: ${userTask.trim()}`,
		`Planner summary: ${planSummary.trim()}`,
		`Assigned work item: ${workItem.trim()}`,
		"Do the work directly. Make changes or produce the concrete artifact needed for this work item.",
	];
	if (reviewSummary?.trim()) lines.push(`Reviewer summary: ${reviewSummary.trim()}`);
	if (blockingFindings.length > 0) {
		lines.push("Blocking findings to address:");
		for (const finding of blockingFindings) lines.push(`- ${finding}`);
	}
	return lines.join("\n");
}

function buildReviewerTask(
	userTask: string,
	plan: OrchestratorPlan,
	workerRuns: WorkerRun[],
	cycle: number,
	maxWorkers: number,
): string {
	const lines = [
		"Review the orchestrated work product.",
		"Return ONLY valid JSON with this exact shape:",
		'{"verdict":"approved"|"revise","summary":"...","blockingFindings":["..."],"repairTasks":["..."]}',
		`Provide at most ${maxWorkers} repairTasks.`,
		"",
		`User task: ${userTask.trim()}`,
		`Planner summary: ${plan.summary}`,
		`Review cycle: ${cycle}`,
	];
	if (plan.reviewFocus.length > 0) {
		lines.push("Review focus:");
		for (const item of plan.reviewFocus) lines.push(`- ${item}`);
	}
	lines.push("", "Worker outputs:");
	for (const run of workerRuns) {
		lines.push(`--- ${run.agent}: ${run.task}`);
		if (run.isError) {
			lines.push(`ERROR: ${run.errorText || "Worker failed without details."}`);
		}
		lines.push(run.output || "(no output)");
	}
	return lines.join("\n");
}

function inferMissionMode(task: string, plan: OrchestratorPlan): MissionLaunchMode {
	if (plan.missionMode) return plan.missionMode;
	if (plan.workerTasks.length >= 3) return "full";
	if (task.trim().split("\n").length > 1) return "full";
	if (task.trim().length > 220) return "full";
	return "lightweight";
}

function buildMissionLaunchRequest(
	ctx: ExtensionContext,
	task: string,
	plan: OrchestratorPlan,
	mode: MissionLaunchMode,
): MissionLaunchRequest {
	const verificationSteps = plan.reviewFocus.length > 0
		? plan.reviewFocus
		: ["Validate the implementation against the original user request."];
	const workerBulletList = plan.workerTasks.map((item) => `- ${item}`).join("\n");
	return {
		requestId: randomUUID(),
		source: "orchestrator",
		goal: task.trim(),
		cwd: ctx.cwd,
		preferredMode: mode,
		entryMode: "promote",
		title: `Orchestrated: ${truncateText(task, 72)}`,
		featureDescription: task.trim(),
		expectedBehavior: plan.summary,
		verificationSteps,
		missionDoc: [
			"# Orchestrator Escalation",
			"",
			"## Task",
			task.trim(),
			"",
			"## Planner Summary",
			plan.summary,
			"",
			"## Worker Breakdown",
			workerBulletList || "- Carry the task end-to-end",
		].join("\n"),
		validationContract: [
			"# Validation Contract",
			"",
			"## Review Focus",
			...(verificationSteps.map((item) => `- ${item}`)),
			"",
			"## Mission Shape",
			`- Requested mode: ${mode}`,
			...(plan.missionReason ? [`- Reason: ${plan.missionReason}`] : []),
		].join("\n"),
		extraDocs: [],
	};
}

function buildCompactResultText(record: OrchestratorRunRecord): string {
	const lines = [
		"# Orchestrator Result",
		"",
		`Verdict: ${record.verdict ?? record.status}`,
		`Run: ${record.runId}`,
		`Summary: ${record.reviewerSummary || record.plannerSummary || record.taskSummary}`,
	];
	if (record.workerCount > 0) {
		lines.push(`Workers: ${record.workerCount}`);
	}
	if (record.reviewCycle > 0) {
		lines.push(`Review cycles: ${record.reviewCycle}/${record.reviewRetryCap}`);
	}
	if (record.blockingFindings.length > 0) {
		lines.push("", "Key reviewer findings:");
		for (const finding of record.blockingFindings.slice(0, 4)) {
			lines.push(`- ${finding}`);
		}
	}
	if (record.status === "escalated") {
		lines.push("", `Mission: ${record.missionId || "(pending response)"}`);
		if (record.missionMode) lines.push(`Mission mode: ${record.missionMode}`);
		if (record.missionReason) lines.push(`Escalation reason: ${record.missionReason}`);
	}
	lines.push("", `Inspect: /orchestrate inspect ${record.runId}`);
	return lines.join("\n");
}

function buildRunMarkdown(record: OrchestratorRunRecord): string {
	const lines = [
		"# Orchestrator Run",
		"",
		`- Run: ${record.runId}`,
		`- Status: ${record.status}`,
		`- Verdict: ${record.verdict ?? record.status}`,
		`- Phase: ${record.phase}`,
		`- Workers: ${record.workerCount}`,
		`- Review cycle: ${record.reviewCycle}/${record.reviewRetryCap}`,
		`- Started: ${new Date(record.startedAt).toISOString()}`,
		`- Updated: ${new Date(record.updatedAt).toISOString()}`,
	];
	if (record.missionId) lines.push(`- Mission: ${record.missionId}`);
	if (record.missionMode) lines.push(`- Mission mode: ${record.missionMode}`);
	if (record.missionReason) lines.push(`- Mission reason: ${record.missionReason}`);
	lines.push("", "## Task", record.task.trim() || "(missing task)");
	lines.push("", "## Task Summary", record.taskSummary || "(missing summary)");
	if (record.plannerSummary) lines.push("", "## Planner Summary", record.plannerSummary);
	if (record.reviewerSummary) lines.push("", "## Reviewer Summary", record.reviewerSummary);
	if (record.blockingFindings.length > 0) {
		lines.push("", "## Blocking Findings");
		for (const finding of record.blockingFindings) lines.push(`- ${finding}`);
	}
	if (record.errorText) lines.push("", "## Error", record.errorText);
	return lines.join("\n");
}

function buildStatusText(state: Awaited<ReturnType<typeof readOrchestratorRuntimeState>>): string {
	const active = state.activeRun;
	const latest = active ?? state.lastRun;
	if (!latest) {
		return [
			"# Orchestrator Status",
			"",
			"State: idle",
			"Last run: none",
		].join("\n");
	}

	const lines = [
		"# Orchestrator Status",
		"",
		`State: ${active ? "running" : "idle"}`,
	];
	if (active) {
		lines.push(`Active run: ${active.runId}`);
		lines.push(`Task: ${active.taskSummary}`);
		lines.push(`Phase: ${active.phase}`);
		if (active.workerCount > 0) lines.push(`Workers: ${active.workerCount}`);
		if (active.reviewCycle > 0) lines.push(`Review cycle: ${active.reviewCycle}/${active.reviewRetryCap}`);
		if (active.missionId) lines.push(`Mission: ${active.missionId}`);
	}
	lines.push(`Last run: ${state.lastRun?.runId ?? latest.runId}`);
	lines.push(`Last verdict: ${state.lastRun?.verdict ?? latest.verdict ?? latest.status}`);
	lines.push(`Inspect: /orchestrate inspect ${state.lastRun?.runId ?? latest.runId}`);
	return lines.join("\n");
}

async function readRunInspectText(target: string): Promise<string> {
	const state = await readOrchestratorRuntimeState();
	const resolvedId = target === "latest"
		? state.activeRun?.runId ?? state.lastRun?.runId
		: target.trim();
	if (!resolvedId) {
		return [
			"# Orchestrator Inspect",
			"",
			"No orchestrator run is available yet.",
		].join("\n");
	}

	try {
		const markdown = await fs.readFile(getOrchestratorRunMarkdownPath(resolvedId), "utf8");
		if (markdown.trim()) return markdown.trim();
	} catch {
		// fall through
	}

	try {
		const raw = await fs.readFile(getOrchestratorRunJsonPath(resolvedId), "utf8");
		const record = JSON.parse(raw) as OrchestratorRunRecord;
		return buildRunMarkdown(record);
	} catch {
		return [
			"# Orchestrator Inspect",
			"",
			`Run not found: ${resolvedId}`,
		].join("\n");
	}
}

async function requestDelegation(
	pi: ExtensionAPI,
	request: DelegationRequest,
	signal: AbortSignal,
	onStatus?: (status: string) => void,
): Promise<DelegationResponse> {
	return await new Promise((resolve, reject) => {
		let done = false;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error("Delegated subagent run did not start within 15s.")));
		}, 15_000);

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubStarted();
			unsubResponse();
			unsubUpdate();
			signal.removeEventListener("abort", handleAbort);
			next();
		};

		const handleAbort = () => {
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: request.requestId });
			finish(() => reject(new Error("Cancelled")));
		};

		const unsubStarted = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== request.requestId) return;
			clearTimeout(startTimeout);
			onStatus?.("running");
		});

		const unsubResponse = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const response = data as Partial<DelegationResponse>;
			if (response.requestId !== request.requestId) return;
			finish(() => resolve(response as DelegationResponse));
		});

		const unsubUpdate = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== request.requestId) return;
			const tool = (data as { currentTool?: unknown }).currentTool;
			if (typeof tool === "string" && tool.trim()) onStatus?.(`tool:${tool}`);
		});

		signal.addEventListener("abort", handleAbort, { once: true });
		if (signal.aborted) {
			handleAbort();
			return;
		}

		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request);
	});
}

async function requestMissionLaunch(
	pi: ExtensionAPI,
	request: MissionLaunchRequest,
	signal: AbortSignal,
): Promise<MissionLaunchResponse> {
	return await new Promise((resolve, reject) => {
		let done = false;
		const timeout = setTimeout(() => {
			finish(() => reject(new Error("Mission Control did not respond within 20s.")));
		}, 20_000);

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			unsubResponse();
			signal.removeEventListener("abort", handleAbort);
			next();
		};

		const handleAbort = () => {
			finish(() => reject(new Error("Cancelled")));
		};

		const unsubResponse = pi.events.on(MISSION_CONTROL_LAUNCH_RESPONSE_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const response = data as Partial<MissionLaunchResponse>;
			if (response.requestId !== request.requestId) return;
			finish(() => resolve(response as MissionLaunchResponse));
		});

		signal.addEventListener("abort", handleAbort, { once: true });
		if (signal.aborted) {
			handleAbort();
			return;
		}

		pi.events.emit(MISSION_CONTROL_LAUNCH_REQUEST_EVENT, request);
	});
}

function renderOrchestratorMessage(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
	if (!ctx.hasUI) {
		process.stdout.write(`${text.trim()}\n`);
		return;
	}
	pi.sendMessage({
		customType: ORCHESTRATOR_MESSAGE_TYPE,
		content: text,
		display: true,
	});
}

function setOrchestratorWidget(ctx: ExtensionContext, record?: OrchestratorRunRecord): void {
	if (!ctx.hasUI) return;
	if (!record) {
		ctx.ui.setWidget("orchestrator", undefined);
		return;
	}

	const lines = buildOrchestratorWidgetLines(record);
	ctx.ui.setWidget("orchestrator", lines.map((line, index) => {
		return index === 0 ? ctx.ui.theme.fg("accent", line) : ctx.ui.theme.fg("dim", line);
	}));
}

function buildExecutionResult(record: OrchestratorRunRecord): { text: string; details: OrchestratorExecutionDetails } {
	return {
		text: buildCompactResultText(record),
		details: {
			runId: record.runId,
			approved: record.verdict === "approved",
			reviewCycles: record.reviewCycle,
			workerCount: record.workerCount,
			missionHint: record.missionHint,
			verdict: record.verdict ?? (record.status === "failed" ? "failed" : "revise"),
			missionId: record.missionId,
			missionMode: record.missionMode,
		},
	};
}

async function runOrchestrator(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	contextMode: DelegationContext,
	signal: AbortSignal,
	onPhase?: (phase: string, record: OrchestratorRunRecord) => void | Promise<void>,
): Promise<{
	text: string;
	details: OrchestratorExecutionDetails;
}> {
	const config = await readOrchestratorModeConfig();
	const cwd = ctx.cwd;
	const runId = `orch_${Date.now()}_${randomUUID().slice(0, 8)}`;
	let activeRecord: OrchestratorRunRecord = {
		version: 1,
		runId,
		task: task.trim(),
		taskSummary: truncateText(task, 96) || "Untitled orchestrator task",
		blockingFindings: [],
		phase: "starting",
		status: "running",
		workerCount: 0,
		reviewCycle: 0,
		reviewRetryCap: config.reviewRetryCap,
		missionHint: false,
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};

	const pushState = async (phase: string, patch: Partial<OrchestratorRunRecord> = {}) => {
		activeRecord = {
			...activeRecord,
			...patch,
			phase,
			updatedAt: Date.now(),
		};
		await upsertActiveRun(activeRecord);
		setOrchestratorWidget(ctx, activeRecord);
		await onPhase?.(phase, activeRecord);
	};

	try {
		await pushState("planning");
		const plannerResponse = await requestDelegation(
			pi,
			{
				requestId: randomUUID(),
				agent: ORCHESTRATOR_PLANNER_AGENT,
				task: buildPlannerTask(task, config.maxWorkers),
				context: contextMode,
				model: formatRoleOverride(config.roles.planner),
				cwd,
			},
			signal,
		);
		if (plannerResponse.isError) {
			throw new Error(plannerResponse.errorText || "Planner leg failed.");
		}

		const plannerText = extractFinalAssistantText(plannerResponse.messages);
		const plan = normalizeOrchestratorPlan(
			extractJsonObject(plannerText),
			task,
			config.maxWorkers,
			plannerText,
		);
		const missionMode = inferMissionMode(task, plan);
		await pushState("planned", {
			taskSummary: truncateText(plan.summary, 96) || activeRecord.taskSummary,
			plannerSummary: plan.summary,
			missionHint: plan.missionHint,
			missionMode,
			missionReason: plan.missionReason,
		});

		const shouldEscalate =
			config.missionBoundary === "mission-first" || (config.missionBoundary === "inline-first" && plan.missionHint);
		if (shouldEscalate) {
			await pushState("mission-escalation", {
				missionHint: true,
				missionMode,
				missionReason: plan.missionReason,
			});
			const response = await requestMissionLaunch(pi, buildMissionLaunchRequest(ctx, task, plan, missionMode), signal);
			if (!response.ok || !response.missionId) {
				throw new Error(response.error || "Mission Control rejected orchestrator escalation.");
			}

			activeRecord = {
				...activeRecord,
				status: "escalated",
				verdict: "escalated",
				missionId: response.missionId,
				missionMode: response.mode ?? missionMode,
				updatedAt: Date.now(),
			};
			await finalizeRun(activeRecord, buildRunMarkdown(activeRecord));
			setOrchestratorWidget(ctx, undefined);
			return buildExecutionResult(activeRecord);
		}

		let workerTasks = plan.workerTasks;
		let latestRuns: WorkerRun[] = [];
		let latestReview = normalizeOrchestratorReview(undefined, "Reviewer did not run.", config.maxWorkers);
		let cycle = 0;

		while (cycle < config.reviewRetryCap) {
			cycle += 1;
			const activeWorkerTasks = workerTasks.slice(0, config.maxWorkers);
			await pushState("workers", {
				reviewCycle: cycle,
				workerCount: activeWorkerTasks.length,
			});

			const workerRequestTasks = activeWorkerTasks.map((workItem) => ({
				agent: "worker",
				task: buildWorkerTask(task, plan.summary, workItem, latestReview.summary, latestReview.blockingFindings),
				model: formatRoleOverride(config.roles.worker),
			}));

			const workerResponse = await requestDelegation(
				pi,
				{
					requestId: randomUUID(),
					agent: workerRequestTasks[0]!.agent,
					task: workerRequestTasks[0]!.task,
					tasks: workerRequestTasks,
					context: contextMode,
					model: formatRoleOverride(config.roles.worker),
					cwd,
				},
				signal,
			);

			latestRuns = (workerResponse.parallelResults ?? []).map((result, index) => ({
				agent: result.agent || workerRequestTasks[index]!.agent,
				task: activeWorkerTasks[index]!,
				output: extractFinalAssistantText(result.messages) || result.errorText || "",
				isError: result.isError,
				errorText: result.errorText,
			}));
			if (latestRuns.length === 0) {
				latestRuns = [{
					agent: "worker",
					task: activeWorkerTasks[0]!,
					output: extractFinalAssistantText(workerResponse.messages) || workerResponse.errorText || "",
					isError: workerResponse.isError,
					errorText: workerResponse.errorText,
				}];
			}

			await pushState("review", {
				workerCount: latestRuns.length,
				reviewCycle: cycle,
			});

			const reviewerResponse = await requestDelegation(
				pi,
				{
					requestId: randomUUID(),
					agent: "reviewer",
					task: buildReviewerTask(task, plan, latestRuns, cycle, config.maxWorkers),
					context: contextMode,
					model: formatRoleOverride(config.roles.reviewer),
					cwd,
				},
				signal,
			);
			if (reviewerResponse.isError) {
				throw new Error(reviewerResponse.errorText || "Reviewer leg failed.");
			}

			const reviewerText = extractFinalAssistantText(reviewerResponse.messages);
			latestReview = normalizeOrchestratorReview(
				extractJsonObject(reviewerText),
				reviewerText || "Reviewer returned no structured verdict.",
				config.maxWorkers,
			);
			await pushState("review-complete", {
				reviewerSummary: latestReview.summary,
				blockingFindings: latestReview.blockingFindings,
				reviewCycle: cycle,
				workerCount: latestRuns.length,
			});

			if (latestReview.verdict === "approved") break;
			if (cycle >= config.reviewRetryCap) break;

			workerTasks = latestReview.repairTasks.length > 0
				? latestReview.repairTasks
				: [
					"Address the blocking reviewer findings across the current implementation and return the corrected result.",
				];
			await pushState("repair-loop", {
				blockingFindings: latestReview.blockingFindings,
				reviewerSummary: latestReview.summary,
			});
		}

		activeRecord = {
			...activeRecord,
			status: "completed",
			verdict: latestReview.verdict,
			reviewerSummary: latestReview.summary,
			blockingFindings: latestReview.blockingFindings,
			reviewCycle: cycle,
			workerCount: latestRuns.length,
			phase: "completed",
			updatedAt: Date.now(),
		};
		await finalizeRun(activeRecord, buildRunMarkdown(activeRecord));
		setOrchestratorWidget(ctx, undefined);
		return buildExecutionResult(activeRecord);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		activeRecord = {
			...activeRecord,
			status: "failed",
			verdict: "failed",
			phase: "failed",
			errorText: message,
			updatedAt: Date.now(),
		};
		await finalizeRun(activeRecord, buildRunMarkdown(activeRecord));
		setOrchestratorWidget(ctx, undefined);
		throw error;
	}
}

export async function runInteractiveOrchestratorTask(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	options: {
		contextMode?: DelegationContext;
		timeoutMs?: number;
		clearEditor?: boolean;
	} = {},
): Promise<{ text: string; details: OrchestratorExecutionDetails }> {
	const trimmed = task.trim();
	if (!trimmed) throw new Error("Task is required.");
	if (!ctx.hasUI) throw new Error("Orchestrate currently requires an interactive Pi session.");

	if (options.clearEditor) {
		ctx.ui.setEditorText("");
	}

	ctx.ui.notify("Running orchestrator...", "info");
	const result = await runOrchestrator(
		pi,
		ctx,
		trimmed,
		options.contextMode ?? "fork",
		AbortSignal.timeout(options.timeoutMs ?? (10 * 60 * 1000)),
	);
	renderOrchestratorMessage(pi, ctx, result.text);
	ctx.ui.notify(
		result.details.verdict === "approved"
			? "Orchestrator run approved by reviewer."
			: result.details.verdict === "escalated"
				? "Orchestrator escalated the task into Mission Control."
				: "Orchestrator stopped with reviewer findings.",
		result.details.verdict === "approved" ? "info" : "warning",
	);
	return result;
}

function writeCommandOutput(ctx: ExtensionContext, pi: ExtensionAPI, text: string): void {
	renderOrchestratorMessage(pi, ctx, text);
}

export default function registerOrchestratorController(pi: ExtensionAPI): void {
	const schema = Type.Object({
		task: Type.String({ description: "The non-trivial task to orchestrate through planner, workers, and reviewer." }),
		context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
			description: "Delegation context for spawned subagents. Defaults to fork.",
		})),
	});

	pi.registerMessageRenderer(ORCHESTRATOR_MESSAGE_TYPE, (message, _options, theme) => {
		const title = theme.fg("accent", theme.bold("Orchestrator"));
		const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		return new Text(`${title}\n\n${body}`, 0, 0);
	});

	pi.registerTool({
		name: "orchestrate",
		label: "Orchestrate",
		description:
			"Run the explicit orchestrator controller for non-trivial work. Uses planner, adaptive worker fanout, mandatory reviewer, and bounded repair loops based on the current Orchestrator mode profile.",
		parameters: schema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task.trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "Task is required." }],
					isError: true,
					details: { approved: false },
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Orchestrate currently requires an interactive Pi session." }],
					isError: true,
					details: { approved: false },
				};
			}

			const result = await runOrchestrator(
				pi,
				ctx,
				task,
				params.context ?? "fork",
				signal,
				(phase, record) => {
					onUpdate?.({
						content: [{ type: "text", text: `Orchestrator phase: ${phase}` }],
						details: {
							phase,
							runId: record.runId,
							workerCount: record.workerCount,
							reviewCycle: record.reviewCycle,
						},
					} as never);
				},
			);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerCommand("orchestrate", {
		description: "Run the explicit planner -> workers -> reviewer controller for a task",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				const usage = "Usage: /orchestrate <task> | /orchestrate status | /orchestrate inspect <latest|id>";
				if (ctx.hasUI) {
					ctx.ui.notify(usage, "error");
				} else {
					process.stdout.write(`${usage}\n`);
				}
				return;
			}

			const [subcommand, ...rest] = trimmed.split(/\s+/);
			if (subcommand === "status") {
				writeCommandOutput(ctx, pi, buildStatusText(await readOrchestratorRuntimeState()));
				return;
			}

			if (subcommand === "inspect") {
				writeCommandOutput(ctx, pi, await readRunInspectText(rest.join(" ").trim() || "latest"));
				return;
			}

			if (!ctx.hasUI) {
				process.stdout.write("Orchestrate currently requires an interactive Pi session.\n");
				return;
			}

			try {
				await runInteractiveOrchestratorTask(pi, ctx, trimmed, {
					contextMode: "fork",
					timeoutMs: 10 * 60 * 1000,
					clearEditor: false,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});
}
