import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { ThinkingLevel } from "@mariozechner/pi-coding-agent";

export const BUILTIN_MODE_RING = ["normal", "plan", "orchestrator"] as const;
export type BuiltinModeName = (typeof BUILTIN_MODE_RING)[number];

export type BehaviorModeState = {
	version: 1;
	currentBehavior: BuiltinModeName;
	updatedAt: number;
};

export type RoleProfile = {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
};

export type OrchestratorModeConfig = {
	version: 1;
	triggerPolicy: "non-trivial" | "always";
	missionBoundary: "inline-first" | "mission-first";
	maxWorkers: number;
	reviewRetryCap: number;
	reviewerGate: "always";
	roles: {
		planner: RoleProfile;
		orchestrator: RoleProfile;
		worker: RoleProfile;
		reviewer: RoleProfile;
	};
};

const KNOWN_SMART_PROVIDER_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"opus-4-6",
	"sonnet-4-6",
	"composer-2",
	"composer-2-fast",
	"glm-5",
	"kimi-k2.5",
	"minimax-m2.5",
]);

const DEFAULT_ORCHESTRATOR_MODE_CONFIG: OrchestratorModeConfig = {
	version: 1,
	triggerPolicy: "non-trivial",
	missionBoundary: "inline-first",
	maxWorkers: 3,
	reviewRetryCap: 3,
	reviewerGate: "always",
	roles: {
		planner: { provider: "smart", modelId: "gpt-5.4", thinkingLevel: "xhigh" },
		orchestrator: { provider: "smart", modelId: "opus-4-6", thinkingLevel: "high" },
		worker: { provider: "smart", modelId: "composer-2-fast", thinkingLevel: "off" },
		reviewer: { provider: "smart", modelId: "gpt-5.4", thinkingLevel: "high" },
	},
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

export function getOrchestratorModeConfigPath(): string {
	return path.join(getGlobalAgentDir(), "orchestrator-mode.json");
}

export function getBehaviorModeStatePath(): string {
	return path.join(getGlobalAgentDir(), "behavior-mode-state.json");
}

export function shouldApplyBehaviorModePrompt(env: NodeJS.ProcessEnv = process.env): boolean {
	const depth = Number(env.PI_SUBAGENT_DEPTH ?? "0");
	return !Number.isFinite(depth) || depth <= 0;
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
	return allowed.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : undefined;
}

function normalizeRoleProfile(value: unknown, fallback: RoleProfile): RoleProfile {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		provider: typeof record.provider === "string" && record.provider.trim() ? record.provider.trim() : fallback.provider,
		modelId: typeof record.modelId === "string" && record.modelId.trim() ? record.modelId.trim() : fallback.modelId,
		thinkingLevel: normalizeThinkingLevel(record.thinkingLevel) ?? fallback.thinkingLevel,
	};
}

export function normalizeOrchestratorModeConfig(value: unknown): OrchestratorModeConfig {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const rawRoles = record.roles && typeof record.roles === "object" ? (record.roles as Record<string, unknown>) : {};

	const maxWorkers = typeof record.maxWorkers === "number" && Number.isFinite(record.maxWorkers)
		? Math.min(3, Math.max(1, Math.round(record.maxWorkers)))
		: DEFAULT_ORCHESTRATOR_MODE_CONFIG.maxWorkers;

	const reviewRetryCap = typeof record.reviewRetryCap === "number" && Number.isFinite(record.reviewRetryCap)
		? Math.min(3, Math.max(1, Math.round(record.reviewRetryCap)))
		: DEFAULT_ORCHESTRATOR_MODE_CONFIG.reviewRetryCap;

	return {
		version: 1,
		triggerPolicy:
			record.triggerPolicy === "always" || record.triggerPolicy === "non-trivial"
				? record.triggerPolicy
				: DEFAULT_ORCHESTRATOR_MODE_CONFIG.triggerPolicy,
		missionBoundary:
			record.missionBoundary === "mission-first" || record.missionBoundary === "inline-first"
				? record.missionBoundary
				: DEFAULT_ORCHESTRATOR_MODE_CONFIG.missionBoundary,
		maxWorkers,
		reviewRetryCap,
		reviewerGate: "always",
		roles: {
			planner: normalizeRoleProfile(rawRoles.planner, DEFAULT_ORCHESTRATOR_MODE_CONFIG.roles.planner),
			orchestrator: normalizeRoleProfile(rawRoles.orchestrator, DEFAULT_ORCHESTRATOR_MODE_CONFIG.roles.orchestrator),
			worker: normalizeRoleProfile(rawRoles.worker, DEFAULT_ORCHESTRATOR_MODE_CONFIG.roles.worker),
			reviewer: normalizeRoleProfile(rawRoles.reviewer, DEFAULT_ORCHESTRATOR_MODE_CONFIG.roles.reviewer),
		},
	};
}

export function normalizeBehaviorModeState(value: unknown): BehaviorModeState {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const currentBehavior = isBuiltinBehaviorMode(record.currentBehavior as string)
		? (record.currentBehavior as BuiltinModeName)
		: "normal";
	const updatedAt =
		typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now();
	return {
		version: 1,
		currentBehavior,
		updatedAt,
	};
}

