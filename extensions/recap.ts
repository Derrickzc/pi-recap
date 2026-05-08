import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";

type Model<TApi = any> = any;
type ProviderStreamOptions = Record<string, unknown> & {
	signal?: AbortSignal;
	maxTokens?: number;
	timeoutMs?: number;
	maxRetries?: number;
	reasoningEffort?: string;
};

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
};

type TitleContext = {
	hasUI: boolean;
	cwd: string;
	sessionManager: { getBranch(): unknown[] };
	ui: {
		theme: Theme;
		setTitle(title: string): void;
		setStatus(key: string, value: string | undefined): void;
	};
	model?: Model<any>;
	modelRegistry: {
		find(provider: string, modelId: string): Model<any> | undefined;
		hasConfiguredAuth?(model: Model<any>): boolean;
		getApiKeyAndHeaders?(model: Model<any>): Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
	signal?: AbortSignal;
};

type SessionState = {
	title?: string;
	firstPrompt?: string;
	recap?: string;
};

type BranchEntry = {
	type?: string;
	customType?: string;
	data?: SessionState;
	message?: { role?: string; content?: unknown };
};

type AgentMessageLike = { role?: string; content?: unknown };

const STATE_KEY = "pi-recap";
const TITLE_MODEL_PROVIDER = "openai";
const TITLE_MODEL_ID = "gpt-5-nano";
const DEFAULT_MAX_RECAP_WORDS = 14;

const DEFAULT_TITLE_PROMPT =
	"You write concise terminal tab titles for coding-agent sessions. Output only a specific 2-6 word title. Do not quote or closely reuse the user's wording.";

const DEFAULT_RECAP_PROMPT =
	"Write a concise terminal status recap for the session. Output only one natural phrase or sentence, at most 14 words. Do not start with phrases like 'The user asks', 'The user requested', or 'This session'. Avoid mentioning participants. Focus on the concrete capability, decision, or result.";

type Settings = {
	recap?: {
		maxWords?: number;
		prompts?: {
			title?: string;
			recap?: string;
		};
	};
};

let currentTitle: string | null = null;
let currentFirstPrompt: string | null = null;
let currentRecap: string | null = null;
let titlePromise: Promise<void> | null = null;
let recapPromise: Promise<void> | null = null;
let lastRecapSourceKey: string | null = null;

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const item = block as { type?: string; text?: string; name?: string; thinking?: string };
			if (item.type === "text") return item.text ?? "";
			if (item.type === "toolCall" && item.name) return `Tool: ${item.name}`;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function heuristicTitle(prompt: string): string {
	const normalized = prompt
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[-•*\s]+/, "")
		.replace(/^(please\s+|can you\s+|could you\s+|would you\s+|help me\s+|i need\s+|i want\s+|we need\s+|let's\s+|lets\s+|i am\s+|i'm\s+)/i, "");

	const sentence = normalized.split(/[.!?\n]/, 1)[0]?.trim() || normalized;
	const words = sentence.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) ?? [];
	const picked = words.slice(0, 5);
	if (picked.length === 1) picked.push("Session");
	const title = picked.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
	const fallback = sentence.slice(0, 48).trim();
	const chosen = title || fallback || "Session Notes";
	return chosen.length > 48 ? `${chosen.slice(0, 45).trimEnd()}…` : chosen;
}

function cleanSingleLine(text: string, fallback = "Session") {
	const line =
		text
			.split("\n")
			.map((part) => part.trim())
			.find(Boolean) ?? "";

	const cleaned = line
		.replace(/^[-•*\d.)\s]+/, "")
		.replace(/^title\s*:\s*/i, "")
		.replace(/^recap\s*:\s*/i, "")
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.?!]+$/, "");

	return cleaned || line || fallback;
}

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

function limitWords(text: string, maxWords: number): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return text.trim();
	return `${words.slice(0, maxWords).join(" ")}…`;
}

function isGenericTitle(title: string | null | undefined): boolean {
	if (!title) return true;
	const normalized = title.trim().toLowerCase();
	return ["session", "session notes", "notes", "recap", "untitled", "general", "default"].includes(normalized);
}

function isGenericPrompt(prompt: string | null | undefined): boolean {
	if (!prompt) return true;
	const cleaned = prompt.trim().toLowerCase().replace(/\s+/g, " ");
	return ["session", "session notes", "notes", "recap", "untitled", "general", "default"].includes(cleaned);
}

