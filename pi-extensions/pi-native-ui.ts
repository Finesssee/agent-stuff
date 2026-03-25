import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, type Component } from "@mariozechner/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

export type PiUiTone = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text";

export type PiUiRow = {
	label: string;
	value?: string;
	tone?: PiUiTone;
};

export type PiUiSection = {
	title?: string;
	rows?: PiUiRow[];
	items?: string[];
};

export type PiUiPanel = {
	title: string;
	kicker?: string;
	sections?: PiUiSection[];
	footer?: string;
};

function trimOrUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function colorize(theme: Theme, tone: PiUiTone | undefined, text: string): string {
	switch (tone) {
		case "accent":
			return theme.fg("accent", text);
		case "success":
			return theme.fg("success", text);
		case "warning":
			return theme.fg("warning", text);
		case "error":
			return theme.fg("error", text);
		case "muted":
			return theme.fg("muted", text);
		case "text":
			return theme.fg("text", text);
		case "dim":
		default:
			return theme.fg("dim", text);
	}
}

function buildPlainPanelLines(panel: PiUiPanel): string[] {
	const lines: string[] = [panel.title.trim()];
	const kicker = trimOrUndefined(panel.kicker);
	if (kicker) lines.push(kicker);
	for (const section of panel.sections ?? []) {
		const title = trimOrUndefined(section.title);
		const rows = (section.rows ?? []).filter((row) => trimOrUndefined(row.label) && trimOrUndefined(row.value));
		const items = (section.items ?? []).map((item) => item.trim()).filter(Boolean);
		if (!title && rows.length === 0 && items.length === 0) continue;
		lines.push("");
		if (title) lines.push(title);
		for (const row of rows) {
			lines.push(`${row.label.trim()}: ${row.value!.trim()}`);
		}
		for (const item of items) {
			lines.push(`- ${item}`);
		}
	}
	const footer = trimOrUndefined(panel.footer);
	if (footer) {
		lines.push("", footer);
	}
	return lines;
}

function buildStyledPanelLines(theme: Theme, panel: PiUiPanel): string[] {
	const lines: string[] = [theme.fg("accent", theme.bold(panel.title.trim()))];
	const kicker = trimOrUndefined(panel.kicker);
	if (kicker) lines.push(theme.fg("dim", kicker));
	for (const section of panel.sections ?? []) {
		const title = trimOrUndefined(section.title);
		const rows = (section.rows ?? []).filter((row) => trimOrUndefined(row.label) && trimOrUndefined(row.value));
		const items = (section.items ?? []).map((item) => item.trim()).filter(Boolean);
		if (!title && rows.length === 0 && items.length === 0) continue;
		lines.push("");
		if (title) lines.push(theme.fg("muted", theme.bold(title)));
		for (const row of rows) {
			lines.push(`${theme.fg("dim", `${row.label.trim()}: `)}${colorize(theme, row.tone, row.value!.trim())}`);
		}
		for (const item of items) {
			lines.push(`${theme.fg("muted", "- ")}${item}`);
		}
	}
	const footer = trimOrUndefined(panel.footer);
	if (footer) {
		lines.push("", theme.fg("dim", footer));
	}
	return lines;
}

export function renderPiUiPanelText(panel: PiUiPanel): string {
	return buildPlainPanelLines(panel).join("\n");
}

export function renderPiUiPanel(theme: Theme, panel: PiUiPanel): Component {
	return new Text(buildStyledPanelLines(theme, panel).join("\n"), 0, 0);
}

export function buildPiUiWidgetLines(title: string, rows: Array<string | undefined>, maxLines = 5): string[] {
	return [title.trim(), ...rows.map((row) => trimOrUndefined(row)).filter(Boolean) as string[]].slice(0, maxLines);
}
