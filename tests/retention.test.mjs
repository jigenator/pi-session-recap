import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { registerApiProvider } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { stopThemeWatcher } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createRetainedRecapUI } from "../index.ts";

const API = "recap-retention-test";
let response = async () => ({ role: "assistant", content: [{ type: "text", text: "Kept orientation. " + "界 task result next step ".repeat(8) }], stopReason: "stop" });
const requests = [];
const stream = (_model, context, options) => {
	requests.push({ context, options });
	return { result: () => response() };
};
registerApiProvider({ api: API, stream, streamSimple: stream });

async function fixture(t, mode) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	assert.ok(previous?.includes("pi-session-recap-tests-"));
	const root = mkdtempSync(join(previous, "retention-"));
	process.env.PI_CODING_AGENT_DIR = root;
	const path = join(root, "session-recap.json");
	const settings = (keep) => writeFileSync(path, JSON.stringify({ keep }));
	requests.length = 0;
	response = async () => ({ role: "assistant", content: [{ type: "text", text: "Kept orientation. " + "界 task result next step ".repeat(8) }], stopReason: "stop" });
	const branch = [{ type: "message", message: { role: "user", content: "Build the feature", timestamp: 1 } }];
	const before = JSON.stringify(branch);
	const model = { provider: "retention", id: "fixture", api: API, name: "fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const manager = {
		getCwd: () => root,
		getBranch: () => branch,
		buildContextEntries: () => branch,
		buildSessionProjection: () => ({ entries: branch.map((sourceEntry) => ({ sourceEntry, messages: [sourceEntry.message] })) }),
	};
	const terminal = { columns: 80, rows: 24, write: () => assert.fail("no terminal writes in offline probe") };
	const session = {
		settingsManager: SettingsManager.inMemory({ theme: "dark", showCacheMissNotices: false }),
		sessionManager: manager, autoCompactionEnabled: false,
		resourceLoader: { getThemes: () => ({ themes: [] }) },
		extensionRunner: { getMarkdownTransformers: () => [] },
		modelRuntime: {},
		getSteeringMessages: () => [], getFollowUpMessages: () => [], getToolDefinition: () => undefined,
	};
	// Actual installed host constructor, widget ownership and mount methods;
	// no init/start, session, credentials, terminal IO or inference.
	const host = new InteractiveMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {} }, { tuiMode: mode, terminal });
	host.renderer.stopped = true; // Probe component tree only, never run the terminal renderer.
	host.fullscreenLayoutRoot = createChatViewport({ document: host.documentContainer, pendingMessages: host.pendingMessagesContainer, status: host.statusContainer, editor: host.editorContainer, footer: host.footerContainer }).root;
	host.mountInteractiveTui(host.renderer, [host.documentContainer, host.pendingMessagesContainer, host.statusContainer, host.widgetContainerAbove, host.editorContainer, host.widgetContainerBelow, host.footerContainer]);
	host.isInitialized = true;
	host.workingVisible = false;
	assert.equal(host.ui.children[0], host.documentContainer);
	assert.deepEqual(host.documentContainer.children, [host.headerContainer, host.loadedResourcesContainer, host.chatContainer]);
	const ui = host.createExtensionUIContext();
	const ctx = { ui, mode: "tui", hasUI: true, sessionManager: manager, model, modelRegistry: { getAvailable: () => [], find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) } };
	const loaded = await loadExtensions([new URL("../index.ts", import.meta.url).pathname], root);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	const commands = extension.commands;
	const handlers = new Map([...extension.handlers].map(([name, callbacks]) => [name, (...args) => {
		for (const callback of callbacks) callback(...args);
	}]));
	t.after(() => {
		handlers.get("session_shutdown")({}, ctx);
		host.clearExtensionWidgets();
		host.themeController.dispose();
		host.footerDataProvider.dispose();
		stopThemeWatcher();
		assert.equal(JSON.stringify(branch), before);
		process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	return { host, ctx, settings, path, handlers, recap: () => commands.get("recap").handler("", ctx), configure: (args) => commands.get("recap").handler(args, ctx), text: () => host.chatContainer.render(80).join("\n") };
}

for (const mode of ["fullscreen", "regular"]) {
	test(`${mode}: retained chronological rows survive new input/agent/turn/tool activity and another recap`, async (t) => {
		const f = await fixture(t, mode);
		f.settings(true);
		await f.recap();
		const first = f.host.chatContainer.children[0];
		assert.match(first.render(80).join("\n"), /Kept orientation/);
		f.ctx.ui.notify("Later notice", "info");
		f.ctx.ui.notify("Coalesced later notice", "info");
		for (const event of ["input", "agent_start", "turn_start"]) f.handlers.get(event)({}, f.ctx);
		await f.host.handleEvent({ type: "agent_start" });
		await f.host.handleEvent({ type: "turn_start" });
		await f.host.handleEvent({ type: "message_start", message: { role: "user", content: "Later chat", timestamp: 2 } });
		await f.host.handleEvent({ type: "message_start", message: { role: "assistant", content: [], timestamp: 3 } });
		await f.host.handleEvent({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "offline fixture" } });
		await f.host.handleEvent({ type: "tool_execution_end", toolCallId: "call", result: { content: [{ type: "text", text: "offline result" }], details: undefined }, isError: false });
		await f.recap();
		assert.equal(f.host.chatContainer.children[0], first);
		const text = f.text();
		assert.equal((text.match(/Kept orientation/g) ?? []).length, 2);
		assert.ok(text.indexOf("Kept orientation") < text.indexOf("Later chat"));
		assert.ok(text.indexOf("Later chat") < text.lastIndexOf("Kept orientation"));
		assert.equal(f.host.documentContainer.children.length, 3, "not appended after chat/pinned");
		assert.equal(f.host.extensionWidgetsBelow.size, 1, "one disposal owner, no per-recap widgets");
		assert.doesNotMatch(JSON.stringify(requests), /Kept orientation|Later chat|offline result/, "visible rows never enter recap model context");
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { keep: true }, "no recap text on disk");
		for (const line of first.render(20)) assert.ok(visibleWidth(line) <= 20, "native wrapping handles wide text");
	});

	for (const event of ["session_shutdown", "session_start", "session_tree"]) {
		test(`${mode}: ${event} disposes kept rows and stale in-flight responses`, async (t) => {
			const f = await fixture(t, mode);
			f.settings(true);
			await f.recap();
			const late = Promise.withResolvers();
			response = () => late.promise;
			const pending = f.recap();
			await new Promise((resolve) => setImmediate(resolve));
			f.handlers.get(event)({ reason: "startup" }, f.ctx);
			assert.doesNotMatch(f.text(), /Kept orientation/);
			late.resolve({ role: "assistant", content: [{ type: "text", text: "Late orientation" }], stopReason: "stop" });
			await pending;
			assert.doesNotMatch(f.text(), /Late orientation/);
			assert.equal(f.host.extensionWidgetsBelow.size, 0);
		});
	}

	test(`${mode}: host reload disposal and transcript rebuild remove rows safely`, async (t) => {
		const f = await fixture(t, mode);
		f.settings(true);
		await f.recap();
		f.host.rebuildChatFromMessages();
		assert.doesNotMatch(f.text(), /Kept orientation/);
		f.host.widgetContainerBelow.render(80); // prunes detached rows
		await f.recap();
		assert.equal((f.text().match(/Kept orientation/g) ?? []).length, 1);
		f.host.clearExtensionWidgets(); // resetExtensionUI's actual reload disposal
		assert.doesNotMatch(f.text(), /Kept orientation/);
		f.handlers.get("session_start")({ reason: "reload" }, f.ctx);
		await f.recap();
		assert.equal((f.text().match(/Kept orientation/g) ?? []).length, 1);
	});

	test(`${mode}: actual host compaction clears UI-only rows without restoration`, async (t) => {
		const f = await fixture(t, mode);
		f.settings(true);
		await f.recap();
		const entries = f.ctx.sessionManager.buildContextEntries();
		f.ctx.sessionManager.buildContextEntries = () => [{ type: "compaction", summary: "Offline summary", tokensBefore: 100 }, ...entries];
		await f.host.handleEvent({ type: "compaction_end", reason: "manual", result: { summary: "Offline summary", tokensBefore: 100 } });
		assert.doesNotMatch(f.text(), /Kept orientation/);
		f.host.widgetContainerBelow.render(80);
		await f.recap();
		assert.equal((f.text().match(/Kept orientation/g) ?? []).length, 1);
	});

	test(`${mode}: native keep selector accepts On, Escape cancels without generation`, async (t) => {
		const f = await fixture(t, mode);
		const pending = f.configure("keep");
		assert.ok(f.host.extensionSelector);
		f.host.extensionSelector.handleInput("\x1b");
		await pending;
		assert.equal(requests.length, 0);
		const on = f.configure("keep");
		f.host.extensionSelector.handleInput("\n");
		await on;
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { keep: true });
		assert.equal(requests.length, 0);
	});

	test(`${mode}: default stays ephemeral; global off affects only new rows`, async (t) => {
		const f = await fixture(t, mode);
		await f.recap();
		f.handlers.get("input")({}, f.ctx);
		assert.doesNotMatch(f.text(), /Kept orientation/);
		assert.equal(f.host.extensionWidgetsAbove.size, 0);
		f.settings(true);
		await f.recap();
		const first = f.host.chatContainer.children[0];
		f.settings(false);
		await f.recap();
		f.handlers.get("turn_start")({}, f.ctx);
		assert.equal(f.host.chatContainer.children[0], first);
		assert.equal((f.text().match(/Kept orientation/g) ?? []).length, 1);
	});

	test(`${mode}: unsupported layout warns and falls back to disposable temporary UI`, async (t) => {
		const f = await fixture(t, mode);
		f.settings(true);
		f.host.documentContainer.addChild(new Container());
		await f.recap();
		assert.match(f.text(), /transcript layout unsupported/);
		assert.doesNotMatch(f.text(), /Kept orientation/);
		assert.equal(f.host.extensionWidgetsBelow.has("session-recap-kept"), false);
		const rendered = () => [f.host.documentContainer, f.host.widgetContainerAbove]
			.flatMap((component) => component.render(80)).join("\n");
		assert.match(rendered(), /Kept orientation/);
		f.handlers.get("input")({}, f.ctx);
		assert.doesNotMatch(rendered(), /Kept orientation/);
	});

	test(`${mode}: retention is read at display time even when global changes during generation`, async (t) => {
		const f = await fixture(t, mode);
		f.settings(false);
		const late = Promise.withResolvers();
		response = () => late.promise;
		const pending = f.recap();
		await new Promise((resolve) => setImmediate(resolve));
		f.settings(true);
		late.resolve({ role: "assistant", content: [{ type: "text", text: "New global state" }], stopReason: "stop" });
		await pending;
		f.handlers.get("input")({}, f.ctx);
		assert.match(f.text(), /New global state/);
	});
}

test("unsupported layout fails closed without adding nodes", () => {
	const document = new Container();
	document.addChild(new Container());
	const widgets = new Map();
	const ctx = { ui: { setWidget(key, factory) { widgets.get(key)?.dispose(); widgets.delete(key); if (factory) widgets.set(key, factory({ mode: "regular", children: [document] })); } } };
	const retained = createRetainedRecapUI(ctx);
	assert.equal(retained.add("Cannot retain"), false);
	assert.equal(document.children.length, 1);
	retained.dispose();
	retained.dispose();
	assert.equal(widgets.size, 0);
});
