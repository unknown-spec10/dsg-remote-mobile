# Host API notes — verified against DeepSeek Harness 0.2.2-rc.1

Scope: the Host-side contract consumed by `bridge.js`. Everything here was read from the
installed Harness, not from memory:

- Install root: the Harness resources directory `…/resources/app.asar/dsh/`
  (an asar archive; the `read` tool opens files inside it, native `glob`/`grep`/`ls` do not).
- Version: `package.json` → `@deepseek-ai/dsh-desktop-runtime` `0.2.2-rc.1`.
- **The shipped `.d.ts` files are absent from the install.** Every package's
  `lib/types/**` contains only the compiled `.js` (which carries the JSDoc and the
  real implementations). Package `package.json` `exports` still name
  `lib/types/*.d.ts`, so type-only readers see through the archive; our research
  used three sources instead:
  1. `node_modules/@deepseek-ai/<pkg>/lib/index.js` and `lib/types/*.js`
     (implementation + JSDoc),
  2. `node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`, a
     generated declaration catalog (2347 entries) containing the public type
     declarations as strings,
  3. focused runtime smoke tests against a fake Cordis context.
- Access path for a **profile-installed** plugin: no `@deepseek-ai/*` imports at
  runtime (module resolution fails). Everything goes through the Cordis context:
  `ctx.get(name)` for services and `ctx.on(name, fn, opts)` for events.

---

## 1. Services actually used

| Service name | Provider package | Shape |
|---|---|---|
| `sessionController` | `@deepseek-ai/dsh-api-session-controller` | class `SessionController`, `super(ctx, "sessionController", { namespace: "session" })` |
| `agents` | `@deepseek-ai/dsh-agent` | class `AgentRegistry`, `super(ctx, "agents")` |
| `agentPresets` | `@deepseek-ai/dsh-agent-preset-registry` | class `AgentPresetRegistry`, `super(ctx, "agentPresets")` |
| `agentDefaultModel` | `@deepseek-ai/dsh-agent-default-model` | injected dependency of the session controller; `currentSelection()` |
| `llm` | `@deepseek-ai/dsh-llm` | fallback catalog only |
| `approval` | `@deepseek-ai/dsh-user-approval` | not called directly; we listen on its waterfall |
| `workingDirectory` | (Host service) | `get(session)` → the session workspace root; used to contain uploads/previews |
| `workspaceRegistry` | (Host service) | `pinnedSessionIds` / `archivedSessionIds` getters, `pinSession`/`archiveSession`/… |
| `workspaceController` | (Host service) | same operations when the registry getters are absent |
| `workspaceChanges` | `dsh-workspace-changes` | `summary(sessionId, seq)` / `diff(sessionId, seq, index, signal)`; live-process only |
| `commands` | `dsh-commands` | `list(agent)` / `execute(agent, line, attachments, signal)`; live Agent required |
| `attachments` | (Host service) | `imageLimits` policy for inline images and previews |
| `userQuestions` | (Host service) | `answer(agent, callId, { answers })` for continued (timed-out) questions |

The v2 feature surface above is documented in detail in `docs/api-notes-v2.md`.

All lookups are defensive: `ctx.get(name)` returns `undefined` when the package is
not composed, and every bridge operation degrades instead of throwing.

`ctx.sessionController` is a Remote (Typert) service, but its business methods are
plain async functions and are callable from Host plugins. Two details matter:

- Several methods call `signal.throwIfAborted()` **unconditionally**, so callers
  must pass an `AbortSignal`. `bridge.js` always creates one (`withSignal()`).
- Methods consult `ctx.remoteAccess.allows()`/`principalOf(ctx.invocation)`.
  `remoteAccess.allows()` returns `true` "for the owner and outside a Remote
  call" (`dsh-api-remote-access/lib/types/index.js`), so Host calls are never
  filtered.

---

## 2. `ctx.sessionController` — exact signatures

From `lib/types/index.d.ts` (declaration catalog) + `lib/index.js` / `lib/types/*.js`:

