import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap from "../index.ts";

const API = "recap-global-model-test";
const requests = [];
let respond = async () => ({ role: "assistant", content: [{ type: "text", text: "Complete recap." }], stopReason: "stop" });
const stream = (model) => {
	requests.push(model);
	return { result: () => respond() };
};
registerApiProvider({ api: API, stream, streamSimple: stream });

function model(provider, id, api = API) {
	return {
		provider, id, name: "Same display name", api, baseUrl: "http://localhost.invalid",
		reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function fixture(t) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	assert.ok(previous?.includes("pi-session-recap-tests-"), "run with the isolation preloader");
	const root = mkdtempSync(join(previous, "global-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	t.after(() => {
		process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	requests.length = 0;
	respond = async () => ({ role: "assistant", content: [{ type: "text", text: "Complete recap." }], stopReason: "stop" });
	const path = join(getAgentDir(), "session-recap.json");
	const active = model("anthropic", "claude-opus");
	const haiku = model("anthropic", "claude-haiku-4-5");
	const selected = model("router", "nested/model");
	const custom = model("bridge", "nested/model", "claude-bridge");
	const available = [haiku, selected, custom];
	const sourceEntry = { type: "message", message: { role: "user", content: "Build a safe recap." } };

	function instance() {
		const flags = new Map();
		const handlers = new Map();
		const commands = new Map();
		const notices = [];
		const dialogs = [];
		const widgets = [];
		const statuses = [];
		let choice = undefined;
		let authCalls = 0;
		const forbidden = () => assert.fail("picker must not mutate the main model or conversation");
		const pi = {
			on: (name, handler) => handlers.set(name, handler),
			registerFlag: (name, options) => flags.set(name, options.default),
			getFlag: (name) => flags.get(name),
			registerCommand: (name, command) => commands.set(name, command),
			setModel: forbidden, appendEntry: forbidden, sendMessage: forbidden, sendUserMessage: forbidden,
		};
		const ctx = {
			mode: "tui", hasUI: true, model: active, cwd: root,
			modelRegistry: {
				getAvailable: () => available,
				find: (provider, id) => available.find((m) => m.provider === provider && m.id === id),
				getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: "fixture-only" }; },
			},
			sessionManager: {
				getBranch: () => [sourceEntry],
				buildSessionProjection: () => ({ entries: [{ sourceEntry, messages: [sourceEntry.message] }] }),
			},
			ui: {
				select: async (title, options, opts) => {
					dialogs.push({ title, options, opts });
					return typeof choice === "function" ? choice(options) : choice;
				},
				notify: (message, type) => notices.push({ message, type }),
				setStatus: (_key, value) => statuses.push(value),
				setWidget(_key, content) {
					widgets.push(content);
					if (typeof content === "function") content({ mode: "regular", children: [] }, this.theme);
				},
				onTerminalInput: () => () => {},
				theme: { fg: (_name, text) => text, bold: (text) => text },
			},
		};
		sessionRecap(pi);
		return {
			ctx, notices, dialogs, widgets, statuses, flags, handlers, commands,
			setChoice: (value) => { choice = value; },
			pick: () => commands.get("recap").handler("model", ctx),
			recap: (args = "") => commands.get("recap").handler(args, ctx),
			get authCalls() { return authCalls; },
		};
	}
	function disk(value) {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(path, value);
	}
	return { root, path, active, haiku, selected, custom, available, instance, disk };
}

test("/recap routes model selection, completes its subcommand, and rejects unknown arguments without inference", async (t) => {
	const f = fixture(t);
	const s = f.instance();
	assert.deepEqual([...s.commands.keys()], ["recap"], "no legacy /recap-model alias");
	const complete = s.commands.get("recap").getArgumentCompletions;
	assert.deepEqual(complete(""), [{ value: "model", label: "model" }]);
	assert.deepEqual(complete("mo"), complete(""));
	assert.equal(complete("unknown"), null);

	await s.recap(" model ");
	assert.equal(s.dialogs.length, 1);
	for (const args of ["unknown", "model extra"]) {
		await s.recap(args);
		assert.deepEqual(s.notices.at(-1), { message: "Usage: /recap [model]", type: "warning" });
	}
	assert.equal(s.dialogs.length, 1);
	assert.equal(requests.length, 0);
	assert.equal(existsSync(f.path), false);
	await s.recap("  ");
	assert.equal(requests.length, 1, "bare /recap still generates a summary");
});

test("native picker uses all available provider/IDs, saves globally, and performs no inference", async (t) => {
	const f = fixture(t);
	const s = f.instance();
	s.handlers.get("session_start")({ reason: "startup" }, s.ctx);
	assert.equal(existsSync(getAgentDir()), false, "initialization/session start must not create config");
	s.setChoice("router/nested/model");
	await s.pick();
	assert.deepEqual(s.dialogs[0].options, ["Automatic (clear global default)", ...f.available.map((m) => `${m.provider}/${m.id}`)]);
	assert.match(s.dialogs[0].title, /saved: Automatic/);
	assert.match(s.dialogs[0].title, /does not guarantee.*custom APIs/);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { model: "router/nested/model" });
	assert.equal(existsSync(join(f.root, "session-recap.json")), false, "not cwd config");
	assert.deepEqual(requests, []);
	assert.equal(s.authCalls, 0);
	assert.equal(s.ctx.model, f.active);
	assert.deepEqual(readdirSync(getAgentDir()), ["session-recap.json"], "no leftover temp files");
	assert.equal(s.notices.at(-1).type, "info");
});

