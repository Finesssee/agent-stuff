import test from "node:test";
import assert from "node:assert/strict";
import {
	extractJsonObject,
	normalizeOrchestratorPlan,
	normalizeOrchestratorReview,
} from "./orchestrator-controller.ts";
import { shouldApplyBehaviorModePrompt } from "./orchestrator-mode.ts";

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
	}, "fallback", 3);
	assert.deepEqual(plan.workerTasks, ["a", "b", "c"]);
	assert.deepEqual(plan.reviewFocus, ["regressions", "tests"]);
	assert.equal(plan.missionHint, true);
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

test("behavior prompts do not apply inside nested subagents", () => {
	assert.equal(shouldApplyBehaviorModePrompt({ PI_SUBAGENT_DEPTH: "0" } as NodeJS.ProcessEnv), true);
	assert.equal(shouldApplyBehaviorModePrompt({ PI_SUBAGENT_DEPTH: "1" } as NodeJS.ProcessEnv), false);
	assert.equal(shouldApplyBehaviorModePrompt({ PI_SUBAGENT_DEPTH: "garbage" } as NodeJS.ProcessEnv), true);
});