```ts
// list: cold-safe, no Agent activation, visible sessions ordered by activity
class SessionController {
  async list(request: object, signal: AbortSignal): Promise<{ items: SessionSummary[] }>;
  async create(request: SessionCreateRequest): Promise<{ sessionId: SessionId; agentPreset?: string }>;
  async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<{ accepted: true }>;
  cancel(request: { sessionId: SessionId }): Promise<{ accepted: true }>;      // live agent only
  async selectModel(request: { sessionId; provider; model; reasoningEffort? }): Promise<{ selected: ModelSelection }>;
  modelCatalog(): Promise<ModelCatalog>;
  async events(request: SessionPageRequest, signal: AbortSignal): Promise<{ cursor; records: SessionHistoryRecord[]; hasMore }>;
  async state(request: { sessionId }, signal): Promise<{ cursor; active; running; queue; pendingInput }>;
  async projections(request: { sessionId }, signal): Promise<{ kind; asOfSeq; values } | null>;
  async resolveAgent(sessionId): Promise<{ agent: Agent } | { error: RemoteError }>;
}
```

Key request/result types (declaration catalog):

```ts
interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId; readonly cwd?: string;
  readonly sessionId?: SessionId; readonly agentPreset?: string;
}
interface SessionPromptRequest {
  readonly requestId: SessionRequestId;
  readonly sessionId: SessionId;
  readonly mode: 'queue' | 'steer';
  readonly content: readonly PromptContentPart[];      // { type:'text', text } is the text part
  readonly clientTimeZone?: string;
}
interface SessionPageRequest {
  readonly address: SessionAddress;
  readonly throughSeq?: number; readonly beforeSeq?: number;
  readonly maxMessages?: number;                      // default 50
  readonly turnWindow?: { minMessages: number; minTurns: number };
}
```

Notes verified in `lib/types/history/controller.js` and `lib/types/history.js`:

- `events()` returns the **newest** message-aligned page: `paginate()` walks the
  log backwards from the end, cuts at `maxMessages` messages, returns
  `events.slice(cut, end)` plus `hasMore = cut > 0`. This matches the mobile
  "open the recent conversation" need; paging further back needs
  `beforeSeq` (not exposed by PROTOCOL v1).
- `records` are `SessionHistoryRecord = { type: 'event', event: SessionWireEvent }`
  where `SessionWireEvent = { type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`.
- `cancel()` reads the **attached** agent only (`ctx.agents.get`), so a cold
  session rejects `session/not-found`; the bridge treats that as a no-op.
- `prompt()` deduplicates by `requestId` (checks inbox + durable log), resumes a
  cold session, and returns `{ accepted: true }`. `mode` is required by the type
  and defaults to queue behaviour in the implementation; the bridge sends `'queue'`.
- `create()` writes to `defaultCwd` (`process.cwd()` of the harness) when neither
  `workspaceId` nor `cwd` is given. The bridge deliberately never sends `cwd`.

---

## 3. Session summaries and projections

`SessionSummary` (declaration catalog) — the list row:

```ts
interface SessionSummary {
  readonly agentAvailable: boolean;
  readonly formatStatus?: 'current' | 'migration-required';
  readonly sessionId: SessionId;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
  readonly parentSessionId?: SessionId;
  readonly origin?: 'subagent';
  readonly cwd?: string;                                 // never forwarded
  readonly projections?: { kind: 'cached'|'sequenced'; asOfSeq: number;
                           values: Partial<SessionProjectionSummaryValues> };
}
```

There is no `title`/`preset`/`model` field on the summary; they are projection
values (`@deepseek-ai/dsh-session-projection`), read from `projections.values`:

| Projection key | Wire value | Package |
|---|---|---|
| `title` | `string \| null` (latest `session/title`); `view: state => state` | `dsh-session-title` |
| `agentPreset` | `string \| null` (header preset + `agent-preset/selected`) | `dsh-agent-preset-registry` (`types/session.js`) |
| `modelSelection` | `{ lastUsed: ModelSelection\|null, next: ModelSelection\|null }` (view of pending/last-used) | `dsh-agent` (`types/model-selection.js`) |
| `titleInput`, `approvalState`, `turnBoundary`, `imageLimits` | not used; `imageLimits` is `summary: false` | — |

