import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildOrchestratorModePrompt,
	buildPlanModePrompt,
	readBehaviorModeState,
	readOrchestratorModeConfig,
} from "./orchestrator-mode.ts";

export default function behaviorModesExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		const behaviorState = await readBehaviorModeState();
		if (behaviorState.currentBehavior === "normal") return undefined;
		if (behaviorState.currentBehavior === "plan") {
			return {
				systemPrompt: [ctx.getSystemPrompt(), "", buildPlanModePrompt()].join("\n"),
			};
		}
		const config = await readOrchestratorModeConfig();
		return {
			systemPrompt: [ctx.getSystemPrompt(), "", buildOrchestratorModePrompt(config)].join("\n"),
		};
	});
}