test("separate already-running instances reread saved defaults and Automatic reset on every recap", async (t) => {
	const f = fixture(t);
	const first = f.instance();
	const second = f.instance();
	await second.recap();
	assert.equal(requests.at(-1), f.haiku, "missing file preserves auto policy");
	first.setChoice("router/nested/model");
	await first.pick();
	await second.recap();
	assert.equal(requests.at(-1), f.selected);
	first.setChoice((options) => options[0]);
	await first.pick();
	assert.match(first.dialogs.at(-1).title, /saved: router\/nested\/model/);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {});
	await second.recap();
	assert.equal(requests.at(-1), f.haiku);
});

test("Escape/cancel does not create or modify a file or unrelated settings", async (t) => {
	const f = fixture(t);
	const s = f.instance();
	await s.pick();
	assert.equal(existsSync(getAgentDir()), false);
	const original = '{ "model": "router/nested/model" }\n';
	f.disk(original);
	const settings = join(getAgentDir(), "settings.json");
	writeFileSync(settings, '{"unrelated":true}\n');
	await s.pick();
	assert.equal(readFileSync(f.path, "utf8"), original);
	s.setChoice((options) => options[0]);
	await s.pick();
	assert.equal(readFileSync(settings, "utf8"), '{"unrelated":true}\n');
});

test("nonempty CLI wins over disk, including invalid explicit fallback; empty CLI uses disk", async (t) => {
	const f = fixture(t);
	f.disk('{"model":"router/nested/model"}');
	const s = f.instance();
	for (const spec of ["anthropic/claude-haiku-4-5", "bad", "/bad", "router/missing"]) {
		s.flags.set("recap-model", ` ${spec} `);
		await s.recap();
		assert.equal(requests.at(-1), spec.startsWith("anthropic/") ? f.haiku : f.active);
	}
	s.flags.set("recap-model", "  ");
	await s.recap();
	assert.equal(requests.at(-1), f.selected);
	s.flags.set("recap-model", "anthropic/claude-haiku-4-5");
	await s.pick();
	assert.match(s.dialogs.at(-1).title, /--recap-model anthropic\/claude-haiku-4-5 overrides/);
});

test("malformed JSON/schema and read failures safely use automatic selection with redacted warnings", async (t) => {
	const f = fixture(t);
	const s = f.instance();
	for (const value of ["private-credential-payload", "null", "[]", "4", '{"model":5}', '{"model":""}', '{"model":"no-slash"}', '{"model":"p/"}', '{"model":"p/\\u001bmodel"}']) {
		f.disk(value);
		await s.recap();
		assert.equal(requests.at(-1), f.haiku);
		assert.equal(s.notices.at(-1).type, "warning");
		assert.doesNotMatch(s.notices.at(-1).message, /private-credential|payload|ENOENT|EISDIR/);
		assert.equal(readFileSync(f.path, "utf8"), value, "invalid file is not rewritten");
	}
	rmSync(f.path);
	mkdirSync(f.path);
	await s.recap();
	assert.equal(requests.at(-1), f.haiku);
	assert.equal(s.notices.at(-1).type, "warning");
});

test("unknown saved model uses active fallback; runtime-only custom API stays listed and silently skipped", async (t) => {
	const f = fixture(t);
	const s = f.instance();
	f.disk('{"model":"router/gone"}');
	await s.recap();
	assert.equal(requests.at(-1), f.active);
	s.setChoice("bridge/nested/model");
	await s.pick();
	assert.ok(s.dialogs[0].options.includes("bridge/nested/model"));
	const before = requests.length;
	const notices = s.notices.length;
	await s.recap();
	assert.equal(requests.length, before);
	assert.equal(s.notices.length, notices);
});