Cold sessions only carry projection hints when the projection cache has them, so
a cold session can legitimately have an empty `values` object. The bridge then
falls back to `projections()`/`state()` (and, for the title, the first
`user/message` in the read history page). **Title is best-effort for cold
sessions.**

`ModelSelection = { provider: string; model: string; reasoningEffort?: string }`.
The bridge sends `next ?? lastUsed`, and `{ provider, model }` only (PROTOCOL's
session frame has no effort field; the model picker frame has it).

Subagent sessions (`origin === 'subagent'`) are filtered out of `listSessions()`
and ignored by the live-event bridge: the phone must only drive ordinary
sessions. Prompt/tool events for subagents are therefore not streamed.

---

## 4. Durable Session events → HistoryItem

Event envelope and types come from `dsh-session/lib/types/index.js`, `surface.js`
and the declaration catalog (`SessionEventMap`); actual write sites in
`dsh-agent-loop/lib/index.js`:

```ts
'turn/start':      { turn: number }
'turn/end':        { turn: number; reason: TurnEndReason }        // {kind:'completed'|'blocked'|'error'|'aborted'|'max-tokens', error?, reason?}
'step/start':      { turn: number; step: number }
'step/end':        { turn: number; step: number }
'user/message':    UserMessage                                    // data IS the message: {id, role:'user', content, source}
'assistant/message': { turn; step; message: AssistantMessage;
                       stream: AssistantStreamRecord[]; usage?; interrupted?: true }
'assistant/attempt': { turn; step; stream }                       // failed/aborted attempt, no message
'tool/call':       { turn; step; callId: ToolCallId; name: string; arguments: string /* raw JSON */ }
'tool/result':     { turn; step; message: ToolResultMessage;      // message.toolCallId is the call id
                     error?: { name; code; reason? }; meta? }
'session/title':   { title: string; ... }                         // not needed: title is projected
```

Message/content shapes (`dsh-llm/lib/types/message.js`, `assembler.js`):

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }        // not rendered in history
  | { type: 'tool-call'; id; name; arguments } // tool calls are protocol, not text
  | { type: 'image' | ... };                    // never forwarded

interface ToolResultMessage { role: 'tool'; source: {kind:'tool', callId};
                              toolCallId: ToolCallId; content: ContentBlock[];
                              isError?: boolean }
```

`bridge.js` mapping (one chronological list, ids stable across reloads):

| Session event | HistoryItem |
|---|---|
| `user/message` with `data.source.kind === 'user'` | `{ id: 'seq:<seq>', kind: 'user', text: joinTextBlocks(content), ts: time }` |
| other `user/message` sinks | skipped (runtime context / model-selection notice / approval-policy notice are not human transcript) |
| `assistant/message` | `{ id: 'seq:<seq>', kind: 'assistant', text: joinTextBlocks(message.content), ts }` (empty content skipped, e.g. max-tokens step) |
| `tool/call` | `{ id: 'tool:<callId>', kind: 'tool', callId, name, title: name, argsPreview, ok: true, output: '', diff: null, durationMs: 0, ts }` |
| `tool/result` | fills the matching `tool:` item: `ok = !message.isError`, `output = joinTextBlocks(message.content) || error.message`, `durationMs = result.time - call.time`; a result with no call in the page (paging cut) creates a standalone `tool:` item |
| `turn/end` with `reason.kind === 'error'` | `{ id: 'seq:<seq>', kind: 'error', text: reason.error.message, ts }`; aborted/blocked/completed add nothing |
| `assistant/attempt`, boundaries, compaction, etc. | skipped |

Tool output and `argsPreview` are truncated (4000 / 200 chars by default).
`diff` is always `null`: no diff view is derived from session events.

---

## 5. Assistant token streaming

Event: `ctx.on('agent/assistant-stream', ({ agent, frame }) => …, { global: true })`.
Emitted by `AssistantStreamAttempt` in `dsh-agent-loop` via the agent's scoped
dispatcher (`this.dispatch.emit("agent/assistant-stream", { frame })`), so the
payload is `{ agent, frame }` and only a `{ global: true }` listener sees every
agent's frames.

```ts
type AssistantStreamFrame =
  | { type:'start'; attemptId; revision; turn: number; step: number }
  | { type:'chunk'; attemptId; revision; index: number; time: number; chunk: StreamChunk }
  | { type:'end';   attemptId; revision; index: number;
      outcome: { kind:'committed'; eventType:'assistant/message'|'assistant/attempt'; seq }
             | { kind:'abandoned' } };