function normalizeForCompare(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isLikelyHeuristicTitle(title: string | null | undefined, prompt: string | null | undefined): boolean {
	if (!title || !prompt) return false;
	const normalizedTitle = normalizeForCompare(title);
	const normalizedPrompt = normalizeForCompare(prompt);
	return normalizedTitle === normalizeForCompare(heuristicTitle(prompt)) || normalizedPrompt.startsWith(normalizedTitle);
}

function isLikelyHeuristicRecap(recap: string | null | undefined): boolean {
	return /^requested\s+.+;\s+completed with\s+/i.test(recap ?? "");
}

function getStoredState(ctx: TitleContext): SessionState {
	const branch = ctx.sessionManager.getBranch() as BranchEntry[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom" || entry.customType !== STATE_KEY) continue;
		return entry.data ?? {};
	}
	return {};
}

function getFirstUserPrompt(ctx: TitleContext): string | null {
	for (const entry of ctx.sessionManager.getBranch() as BranchEntry[]) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = extractText(entry.message.content).trim();
		if (text) return text;
	}
	return null;
}

function getFirstUserPromptFromMessages(messages: unknown[]): string | null {
	for (const entry of messages as AgentMessageLike[]) {
		if (entry?.role !== "user") continue;
		const text = extractText(entry.content).trim();
		if (text) return text;
	}
	return null;
}

function getLastAssistantMessage(ctx: TitleContext): string | null {
	const branch = ctx.sessionManager.getBranch() as BranchEntry[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = extractText(entry.message.content).trim();
		if (text) return text;
	}
	return null;
}

function getLastAssistantMessageFromMessages(messages: unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const entry = messages[i] as AgentMessageLike | undefined;
		if (entry?.role !== "assistant") continue;
		const text = extractText(entry.content).trim();
		if (text) return text;
	}
	return null;
}

function persistState(pi: ExtensionAPI, state: SessionState): void {
	pi.appendEntry(STATE_KEY, state);
}

function getHomeDir(): string {
	return process.env.USERPROFILE || (process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : "") || process.env.HOME || "";
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(getHomeDir(), ".pi", "agent");
}

function readJsonFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		reportError("settings", `${path}: ${describeError(error)}`);
		return {};
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		result[key] = isPlainObject(current) && isPlainObject(value) ? mergeSettings(current, value) : value;
	}
	return result;
}

function getSettings(ctx: TitleContext): Settings {
	const globalSettings = readJsonFile(join(getAgentDir(), "settings.json"));
	const projectSettings = readJsonFile(join(ctx.cwd, ".pi", "settings.json"));
	return mergeSettings(globalSettings, projectSettings) as Settings;
}

function getRecapConfig(ctx: TitleContext): { titlePrompt: string; recapPrompt: string; maxWords: number } {
	const recap = getSettings(ctx).recap;
	const prompts = recap?.prompts;
	const maxWords = Number.isFinite(recap?.maxWords) && recap!.maxWords! > 0 ? Math.floor(recap!.maxWords!) : DEFAULT_MAX_RECAP_WORDS;
	return {
		titlePrompt: prompts?.title?.trim() || DEFAULT_TITLE_PROMPT,
		recapPrompt: prompts?.recap?.trim() || DEFAULT_RECAP_PROMPT,
		maxWords,
	};
}

function makeRecapKey(firstPrompt: string, lastAssistant: string): string {
	return `${cleanSingleLine(firstPrompt, "").slice(0, 80)}\n\n${cleanSingleLine(lastAssistant, "").slice(0, 140)}`;
}

