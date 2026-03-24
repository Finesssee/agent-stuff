import test from "node:test";
import assert from "node:assert/strict";
import {
	buildOrchestratorModePrompt,
	buildPlanModePrompt,
	getDisplayedModeLabel,
	isKnownBehaviorModeVirtualModel,
	normalizeBehaviorModeState,
	normalizeOrchestratorModeConfig,
} from "./orchestrator-mode.ts";

test("normalizeOrchestratorModeConfig fills defaults and clamps numeric bounds", () => {
	const config = normalizeOrchestratorModeConfig({
		triggerPolicy: "always",
		missionBoundary: "mission-first",
		maxWorkers: 9,
		reviewRetryCap: 0,
		roles: {
			worker: {
				provider: "smart",
				modelId: "composer-2-fast",
			},
		},
	});

	assert.equal(config.triggerPolicy, "always");
	assert.equal(config.missionBoundary, "mission-first");
	assert.equal(config.maxWorkers, 3);
	assert.equal(config.reviewRetryCap, 1);
	assert.equal(config.workers.primary.modelId, "composer-2-fast");
	assert.ok(config.workers.pool.length >= 1);
	assert.equal(config.roles.planner.modelId, "gpt-5.4");
});

test("normalizeOrchestratorModeConfig migrates legacy single worker into primary worker", () => {
	const config = normalizeOrchestratorModeConfig({
		roles: {
			worker: {
				provider: "smart",
				modelId: "kimi-k2.5",
				thinkingLevel: "low",
			},
		},
	});

	assert.equal(config.workers.primary.provider, "smart");
	assert.equal(config.workers.primary.modelId, "kimi-k2.5");
	assert.equal(config.workers.primary.thinkingLevel, "low");
	assert.ok(config.workers.pool.length >= 1);
});

test("getDisplayedModeLabel keeps behavioral label stable across overlays and presets", () => {
	assert.equal(getDisplayedModeLabel("custom", "orchestrator"), "orchestrator*");
	assert.equal(getDisplayedModeLabel("review", "plan"), "plan*");
	assert.equal(getDisplayedModeLabel("normal", "plan"), "normal");
});

test("normalizeBehaviorModeState falls back to normal for invalid state", () => {
	const state = normalizeBehaviorModeState({ currentBehavior: "weird", updatedAt: "nope" });
	assert.equal(state.currentBehavior, "normal");
	assert.equal(typeof state.updatedAt, "number");
});

test("behavior prompts include key orchestration guidance", () => {
	const config = normalizeOrchestratorModeConfig({
		triggerPolicy: "always",
		missionBoundary: "mission-first",
	});
	const orchestratorPrompt = buildOrchestratorModePrompt(config);
	const planPrompt = buildPlanModePrompt();

	assert.match(orchestratorPrompt, /Behavior mode: Orchestrator/);
	assert.match(orchestratorPrompt, /smart\/composer-2-fast/);
	assert.match(orchestratorPrompt, /Worker pool/);
	assert.match(orchestratorPrompt, /Mission Control/);
	assert.match(planPrompt, /Behavior mode: Plan/);
	assert.match(planPrompt, /planning-first mode/);
});

test("smart routed family ids are treated as known virtual mode models", () => {
	assert.equal(isKnownBehaviorModeVirtualModel("smart", "opus-4-6"), true);
	assert.equal(isKnownBehaviorModeVirtualModel("smart", "composer-2"), true);
	assert.equal(isKnownBehaviorModeVirtualModel("smart", "composer-2-fast"), true);
	assert.equal(isKnownBehaviorModeVirtualModel("smart", "glm-5"), true);
	assert.equal(isKnownBehaviorModeVirtualModel("smart", "minimax-m2.5"), true);
	assert.equal(isKnownBehaviorModeVirtualModel("smart", "made-up-model"), false);
	assert.equal(isKnownBehaviorModeVirtualModel("cursor", "opus-4-6"), false);
});