type StreamChunk =
  | { type:'text-delta'; index; text }
  | { type:'reasoning-delta'; index; text }
  | { type:'tool-call-delta'; index; id; name?; argumentsDelta }
  | { type:'block-start'; index; blockType }
  | { type:'block-end'; index; block }
  | { type:'usage'; usage }
  | { type:'finish'; reason; replayState? };
```

Mapping to `onAssistant`:

- `start` → `{ sessionId, phase:'start', turn, step, text:'', reasoning:null }`
- `chunk` + `text-delta` → `{ phase:'delta', turn, step, text: chunk.text, reasoning:null }`
- `chunk` + `reasoning-delta` → `{ phase:'delta', turn, step, text:'', reasoning: chunk.text }`
- `end` → `{ phase:'end', turn, step, text:'', reasoning:null }`
- All other chunk types are ignored. `text`/`reasoning` are **incremental
  fragments**, not cumulative text; the server may coalesce adjacent fragments
  for the ~30 fps throttle. `turn`/`step` are taken from the `start` frame
  because deltas do not carry them.

There is no Cordis event scoping surprise: `agent/assistant-stream` is an emit,
not a waterfall, so the first answer wins trivially.

---

## 6. Tool lifecycle

Chosen source: durable `session/event` `tool/call` / `tool/result`
(`dsh-tools/lib/types/batch.js` writes them; `dsh-agent-loop` recovery re-emits
missing results). This is preferred over `tools/pre-execute`/`tools/result`
because it carries `callId`, `name` and raw `arguments` durably and works for
every executor (native, PTC, transient tools), and it survives a reconnect
because history reproduces it.

- `tool/call` → `onTool({ sessionId, phase:'start', callId, name, title: name, argsPreview, detail })`
  - `argsPreview`: compact single-line JSON (or the raw string) truncated to 200 chars.
  - `detail`: shallow copy of the parsed arguments object (≤12 keys, strings
    capped at 400 chars). `null` when the arguments are not a JSON object.
  - `title`: there is **no tool-title service call in the durable event**. The
    bridge uses the tool name as `title`; the mobile UI can localise known names.
    (`ToolDefinition.presentCall`/`presentResult` produce view models for the
    desktop, but they are not persisted with the event.)
- `tool/result` → `onTool({ sessionId, phase:'end', callId, ok: !message.isError,
  output, durationMs, name, title })`
  - `output` = text blocks of `data.message.content`, falling back to
    `data.error.message`/`.reason`; truncated to 4000 chars.
  - `durationMs` = result event time − call event time (both are durable
    millisecond timestamps).

---

## 7. Approvals

Service: `@deepseek-ai/dsh-user-approval` (`super(ctx, "approval")`). The bridge
does **not** call `approval.request()`; it answers through the waterfall that the
service dispatches (`lib/types/index.js`, implementation `lib/index.js`):

```ts
this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req,
                   () => Promise.resolve('unavailable'))
