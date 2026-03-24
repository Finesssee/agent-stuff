import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type OrchestratorRunVerdict = "approved" | "revise" | "escalated" | "failed";

export type OrchestratorRunRecord = {
	version: 1;
	runId: string;
	task: string;
	taskSummary: string;
	plannerSummary?: string;
	reviewerSummary?: string;
	blockingFindings: string[];
	phase: string;
	status: "running" | "completed" | "failed" | "escalated";
	verdict?: OrchestratorRunVerdict;
	workerCount: number;
	reviewCycle: number;
	reviewRetryCap: number;
	missionHint: boolean;
	missionMode?: "lightweight" | "full";
	missionReason?: string;
	missionId?: string;
	startedAt: number;
	updatedAt: number;
	errorText?: string;
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

function normalizeRunRecord(value: unknown): OrchestratorRunRecord | undefined {
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
		status,
		verdict,
		workerCount: typeof record.workerCount === "number" && Number.isFinite(record.workerCount) ? Math.max(0, Math.round(record.workerCount)) : 0,
		reviewCycle: typeof record.reviewCycle === "number" && Number.isFinite(record.reviewCycle) ? Math.max(0, Math.round(record.reviewCycle)) : 0,
		reviewRetryCap: typeof record.reviewRetryCap === "number" && Number.isFinite(record.reviewRetryCap) ? Math.max(1, Math.round(record.reviewRetryCap)) : 1,
		missionHint: record.missionHint === true,
		missionMode: record.missionMode === "lightweight" || record.missionMode === "full" ? record.missionMode : undefined,
		missionReason: typeof record.missionReason === "string" ? record.missionReason : undefined,
		missionId: typeof record.missionId === "string" && record.missionId.trim() ? record.missionId.trim() : undefined,
		startedAt: typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : Date.now(),
		updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
		errorText: typeof record.errorText === "string" && record.errorText.trim() ? record.errorText.trim() : undefined,
	};
}

export function normalizeOrchestratorRuntimeState(value: unknown): OrchestratorRuntimeState {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		version: 1,
		activeRun: normalizeRunRecord(record.activeRun),
		lastRun: normalizeRunRecord(record.lastRun),
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
	state.activeRun = normalizeRunRecord(record);
	if (!state.lastRun || state.lastRun.runId === record.runId) {
		state.lastRun = normalizeRunRecord(record);
	}
	await writeOrchestratorRuntimeState(state);
}

export async function finalizeRun(record: OrchestratorRunRecord, markdown?: string): Promise<void> {
	const state = await readOrchestratorRuntimeState();
	state.activeRun = undefined;
	state.lastRun = normalizeRunRecord(record);
	await writeOrchestratorRuntimeState(state);
	await fs.mkdir(getOrchestratorRunsDir(), { recursive: true });
	await writeJsonAtomic(getOrchestratorRunJsonPath(record.runId), record);
	if (typeof markdown === "string" && markdown.trim()) {
		await fs.writeFile(getOrchestratorRunMarkdownPath(record.runId), `${markdown.trim()}\n`, "utf8");
	}
}

export function buildOrchestratorWidgetLines(record: OrchestratorRunRecord): string[] {
	const lines = [
		"Orchestrator",
		`- ${record.taskSummary || record.task || record.runId}`,
		`- Phase: ${record.phase}`,
	];
	if (record.workerCount > 0) {
		lines.push(`- Workers: ${record.workerCount}`);
	}
	if (record.reviewCycle > 0) {
		lines.push(`- Review cycle: ${record.reviewCycle}/${record.reviewRetryCap}`);
	}
	if (record.missionId) {
		lines.push(`- Mission: ${record.missionId}`);
	}
	return lines.slice(0, 6);
}
