import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { showRecap, createRetainedRecapUI } from "../index.ts";

function createUi(mode) {
	const document = new Container();
	for (let i = 0; i < 3; i++) document.addChild(new Container());
	const tui = { mode, children: [document], requestRender() {} };
	const theme = { fg: (_name, text) => text, bold: (text) => text };
	const widgets = new Map();
	const ui = {
		theme,
		setWidget(key, content, options) {
			widgets.get(key)?.component?.dispose?.();
			widgets.delete(key);
			if (content === undefined) return;
			const component = typeof content === "function" ? content(tui, theme) : undefined;
			widgets.set(key, { content, component, options });
		},
	};
	return { ctx: { ui }, document, widgets };
}

test("fullscreen recap is temporary transcript content", () => {
	const { ctx, document, widgets } = createUi("fullscreen");
	showRecap(ctx, "Temporary recap text.");

	assert.equal(document.children.length, 4);
	assert.match(document.children[3].render(80).join("\n"), /Temporary recap text/);
	assert.equal(widgets.get("session-recap").options.placement, "belowEditor");
	assert.deepEqual(widgets.get("session-recap").component.render(80), []);

	ctx.ui.setWidget("session-recap", undefined);
	assert.equal(document.children.length, 3);
});

test("regular mode keeps the above-editor recap", () => {
	const { ctx, document, widgets } = createUi("regular");
	showRecap(ctx, "Temporary recap text.");

	assert.equal(document.children.length, 3);
	assert.equal(widgets.get("session-recap").options.placement, "aboveEditor");
	assert.deepEqual(widgets.get("session-recap").content, ["✦ recap", "Temporary recap text."]);
});


test("retained rows use the current theme after invalidation and wrap natively", () => {
	const { ctx, document, widgets } = createUi("regular");
	const retained = createRetainedRecapUI(ctx);
	assert.equal(retained.add("The task is ready."), true);
	const row = document.children[2].children[0];
	assert.match(row.render(80).join("\n"), /The task is ready/);
	ctx.ui.theme = { fg: (_name, text) => `NEW ${text}`, bold: (text) => text };
	row.invalidate();
	assert.match(row.render(80).join("\n"), /NEW The task/);
	retained.dispose();
	assert.equal(document.children[2].children.length, 0);
	assert.equal(widgets.size, 0);
});