```

- Payload (`ApprovalRequestEvent`): `{ agent, toolName, callId?, reason?,
  displayReason?: { en: string; [locale: string]: string }, signal? }`.
- Outcome vocabulary (`ApprovalOutcome`):
  `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`. The service
  normalises rogue returns to `'unavailable'` and the **only grant is
  `allowed-once`**.
- Policy: a session whose effective policy is `'never'` returns `'rejected'`
  before any listener runs. A missing answerer fails closed with `'unavailable'`;
  a throwing answerer is swallowed to `'unavailable'`.
- The service writes the durable `approval/asked` / `approval/decided` pair and
  generates its own request id; that id is **not** in the waterfall payload, so
  the bridge mints its own phone-facing `requestId` (UUID) and keeps it in a
  pending map.
- Scope: the waterfall `this` is the agent scope, so the listener must be
  registered as `{ global: true }` (plus `{ prepend: true }` to sit in front of
  the gateway's forwarding listener). `ctx.on(...)` returns the disposer.
- Desktop answerer: `@deepseek-ai/dsh-api-remotes` forwards the `approval/request`
  waterfall to connected Remote peers; `dsh-client-ui-approval` renders it in the
  DSH web UI and answers `allowed-once`/`rejected`. Because the waterfall would otherwise
  offer the request to both answerers, the bridge routes it **exclusively** while a phone is
  connected (v15) and delegates with `next()` when no phone is connected.

Bridge behaviour (`onApprovalRequest`):

1. If `options.hasApprovalPeers()` is supplied and returns false, delegate straight to
   `next()` — an unpaired phone must never stall an approval.
2. Otherwise emit `onApproval` and wait for the phone. The bridge does **not** call `next()`
   in parallel: while a phone is connected it is the only answerer, so the desktop cannot be
   left with a duplicate card whose request was already settled by the phone. The desktop
   still sees the same pending list through the plugin's approval dock and can answer it.
3. `answerApproval(requestId, 'allow'|'reject')` maps to `'allowed-once'`/`'rejected'` and
   settles the promise; the first answer wins.
4. `request.signal` abort settles `'cancelled'` and emits
   `onApprovalResolved({ outcome:'cancelled' })`.
5. `options.approvalWaitMs > 0` fails closed with `'unavailable'` after the deadline; `0`
   (the default) waits indefinitely for a phone answer or turn abort.
6. `dispose()` / last unsubscribe settles every pending approval with `'cancelled'`.

`expiresAt` is `0` in every frame: the Host has no approval deadline field, only
the tool's own timeout and the turn's abort signal.

Question requests (`user-questions/request`) use the same exclusive pattern with one extra
safety net: when **no** phone is connected at request time the bridge keeps the request
pending for `questionHandoffMs` (default 45 s) so a reconnecting phone can answer it, then
delegates to the next answerer. A connected phone is the exclusive answerer (no handoff
timer), matching approval routing.

---

## 8. Models

Preferred: `ctx.sessionController.modelCatalog()` (`lib/types/catalog.js`).

```ts
interface ModelCatalog {
  readonly default: ModelSelection;
  readonly routableProviders: readonly string[];
  readonly groups: readonly { id: string; name: string;
    models: readonly { id; name; description?; reasoning?: { efforts; defaultEffort? }; badge? }[] }[];
  readonly failures: readonly { id; name; message }[];   // per-provider isolation, not forwarded
}
```

Bridge maps it to PROTOCOL:

- `catalog: groups.flatMap(g => g.models.map(m => ({ provider: g.id, model: m.id, label: m.name })))`
- `current: { provider: default.provider, model: default.model,
  reasoningEffort: default.reasoningEffort ?? null }`

Fallback when no session controller: `ctx.llm.listProviders()`,
`await ctx.llm.listModels(providerId)`, `await ctx.llm.resolveModelInfo(provider, model)`
plus `ctx.agentDefaultModel.currentSelection()`.

`selectModel(sessionId, {provider, model, reasoningEffort?})` calls
`sessionController.selectModel`, which validates the model is currently routable
(`modelAvailable`), runs `resolveCallConfig`, calls `agent.model.select()` and
persists the default in the background. Unknown model → `session/model-unavailable`.

---

## 9. Agent presets

Service `agentPresets` (`@deepseek-ai/dsh-agent-preset-registry`), `super(ctx, "agentPresets")`.

```ts
async list(): Promise<{ id; name?; description?; order?; broken? }[]>  // sorted by order then id
get defaultId(): string                                                // selectedDefault ?? default
presetForSession(session): string | null                               // 'agentPreset' projection
async select(agent: Agent, preset: string): Promise<{ id }>            // blank session only
async resolve(id?): Promise<{ id; broken? }>
remoteExportList(): Promise<{ presets: (row & { isDefault: boolean })[] }>
```

Bridge mapping: `{ presets: [{ id, title: name ?? id, description: description ?? '' }],
current: defaultId ?? null }`. `current` is the deployment default (the phone
shows the per-session preset from the session list; `preset.list` has no session
argument).

`selectPreset(sessionId, preset)` resolves the agent through
`sessionController.resolveAgent(sessionId)` (resuming a cold session) and calls
`presets.select(agent, preset)`. The registry rejects sessions whose first turn
started with `agent-preset/locked`; `not-found`/`invalid`/`locked` surface as the
protocol error envelope. A preset with a broken mount is still listed (with no
`broken` field in our wire shape).

---

## 10. Status

Two sources are used and both are forwarded as `onStatus({ sessionId, running })`:

- `ctx.on('session/event', (session, event))` `turn/start` → true, `turn/end` → false.
  Durable and cold-safe (a resumed/replayed turn start shows running).
- `ctx.on('agent/status', ({ agent, status }))` with `AgentStatus = 'idle' | 'running'`.

A turn can run more than once per session; duplicate/coalescible frames are
expected. `server.js` should treat `session.status` as idempotent state, not as a
delta. The passive read `sessionController.state({sessionId})` gives the
authoritative snapshot (`{cursor, active, running, queue, pendingInput}`) if a
resync is ever needed.

---

## 11. Verified wire mapping (DSH → PROTOCOL.md)

| PROTOCOL frame | Source |
|---|---|
| `sessions` / session object | `sessionController.list()` summary + `title`/`agentPreset`/`modelSelection` projections |
| `session.opened` | session object above + `sessionController.events({maxMessages: limit})` history page |
| `history` | `events()` newest page, `mapHistory()` |
| `assistant.start/delta/end` | `agent/assistant-stream` frames |
| `tool.start/end` | `session/event` `tool/call` / `tool/result` |
| `approval.request` | `approval/request` waterfall payload (`displayReason`→`displayReason`, `callId`→`callId`, ours `requestId`, `expiresAt:0`) |
| `approval.resolved` | bridge settle path (`allowed-once`/`rejected`/`cancelled`/`unavailable`) |
| `session.status` | `turn/start`, `turn/end`, `agent/status` |
| `models` | `modelCatalog()` / `llm` fallback |
| `presets` | `agentPresets.list()` + `defaultId` |
| prompt / stop / model.select / preset.select / approval.answer | `sessionController.prompt/cancel/selectModel`, `agentPresets.select`, approval pending map |

The v2 frames (session management, queue, context, changes, commands, limits, questions and
attachments) are mapped from the sources in `docs/api-notes-v2.md`; this table covers only the
original v1 surface.

Wire-shape decisions:

- Session ids are the Harness `SessionId` (opaque `session-<uuid>` strings).
- `updatedAt`/`ts` are the Harness millisecond timestamps.
- History ids are `seq:<n>` for messages and `tool:<callId>` for tool cards, so
  the SPA's list keys are stable across reconnects.
- The bridge strips `cwd` and any other filesystem field from every payload.
  Error messages are path-redacted and capped at 600 chars. Tool arguments and
  tool output are **not** path-redacted by default (the tool card needs them);
  `createBridge(ctx, { redactPaths: true })` enables redaction for deployments
  that require it.

---

## 12. Error / failure contract

All bridge methods resolve; none reject.

- Data operations return empty data on failure: `listSessions → []`,
  `history → []`, `listModels → {catalog:[],current:null}`,
  `listPresets → {presets:[],current:null}`.
- `openSession` returns either `{ session, history }` or
  `{ ok: false, error: '<message>', errorCode: 'not-found'|'bad-request'|'internal' }`.
- `createSession` returns a session object with `id`, or the same error envelope.
- `prompt`/`cancel`/`selectModel`/`selectPreset` resolve `undefined` on success
  and the error envelope on failure. `server.js`'s `callBridge()` already treats
  any object with `ok === false` as a thrown failure (`new Error(value.error)`),
  so `error` is a **string**; the protocol code rides beside it in `errorCode`.
- `answerApproval` returns `false` for unknown/expired ids.
- `answerQuestion` returns `true`/`false` for waterfall questions, an `{ ok:false }` envelope
  on bad input, and delegates to `ctx.userQuestions.answer` for a continued question.
- Error `code` is one of the protocol codes: `bad-request`, `not-found`, `internal`,
  `unavailable`, `forbidden`, `not-live` (mapped from RemoteError codes such as
  `session/not-found`, `agent-preset/locked`, `session/model-unavailable`, and from bridge guards such as live-session command validation and cold-session checks).

---

## 13. Uncertainties / fallbacks (read before touching bridge.js)

1. **`.d.ts` are not shipped** in this install (see header). Signatures above were
   reconstructed from the compiled `lib/types/*.js` and the
   `dsh-tool-cordis` declaration catalog; they match the code paths actually
   executed in the smoke test, but a future Harness build may rename a method
   without changing the packages list.
2. **Approval routing is exclusive to the connected phone (v15).** Earlier v1 builds called
   `next()` concurrently and raced the desktop answerer, which left a duplicate desktop
   prompt that could only be dismissed by answering it again. The bridge now delegates
   `next()` only when no phone is connected and otherwise waits for the phone; the desktop
   plugin dock polls the same pending list, so either surface can answer and the first one
   wins. There is still no Host API to cancel a specific pending Remote prompt in
   0.2.2-rc.1, which is why the exclusive routing matters.
3. **Approval id mismatch.** The durable `approval/asked` id is generated inside
   `ApprovalService.request` and is not part of the waterfall payload, so the
   phone-facing `requestId` is bridge-owned. Nothing in the phone protocol
   correlates to the durable audit id; this is intentional.
4. **Approval timeout semantics.** `approvalWaitMs` defaults to 0 (wait). With no
   desktop connected and the phone gone, an approval stays pending until the
   turn is aborted. `server.js` should pass `hasApprovalPeers: () => <connected
   device count> > 0` and may set `approvalWaitMs` to fail closed.
5. **`onAssistant` delta text is incremental**, not cumulative. The server's
   30 fps coalescing must concatenate fragments. Reasoning arrives in
   `reasoning`, text in `text`, never both in one frame.
6. **Live turn errors are not a first-class event.** PROTOCOL v1 has no live
   error frame. The bridge closes an open assistant bubble on `agent/error` and
   relies on the next history read for the `kind:'error'` item (from
   `turn/end.reason.kind === 'error'`).
7. **Tool titles are the tool names.** The durable `tool/call` event has no
   presentation title; deriving one would need the (non-persisted) tool
   definition's `presentCall` view. The SPA is expected to localise known names.
8. **Cold-session titles can be empty.** `list()` serves title from the
   projection cache; a cold, uncached session may have no `values.title`. The
   bridge leaves `title: ''` in the list and only recovers a title heuristic in
   `openSession` (from projections or the first user message).
9. **`selectPreset` may resume a cold session.** `resolveAgent()` activates an
   agent to call `presets.select()`; selecting a preset on a started session
   therefore fails with `agent-preset/locked` (mapped to `bad-request`). The
   bridge does not pre-check blankness.
10. **`cancel` cannot stop a cold session** (`session/not-found`), and a cold
    session has no agent to cancel; the bridge returns success.
11. **`modelCatalog()` can report per-provider failures** (`failures[]`). They
    are swallowed: the phone only sees routable groups. If a provider's models
    disappear from the picker, the cause is in `failures`, not in the bridge.
12. **`redactPaths` is off by default.** If the deployment treats tool arguments
    as secret, pass `redactPaths: true`; history error text and operation errors
    are always path-redacted regardless.
13. **Subagent sessions are hidden.** `listSessions` filters
    `origin === 'subagent'`; prompt/tool/stream events for subagent agents are
    ignored. Driving a subagent's own session from the phone is not supported by
    v1.
14. **Fallback paths are best-effort.** `prompt` via `agent.followup()` with a
    hand-built message (no `@deepseek-ai/dsh-llm` `createUserMessage`) may be
    rejected by the loop's frozen-message expectations; it only runs when
    `sessionController` is absent. `listModels` falls back to `ctx.llm`.
15. **No pagination beyond the newest page.** PROTOCOL v1's `history.load` is
    `limit` only; `sessionController.events` supports `beforeSeq`/`throughSeq`
    when v2 needs "load older".

---

## 14. What `server.js` must tolerate

- Handlers are optional and may be added/removed via `subscribe()` more than
  once; multiple subscriptions all receive events. Unsubscribing the last one
  removes the bridge's Cordis listeners and cancels pending approvals.
- `onStatus` may deliver the same `running` value twice (turn boundary +
  agent status). Treat it as idempotent.
- `onAssistant` `phase:'end'` may arrive without a preceding `start` after a
  reconnect; do not assume a strict start/end pairing.
- `onTool` `phase:'end'` can arrive without a matching `start` if the bridge was
  created mid-turn (or after a server restart): `name`/`title` will be `''`.
- Approval `requestId` values are bridge-owned; never parse them.
- Calls to `prompt`/`selectModel`/etc. may return the `{ok:false,error}`
  envelope; check it instead of assuming `undefined`/success.
- `dispose()` is final: after it, `subscribe()` is a no-op and every data call
  still resolves (empty/error).

---

## 15. Method → Host mapping (quick reference)

| `createBridge()` method | Host calls |
|---|---|
| `listSessions()` | `sessionController.list({}, signal)`; fallback `agents.list()` |
| `openSession(id)` | `sessionController.events({address:{kind:'session',id},maxMessages:50})` + `list()` / `projections()` / `state()` |
| `createSession({preset})` | `sessionController.create({agentPreset?})` |
| `history(id,{limit})` | `sessionController.events({..., maxMessages:limit})` |
| `prompt(id,text,requestId)` | `sessionController.prompt({sessionId,requestId,mode:'queue',content:[{type:'text',text}]}, signal)` |
| `cancel(id)` | `sessionController.cancel({sessionId})`; fallback `agent.cancel({kind:'user'})` |
| `listModels()` | `sessionController.modelCatalog()`; fallback `llm.listProviders/listModels/resolveModelInfo` + `agentDefaultModel.currentSelection()` |
| `selectModel(id, sel)` | `sessionController.selectModel({sessionId,provider,model,reasoningEffort?})`; fallback `agent.model.select()` |
| `listPresets()` | `agentPresets.list()` + `agentPresets.defaultId` |
| `selectPreset(id,preset)` | `sessionController.resolveAgent(id)` then `agentPresets.select(agent,preset)` |
| `answerApproval(id,decision)` | pending map → waterfall answer (`allowed-once`/`rejected`) |
| `answerQuestion({requestId?,sessionId?,callId?,answers})` | pending question map, or `ctx.userQuestions.answer(agent, callId, {answers})` |
| `subscribe(handlers)` | `ctx.on('agent/assistant-stream'|'session/event'|'agent/status'|'agent/error'|'approval/request'|'user-questions/request', {global:true})` |
| `dispose()` | dispose listeners, settle pending approvals/questions, clear maps |

The v2 surface (`createSession`, `renameSession`, `forkSession`, `searchSessions`,
`setSessionPinned/Archived`, `listQueue`/`updateQueue`, `contextFor`, `changesList/Diff`,
`listCommands`/`executeCommand`, `saveUpload`/`readUpload`, `imageLimits`, `listModels`,
`selectModel`, `listPresets`, `selectPreset`) is documented method-by-method in
`docs/api-notes-v2.md`.