function updateUI(ctx: TitleContext): void {
	if (!ctx.hasUI) return;

	ctx.ui.setTitle(currentTitle ?? "pi");
	ctx.ui.setStatus(
		STATE_KEY,
		currentRecap
			? ctx.ui.theme.fg("dim", "※ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.bold("Recap:")) + ctx.ui.theme.fg("muted", ` ${ctx.ui.theme.italic(currentRecap)}`)
			: undefined,
	);
}

function pickModel(ctx: TitleContext): Model<any> | undefined {
	return ctx.modelRegistry.find(TITLE_MODEL_PROVIDER, TITLE_MODEL_ID);
}

async function completeWithAuth(ctx: TitleContext, model: Model<any>, context: Parameters<typeof complete>[1], options: ProviderStreamOptions) {
	const baseOptions = {
		...options,
		// Keep these small helper calls from hanging the UI too long.
		timeoutMs: options.timeoutMs ?? 30_000,
		maxRetries: options.maxRetries ?? 1,
	};

	if (!ctx.modelRegistry.getApiKeyAndHeaders) {
		return complete(model, context, baseOptions);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	return complete(model, context, {
		...baseOptions,
		apiKey: auth.apiKey,
		headers: auth.headers,
	});
}

function extractAssistantText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reportError(area: string, error: unknown): void {
	const message = describeError(error);
	if (message.includes("This extension ctx is stale")) return;
	console.warn(`[pi-recap] ${area} failed: ${message}`);
}

async function generateTitle(pi: ExtensionAPI, ctx: TitleContext, prompt: string): Promise<void> {
	if (titlePromise) return titlePromise;

	titlePromise = (async () => {
		const firstPrompt = prompt.trim();
		currentFirstPrompt = firstPrompt;

		const model = pickModel(ctx);
		if (!model) {
			reportError("title", `${TITLE_MODEL_PROVIDER}/${TITLE_MODEL_ID} is not registered`);
			return;
		}

		try {
			const config = getRecapConfig(ctx);
			const response = await completeWithAuth(
				ctx,
				model,
				{
					systemPrompt: config.titlePrompt,
					messages: [
						{
							role: "user",
							content: `Create a concise 2-6 word title for this coding session. Make it specific and human-friendly. Do not reuse the user's phrasing. Output only the title.\n\nFirst prompt:\n${firstPrompt}`,
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: 256,
					reasoningEffort: "minimal",
				},
			);

			const cleaned = cleanSingleLine(extractAssistantText(response), "");
			if (wordCount(cleaned) >= 2 && !isGenericTitle(cleaned)) {
				currentTitle = cleaned.length > 48 ? `${cleaned.slice(0, 45).trimEnd()}…` : cleaned;
				persistState(pi, { title: currentTitle, firstPrompt: currentFirstPrompt ?? undefined, recap: currentRecap ?? undefined });
				updateUI(ctx);
			}
		} catch (error) {
			reportError("title", error);
		}
	})();

	try {
		await titlePromise;
	} finally {
		titlePromise = null;
	}
}

async function generateRecap(
	pi: ExtensionAPI,
	ctx: TitleContext,
	eventMessages?: unknown[],
	firstPromptOverride?: string | null,
	lastAssistantOverride?: string | null,
): Promise<void> {
	if (recapPromise) return recapPromise;

	recapPromise = (async () => {
		const firstPrompt = firstPromptOverride ?? currentFirstPrompt ?? (eventMessages ? getFirstUserPromptFromMessages(eventMessages) : null) ?? getFirstUserPrompt(ctx);
		const lastAssistant = lastAssistantOverride ?? (eventMessages ? getLastAssistantMessageFromMessages(eventMessages) : null) ?? getLastAssistantMessage(ctx);
		if (!firstPrompt || !lastAssistant) return;

		const recapKey = makeRecapKey(firstPrompt, lastAssistant);
		if (recapKey === lastRecapSourceKey) return;

		const model = pickModel(ctx);
		if (!model) {
			reportError("recap", `${TITLE_MODEL_PROVIDER}/${TITLE_MODEL_ID} is not registered`);
			return;
		}

		try {
			const config = getRecapConfig(ctx);
			const response = await completeWithAuth(
				ctx,
				model,
				{
					systemPrompt: config.recapPrompt,
					messages: [
						{
							role: "user",
							content: `Create the recap from this exchange. Prefer compact status-line wording like "Can create GitHub gists with gh" instead of "The user asks...".\n\nRequest:\n${firstPrompt}\n\nResult:\n${lastAssistant}`,
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: 256,
					reasoningEffort: "minimal",
				},
			);

			const recap = limitWords(cleanSingleLine(extractAssistantText(response), ""), config.maxWords);
			if (recap) {
				lastRecapSourceKey = recapKey;
				currentRecap = recap;
				persistState(pi, { title: currentTitle ?? undefined, firstPrompt: currentFirstPrompt ?? firstPrompt, recap: currentRecap });
				updateUI(ctx);
			}
		} catch (error) {
			reportError("recap", error);
		}
	})();

	try {
		await recapPromise;
	} finally {
		recapPromise = null;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const typedCtx = ctx as TitleContext;
		const state = getStoredState(typedCtx);
		lastRecapSourceKey = null;
		currentTitle = isGenericTitle(state.title) ? null : state.title ?? null;
		currentFirstPrompt = isGenericPrompt(state.firstPrompt) ? getFirstUserPrompt(typedCtx) : state.firstPrompt ?? getFirstUserPrompt(typedCtx);
		if (isLikelyHeuristicTitle(currentTitle, currentFirstPrompt)) currentTitle = null;
		currentRecap = isLikelyHeuristicRecap(state.recap) ? null : state.recap ?? null;

		updateUI(typedCtx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role !== "user") return;
		const typedCtx = ctx as TitleContext;
		const prompt = extractText(event.message.content).trim();
		if (!prompt || isGenericPrompt(prompt)) return;
		currentFirstPrompt = prompt;
		persistState(pi, { title: currentTitle ?? undefined, firstPrompt: currentFirstPrompt, recap: currentRecap ?? undefined });
		if (!currentTitle || isGenericTitle(currentTitle)) {
			await generateTitle(pi, typedCtx, prompt);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		await generateRecap(pi, ctx as TitleContext, event.messages, currentFirstPrompt);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATE_KEY, undefined);
	});
}
