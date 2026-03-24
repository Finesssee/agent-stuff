import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type OrchestratorRunVerdict = "approved" | "revise" | "escalated" | "failed";

export type OrchestratorTimelineEvent = {
	kind: "phase" | "progress" | "verdict" | "mission" | "error";
	label: string;
	detail?: string;
	at: number;
	phase?: string;
};

export type OrchestratorRunRecord = {
	version: 1;
	runId: string;
	task: string;
	taskSummary: string;
	plannerSummary?: string;
	reviewerSummary?: string;
	blockingFindings: string[];
	phase: string;
	currentStep?: string;
	status: "running" | "completed" | "failed" | "escalated";
	verdict?: OrchestratorRunVerdict;
	workerCount: number;
	workerModels: string[];
	reviewCycle: number;
	reviewRetryCap: number;
	missionHint: boolean;
	missionMode?: "lightweight" | "full";
	missionReason?: string;
	missionId?: string;
	startedAt: number;
	updatedAt: number;
	errorText?: string;
	timeline: OrchestratorTimelineEvent[];
};

export type OrchestratorRuntimeState = {
	version: 1;
	activeRun?: OrchestratorRunRecord;
	lastRun?: OrchestratorRunRecord;
};

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function getGlobalAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return expandUserPath(env);
	return path.join(os.homedir(), ".pi", "agent");
}

export function getOrchestratorDir(): string {
	return path.join(getGlobalAgentDir(), "orchestrator");
}

export function getOrchestratorStatePath(): string {
	return path.join(getOrchestratorDir(), "state.json");
}

export function getOrchestratorRunsDir(): string {
	return path.join(getOrchestratorDir(), "runs");
}

export function getOrchestratorRunJsonPath(runId: string): string {
	return path.join(getOrchestratorRunsDir(), `${runId}.json`);
}

export function getOrchestratorRunMarkdownPath(runId: string): string {
	return path.join(getOrchestratorRunsDir(), `${runId}.md`);
}

function normalizeTimelineEvent(value: unknown): OrchestratorTimelineEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
	if (!label) return undefined;
	const kind =
		record.kind === "phase" ||
		record.kind === "progress" ||
		record.kind === "verdict" ||
		record.kind === "mission" ||
		record.kind === "error"
			? record.kind
			: "progress";
	return {
		kind,
		label,
		detail: typeof record.detail === "string" && record.detail.trim() ? record.detail.trim() : undefined,
		at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : Date.now(),
		phase: typeof record.phase === "string" && record.phase.trim() ? record.phase.trim() : undefined,
	};
}

export function normalizeOrchestratorRunRecord(value: unknown): OrchestratorRunRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const runId = typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : undefined;
	const task = typeof record.task === "string" ? record.task : "";
	const taskSummary = typeof record.taskSummary === "string" && record.taskSummary.trim()
		? record.taskSummary.trim()
		: task;
	const phase = typeof record.phase === "string" && record.phase.trim() ? record.phase.trim() : "idle";
	const status = record.status === "running" || record.status === "completed" || record.status === "failed" || record.status === "escalated"
		? record.status
		: undefined;
	if (!runId || !status) return undefined;
	const verdict = record.verdict === "approved" || record.verdict === "revise" || record.verdict === "escalated" || record.verdict === "failed"
		? record.verdict
		: undefined;
	return {
		version: 1,
		runId,
		task,
		taskSummary,
		plannerSummary: typeof record.plannerSummary === "string" ? record.plannerSummary : undefined,
		reviewerSummary: typeof record.reviewerSummary === "string" ? record.reviewerSummary : undefined,
		blockingFindings: Array.isArray(record.blockingFindings)
			? record.blockingFindings.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			: [],
		phase,
		currentStep: typeof record.currentStep === "string" && record.currentStep.trim() ? record.currentStep.trim() : undefined,
		status,
		verdict,
		workerCount: typeof record.workerCount === "number" && Number.isFinite(record.workerCount) ? Math.max(0, Math.round(record.workerCount)) : 0,
		workerModels: Array.isArray(record.workerModels)
			? [...new Set(record.workerModels.filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
			: [],
		reviewCycle: typeof record.reviewCycle === "number" && Number.isFinite(record.reviewCycle) ? Math.max(0, Math.round(record.reviewCycle)) : 0,
		reviewRetryCap: typeof record.reviewRetryCap === "number" && Number.isFinite(record.reviewRetryCap) ? Math.max(1, Math.round(record.reviewRetryCap)) : 1,
		missionHint: record.missionHint === true,
		missionMode: record.missionMode === "lightweight" || record.missionMode === "full" ? record.missionMode : undefined,
		missionReason: typeof record.missionReason === "string" ? record.missionReason : undefined,
		missionId: typeof record.missionId === "string" && record.missionId.trim() ? record.missionId.trim() : undefined,
		startedAt: typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : Date.now(),
		updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
		errorText: typeof record.errorText === "string" && record.errorText.trim() ? record.errorText.trim() : undefined,
		timeline: Array.isArray(record.timeline)
			? record.timeline
				.map((item) => normalizeTimelineEvent(item))
				.filter((item): item is OrchestratorTimelineEvent => Boolean(item))
				.slice(-24)
			: [],
	};
}

export function normalizeOrchestratorRuntimeState(value: unknown): OrchestratorRuntimeState {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		version: 1,
		activeRun: normalizeOrchestratorRunRecord(record.activeRun),
		lastRun: normalizeOrchestratorRunRecord(record.lastRun),
	};
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.rename(tempPath, filePath);
}

