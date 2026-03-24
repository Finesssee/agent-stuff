import test from "node:test";
import assert from "node:assert/strict";
import {
	assignWorkerProfiles,
	buildOrchestratorMessageContent,
	describeDelegationProgress,
	extractJsonObject,
	normalizeOrchestratorPlan,
	normalizeOrchestratorReview,
	ORCHESTRATOR_MESSAGE_TYPE,
	renderOrchestratorMessageText,
	shouldAutoRouteOrchestratorTask,
} from "./orchestrator-controller.ts";
import registerOrchestratorController from "./orchestrator-controller.ts";
import { normalizeOrchestratorModeConfig, shouldApplyBehaviorModePrompt } from "./orchestrator-mode.ts";
import type { OrchestratorRunRecord } from "./orchestrator-runtime.ts";

test("extractJsonObject parses fenced JSON payloads", () => {
	const parsed = extractJsonObject('```json\n{"summary":"ok","workerTasks":["one"]}\n```') as {
		summary: string;
		workerTasks: string[];
	};
	assert.equal(parsed.summary, "ok");
	assert.deepEqual(parsed.workerTasks, ["one"]);
});

test("normalizeOrchestratorPlan falls back to the original task when planner output is unstructured", () => {
	const plan = normalizeOrchestratorPlan(undefined, "ship the fix", 3, "fallback");
	assert.equal(plan.summary, "fallback");
	assert.deepEqual(plan.workerTasks, ["ship the fix"]);
	assert.equal(plan.missionHint, false);
});

test("normalizeOrchestratorPlan clamps worker fanout and preserves review focus", () => {
	const plan = normalizeOrchestratorPlan({
		summary: "do the thing",
		workerTasks: ["a", "b", "c", "d"],
		reviewFocus: ["regressions", "tests"],
		missionHint: true,
		missionMode: "full",
		missionReason: "Needs detached execution",
	}, "fallback", 3);
	assert.deepEqual(plan.workerTasks, ["a", "b", "c"]);
	assert.deepEqual(plan.reviewFocus, ["regressions", "tests"]);
	assert.equal(plan.missionHint, true);
	assert.equal(plan.missionMode, "full");
	assert.equal(plan.missionReason, "Needs detached execution");
});

test("normalizeOrchestratorReview infers revise when blocking findings exist", () => {
	const review = normalizeOrchestratorReview({
		summary: "needs work",
		blockingFindings: ["bug 1"],
		repairTasks: ["fix bug 1"],
	}, "fallback", 3);
	assert.equal(review.verdict, "revise");
	assert.deepEqual(review.blockingFindings, ["bug 1"]);
	assert.deepEqual(review.repairTasks, ["fix bug 1"]);
});

test("normalizeOrchestratorReview defaults to approved without findings", () => {
	const review = normalizeOrchestratorReview({}, "looks good", 3);
	assert.equal(review.verdict, "approved");
	assert.equal(review.summary, "looks good");
});

test("assignWorkerProfiles uses the primary worker first and then the pool", () => {
	const config = normalizeOrchestratorModeConfig({
		maxWorkers: 3,
		workers: {
			primary: { provider: "smart", modelId: "composer-2-fast", thinkingLevel: "off" },
			pool: [
				{ provider: "smart", modelId: "composer-2", thinkingLevel: "off" },
				{ provider: "smart", modelId: "gpt-5.4-mini", thinkingLevel: "high" },
			],
		},
	});

	const assignments = assignWorkerProfiles(config, ["task a", "task b", "task c"]);
	assert.deepEqual(
		assignments.map((item) => item.profile.modelId),
		["composer-2-fast", "composer-2", "gpt-5.4-mini"],
	);
	assert.deepEqual(
		assignments.map((item) => item.task),
		["task a", "task b", "task c"],
	);
});

test("assignWorkerProfiles cycles the pool deterministically when needed", () => {
	const config = normalizeOrchestratorModeConfig({
		maxWorkers: 3,
		workers: {
			primary: { provider: "smart", modelId: "composer-2-fast", thinkingLevel: "off" },
			pool: [{ provider: "smart", modelId: "kimi-k2.5", thinkingLevel: "off" }],
		},
	});

	const assignments = assignWorkerProfiles(config, ["task a", "task b", "task c"]);
	assert.deepEqual(
		assignments.map((item) => item.profile.modelId),
		["composer-2-fast", "kimi-k2.5", "kimi-k2.5"],
	);
});

test("behavior prompts do not apply inside nested subagents", () => {
	assert.equal(shouldApplyBehaviorModePrompt({ PI_SUBAGENT_DEPTH: "0" } as NodeJS.ProcessEnv), true);
	assert.equal(shouldApplyBehaviorModePrompt({ PI_SUBAGENT_DEPTH: "1" } as NodeJS.ProcessEnv), false);
	assert.equal(shouldApplyBehaviorModePrompt({ PI_SUBAGENT_DEPTH: "garbage" } as NodeJS.ProcessEnv), true);
});

