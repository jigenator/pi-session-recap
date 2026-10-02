# pi-session-recap

A personal [Pi](https://pi.dev) extension that leaves a short, temporary “while you were away” orientation at the end of the transcript. It states the high-level task, a recent result, and the next step or blocker after you return to one of several sessions.

The recap is UI only: it is not appended to the session, saved in conversation history, or sent to the main agent model. It disappears when input or agent work resumes.

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
- **Manual:** `/recap`, which bypasses the meaningful-activity gate.

Quick pane switches do not call a model. A draft is cancelled and its UI is cleared when new work starts, `/tree` changes branches, a session is replaced, extensions reload, or Pi shuts down. Late responses are discarded after cancellation or if the projected session context changed.

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

## Model selection, privacy, and cost

The extension reuses Pi’s active provider authentication and chooses, in order:

1. a `--recap-model` override found in Pi’s model registry;
2. `anthropic/claude-haiku-4-5` for Anthropic sessions, when available;
3. a same-provider GPT-5.6 Luna model for GPT sessions, when available;
4. the active model.

If a selected model has no usable authentication, the recap is skipped, not rerouted to another provider. Invalid overrides fall directly back to the active model rather than its cheaper sibling.

Pi 1.0 transcript system messages (including prompt sections and tool declarations) are excluded. A recap uses no tools, system prompt, skills, reasoning, or prompt-cache retention. Output is limited to 256 tokens. Input is the latest 30 projected messages, with bounded beginning/end excerpts for large tool results and initial requests, plus the active compaction or branch summary. This is a message-window bound, not a hard total-token budget: ordinary messages, images, and summaries can still be large. Only a clean `stopReason: "stop"` is displayed; failed, aborted, deferred, tool-use, pending, and token-limit-truncated responses are discarded. Errors are reported without provider details.

A Pi-only custom API handler (for example, a runtime-only `claude-bridge` handler) cannot be routed by the standalone `pi-ai` compatibility completion. That case is skipped silently. Select a built-in API-backed provider/model with `--recap-model` if one is available. OpenAI Codex and Google models using built-in Pi API types are supported by the same completion path.

Every automatic recap is a separate provider request and may incur cost. `--recap-disable`, longer timers, or a cheaper explicit model are the available controls.

## Pi 1.0 and Herdr status

This checkout typechecks and loads against installed `@earendil-works/pi-*` **1.0.0**. It uses Pi 1.0’s canonical `buildSessionProjection()`, final `agent_settled` boundary, `session_shutdown` cleanup, and `ctx.ui.onTerminalInput()` ownership rather than attaching its own stdin listener.

Herdr findings are deliberately separated:

- **Source-supported:** installed Herdr 0.9.3 corresponds to source commit `7b116c05bfda646af39d2524c54e70c751f57ee8`. Its [focus synchronization](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api.rs#L842) sends `CSI O` to the pane losing focus and `CSI I` to the pane gaining focus, but only when the pane application enabled DECSET `?1004`; its source includes pane-switch and outer-window-focus tests. Client-local navigation uses [separate focus reconciliation](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/server/headless/client_views.rs#L420), so not every client movement implies a global pane transition. This extension enables that mode while its Pi session is active.
- **Not runtime-verified here:** no existing Herdr pane was focused, renamed, reloaded, reset, or otherwise touched, and no live pane-switch acceptance test was run. Multi-client/local-view focus semantics can differ from a single-client pane switch.
- **Fallback:** window focus and pane focus are different signals. If the active setup does not deliver reliable pane transitions, pass `--recap-disable-focus` so the explicit 120-second idle fallback remains authoritative.

## Development checks

All model responses in tests are local mocks; the suite performs no inference and reads no real credentials or transcripts.

```bash
npm install --ignore-scripts
npm run check
npm pack --dry-run --json
```

## Provenance

Imported from Thomas Mustier’s MIT-licensed [`session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap) at exact upstream commit [`4a63a2ebd3683d86597e226c7ff778ea4837dd73`](https://github.com/tmustier/pi-extensions/commit/4a63a2ebd3683d86597e226c7ff778ea4837dd73), released upstream as `@tmustier/pi-session-recap` 0.5.1 on 2026-09-22. The imported revision is the merged compatibility PR [#112](https://github.com/tmustier/pi-extensions/pull/112), targets Pi 0.87, and does **not** contain PR [#106](https://github.com/tmustier/pi-extensions/pull/106) (`0c9b11657af023a6d1c064d04e95a1456301f3ff` was not an ancestor and the PR remained open as of 2026-10-01).

This fork integrates the still-needed #106 response-validity fix and focused regressions, with credit to **Serge Baranov (`CrazyCoder`)**, then adapts lifecycle and terminal-input ownership for Pi 1.0. Provider error details are intentionally redacted beyond that patch. The original MIT copyright and full license are in [LICENSE](./LICENSE); the imported release history is retained in [CHANGELOG.md](./CHANGELOG.md).
