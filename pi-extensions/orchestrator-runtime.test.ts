import test from "node:test";
import assert from "node:assert/strict";
import {
	buildOrchestratorWidgetLines,
	normalizeOrchestratorRuntimeState,
	type OrchestratorRunRecord,
} from "./orchestrator-runtime.ts";

test("normalizeOrchestratorRuntimeState preserves additive orchestrator timeline fields", () => {
	const state = normalizeOrchestratorRuntimeState({
		activeRun: {
			runId: "orch_live",
			task: "Audit the orchestrator widget",
			taskSummary: "Audit the orchestrator widget",
			blockingFindings: [],
			phase: "review",
			currentStep: "Reviewer checking results",
			status: "running",
			workerCount: 2,
			workerModels: ["smart/composer-2-fast"],
			reviewCycle: 1,
			reviewRetryCap: 2,
			missionHint: false,
			startedAt: 1,
			updatedAt: 2,
			timeline: [
				{ kind: "phase", label: "Planner finished", at: 1, phase: "planned" },
				{ kind: "phase", label: "Reviewer checking results", at: 2, phase: "review" },
			],
		},
	});

	assert.equal(state.activeRun?.currentStep, "Reviewer checking results");
	assert.deepEqual(state.activeRun?.timeline.map((event) => event.label), [
		"Planner finished",
		"Reviewer checking results",
	]);
});

test("buildOrchestratorWidgetLines renders a compact live progress panel", () => {
	const record: OrchestratorRunRecord = {
		version: 1,
		runId: "orch_live",
		task: "Audit the orchestrator widget",
		taskSummary: "Audit the orchestrator widget",
		blockingFindings: [],
		phase: "review",
		currentStep: "Reviewer checking results",
		status: "running",
		workerCount: 2,
		workerModels: ["smart/composer-2-fast", "smart/gpt-5.4-mini"],
		reviewCycle: 1,
		reviewRetryCap: 2,
		missionHint: false,
		startedAt: 1,
		updatedAt: 2,
		timeline: [
			{ kind: "phase", label: "Planner finished", at: 1, phase: "planned" },
			{ kind: "phase", label: "Reviewer checking results", at: 2, phase: "review" },
		],
	};

	const lines = buildOrchestratorWidgetLines(record);
	assert.deepEqual(lines, [
		"Orchestrator",
		"Task: Audit the orchestrator widget",
		"Step: Reviewer checking results",
		"Phase: review",
		"Workers: 2 active",
		"Review: 1/2",
	]);
});