test("failed atomic rename never confirms saved or destroys old state and cleans its temp file", async (t) => {
	const f = fixture(t);
	mkdirSync(f.path, { recursive: true });
	writeFileSync(join(f.path, "owned-test-sentinel"), "unchanged");
	const s = f.instance();
	s.setChoice("router/nested/model");
	await s.pick();
	assert.equal(s.notices.at(-1).type, "error");
	assert.equal(s.notices.at(-1).message, "session-recap: could not save global recap model");
	assert.equal(readFileSync(join(f.path, "owned-test-sentinel"), "utf8"), "unchanged");
	assert.deepEqual(readdirSync(getAgentDir()), ["session-recap.json"]);
});

test("parent path write failure is redacted and does not confirm success", async (t) => {
	const f = fixture(t);
	writeFileSync(getAgentDir(), "owned-test-file");
	const s = f.instance();
	s.setChoice("router/nested/model");
	await s.pick();
	assert.equal(s.notices.at(-1).type, "error");
	assert.doesNotMatch(JSON.stringify(s.notices), /owned-test-file|EEXIST|ENOTDIR|global recap model saved/);
});

for (const event of ["session_shutdown", "session_tree", "session_start", "input", "turn_start", "agent_start"]) {
	test(`${event} cancels picker and rejects late choice without writing or stale UI`, async (t) => {
		const f = fixture(t);
		f.disk('{"model":"anthropic/claude-haiku-4-5"}');
		const original = readFileSync(f.path, "utf8");
		const s = f.instance();
		const choice = Promise.withResolvers();
		s.setChoice(() => choice.promise);
		const pending = s.pick();
		const signal = s.dialogs[0].opts.signal;
		s.handlers.get(event)({ reason: "startup" }, s.ctx);
		assert.equal(signal.aborted, true);
		const updates = s.widgets.length + s.statuses.length + s.notices.length;
		choice.resolve("router/nested/model");
		await pending;
		assert.equal(readFileSync(f.path, "utf8"), original);
		assert.equal(s.widgets.length + s.statuses.length + s.notices.length, updates);
		assert.equal(requests.length, 0);
	});
}

test("picking cancels an in-flight recap and suppresses new recap work until dialog closes", async (t) => {
	const f = fixture(t);
	const s = f.instance();
	const response = Promise.withResolvers();
	respond = () => response.promise;
	const recap = s.recap();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests.length, 1);
	const choice = Promise.withResolvers();
	s.setChoice(() => choice.promise);
	const pending = s.pick();
	await s.recap();
	assert.equal(requests.length, 1);
	response.resolve({ role: "assistant", content: [{ type: "text", text: "Stale" }], stopReason: "stop" });
	await recap;
	assert.equal(s.widgets.some(Array.isArray), false);
	assert.equal(s.statuses.at(-1), undefined);
	choice.resolve(undefined);
	await pending;
	assert.equal(existsSync(f.path), false);
});

for (const mode of ["rpc", "print", "json"]) {
	test(`picker does not prompt or write in ${mode} mode`, async (t) => {
		const f = fixture(t);
		const s = f.instance();
		s.ctx.mode = mode;
		await s.pick();
		assert.equal(s.dialogs.length, 0);
		assert.equal(existsSync(getAgentDir()), false);
		assert.equal(requests.length, 0);
	});
}

test("available model IDs are not restricted to a hardcoded naming pattern", async (t) => {
	const f = fixture(t);
	const unusual = model("custom-provider", "nested/model name/");
	f.available.push(unusual);
	const s = f.instance();
	s.setChoice("custom-provider/nested/model name/");
	await s.pick();
	await s.recap();
	assert.equal(requests.at(-1), unusual);
});

test("a superseding picker owns cancellation and late old completion cannot clear it", async (t) => {
	const f = fixture(t);
	const s = f.instance();
	const firstChoice = Promise.withResolvers();
	const secondChoice = Promise.withResolvers();
	s.setChoice(() => firstChoice.promise);
	const first = s.pick();
	s.setChoice(() => secondChoice.promise);
	const second = s.pick();
	assert.equal(s.dialogs[0].opts.signal.aborted, true);
	firstChoice.resolve("bridge/nested/model");
	await first;
	await s.recap();
	assert.equal(requests.length, 0, "second picker still suppresses recap work");
	secondChoice.resolve("router/nested/model");
	await second;
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { model: "router/nested/model" });
	assert.equal(s.notices.length, 1);
});
