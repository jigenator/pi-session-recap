# pi-session-recap

A personal [Pi](https://pi.dev) extension that leaves a short “while you were away” orientation in the transcript. It states the high-level task, a recent result, and the next step or blocker after you return to one of several sessions.

The recap is UI only: it is not appended to the session, saved in conversation history, or sent to the main or recap model as conversation context. By default it disappears when input or agent work resumes. `/recap keep` can retain completed recaps onscreen during ordinary work.

## Install

While development is local, review and try the checkout without changing Pi configuration:

```bash
pi -e /absolute/path/to/pi-session-recap
```

After these changes are published to GitHub, a persistent install can use:

```bash
pi install git:github.com/jigenator/pi-session-recap
```

No install or live configuration change is performed by this repository’s test suite.

## Triggers

- **Away:** after 90 seconds of continuous terminal or Herdr-pane blur.
- **Turn ended while away:** after a short debounce, once Pi reaches `agent_settled` (after retries, compaction, or queued continuation).
- **Idle fallback:** 120 seconds after `turn_end` until a real focus event has been seen. Use this when the terminal or multiplexer does not forward focus reliably.
- **Orientation:** shortly after a session resumes or forks.
- **Manual:** `/recap` for a brief orientation, or `/recap detailed` for an on-demand breakdown of the current session. Both bypass the meaningful-activity gate.

Quick pane switches do not call a model. A draft is cancelled when new work starts, `/tree` changes branches, a session is replaced, extensions reload, or Pi shuts down. Temporary UI is cleared at those boundaries; kept rows survive new work but not session/branch resets. Late responses are discarded after cancellation or if the projected session context changed.

## Detailed recap and autocomplete

Run `/recap detailed` for a headed, bulleted breakdown from the beginning of the **current active session branch**: the goal and changing requests, earlier work, decisions, results/tests, useful files/artifacts, blockers, unfinished work and next actions. It asks the recap model to distinguish completed, proposed, unverified and failed work and ground claims in the supplied history. `/recap` and all automatic triggers remain brief; there is no saved detail preference.

Detailed input includes all available messages on that branch, including pre-compaction work, with Pi's latest branch-local context replacements/removals applied. It does not read other sessions or abandoned branches. Compaction and branch summaries are excluded because they can contain stale redacted content or abandoned-path work; system prompts and tool declarations are excluded too. Where summaries were excluded, the request tells the model to disclose that only available edited active-branch messages are covered: **summary-only/imported history cannot be reconstructed**. This is not an exhaustive audit of raw history. Request-local extension `context` transformations are not replayed; persisted `context_edit` entries are honored.

Type `/recap ` to see Pi's native suggestions: `model`, `keep`, and `detailed`. Type a prefix such as `/recap det` and press Tab to complete the suggested subcommand. Both recap modes use the same selected model/authentication, separate provider call, cancellation checks, and UI-only keep On/Off behavior. Neither the command operation nor its result is inserted into main-model history; recap text is never persisted by this extension.

## Flags

| Flag | Default | Purpose |
|---|---:|---|
| `--recap-away-seconds <n>` | `90` | Continuous blur before an away recap. |
| `--recap-idle-seconds <n>` | `120` | No-focus-event fallback after `turn_end`. |
| `--recap-disable-focus` | `false` | Disable DECSET `?1004`; idle fallback remains active. |
| `--recap-during-active` | `false` | Permit away recaps before the agent fully settles. |
| `--recap-disable` | `false` | Disable automatic recaps; `/recap` still works. |
| `--recap-model "<provider>/<id>"` | automatic | Explicit recap model; malformed or unknown IDs fall back to the active model. |

Durations are clamped to at least five seconds.

## Onscreen retention

Run `/recap keep` for Pi’s native **On / Off** choice, showing the current global preference. Escape cancels without saving or generating a recap. **Off** is the default. **On** keeps each subsequently completed recap as an ordinary chronological, wrapped transcript row in both regular and fullscreen modes. New input, agent turns, tool activity, notifications, and newer recaps do not replace earlier kept rows. Turning Off affects new recaps only; already-kept rows remain until the UI resets.

This is **keep onscreen only**, not saved history: all kept rows disappear on compaction or display rebuild (including some `/settings` changes), reload, shutdown, session replacement, or branch navigation. There is no restoration from disk. Pi 1.0’s verified private layout is used only to append to its chat container; if that layout no longer matches, the extension warns and falls back to temporary display rather than pinning or persisting the text.

The global boolean `keep` shares `<agent-dir>/session-recap.json` with the optional `model`, e.g. `{"model":"provider/id","keep":true}`. Both commands preserve the other setting, rereading it after the dialog before an atomic save; invalid/unreadable settings are not overwritten. Each newly displayed recap rereads retention, so running sessions sharing the agent directory see changes without watchers. No recap text is written to configuration, session entries, or model context.

## Model selection, privacy, and cost

Run `/recap model` to choose a global default from Pi’s available provider/model list. The picker shows the saved choice and any active CLI override; it never calls a model or changes Pi’s main model. Escape cancels without saving. **Automatic** clears the default and restores the existing automatic policy (unless overridden).

The choice is stored in `<agent-dir>/session-recap.json` as an optional `model` string alongside the optional `keep` boolean. Automatic removes only `model`, preserving retention (reset writes `{}` when no retention preference exists). The directory comes from Pi’s `getAgentDir()`: normally `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`, never project configuration or `settings.json`. Nothing is created on extension load. Each recap rereads the file, so already-running sessions sharing that directory see changes on their next recap; in-flight requests are not rerouted. Invalid/unreadable files warn without exposing their contents and use automatic model selection (unless overridden by `--recap-model`) and temporary display. Failed saves report an error, not success.

The extension uses Pi’s authentication for the selected provider and chooses, in order:

1. a nonempty `--recap-model` override;
2. the saved global default;
3. `anthropic/claude-haiku-4-5` for Anthropic sessions, when available;
4. a same-provider GPT-5.6 Luna model for GPT sessions, when available;
5. the active model.

If a selected model has no usable authentication, the recap is skipped, not rerouted to another provider. Malformed or unknown CLI overrides, and unknown saved model IDs, fall directly back to the active model rather than its cheaper sibling.

Pi 1.0 transcript system messages (including prompt sections and tool declarations) are excluded. A recap uses no tools, system prompt, skills, reasoning, or prompt-cache retention.

- **Brief:** output is limited to 256 tokens and normalized to a single paragraph. Input remains the latest 30 projected messages (extended backward when necessary to retain a tool-call boundary), plus the initial request and active compaction or branch summary. Long initial-request framing retains its first/last 4,000 characters.
- **Detailed:** output preserves headings/bullets/newlines and allows up to 4,096 tokens, capped by the selected model's declared output maximum. Input spans the edited active branch without a message-window bound or initial-request truncation; summaries are excluded as described above.
- **Both:** each long tool-result text block retains its first/last 2,000 characters with a truncation marker. There is no hard total-input-token budget: ordinary messages, tool calls, images, and (for brief recaps) summaries can still be large. A long detailed session may exceed the selected provider's context limit and fail; there is no automatic chunking, retry, extra summarization call, or silent fallback to recent-only history.

Only a clean `stopReason: "stop"` is displayed; failed, aborted, deferred, tool-use, pending, and token-limit-truncated responses are discarded. Errors are reported without provider details.

A Pi-only custom API handler (for example, a runtime-only `claude-bridge` handler) cannot be routed by the standalone `pi-ai` compatibility completion. That case is skipped silently. Being listed in Pi’s picker is not proof of standalone recap compatibility; custom APIs are not filtered out. Select a built-in API-backed provider/model with `/recap model` or `--recap-model` if one is available. OpenAI Codex and Google models using built-in Pi API types are supported by the same completion path.

Every generated recap is one separate provider request and may incur cost; detailed recaps can cost more because they send more history. `--recap-disable`, longer timers, or a cheaper explicit model are the available controls.

## Pi 1.0 and Herdr status

This checkout typechecks and loads against installed `@earendil-works/pi-*` **1.0.0**. It uses Pi 1.0’s canonical `buildSessionProjection()`, final `agent_settled` boundary, `session_shutdown` cleanup, and `ctx.ui.onTerminalInput()` ownership rather than attaching its own stdin listener.

Herdr findings are deliberately separated:

- **Source-supported:** installed Herdr 0.9.3 corresponds to source commit `7b116c05bfda646af39d2524c54e70c751f57ee8`. Its [focus synchronization](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api.rs#L842) sends `CSI O` to the pane losing focus and `CSI I` to the pane gaining focus, but only when the pane application enabled DECSET `?1004`; its source includes pane-switch and outer-window-focus tests. Client-local navigation uses [separate focus reconciliation](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/server/headless/client_views.rs#L420), so not every client movement implies a global pane transition. This extension enables that mode while its Pi session is active.
- **Not runtime-verified here:** no existing Herdr pane was focused, renamed, reloaded, reset, or otherwise touched, and no live pane-switch acceptance test was run. Multi-client/local-view focus semantics can differ from a single-client pane switch.
- **Fallback:** window focus and pane focus are different signals. If the active setup does not deliver reliable pane transitions, pass `--recap-disable-focus` so the explicit 120-second idle fallback remains authoritative.

## Development checks

All model responses in tests are local mocks; the suite performs no inference and reads no real credentials or transcripts. The test preloader sets `PI_CODING_AGENT_DIR` to an owned temporary directory and removes it on exit, isolating all tests from the real global recap setting.

```bash
npm install --ignore-scripts
npm run check
npm pack --dry-run --json
```

## Provenance

Imported from Thomas Mustier’s MIT-licensed [`session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap) at exact upstream commit [`4a63a2ebd3683d86597e226c7ff778ea4837dd73`](https://github.com/tmustier/pi-extensions/commit/4a63a2ebd3683d86597e226c7ff778ea4837dd73), released upstream as `@tmustier/pi-session-recap` 0.5.1 on 2026-09-22. The imported revision is the merged compatibility PR [#112](https://github.com/tmustier/pi-extensions/pull/112), targets Pi 0.87, and does **not** contain PR [#106](https://github.com/tmustier/pi-extensions/pull/106) (`0c9b11657af023a6d1c064d04e95a1456301f3ff` was not an ancestor and the PR remained open as of 2026-10-01).

This fork integrates the still-needed #106 response-validity fix and focused regressions, with credit to **Serge Baranov (`CrazyCoder`)**, then adapts lifecycle and terminal-input ownership for Pi 1.0. Provider error details are intentionally redacted beyond that patch. The original MIT copyright and full license are in [LICENSE](./LICENSE); the imported release history is retained in [CHANGELOG.md](./CHANGELOG.md).
