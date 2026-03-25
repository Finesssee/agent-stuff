import test from "node:test";
import assert from "node:assert/strict";
import {
	buildOrchestratorDraftCommand,
	buildSteeringDraftCommand,
	cycleSteeringComposeMode,
	formatPromptEditorLabel,
} from "./prompt-editor.ts";

test("cycleSteeringComposeMode advances through normal, qsteer, psteer, then back to normal", () => {
	assert.equal(cycleSteeringComposeMode("normal"), "qsteer");
	assert.equal(cycleSteeringComposeMode("qsteer"), "psteer");
	assert.equal(cycleSteeringComposeMode("psteer"), "normal");
});

test("buildSteeringDraftCommand rewrites queued and power steer drafts", () => {
	assert.equal(buildSteeringDraftCommand("normal", "refocus on tests"), undefined);
	assert.equal(buildSteeringDraftCommand("qsteer", "refocus on tests"), "/qsteer refocus on tests");
	assert.equal(buildSteeringDraftCommand("psteer", "refocus on tests"), "/psteer refocus on tests");
	assert.equal(buildSteeringDraftCommand("qsteer", "   "), undefined);
});

test("buildOrchestratorDraftCommand only rewrites non-trivial drafts", () => {
	assert.equal(buildOrchestratorDraftCommand("what time is it?", "non-trivial"), undefined);
	assert.equal(
		buildOrchestratorDraftCommand("implement the smart model selector fix and add tests", "non-trivial"),
		"/orchestrate implement the smart model selector fix and add tests",
	);
	assert.equal(buildOrchestratorDraftCommand("hello", "always"), "/orchestrate hello");
});

test("formatPromptEditorLabel appends steering mode only when armed", () => {
	assert.equal(formatPromptEditorLabel("orchestrator", "normal"), "orchestrator");
	assert.equal(formatPromptEditorLabel("orchestrator", "qsteer"), "orchestrator · qsteer");
	assert.equal(formatPromptEditorLabel("orchestrator", "psteer"), "orchestrator · psteer");
});