test("shouldAutoRouteOrchestratorTask keeps tiny direct asks inline", () => {
	assert.equal(shouldAutoRouteOrchestratorTask("what is cmp?", "non-trivial"), false);
	assert.equal(shouldAutoRouteOrchestratorTask("show providers", "non-trivial"), false);
});

test("shouldAutoRouteOrchestratorTask routes non-trivial execution asks", () => {
	assert.equal(
		shouldAutoRouteOrchestratorTask("implement the orchestrator status view and add tests", "non-trivial"),
		true,
	);
	assert.equal(
		shouldAutoRouteOrchestratorTask("trace the repo, compare providers, and fix the failing build", "non-trivial"),
		true,
	);
});

test("shouldAutoRouteOrchestratorTask respects always mode", () => {
	assert.equal(shouldAutoRouteOrchestratorTask("hello there", "always"), true);
});

test("registerOrchestratorController registers a custom orchestrator renderer", () => {
	const renderers: string[] = [];
	registerOrchestratorController({
		registerMessageRenderer(type: string) {
			renderers.push(type);
		},
		registerTool() {},
		registerCommand() {},
	} as any);
	assert.deepEqual(renderers, [ORCHESTRATOR_MESSAGE_TYPE]);
});

test("describeDelegationProgress turns raw delegation updates into readable progress", () => {
	assert.equal(describeDelegationProgress("planner", "running"), "Planner running");
	assert.equal(describeDelegationProgress("workers", "tool:edit_file"), "Workers using edit file");
	assert.equal(describeDelegationProgress("reviewer", "tool:mcp__morph_mcp__edit_file"), "Reviewer using edit file");
});

test("buildOrchestratorMessageContent builds a timeline-first result payload", () => {
	const record: OrchestratorRunRecord = {
		version: 1,
		runId: "orch_demo",
		task: "Fix the orchestrator status output",
		taskSummary: "Tighten the orchestrator status output",
		plannerSummary: "Split runtime and rendering work",
		reviewerSummary: "Approved after the status card matched the widget.",
		blockingFindings: [],
		phase: "completed",
		currentStep: "Reviewer approved the run",
		status: "completed",
		verdict: "approved",
		workerCount: 2,
		workerModels: ["smart/composer-2-fast", "smart/gpt-5.4-mini"],
		reviewCycle: 1,
		reviewRetryCap: 2,
		missionHint: false,
		startedAt: 1,
		updatedAt: 2,
		timeline: [
			{ kind: "phase", label: "Planner finished", at: 1, phase: "planned" },
			{ kind: "phase", label: "Workers finished", at: 2, phase: "review" },
			{ kind: "verdict", label: "Reviewer approved the run", at: 3, phase: "completed" },
		],
	};

	const content = buildOrchestratorMessageContent("result", record);
	assert.equal(content.kind, "result");
	assert.equal(content.state, "approved");
	assert.equal(content.currentStep, "Reviewer approved the run");
	assert.deepEqual(
		content.timeline.map((event) => event.label),
		["Planner finished", "Workers finished", "Reviewer approved the run"],
	);
	assert.equal(content.inspectHint, "/orchestrate inspect orch_demo");
});

test("renderOrchestratorMessageText shows structured timeline and metadata", () => {
	const record: OrchestratorRunRecord = {
		version: 1,
		runId: "orch_demo",
		task: "Fix the orchestrator status output",
		taskSummary: "Tighten the orchestrator status output",
		plannerSummary: "Split runtime and rendering work",
		reviewerSummary: "Approved after the status card matched the widget.",
		blockingFindings: [],
		phase: "completed",
		currentStep: "Reviewer approved the run",
		status: "completed",
		verdict: "approved",
		workerCount: 2,
		workerModels: ["smart/composer-2-fast", "smart/gpt-5.4-mini"],
		reviewCycle: 1,
		reviewRetryCap: 2,
		missionHint: false,
		startedAt: 1,
		updatedAt: 2,
		timeline: [
			{ kind: "phase", label: "Planner finished", at: 1, phase: "planned" },
			{ kind: "phase", label: "Workers finished", at: 2, phase: "review" },
			{ kind: "verdict", label: "Reviewer approved the run", at: 3, phase: "completed" },
		],
	};

	const text = renderOrchestratorMessageText(buildOrchestratorMessageContent("result", record));
	assert.match(text, /State: approved/);
	assert.match(text, /Step: Reviewer approved the run/);
	assert.match(text, /Timeline:/);
	assert.match(text, /- Planner finished/);
	assert.match(text, /Inspect: \/orchestrate inspect orch_demo/);
});
