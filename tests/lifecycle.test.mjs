import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap from "../index.ts";

const API = "session-recap-lifecycle-test";
let responseFactory = async () => ({
	role: "assistant",
	content: [{ type: "text", text: "Complete recap." }],
	stopReason: "stop",
});
let requestCount = 0;

function stubStream() {
	requestCount += 1;
	return { result: () => responseFactory() };
}

registerApiProvider({ api: API, stream: stubStream, streamSimple: stubStream });

function makePi() {
	const commands = new Map();
	const handlers = new Map();
	const flags = new Map();
	return {
		commands,
		handlers,
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerFlag(name, options) {
			flags.set(name, options.default);
		},
		getFlag(name) {
			return flags.get(name);
		},
	};
}

function makeContext() {
	const branch = [
		{ type: "message", message: { role: "user", content: "Build a safe recap extension." } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I completed enough meaningful work to draft an orientation recap for this session now. ".repeat(3) }],
			},
		},
	];
	const widgets = [];
	const statuses = [];
	return {
		widgets,
		statuses,
		ctx: {
			mode: "tui",
			hasUI: true,
			model: {
				id: "lifecycle-model",
				name: "Lifecycle model",
				api: API,
				provider: "lifecycle",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
			modelRegistry: {
				find: () => undefined,
				getAvailable: () => [],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-only" }),
			},
			sessionManager: {
				getBranch: () => branch,
				buildSessionProjection: () => ({
					entries: branch.map((sourceEntry) => ({ sourceEntry, messages: [sourceEntry.message] })),
				}),
			},
			ui: {
				onTerminalInput: () => () => {},
				notify() {},
				setStatus(_key, value) {
					statuses.push(value);
				},
				setWidget(_key, content) {
					widgets.push(content);
					if (typeof content === "function") content({ mode: "regular", children: [] }, this.theme);
				},
				theme: { fg: (_name, text) => text, bold: (text) => text },
			},
		},
	};
}

for (const reason of ["resume", "fork"]) {
	test(`${reason} generates an orientation for meaningful activity`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		requestCount = 0;
		const pi = makePi();
		const { ctx, widgets } = makeContext();
		sessionRecap(pi);
		pi.handlers.get("session_start")({ reason }, ctx);
		t.mock.timers.tick(300);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(requestCount, 1);
		assert.ok(widgets.some(Array.isArray));
		pi.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
	});
}

for (const event of ["session_shutdown", "session_tree", "input"]) {
	test(`${event} cancels a delayed resume recap`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		requestCount = 0;
		const pi = makePi();
		const { ctx } = makeContext();
		sessionRecap(pi);

		pi.handlers.get("session_start")({ reason: "resume" }, ctx);
		pi.handlers.get(event)({}, ctx);
		t.mock.timers.tick(300);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(requestCount, 0, "cancelled resume work must not request a recap");
	});
}

test("shutdown prevents a late recap from rendering into a replacement session", async () => {
	requestCount = 0;
	const response = Promise.withResolvers();
	responseFactory = () => response.promise;
	const pi = makePi();
	const { ctx, widgets, statuses } = makeContext();
	sessionRecap(pi);

	const pending = pi.commands.get("recap").handler("", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requestCount, 1);

	pi.handlers.get("session_shutdown")({ reason: "resume" }, ctx);
	response.resolve({
		role: "assistant",
		content: [{ type: "text", text: "This belongs to the old session." }],
		stopReason: "stop",
	});
	await pending;

	assert.equal(
		widgets.some((content) => Array.isArray(content)),
		false,
		"an aborted old-session request must not render recap content",
	);
	assert.equal(widgets.at(-1), undefined, "shutdown clears owned recap UI");
	assert.equal(statuses.at(-1), undefined, "shutdown clears owned status UI");
});

test("tree navigation clears visible UI and discards pending work even for identical context", async () => {
	requestCount = 0;
	const pi = makePi();
	const { ctx, widgets, statuses } = makeContext();
	sessionRecap(pi);
	await pi.commands.get("recap").handler("", ctx);
	assert.ok(widgets.some(Array.isArray));

	const response = Promise.withResolvers();
	responseFactory = () => response.promise;
	const pending = pi.commands.get("recap").handler("", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	pi.handlers.get("session_tree")({ oldLeafId: "old", newLeafId: "new" }, ctx);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(statuses.at(-1), undefined);
	const updates = widgets.length;

	response.resolve({ role: "assistant", content: [{ type: "text", text: "Old branch recap." }], stopReason: "stop" });
	await pending;
	assert.equal(widgets.length, updates, "identical text on another branch must not admit old work");
});

test("idle fallback does not duplicate a pending manual request", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	requestCount = 0;
	const response = Promise.withResolvers();
	responseFactory = () => response.promise;
	const pi = makePi();
	const { ctx } = makeContext();
	sessionRecap(pi);
	const pending = pi.commands.get("recap").handler("", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	pi.handlers.get("turn_end")({}, ctx);
	t.mock.timers.tick(120_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requestCount, 1);
	pi.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
	response.resolve({ role: "assistant", content: [], stopReason: "aborted" });
	await pending;
});

test("shutdown during authentication does not start a model request afterward", async () => {
	requestCount = 0;
	const auth = Promise.withResolvers();
	const pi = makePi();
	const { ctx } = makeContext();
	ctx.modelRegistry.getApiKeyAndHeaders = () => auth.promise;
	sessionRecap(pi);
	const pending = pi.commands.get("recap").handler("", ctx);
	pi.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
	auth.resolve({ ok: true, apiKey: "fixture-only" });
	await pending;
	assert.equal(requestCount, 0);
});

test("Pi 1.0 terminal-input listener and focus mode are released on shutdown", () => {
	const pi = makePi();
	const { ctx } = makeContext();
	let unsubscribed = 0;
	let listener;
	ctx.ui.onTerminalInput = (handler) => {
		listener = handler;
		return () => {
			unsubscribed += 1;
		};
	};

	const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const originalWrite = process.stdout.write;
	const writes = [];
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	process.stdout.write = (value) => {
		writes.push(String(value));
		return true;
	};
	try {
		sessionRecap(pi);
		pi.handlers.get("session_start")({ reason: "startup" }, ctx);
		assert.equal(typeof listener, "function");
		pi.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
	} finally {
		process.stdout.write = originalWrite;
		if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
		else delete process.stdout.isTTY;
		if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
		else delete process.stdin.isTTY;
	}

	assert.equal(unsubscribed, 1);
	assert.deepEqual(writes, ["\x1b[?1004h", "\x1b[?1004l"]);
});
