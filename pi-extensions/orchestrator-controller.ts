import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { readOrchestratorModeConfig, type OrchestratorModeConfig, type RoleProfile } from "./orchestrator-mode.ts";

const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";

type DelegationContext = "fresh" | "fork";

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
};

export type OrchestratorReview = {
	verdict: "approved" | "revise";
	summary: string;
	blockingFindings: string[];
	repairTasks: string[];
};

function formatRoleOverride(profile: RoleProfile): string {
	return `${profile.provider}/${profile.modelId}`;
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

function buildPlannerTask(task: string, maxWorkers: number): string {
	return [
		"Decompose the user's request into an execution-ready orchestration plan.",
		`Use between 1 and ${maxWorkers} worker tasks.`,
		"Return ONLY valid JSON with this exact shape:",
		'{"summary":"...","workerTasks":["..."],"reviewFocus":["..."],"missionHint":false}',
		"Rules:",
		"- workerTasks must be disjoint and execution-ready",
		"- reviewFocus should highlight the most important risks for the reviewer",
		"- set missionHint=true only if the task is clearly detached/long-running/mission-shaped",
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

function formatFinalResult(
	userTask: string,
	plan: OrchestratorPlan,
	workerRuns: WorkerRun[],
	review: OrchestratorReview,
	reviewCycles: number,
	config: OrchestratorModeConfig,
): string {
	const lines = [
		"# Orchestrator Result",
		"",
		`Verdict: ${review.verdict}`,
		`Review cycles: ${reviewCycles}/${config.reviewRetryCap}`,
		`Worker fanout used: ${workerRuns.length}/${config.maxWorkers}`,
		"",
		"## Task",
		userTask.trim(),
		"",
		"## Planner Summary",
		plan.summary,
		"",
		"## Reviewer Summary",
		review.summary,
	];
	if (review.blockingFindings.length > 0) {
		lines.push("", "## Blocking Findings");
		for (const finding of review.blockingFindings) lines.push(`- ${finding}`);
	}
	lines.push("", "## Worker Outputs");
	for (const run of workerRuns) {
		lines.push(`### ${run.agent}: ${run.task}`);
		if (run.isError) lines.push(`Worker error: ${run.errorText || "Unknown error"}`);
		lines.push(run.output || "(no output)", "");
	}
	return lines.join("\n");
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

async function runOrchestrator(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	contextMode: DelegationContext,
	signal: AbortSignal,
	onPhase?: (phase: string) => void,
): Promise<{
	text: string;
	details: {
		approved: boolean;
		reviewCycles: number;
		workerCount: number;
		missionHint: boolean;
		verdict: OrchestratorReview["verdict"];
	};
}> {
	const config = await readOrchestratorModeConfig();
	const cwd = ctx.cwd;

	onPhase?.("planner");
	const plannerResponse = await requestDelegation(
		pi,
		{
			requestId: randomUUID(),
			agent: "planner",
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

	let workerTasks = plan.workerTasks;
	let latestRuns: WorkerRun[] = [];
	let latestReview = normalizeOrchestratorReview(undefined, "Reviewer did not run.", config.maxWorkers);
	let cycle = 0;

	while (cycle < config.reviewRetryCap) {
		cycle += 1;
		onPhase?.(`workers:${cycle}`);

		const workerRequestTasks = workerTasks.slice(0, config.maxWorkers).map((workItem) => ({
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
			task: workerTasks[index]!,
			output: extractFinalAssistantText(result.messages) || result.errorText || "",
			isError: result.isError,
			errorText: result.errorText,
		}));
		if (latestRuns.length === 0) {
			latestRuns = [{
				agent: "worker",
				task: workerTasks[0]!,
				output: extractFinalAssistantText(workerResponse.messages) || workerResponse.errorText || "",
				isError: workerResponse.isError,
				errorText: workerResponse.errorText,
			}];
		}

		onPhase?.(`reviewer:${cycle}`);
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

		if (latestReview.verdict === "approved") break;
		if (cycle >= config.reviewRetryCap) break;

		workerTasks = latestReview.repairTasks.length > 0
			? latestReview.repairTasks
			: [
				"Address the blocking reviewer findings across the current implementation and return the corrected result.",
			];
	}

	const text = formatFinalResult(task, plan, latestRuns, latestReview, cycle, config);
	return {
		text,
		details: {
			approved: latestReview.verdict === "approved",
			reviewCycles: cycle,
			workerCount: latestRuns.length,
			missionHint: plan.missionHint,
			verdict: latestReview.verdict,
		},
	};
}

export default function registerOrchestratorController(pi: ExtensionAPI): void {
	const schema = Type.Object({
		task: Type.String({ description: "The non-trivial task to orchestrate through planner, workers, and reviewer." }),
		context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
			description: "Delegation context for spawned subagents. Defaults to fork.",
		})),
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
				(phase) => {
					onUpdate?.({
						content: [{ type: "text", text: `Orchestrator phase: ${phase}` }],
						details: { phase },
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
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /orchestrate <task>", "error");
				return;
			}
			if (!ctx.hasUI) {
				process.stdout.write("Orchestrate currently requires an interactive Pi session.\n");
				return;
			}

			ctx.ui.notify("Running orchestrator...", "info");
			try {
				const result = await runOrchestrator(pi, ctx, task, "fork", AbortSignal.timeout(10 * 60 * 1000));
				pi.sendMessage({
					content: result.text,
					display: true,
				});
				ctx.ui.notify(
					result.details.approved
						? "Orchestrator run approved by reviewer."
						: "Orchestrator stopped with reviewer findings.",
					result.details.approved ? "info" : "warning",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});
}
