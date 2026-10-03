import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import sessionRecap from "../index.ts";

const API = "recap-detailed-test";
let requests = [];
let respond;
const output = "## Work so far\n\n- Completed early work.\n- Proposed later work.\n\n## Next actions\n- Rerun tests.";
const stream = (model, context, options) => {
	requests.push({ model, context, options });
	return { result: () => respond() };
};
registerApiProvider({ api: API, stream, streamSimple: stream });

function fixture(t) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	assert.ok(previous?.includes("pi-session-recap-tests-"));
	const root = mkdtempSync(join(previous, "detailed-"));
	process.env.PI_CODING_AGENT_DIR = root;
	const path = join(root, "session-recap.json");
	const commands = new Map(), handlers = new Map(), flags = new Map();
	const widgets = [], notices = [], authModels = [];
	requests = [];
	respond = async () => ({ role: "assistant", content: [{ type: "text", text: `\n${output}\n` }], stopReason: "stop" });
	const manager = SessionManager.inMemory(root);
	const initial = manager.appendMessage({ role: "user", content: "Original goal", timestamp: 1 });
	const early = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Early result" }], timestamp: 2 });
	for (let i = 0; i < 35; i++) manager.appendMessage({ role: "user", content: `Later request ${i}`, timestamp: i + 3 });
	const model = { id: "selected", provider: "fixture", name: "fixture", api: API, reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const forbidden = () => assert.fail("recap must not write main history or change its model");
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerFlag: (name, options) => flags.set(name, options.default),
		getFlag: (name) => flags.get(name),
		appendEntry: forbidden, sendMessage: forbidden, sendUserMessage: forbidden, setModel: forbidden,
	};
	const ctx = {
		mode: "tui", hasUI: true, model, sessionManager: manager,
		modelRegistry: {
			find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
			getAvailable: () => [],
			getApiKeyAndHeaders: async (selected) => { authModels.push(selected); return { ok: true, headers: { "fixture-header": "fixture-value" }, env: { FIXTURE: "1" } }; },
		},
		ui: {
			setStatus() {}, onTerminalInput: () => () => {},
			notify: (message, type) => notices.push({ message, type }),
			setWidget(_key, content) {
				widgets.push(content);
				if (typeof content === "function") content({ mode: "regular", children: [] }, this.theme);
			},
			theme: { fg: (_name, text) => text, bold: (text) => text },
		},
	};
	sessionRecap(pi);
	t.after(() => {
		handlers.get("session_shutdown")({}, ctx);
		process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, path, manager, initial, early, model, ctx, flags, widgets, notices, handlers, authModels, command: commands.get("recap"), recap: (args = "detailed") => commands.get("recap").handler(args, ctx) };
}

test("detailed is one separate multiline call with selected auth, no writes or saved mode; next ordinary recap stays brief", async (t) => {
	const f = fixture(t);
	writeFileSync(f.path, '{"model":"fixture/selected","keep":false}\n');
	f.ctx.model = { ...f.model, id: "main-model" };
	const before = JSON.stringify(f.manager.getEntries());
	const settings = readFileSync(f.path, "utf8");
	await f.recap(" detailed ");
	assert.equal(requests.length, 1);
	const request = requests[0];
	assert.equal(request.model, f.model);
	assert.equal(f.authModels[0], f.model);
	assert.deepEqual(request.options.headers, { "fixture-header": "fixture-value" });
	assert.deepEqual(request.options.env, { FIXTURE: "1" });
	assert.equal(request.options.reasoning, undefined);
	assert.equal(request.options.cacheRetention, "none");
	assert.equal(request.options.maxTokens, 4096);
	assert.equal(request.context.systemPrompt, undefined, "compat strips the empty legacy system prompt");
	assert.equal(request.context.messages.some((message) => message.role === "system"), false);
	assert.equal(request.context.tools, undefined);
	assert.equal(request.context.messages.length, 38);
	assert.match(JSON.stringify(request.context), /Early result/);
	assert.match(request.context.messages.at(-1).content[0].text, /changing requests.*earlier work/);
	assert.deepEqual(f.widgets.filter(Array.isArray), [["✦ recap", output]]);
	await f.recap("");
	assert.equal(requests.length, 2);
	assert.equal(requests[1].options.maxTokens, 256);
	assert.match(requests[1].context.messages.at(-1).content[0].text, /exactly 1-3 short sentences/);
	assert.doesNotMatch(JSON.stringify(requests[1].context), /Early result|Completed early work/);
	assert.deepEqual(f.widgets.filter(Array.isArray).at(-1), ["✦ recap", output.replace(/\s+/g, " ")]);
	assert.equal(JSON.stringify(f.manager.getEntries()), before);
	assert.equal(readFileSync(f.path, "utf8"), settings);
	assert.equal(f.ctx.model.id, "main-model");
	assert.deepEqual(readdirSync(f.root), ["session-recap.json"]);
});