export async function readOrchestratorRuntimeState(): Promise<OrchestratorRuntimeState> {
	try {
		const raw = await fs.readFile(getOrchestratorStatePath(), "utf8");
		return normalizeOrchestratorRuntimeState(JSON.parse(raw));
	} catch {
		return normalizeOrchestratorRuntimeState(undefined);
	}
}

export async function writeOrchestratorRuntimeState(state: OrchestratorRuntimeState): Promise<void> {
	await writeJsonAtomic(getOrchestratorStatePath(), normalizeOrchestratorRuntimeState(state));
}

export async function upsertActiveRun(record: OrchestratorRunRecord): Promise<void> {
	const state = await readOrchestratorRuntimeState();
	state.activeRun = normalizeOrchestratorRunRecord(record);
	if (!state.lastRun || state.lastRun.runId === record.runId) {
		state.lastRun = normalizeOrchestratorRunRecord(record);
	}
	await writeOrchestratorRuntimeState(state);
}

export async function finalizeRun(record: OrchestratorRunRecord, markdown?: string): Promise<void> {
	const state = await readOrchestratorRuntimeState();
	state.activeRun = undefined;
	state.lastRun = normalizeOrchestratorRunRecord(record);
	await writeOrchestratorRuntimeState(state);
	await fs.mkdir(getOrchestratorRunsDir(), { recursive: true });
	await writeJsonAtomic(getOrchestratorRunJsonPath(record.runId), record);
	if (typeof markdown === "string" && markdown.trim()) {
		await fs.writeFile(getOrchestratorRunMarkdownPath(record.runId), `${markdown.trim()}\n`, "utf8");
	}
}

function shortenWidgetText(value: string, maxLength = 52): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return trimmed.length > maxLength ? `${trimmed.slice(0, Math.max(0, maxLength - 3))}...` : trimmed;
}

export function buildOrchestratorWidgetLines(record: OrchestratorRunRecord): string[] {
	const latestEvent = record.timeline.at(-1);
	const step = record.currentStep || latestEvent?.label || record.reviewerSummary || record.plannerSummary;
	const lines = ["Orchestrator", `Task: ${shortenWidgetText(record.taskSummary || record.task || record.runId)}`];
	if (step) lines.push(`Step: ${shortenWidgetText(step)}`);
	lines.push(`Phase: ${record.phase}`);
	if (record.workerCount > 0) lines.push(`Workers: ${record.workerCount} active`);
	if (record.reviewCycle > 0) {
		lines.push(`Review: ${record.reviewCycle}/${record.reviewRetryCap}`);
	} else if (record.missionId) {
		lines.push(`Mission: ${shortenWidgetText(record.missionId, 40)}`);
	} else if (latestEvent?.detail) {
		lines.push(`Latest: ${shortenWidgetText(latestEvent.detail)}`);
	}
	return lines.slice(0, 6);
}