export async function readOrchestratorModeConfig(): Promise<OrchestratorModeConfig> {
	try {
		const raw = await fs.readFile(getOrchestratorModeConfigPath(), "utf8");
		return normalizeOrchestratorModeConfig(JSON.parse(raw));
	} catch {
		return normalizeOrchestratorModeConfig(undefined);
	}
}

export async function saveOrchestratorModeConfig(config: OrchestratorModeConfig): Promise<void> {
	const filePath = getOrchestratorModeConfigPath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(normalizeOrchestratorModeConfig(config), null, 2)}\n`, "utf8");
}

export async function readBehaviorModeState(): Promise<BehaviorModeState> {
	try {
		const raw = await fs.readFile(getBehaviorModeStatePath(), "utf8");
		return normalizeBehaviorModeState(JSON.parse(raw));
	} catch {
		return normalizeBehaviorModeState(undefined);
	}
}

export async function saveBehaviorModeState(currentBehavior: BuiltinModeName): Promise<void> {
	const filePath = getBehaviorModeStatePath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const state = normalizeBehaviorModeState({ currentBehavior, updatedAt: Date.now() });
	await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function isBuiltinBehaviorMode(mode: string): mode is BuiltinModeName {
	return (BUILTIN_MODE_RING as readonly string[]).includes(mode);
}

export function formatProfile(profile: RoleProfile): string {
	const base = `${profile.provider}/${profile.modelId}`;
	return profile.thinkingLevel && profile.thinkingLevel !== "off" ? `${base}:${profile.thinkingLevel}` : base;
}

export function isKnownBehaviorModeVirtualModel(provider: string | undefined, modelId: string | undefined): boolean {
	return provider === "smart" && typeof modelId === "string" && KNOWN_SMART_PROVIDER_MODEL_IDS.has(modelId);
}

export function getDisplayedModeLabel(currentMode: string, lastRealMode: string): string {
	if (currentMode === "custom" && isBuiltinBehaviorMode(lastRealMode)) return `${lastRealMode}*`;
	if (!isBuiltinBehaviorMode(currentMode) && currentMode && isBuiltinBehaviorMode(lastRealMode)) return `${lastRealMode}*`;
	return currentMode;
}

export function buildPlanModePrompt(): string {
	return [
		"Behavior mode: Plan",
		"You are in planning-first mode.",
		"Default behavior for this turn:",
		"- Clarify requirements, constraints, interfaces, failure modes, and verification.",
		"- Produce plans, specs, tradeoffs, and implementation guidance.",
		"- Do not implement or mutate code unless the user explicitly asks to leave planning mode or explicitly demands execution anyway.",
		"- Prefer reading and analysis over delegation.",
	].join("\n");
}

export function buildOrchestratorModePrompt(config: OrchestratorModeConfig): string {
	const directHandlingRule =
		config.triggerPolicy === "always"
			? "Assume orchestration is the default for nearly all real work; stay direct only for one-command checks or tiny replies that clearly do not benefit from decomposition."
			: "Treat non-trivial work as delegation-first. Stay direct only for trivial asks such as simple answers, one-command checks, or tiny edits that do not benefit from decomposition.";

	const missionBoundaryRule =
		config.missionBoundary === "mission-first"
			? "- Prefer escalating mission-shaped work into Mission Control early once scope looks durable, multi-step, or likely to outlive the current interactive session."
			: "- Stay inline by default. Escalate to Mission Control only when the task is clearly long-running, mission-shaped, or explicitly background/detached work.";

	return [
		"Behavior mode: Orchestrator",
		"You are the main orchestrator for this session.",
		directHandlingRule,
		"",
		"Preferred execution surface:",
		"- For non-trivial work, prefer the orchestrate tool or /orchestrate command instead of manually juggling planner/worker/reviewer calls.",
		"- Use raw subagent calls only when you need a one-off specialist step that does not justify the full controller.",
		"",
		"Default orchestration pipeline:",
		`1. Planning leg via subagent agent "planner" using model override ${formatProfile(config.roles.planner)}.`,
		`2. Main orchestration leg stays in this session using ${formatProfile(config.roles.orchestrator)} as the active mode profile.`,
		`3. Worker leg via subagent workers using model override ${formatProfile(config.roles.worker)}.`,
		`4. Reviewer gate via subagent agent "reviewer" using model override ${formatProfile(config.roles.reviewer)}.`,
		"",
		"Execution rules:",
		`- Worker fanout is adaptive with a hard cap of ${config.maxWorkers}. Use fewer workers unless the task cleanly splits.`,
		`- Reviewer is mandatory for every orchestrated run.`,
		`- Reviewer-driven repair loops may continue automatically, but must stop after ${config.reviewRetryCap} review cycles and then surface the bounded failure clearly.`,
		"- Keep the main session focused on routing, decomposition, synthesis, and conflict resolution.",
		"- When using raw subagent calls, prefer explicit model overrides so the editable role stack actually takes effect.",
		missionBoundaryRule,
	].join("\n");
}