test("detailed respects a smaller selected output maximum and joins text blocks with newlines", async (t) => {
	const f = fixture(t);
	f.model.maxTokens = 2048;
	respond = async () => ({ content: [{ type: "text", text: "## Goal" }, { type: "text", text: "- Result" }], stopReason: "stop" });
	await f.recap();
	assert.equal(requests[0].options.maxTokens, 2048);
	assert.deepEqual(f.widgets.filter(Array.isArray), [["✦ recap", "## Goal\n\n- Result"]]);
	assert.deepEqual(readdirSync(f.root), []);
});

test("only the current branch is reconstructed, never abandoned raw or summary history", async (t) => {
	const f = fixture(t);
	f.manager.appendMessage({ role: "user", content: "ABANDONED RAW", timestamp: 100 });
	f.manager.branchWithSummary(f.initial, "ABANDONED SUMMARY");
	f.manager.appendMessage({ role: "user", content: "New active work", timestamp: 101 });
	const before = JSON.stringify(f.manager.getEntries());
	await f.recap();
	assert.doesNotMatch(JSON.stringify(requests[0].context), /ABANDONED|Early result|Later request/);
	assert.match(JSON.stringify(requests[0].context), /Original goal|New active work/);
	assert.match(JSON.stringify(requests[0].context), /Summary-only\/imported history/);
	assert.equal(JSON.stringify(f.manager.getEntries()), before);
});

test("a late detailed response is rejected after an early pre-compaction context edit", async (t) => {
	const f = fixture(t);
	f.manager.appendCompaction("Summary without early detail", f.manager.getLeafId(), 100);
	const late = Promise.withResolvers();
	respond = () => late.promise;
	const pending = f.recap();
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(JSON.stringify(requests[0].context), /Early result/);
	f.manager.appendContextEdit(f.early, { content: "Revised early result" });
	late.resolve({ content: [{ type: "text", text: "Stale detailed output" }], stopReason: "stop" });
	await pending;
	assert.equal(f.widgets.filter(Array.isArray).length, 0);
});

for (const event of ["input", "turn_start", "agent_start", "session_tree", "session_start", "session_shutdown"]) {
	test(`detailed ${event} cancellation discards late UI`, async (t) => {
		const f = fixture(t);
		const late = Promise.withResolvers();
		respond = () => late.promise;
		const pending = f.recap();
		await new Promise((resolve) => setImmediate(resolve));
		f.handlers.get(event)({ reason: "startup" }, f.ctx);
		assert.equal(requests[0].options.signal.aborted, true);
		late.resolve({ content: [{ type: "text", text: output }], stopReason: "stop" });
		await pending;
		assert.equal(f.widgets.filter(Array.isArray).length, 0);
		assert.deepEqual(readdirSync(f.root), []);
	});
}

test("automatic idle stays brief after detailed; no hidden extra requests", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture(t);
	await f.recap();
	f.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Meaningful result with enough words. ".repeat(10) }], timestamp: 100 });
	f.handlers.get("turn_end")({}, f.ctx);
	t.mock.timers.tick(120000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests.length, 2);
	assert.equal(requests[1].options.maxTokens, 256);
	assert.match(requests[1].context.messages.at(-1).content[0].text, /exactly 1-3/);
});

for (const reason of ["error", "length", "aborted", "pending", "toolUse", "deferred"]) {
	test(`detailed ${reason} never shows partial output or retries`, async (t) => {
		const f = fixture(t);
		respond = async () => ({ content: [{ type: "text", text: "Partial private output" }], stopReason: reason, errorMessage: "private provider details" });
		await f.recap();
		assert.equal(requests.length, 1);
		assert.equal(f.widgets.filter(Array.isArray).length, 0);
		assert.doesNotMatch(JSON.stringify(f.notices), /private|Partial/);
	});
}

test("native autocomplete lists recap subcommands and Tab completes every prefix", async (t) => {
	const f = fixture(t);
	const provider = new CombinedAutocompleteProvider([{ name: "recap", ...f.command }], f.root);
	const options = { signal: new AbortController().signal };
	const suggestions = await provider.getSuggestions(["/recap "], 0, 7, options);
	assert.deepEqual(suggestions.items.map((item) => item.value), ["model", "keep", "detailed"]);
	const identity = (text) => text;
	for (const [prefix, expected] of [["mo", "model"], ["ke", "keep"], ["det", "detailed"]]) {
		const editor = new Editor({ requestRender() {} }, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } });
		editor.setAutocompleteProvider(provider);
		for (const character of `/recap ${prefix}`) editor.handleInput(character);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(editor.isShowingAutocomplete(), true, "typing uses native subcommand suggestions");
		editor.handleInput("\t");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(editor.getText().trimEnd(), `/recap ${expected}`);
		editor.handleInput("\x1b");
	}
	assert.equal(requests.length, 0);
});
