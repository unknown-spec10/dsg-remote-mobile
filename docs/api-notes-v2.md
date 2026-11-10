# dsh-remote-mobile v2 — verified Host API notes

Research date: 2026-11-09. Target: installed **DeepSeek Harness 0.2.2-rc.1** (Desktop asar build).
Status: research notes; the v2 surface described here is implemented in `bridge.js` /
`PROTOCOL.md` as of v15. Items flagged **UNVERIFIED** were not conclusively probed.

> Superseded in one place (v20): the notes below recommend a phone command **allowlist**
> (list only `compact`). The shipped bridge instead reads the live Agent's command registry and
> mirrors the desktop palette, keeping only `/export` and the policy-changing `/permission`
> desktop-only (see `PROTOCOL.md`). The allowlist discussion is kept as historical research.

## How this was verified

1. **Cordis Inspect (Host)** — `Service.listService` with **no input** returns the live
   capability directory (≈250 services with method signatures). Passing an `input`
   object (`{"service": "sessionController"}`) is currently rejected by the inspect
   transport with `"input" must be an object`, so the per-service "exact contract"
   mode could not be used. The no-input directory was captured and used for the live
   signature inventory; all *type* declarations come from source #2.
2. **Generated declaration catalog** — `dsh-tool-cordis/lib/types/api-catalog.js`
   (1206 unique declarations, generated from the real `.d.ts`). This is the same
   catalog that backs Cordis Inspect's detail mode. Extracted with a Node asar reader
   (the shipped `.d.ts` files themselves are absent from the install).
3. **Compiled implementation** — each package's `lib/types/*.js` / `lib/index.js`,
   which retains JSDoc and the real logic (validation, error codes, ordering).
4. **Desktop configuration** — bundled `cordis.patch.yml` files for resolved values
   (e.g. `maxTitleBytes: 80`).

No live Host mutation was attempted: everything below is a read-only source finding.
Items that would need a live integration probe are flagged **UNVERIFIED**.

---

## Cross-cutting model (read first)

| Capability class | Needs | Examples |
|---|---|---|
| **Cold-safe** (works on persisted sessions, no Agent resume) | `ctx.sessionQuery` / projection cache | `sessionController.list/search/events/projections`, `subagents.listChildren`, `workspaceRegistry.*` |
| **Live-only** (requires an attached `Agent` or in-memory `Session`) | `ctx.agents.get(id)` / resolved Agent | `sessionController.cancel/updateQueue/resolveAgent`, `commands.list/execute`, `approval.setPolicy`, `tokenMeter.measure/contextPressure`, `workspaceChanges.summary/diff`, `agentTeams.*` |
| **Resumes a cold session as a side effect** | `sessionController.resolveAgent` | `prompt`, `rename`, `selectModel`, `selectPreset`, `cancel` (attached-only) |

`SessionSummary.agentAvailable` (true iff `ctx.agents.get(id)?.session === session`)
tells the phone whether live-only actions are currently possible. Our bridge v1 already
exposes `running`; v2 should add `agentAvailable` so the SPA can hide live-only
controls instead of failing them.

`ctx.sessionController` methods are Typert `@Remote` services but are plain async
methods callable from a Host plugin. Methods that take a `signal` call
`signal.throwIfAborted()` unconditionally, so a real `AbortSignal` is required.
`principalOf(ctx.invocation)` is `undefined` outside a Remote call, so Host calls are
treated as the owner and `remoteAccess.allows(...)` returns true.

---

## 1. `sessionController.modelCatalog()` — models, reasoning effort, `selectModel`

### Signatures (live inspect + catalog)

```ts
// dsh-api-session-controller
@Remote('modelCatalog') modelCatalog(): Promise<ModelCatalog>
@Remote('selectModel') selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>
```

```ts
interface ModelCatalog {
  readonly default: ModelSelection;                  // deployment default (agentDefaultModel)
  readonly routableProviders: readonly string[];
  readonly groups: readonly ModelProviderGroup[];
  readonly failures: readonly ModelCatalogFailure[]; // per-provider isolation, NOT shown as models
}
interface ModelProviderGroup { readonly id: string; readonly name: string; readonly models: readonly ModelCatalogModel[] }
interface ModelCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: { efforts: readonly { id: string; name: string; description?: string }[];
                         defaultEffort?: string };
  readonly badge?: LlmModelBadge;
}
interface ModelCatalogFailure { readonly id: string; readonly name: string; readonly message: string }
interface ModelSelection { provider: string; model: string; reasoningEffort?: ReasoningEffortId }  // effort is an opaque branded string
interface SessionSelectModelRequest extends ModelSelection { readonly sessionId: SessionId }
interface SessionSelectModelValue { readonly selected: ModelSelection }
```

`ModelSelection` is not a standalone catalog declaration; its exact fields are pinned by
`selectModel` usage (`commands.js`) and `model-selection.js` (`toSelection`): `provider`,
`model`, optional `reasoningEffort` (omit = provider/adapter default).

### Reasoning efforts

- **Yes.** Every routable model may carry `reasoning.efforts[]` with stable `id`, display
  `name` and optional `description`, plus optional `defaultEffort`.
- If `reasoning` is absent → the model exposes no effort control.
- If `reasoning.defaultEffort` is absent → the UI adds an explicit **“Provider default”**
  choice whose value is “omit `reasoningEffort`”.
- If `defaultEffort` is present → that effort is the effective default and the UI does
  **not** add a provider-default entry (`dsh-client-ui-model-selection/lib/client.js`,
  `effortChoices` / `effortLabel`).

### How the desktop picks an effort (verified in `dsh-client-ui-model-selection`)

```ts
sessions.selectModel({ sessionId, provider: selection.provider, model: selection.model,
  ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort } })
```

- Current = `modelSelectionProjection.next ?? catalog.default`.
- Displayed effort = `current.reasoningEffort ?? reasoning.defaultEffort` (name lookup in
  `efforts[]`; falls back to the raw id; “Provider default” when nothing is set).
- Model choices are pre-built with `reasoningEffort: model.reasoning?.defaultEffort` when
  a default exists; picking an effort re-submits the same route with that effort.

### `selectModel` behavior (live-only; resumes cold)

1. `resolveAgent(sessionId)` — cold session is resumed.
2. `requireModel` → `ctx.llm.listProviders()` + `ctx.llm.listModels(provider)` availability.
3. Builds `{provider, model, reasoningEffort?}` (any `reasoningEffort` is branded, not
   validated by the brander), then `await ctx.llm.resolveCallConfig(selected)`.
4. `agent.model.select(selected)` → appends durable `model/selection` event (idempotent
   when unchanged) — this drives the `modelSelection` projection.
5. `ctx.agentDefaultModel.saveSelection(selected)` in the background (writes profile
   config via `configEditor`; failures are logged, not surfaced).
6. Returns `{ selected }`. Any validation failure is remapped to
   `RemoteError('session/model-unavailable', message, {provider, model})`.

**Effort validation** happens inside `llm.resolveCallConfig`/`prepareCall` against the
resolved adapter; a wrong effort id therefore surfaces as **`session/model-unavailable`**
(no dedicated code). **UNVERIFIED:** the exact adapter-side check text.

### Reading the current effort for a session

- **Cold-safe:** `sessionController.projections({sessionId}, signal)` →
  `values.modelSelection` = `{ lastUsed: ModelSelection|null, next: ModelSelection|null }`
  (`next` = pending choice ?? lastUsed). Effective effort =
  `(next ?? lastUsed)?.reasoningEffort ?? catalogModel.reasoning.defaultEffort`.
  `modelSelection` is a *summary* projection, so it is also in `list()` rows.
- **Live:** `ctx.agents.get(id)?.model.current()` returns `{provider, model, reasoningEffort?}`
  where a recorded selection wins and falls back to `agent.options` (provider/model/effort
  supplied at creation).
- A durable `request/header` event records what the request actually used:
  `data.header.config` (may include `reasoningEffort`) and
  `data.header.adapterDefaults.reasoningEffort === true` means the adapter defaulted it
  (so it should be displayed as “provider default”, not as a selected effort).

### Gotchas

- `modelCatalog()` groups only **routable** providers; a provider that throws appears only
  in `failures[]`. A model can be absent from the picker while the provider is configured.
- The catalog does **not** expose `inputModalities`; to decide whether a model accepts
  images (item 9) use `ctx.llm.resolveModelInfo(provider, model)` and check
  `inputModalities?.includes('image')` (catalog `LlmModelInfo.inputModalities`).
- `selectModel` also changes the **deployment default** (background save), matching the
  desktop’s behaviour. A phone model change is therefore persistent across sessions.

### Recommended frames

`models` already exists; extend each catalog entry:
`{ provider, model, label, reasoning: { efforts:[{id,name,description?}], defaultEffort? } | null }`
and `current: {provider, model, reasoningEffort, effectiveEffort, effortLabel}`.
Add `model.select` accepting `reasoningEffort: string|null` (null = provider default).

---

## 2. `sessionController.rename` / `fork`

### Rename

```ts
@Remote('rename') rename(request: SessionRenameRequest): Promise<SessionRenameValue>
interface SessionRenameRequest { readonly sessionId: SessionId; readonly title: string }
interface SessionRenameValue   { readonly title: string; readonly seq: number }
```

- **Resumes cold sessions**: `commands.rename` calls `resolveAgent(sessionId)` first, so a
  persisted session is opened, then `ctx.sessionTitle.rename(agent.session, request.title)`.
- **Title validation/normalization** (`dsh-session-title`): strips OSC/CSI/ESC control
  sequences, control characters and bidi directional controls, collapses all whitespace to
  single spaces, trims, then truncates to `maxTitleBytes` **UTF-8 bytes without splitting a
  code point**. Empty result → `RemoteError('session/title-invalid', 'session title must
  contain visible characters', {sessionId})`.
- **Limit is deployment config**: `maxTitleBytes` (required config). The shipped desktop
  composition (`dsh-base/cordis.patch.yml`) sets `maxTitleBytes: 80`, `fallbackMaxWords: 5`,
  `fallbackMaxBytes: 40`. Treat **80 UTF-8 bytes** as the phone limit; longer titles are
  silently truncated (not rejected).
- Appends durable `session/title` with `{title, messageSeqs: [], source: {kind:'user'}}`,
  updates the `title` projection, and returns the accepted title + event seq.
  A user rename pins the title (supersedes automatic generation).
- Errors: `session/title-invalid` (empty), `session/not-found`, `session/agent-busy`
  (subagent ownership), `gateway/internal`.

### Fork

```ts
@Remote('fork') async fork(request: SessionForkRequest): Promise<SessionForkValue>
interface SessionForkRequest { readonly sessionId: SessionId; readonly atSeq?: number; readonly allowMigration?: boolean }
interface SessionForkValue   { readonly sessionId: SessionId }
```

- **What it forks:** an exact event prefix of the source log (inclusive `atSeq`). Omitted
  `atSeq` = latest completed-turn prefix (`turn/end` plus trailing standalone events before
  the next `turn/start`/appended user message/inbox splice). No completed turn →
  `RemoteError('session/fork-unavailable', 'session "…" has no completed turn to fork from')`.
  Invalid `atSeq` (not an existing seq) → `session/fork-unavailable`.
- **Cold source is fine:** the controller reads via `ctx.sessionQuery.observeSession`, so a
  persisted session forks without activation. An open cut (source mid-turn) gets synthetic
  fork closers.
- **Migration nuance:** if the source is *not live* and its stored format is
  `migration-required`, `allowMigration: false` rejects **before** forking with
  `RemoteError('session/migration-required', 'Open the source Session to complete migration before forking')`.
  Omitted/`true` lets the read path migrate.
- **Child characteristics:** new id `session-<uuid>`; `cwd` inherited from the source header
  (omitted if the source has none — a cwd-less fork is a corner case; **UNVERIFIED** whether
  the loop accepts a cwd-less Agent); seeded with the source prefix
  (`buildForkSeed`, `inheritedEventCount`, `isSeeded: true`); `agentPreset` inherited from
  the source’s *current* preset; attached to the source’s workspace when the source belongs
  to one. It is an **independent conversation** (not `origin:'subagent'`, no
  `parentSession`), and archiving the source does not archive the fork.
- **Appears in `list()`?** Yes — a normally persisted top-level session
  (`sessionController.list()` reads `sessionQuery.listSessions`, which includes live and
  persisted sessions). The desktop client also inserts a local `blank:true` placeholder
  until the refreshed summary arrives.
- Errors: `session/not-found`, `session/fork-unavailable`, `session/migration-required`,
  `subagent/…` (address validation), `session/workspace-attach-failed`, `gateway/internal`.

### Recommended frames

`session.rename {sessionId,title}` → `session.updated {session}`; `session.fork {sessionId,
atSeq?}` → `session.forked {sessionId, sourceSessionId}` plus a refreshed `sessions` list
(the fork is a normal session). If exposing `atSeq`, validate `0 <= atSeq <= lastSeq` client-side
and expect `session/fork-unavailable` otherwise.

---

## 3. `sessionController.search`

```ts
@Remote('search') async search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue>
interface SessionSearchValue { readonly items: readonly SessionSearchItem[]; readonly hasMore: boolean }
interface SessionSearchItem  { readonly sessionId: SessionId; readonly snippet: string }
// SessionSearchRequest is not in the catalog; the controller only reads `request.query`
```

- **Request:** the controller passes `request.query` only
  (`this.listState.search(request.query, signal)`); extra fields are ignored. Query is
  trimmed; empty → `gateway/bad-request`; >500 UTF-16 chars or containing NUL →
  `gateway/bad-request`.
- **What is searched:** literal message *content*, not titles. The provider call uses
  `eventFilters: [{kind:'type', values:['user/message','assistant/message']},
  {kind:'surface', values:['current']}]` — only the current model-visible surface, so
  messages removed by surface replacement/compaction do not match. Case sensitivity and
  tokenization are provider-defined (`dsh-session-query-sqlite`); **UNVERIFIED** (treat as
  literal substring/FTS and let the UI show the snippet).
- **Cold-safe:** no Agent resume, no projection requirement. Requires `sessionQuery` to be
  mounted; otherwise `gateway/internal` “session search is unavailable: this deployment does
  not mount @deepseek-ai/dsh-session-query”.
- **Pagination/limits:** the controller internally pages the provider, deduplicates by
  session (best match per session), caps at `SESSION_SEARCH_RESULT_LIMIT = 20` sessions,
  truncates each snippet to `SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240` code points, and
  returns `hasMore` = “there were more hits before `remoteAccess` filtering”. **No cursor
  or offset is exposed by `sessionController.search`** (the underlying
  `SessionSearchRequest` has `query/filters?/limit?/cursor?`, but the controller does not
  forward them). V1 phone search is therefore “top 20 sessions + hasMore”.
- Errors: `gateway/bad-request` (query), `gateway/internal` (provider failure);
  cancellation → `gateway/cancelled`.

### Recommended frame

`search.query {query}` → `search.results {query, items:[{sessionId,snippet}], hasMore}`.
Add `session.search` to the SPA with a debounce; no pagination until v3 (to page, the bridge
would have to call `ctx.sessionQuery.searchSessions` directly and stitch `cursor`).

---

## 4. Queue: `state().queue`, `pendingInput`, `updateQueue`, prompt modes

### Signatures

```ts
@Remote state(request: SessionStateRequest, signal: AbortSignal): Promise<SessionState>
@Remote('updateQueue') updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue>
@Remote('prompt') async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>

interface SessionState {
  readonly cursor: number;
  readonly active: boolean;          // false = cold/no attached Agent
  readonly running: boolean;
  readonly queue: readonly SessionQueuedItem[] | null;   // null while inactive
  readonly pendingInput: readonly ('approval'|'question'|'other')[];
}
interface SessionQueuedItem {
  readonly id: MessageId;
  readonly placement: 'queued' | 'steering' | 'context';
  readonly rpcId?: SessionRequestId;
  readonly content: readonly JsonValue[];   // content blocks: {type:'text',text} / image / file
}
interface SessionUpdateQueueRequest {
  readonly sessionId: SessionId;
  readonly itemId: MessageId;
  readonly action: QueueAction;
}
type QueueAction =
  | { readonly kind: 'edit'; readonly content: readonly TextBlock[] }  // text blocks only, non-whitespace required
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' };
interface SessionUpdateQueueValue { readonly accepted: true }
interface SessionPromptRequest {
  readonly requestId: SessionRequestId;   // idempotency key (duplicate ids are ignored)
  readonly sessionId: SessionId;
  readonly mode: 'queue' | 'steer';
  readonly content: readonly PromptContentPart[];
  readonly clientTimeZone?: string;
}
interface SessionPromptValue { readonly accepted: true }
```

Queue semantics (verified in `commands.js` / `state/controller.js`):

- `queue` = `[...agent.inbox.nextTurn.map(placement 'queued'), ...agent.inbox.nextStep.map(
  source.kind==='user' ? 'steering' : 'context')]`; each carries `id`, optional `rpcId`
  (prompt request id) and the original content blocks.
- **`pendingInput`** is derived from `ctx.typertGateway.getPendingRemoteEvents()` and
  reports `'approval'` (approval/request), `'question'` (user-questions/request) or
  `'other'`. It is *not* the queue; a running turn blocked on approval usually has
  `pendingInput: ['approval']`.
- **Queue items are in-memory** until the loop claims them at the start of the next
  turn/step. Only then do they become durable `user/message` events with
  `surfaceOp:'append'`. Consequence: the phone’s history will not show a queued prompt
  until it is admitted; `state().queue` is the only read.
- The durable trace of inbox mutations is `agent/inbox/spliced`:
  `{ target: 'next-turn'|'next-step', start, removedCount?, inserted: Message[], outcome? }`
  (each inserted entry is a full Message, so `id`/`content`/`source.rpcId` are recoverable).
  Our bridge can forward these as queue-change pushes without polling `state()`.
- **No reorder action exists.** Only edit / remove / steer. Edit accepts **text blocks
  only** (`content.some(b => b.type !== 'text')` → `session/attachment-invalid`
  `QUEUE_EDIT_NON_TEXT`); empty text → `gateway/bad-request`. Edit/remove locate the item in
  `nextTurn` or `nextStep`; not found → `session/queue-item-not-found`. Steer requires the
  item to be in `next-turn` **and** `agent.status === 'running'`, else
  `session/steer-unavailable`. Remove retires the prompt’s upload receipts for its `rpcId`.
  `updateQueue` resolves a cold session first; if it cannot, `session/queue-item-not-found`.
- **Prompt modes:** `mode:'queue'` → `agent.followup(message)` (next-turn queue);
  `mode:'steer'` → `agent.steer(message)` (nearest next-step injection; requires a running
  turn — otherwise `session/agent-busy`). Duplicate `requestId` (same `rpcId` in inbox or
  durable log) returns `{accepted:true}` without enqueueing again. `hasPromptContent` rejects
  whitespace-only content. Image parts are admitted first (item 9).

### Gotchas

- `state()` is live-only in effect: for a cold session `queue` is `null` and `active:false`;
  do not attempt `updateQueue` on it (it would resume/queue-fail).
- `queued` items have `id` values that are Message ids, **not** durable session seqs; keep
  them as opaque ids.
- Queue edits do not touch the model transcript; the phone must re-read `state()` (or handle
  our pushed `queue.changed`) after edit/remove/steer.
- `pendingInput` can contain `'approval'` while an approval card is pending; don’t use it as
  a running flag (`running` is separate).

### Recommended frames

`queue.list {sessionId}` → `queue {sessionId, items:[{id, placement, rpcId?, text}], pendingInput:[...]}`
(server-side flatten text blocks); `queue.update {sessionId, itemId, action:{kind:'edit',text}|{kind:'remove'}|{kind:'steer'}}`;
push `queue.changed {sessionId, items}` from `state()` refresh and/or `agent/inbox/spliced`.
Extend `prompt` with `mode: 'queue'|'steer'` (default queue) and reuse `requestId`.

---

## 5. Workspace pin / archive

### Signatures (live inspect)

```ts
// ctx.workspaceController (dsh-api-workspace-controller)
@Remote('archiveSession')   archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue>
@Remote('unarchiveSession') unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue>
@Remote('pinSession')       pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue>
@Remote('unpinSession')     unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue>
@Remote({mode:'stream'}) async *follow(signal): AsyncIterable<WorkspaceFollowFrame>

interface WorkspaceArchiveSessionRequest { readonly sessionId: SessionId; readonly stopActivity?: boolean }
interface WorkspaceArchiveValue { readonly archivedSessionIds: readonly SessionId[] }
interface WorkspacePinSessionRequest { readonly sessionId: SessionId }
interface WorkspacePinValue { readonly pinnedSessionIds: readonly SessionId[] }

type WorkspaceFollowFrame =
  | { readonly type:'baseline'; readonly value: WorkspaceBaseline }
  | { readonly type:'replace';  readonly value: WorkspaceBaseline }
  | { readonly type:'upsert';   readonly workspace: WorkspaceView }
  | { readonly type:'remove';   readonly workspaceId: WorkspaceId }
  | { readonly type:'order';    readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type:'archived'; readonly archivedSessionIds: readonly SessionId[] }
  | { readonly type:'pinned';   readonly pinnedSessionIds: readonly SessionId[] };

interface WorkspaceBaseline {
  readonly items: readonly WorkspaceView[];
  readonly archivedSessionIds: readonly SessionId[];
  readonly pinnedSessionIds: readonly SessionId[];
}
interface WorkspaceView {
  readonly workspaceId: WorkspaceId; readonly path: string;   // absolute host path — strip on the phone
  readonly title: string; readonly sessionIds: readonly SessionId[];
  readonly createdAt: string; readonly updatedAt: string;
}
```

Registry semantics (`dsh-workspace/lib/types/index.js`):

- Sets are **registry-global** (not per-workspace): `workspaceRegistry.archivedSessionIds`
  and `workspaceRegistry.pinnedSessionIds` getters expose them to Host plugins directly
  (no Remote call needed; no signal).
- **Archive**: session must exist live **or in persistence** (else `WorkspaceUnknownSessionError`);
  without `stopActivity`, the `workspace/session-activity` waterfall is asked and any reported
  activity rejects with `WorkspaceActiveSessionError`; with `stopActivity:true` the archive is
  written first and `workspace/session-stop` providers then stop work (agent turn, jobs,
  subagents, schedules); archiving **drops the pin** in the same write (mutually exclusive);
  already archived = no-op. Workspace accounting (`sessionIds` order) is untouched, so
  unarchiving restores position. Unarchive never checks existence; not archived = no-op.
- **Pin**: session must exist and **must not be archived** (else
  `WorkspaceArchivedSessionPinError`); prepends to the pin list (most recent first); already
  pinned = no-op.
- Archive gate: an archived session (and subagent descendants) cannot run a model step —
  the controller plugin listens on `agent/pre-step` and rejects; the turn ends `blocked`
  without a model request. **Unarchiving lifts the gate for the whole lineage.** Therefore a
  prompt sent to an archived session is accepted into the queue but never runs; the phone
  should disable send when archived (or auto-unarchive).

### Do archived sessions disappear from `sessionController.list()`?

**No.** `list()` = `ctx.sessionQuery.listSessions()` (all live + persisted) filtered only by
`remoteAccess.allows()`; there is no archive filter in the controller or session query.
The desktop hides archived rows client-side from `WorkspaceBaseline.archivedSessionIds`.
The phone bridge must apply the same filter, from:
- `ctx.workspaceRegistry.archivedSessionIds` / `.pinnedSessionIds` (Host-contract getters,
  cheapest, synchronous), or
- `ctx.workspaceController.follow(signal)` frames (baseline + `archived`/`pinned` increments).

`WorkspaceView.path` is an absolute host filesystem path: **never send it to the phone**
(v1 rule). The `title` is safe.

### Gotchas

- No `signal` parameter on the four mutations; they are serialized internally
  (`enqueueOperation`) against other registry writes.
- `stopActivity` is destructive: it stops a running turn/job. Never default it on the phone
  without a confirm.
- If the deployment mounts no workspace controller/registry (workspace feature disabled),
  archive/pin are unavailable; the bridge must degrade (report `archived:false`,
  `pinned:false`, hide controls).
- Archiving also affects workspace grouping in the desktop sidebar; the phone only needs
  the flags.
- Pinning and archiving are mutually exclusive; an archive silently unpins.

### Recommended frames

Add to `sessions` / session object: `pinned:boolean`, `archived:boolean` (from registry
sets). Add `workspace.state` (baseline sets) and `session.pin|unpin|archive|unarchive`
commands mirrored to all devices, echoing the returned id arrays. Keep paths server-side.

---

## 6. `workspaceChanges.summary` / `diff`

### Signatures (live inspect + catalog)

```ts
// ctx.workspaceChanges (dsh-workspace-changes)
summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>

interface WorkspaceChangesSummary {
  turn: number;
  cwd: string;                         // absolute — strip on the phone
  files: WorkspaceChangedFile[];       // kept files (<= maxFiles)
  total: number;                       // full changed count before the maxFiles cap
  added: number; deleted: number;
  snapshot?: { before: string; after: string };   // opaque snapshot ids, omit from phone
}
interface WorkspaceChangedFile {
  path: string;                        // relative inside cwd, absolute elsewhere — strip/display
  display: string;                     // slash path, may be `~/...`; safe-ish but may reveal home
  added: number; deleted: number; binary?: true; oversized?: true;
}
type WorkspaceFileDiff =
  | { kind:'text'; path; display; before: boolean; after: boolean;
      hunks: { oldStart:number; oldLines:number; newStart:number; newLines:number; lines:string[] }[];
      coarse: boolean }
  | { kind:'binary'; path; display }
  | { kind:'oversized'; path; display };
```

### Semantics

- `seq` is the **Session event sequence of the `workspace/changes` event**, not a turn or
  file index. The event itself carries only `{turn}`; the summary is held in Host memory by
  the recorder, keyed by that seq. The client discovers seqs by scanning session history for
  `workspace/changes` events (desktop deliverables UI does exactly this: `changesSummaryUrl(
  sessionId, seq)`).
- `index` is the **original index in `summary.files`** (the array after the `maxFiles` cap).
  Any file in the capped array works; out-of-range or unknown seq → `undefined`.
- **Live-process only:** the recorder exists for **live Sessions of this Host process**;
  `session/disposed` deletes its record (`forget`). A cold session, or a session this Host
  never recorded (e.g. another process wrote the event), returns `undefined`. The durable
  event survives but the summary does not.
- `diff` returns a refusal-kind record (`kind:'binary'` / `kind:'oversized'`) instead of
  hunks for uncomparable files; `kind:'text'` carries unified-style hunks whose `lines[]`
  entries are `+added`, `-deleted`, or context lines (no `@@` headers). `coarse:true` means
  the line diff exceeded `diffTimeoutMs` and one whole-file hunk was produced.
- Limits (defaults in `dsh-workspace-changes` Config — deployment may override):
  `timeoutMs 30000`, `outputMaxBytes 8 MiB`, `maxFiles 500`, `maxFileBytes 2 MiB`,
  `diffTimeoutMs 100`.
- `summary` is synchronous; `diff` is async and **throws** when a snapshot read fails while
  the recorder lives. Both return `undefined` for unknown coordinates.
- No pagination; a summary is bounded by `maxFiles`/`maxFileBytes`, a diff by these caps +
  the coarse fallback.

### Recommended frames

`changes.list {sessionId, limit}` → `{items:[{seq, turn, total, added, deleted, files:[{display,path?,added,deleted,binary?,oversized?}]}]}`
(derive seq/turn from history `workspace/changes` events; keep `cwd` server-side).
`changes.diff {sessionId, seq, index}` → `{kind, display, hunks|reason, coarse}`. Cache
per (session,seq) and evict on session dispose. Expect `undefined` for cold sessions — show
“diff unavailable (session not live)”.

---

## 7. Token meter / context pressure

### Signatures (live inspect + catalog)

```ts
// ctx.tokenMeter
contextPressure(session: Session): Pick<ContextPressureProjection, 'pressureTokens' | 'contextWindow'>
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement
estimateMessage(message: Message): number

interface ContextPressureProjection { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
interface TokenMeasurement {
  readonly logRevision: SessionLogOffset;
  readonly baseline: { kind:'none'; tokens:0 }
                  | { kind:'estimated'; tokens:number }
                  | { kind:'usage'; tokens:number; usage: Readonly<TokenUsage> };
  readonly surfaceDeltaTokens: number;
  readonly totalTokens: number;
  readonly surfaceTokens: number;
  readonly nodes: readonly { seq: SessionSeq; tokens: number; heuristicTokens: number }[];
}
interface TokenUsage { inputTokens; outputTokens; totalTokens?; cacheReadTokens?; cacheWriteTokens?; reasoningTokens?: number }
```

### How to obtain the `Session` object it needs

- `sessionController`/`sessionQuery` expose **no** cold `Session` object. `tokenMeter.*`
  takes a live in-memory `Session`:
  - `ctx.sessions.get(sessionId)` (attached only), or
  - `ctx.agents.get(sessionId)?.session` (live Agent), or resume first with
    `ctx.sessionController.resolveAgent(sessionId)` and use `result.agent.session`.
- `ctx.sessions.prepare(id, options)` exists but is an internal persistence primitive
  (creates an unprepared Session); **not recommended** for cold reads — **UNVERIFIED**.
- **Cold-safe alternative:** the `contextPressure` projection has a wire view
  (`usage-projection.js`), `summary:false`:
  `sessionController.projections({sessionId})` → `values.contextPressure =
  { contextWindow?, pressureTokens?, projectedTokens? }`. The projection fold runs from the
  session log (`projectionMode:'all'`), so it works for cold sessions without activation.
  Semantics: `pressureTokens` = provider prompt-side tokens from the latest usage sample;
  `contextWindow` = latest `request/context.contextWindow`;
  `projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`.

### Is `measure` suitable for a phone meter?

- Yes, for live sessions: `totalTokens` (baseline + surface delta) vs `contextPressure().contextWindow`
  is exactly a used/limit meter; `baseline.kind` tells you whether the number is provider
  usage (`'usage'`) or an estimator (`'estimated'`/`'none'`) — display it honestly.
- `measure` is heavier (walks the current surface nodes), and the second argument is an
  optional `EpochHeader` to price against a specific request configuration. For a phone
  status line, prefer the projections:
  - used: `contextPressure.projectedTokens ?? pressureTokens ?? 0`
  - limit: `contextPressure.contextWindow`
  - cumulative spend buckets: `values.tokenUsage` (projection wire view returns
    `state.totals`, TokenUsage-like buckets) — useful for “tokens used this session”, but
    it is provider usage, not a limit.
- **`tokenMeasurement` projection is Host-only** (no wire view); `measure()` is the only
  way to get per-node detail.

### Gotchas

- `pressureTokens` is **prompt-side only** and advances only when the next request reports
  usage; it does not move during a streaming turn. A “context full” meter should use
  `projectedTokens`.
- Cold sessions: no `measure`, but projections work; if the projection cache/log lacks
  `request/context` (e.g. never ran a turn) fields are absent — display “unknown”, not 0.
- Resuming a cold session (`resolveAgent`) just to read the meter is expensive (loads the
  Agent/preset); use projections instead.

### Recommended frames

`context.get {sessionId}` → `{pressureTokens?, projectedTokens?, contextWindow?, basis:'usage'|'estimated'|'unknown', tokenUsage?:{input,output,cacheRead?,cacheWrite?,reasoning?}}`.
Push `context.changed {sessionId, ...}` after `turn/end`, `assistant/message` and
`request/context` events (or poll on demand). SPA renders a ratio bar + “estimated” badge.

---

## 8. `commands.list` / `commands.execute`

### Signatures (live inspect + catalog)

```ts
// ctx.commands (dsh-commands)
@Remote list(agent: Agent): readonly CommandDescriptor[]
find(agent: Agent, name: string): CommandDefinition | undefined
@Remote async execute(
  agent: Agent, line: string, submittedAttachments: readonly CommandSubmitAttachment[], signal: AbortSignal,
): Promise<CommandExecution | undefined>

interface CommandDescriptor { definitionId?: CommandDefinitionId; name: string; description: string;
                              input?: { hint: string; attachments?: boolean } }
interface CommandExecution { commandId: CommandId; result: CommandResult }
type CommandResult = { kind:'success'; text?: string; sourceEventSeq?: SessionSeq }
                   | { kind:'error'; text: string }
type CommandSubmitAttachment = ({ type:'image' } & { mediaType: ImageMediaType; data: string; name?: string })
                             | { type:'file'; receiptId: string };
```

### Requirements and safety

- **Requires a live Agent.** Both methods take an `Agent` and resolve commands through the
  Agent’s scoped Cordis layers (`view(agent)`), so the Agent must be in the registry; typert’s
  `agent` lookup is `ctx.agents.get(id)` and does **not** resume. For a cold session, the
  bridge must `resolveAgent(sessionId)` first (this activates the session) and then call
  `commands.list(agent)`/`execute(agent, …)`. There is no cold command listing.
- **No Host-side safety/remote flag.** `CommandDescriptor` has only name/description/input.
  Commands are registered globally or per-Agent scope; the desktop’s command palette uses
  the same list. The installed build registers e.g. `compact` (“Compact older conversation
  history”, `dsh-command-compact`) plus preset/agent-scoped commands and client-side
  consumer commands. Some are destructive to context; **the phone must ship an allowlist**
  (recommend v2: list-only + `compact` behind a confirm, or omit commands entirely until a
  curation decision).
- **Execution results map back into the session as durable events**, not as model messages:
  - `command/run` `{ commandId, name, args?, source:{kind:'user'} }` appended before the
    handler; `args` is the raw input after the command name unless `recordInput === false`.
  - `command/done` `{ commandId, kind:'success'|'error', text?, sourceEventSeq? }` appended
    after settlement (thrown/aborted handler → `kind:'error'`).
  - Both are **log-only** appends: no turn wraps them, they are not on the message surface.
    The phone history should render them as new `command` items (or `system`), pairing by
    `commandId`; `sourceEventSeq` points at a produced event (e.g. compaction checkpoint) and
    is metadata, not a message.
  - Admission misses (malformed line, unknown name) return `undefined` and log nothing;
    the composer shows an immediate error. Handler errors become `CommandResult{kind:'error'}`.
- Attachment admission is enforced inside `execute` before the handler: attachments only if
  `input.attachments === true`, absent attachment store → error result, image limits →
  error result (`CommandResult`, not a throw). `signal.aborted` before dispatch throws.
- Proposed-but-unrun lines do not enter model context.

### Gotchas

- The `Agent` parameter comes from the Remote lookup; a **Host plugin** should call
  `ctx.commands.list(agent)` directly with a resolved live agent (same object identity
  matters for scoped layering: use `ctx.agents.get(id)` after `resolveAgent`).
- Executing a command may itself run a compaction that rewrites the surface; treat history
  as stale and refresh after `command/done`.
- `commands.list` output differs per Agent scope/preset — not a global catalog.

### Recommended frames

`commands.list {sessionId}` → `commands {items:[{name,description,hint?,attachments?}], available:boolean}`
(filtered by the bridge allowlist; `available:false` when the session is cold and resume is
not desired). `commands.execute {sessionId,line,requestId?}` → `command.result
{commandId,name,kind,text?,sourceEventSeq?}`; push `command.started/done` frames from the
`command/run`/`command/done` session events. Add `command` HistoryItem kind (`id:
command:<commandId>`) so reloads render the same flow node.

---

## 9. Attachments and the image path

### Exact content-part shapes

```ts
// Browser-safe prompt part (dsh-cordis-client-runner PromptContentPart):
type PromptContentPart =
  | { readonly type:'text'; readonly text:string }
  | { readonly type:'image'; readonly mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif';
      readonly data: string /* canonical base64 */; readonly name?: string }
  | { readonly type:'file'; readonly receiptId: string };

// Admitted/durable content (AdmittedPromptContentPart):
| { type:'text'; text }
| { type:'image'; attachment: ImageAttachmentRef }
| { type:'file'; attachment: FileAttachmentRef }

interface ImageAttachmentRef {
  attachmentId: AttachmentId;                    // content-addressed `sha256:<hex>`; never a path/URL
  mediaType: ImageMediaType; bytes: number; width: number; height: number;
  name?: string; originalDimensions?: { width:number; height:number };
}
interface ImageBlock { type:'image'; attachment: ImageAttachmentRef; offloaded?: true }
```

`sessionController.prompt` runs: `resolvePromptFileReceipts(content)` (turns `{type:'file',
receiptId}` into the staged attachment — which may be an image) → `attachments.admitPromptContent`
(encodes/admits encoded image parts and passes stored images through) → `createUserMessage`
→ image-capability check against the current model. So **both** of these work:

1. **Inline encoded image (no pre-upload):**
   `{type:'image', mediaType, data: <canonical base64>, name?}` in `prompt.content` — the
   attachment store saves it (`admitEncodedImages`), returns a durable `ImageAttachmentRef`,
   and the message contains an `ImageBlock`.
2. **Staged upload receipt (desktop-style, streams bytes to the Host):**
   `ctx.fileUploads.uploadImageStream({ sessionId, data: AsyncIterable<Uint8Array>, mediaType, signal?, name? })`
   → `{ receiptId, image: ImageAttachmentRef }`; then `prompt.content` contains
   `{type:'file', receiptId}`. The controller replaces it with the staged image; `bindPrompt`
   pins the receipt to the `requestId` until the accepted `user/message` (matching
   `source.rpcId`) is observed, then the receipt is retired. Unknown/foreign/expired receipt
   → `session/attachment-invalid` (`FILE_NOT_STAGED`).
   For files use `uploadStream` (same shape) or `ctx.fileUploads.upload(agent, {data:
   canonicalBase64, name?})` (Remote variant).

`saveImage({data:Uint8Array, mediaType, name?})` stores directly without a receipt and
returns an `ImageAttachmentRef`; a stored-image part (`{type:'image', attachment, encodedBytes}`
in the admission type) also passes through. Use receipts or inline base64 for prompts;
`saveImage` is useful when you already hold bytes and want a ref before composing content.

### Limits

`ctx.attachments.imageLimits` (`ImageAttachmentLimits`):

```ts
{ maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, maxImagePixels, maxImageDimension,
  mediaTypes: readonly ImageMediaType[] }
```

- `maxImagesPerMessage` default **20**; `maxImageBytes` default **52_428_800 (50 MiB)**;
  other defaults are constants in `dsh-attachment-local` that were not resolved here
  (**UNVERIFIED** — read the live object at runtime). `mediaTypes` is deployment-filtered;
  declaring an unsupported type → `session/attachment-invalid` `UNSUPPORTED_IMAGE_TYPE`.
- `uploadImageStream` reads at most `min(maxImageBytes, maxMessageImageBytes)` and fails with
  `IMAGE_TOO_LARGE`; admission validates count/aggregate bytes (`TOO_MANY_IMAGES`,
  `IMAGES_TOO_LARGE`), detects the real media type (`IMAGE_TYPE_MISMATCH`), enforces
  pixel/dimension limits, and normalizes (downscales) before storing; `originalDimensions`
  records a downscale.
- Cold-safe way to read limits: `sessionController.projections({sessionId})` →
  `values.imageLimits` (projection wire view is `summary:false`, so it is absent from list
  rows but present in full projections).

### Reading an image back for a phone preview

- `sessionController.attachment({ sessionId, attachment: ImageAttachmentRef })` →
  `{ attachment, data: <base64> }` (does not check session existence; reads the store).
- `ctx.attachments.readImage(ref, signal)` → `StoredImageAttachment { ref, data: Uint8Array }`
  (Host-path convenience). `readImageRequest(ref, target, signal)` derives provider-request
  images (not needed for a UI preview).
- Sources of refs for the SPA: durable message content blocks (`user/message`,
  `assistant/message`) contain `ImageBlock` with `attachment`; v2 history mapping should
  emit `attachments:[{attachmentId,mediaType,bytes,width,height,name?}]` instead of trying to
  inline bytes. Preview = `attachment.get {attachmentId}` → base64 (cache client-side by id,
  content-addressed and immutable).

### Recommended changes to our bridge

- Replace the v1 “append file paths as text” behaviour with content parts.
- `prompt` request extension: `content` parts `[{type:'text',text},{type:'image',mediaType,data}]`
  or a two-step `upload.image` frame that returns `{receiptId, image}` then a prompt with
  `{type:'file',receiptId}`. Inline base64 is simpler for a phone (no receipt lifecycle), but
  costs ~33% payload; prefer streaming upload for photos and inline for small screenshots.
- `history` items gain `attachments[]`; `attachment.get` returns base64 with a size cap.
- `image.limits` frame for the SPA picker (from projections or `ctx.attachments.imageLimits`).
- Check `llm.resolveModelInfo(provider, model).inputModalities.includes('image')` before
  showing the photo button; otherwise the prompt fails with `session/attachment-invalid`.

**UNVERIFIED:** which of inline-base64 vs staged-receipt the current desktop chat composer
uses end-to-end (the bundled client uploads via the Host streaming route and returns
`receiptId`; the exact prompt-content assembly is inside a bundled client module and was not
traced). Both shapes are accepted by the Host runtime; probe once with a real session.

---

## 10. `approval/request` payload, outcomes, policy

### Payload

```ts
interface ApprovalRequestEvent {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: ToolCallId;
  readonly reason?: string;                                  // model-facing explanation
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string };  // localized UI text
  readonly signal?: AbortSignal;
}
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
```

- **No tool arguments / command text / diff preview.** The waterfall payload carries only
  tool name, optional call id, reason, localized display reason and the abort signal.
  `dsh-tools/lib/pipeline.js` builds it as `{agent, toolName, callId, reason?, displayReason?,
  signal}` from a tool’s `PreToolDecision.ask`. `displayReason` is a localization map (pick
  `en` on the phone) supplied by the asking tool (e.g. the sandbox escalation wording).
- **To enrich an approval card**, correlate `callId` with the durable `tool/call` event
  (`data.arguments` is the raw JSON string) — either from our live `onTool` cache (v1 already
  keeps `toolStarts`) or by scanning the recent history page. The arguments may contain the
  command/path; `reason`/`displayReason` are the only model/UI text the Host supplies.
  Diff previews are impossible at ask time (the tool has not run); only the tool’s args.
- The service appends a durable audit pair: `approval/asked` `{id, toolName, callId?, reason?}`
  and `approval/decided` `{id, outcome}` (turn-enclosed). The `id` is generated inside
  `ApprovalService.request` and is **not** in the waterfall payload; our bridge-owned
  `requestId` remains necessary. The pair can be observed via `session/event` if an audit id
  is wanted.
- A request outside an open turn throws (the service requires `turnOpen`); a missing answerer
  fails closed with `'unavailable'`; a throwing answerer is contained to `'unavailable'`;
  rogue returns are normalized to `'unavailable'`.

### Outcomes / “always allow”

- Exactly four outcomes; **`allowed-once` is the only grant**. There is **no
  allow-for-session / always-allow outcome**, no persistent grant and no “remember” API.
- `ApprovalPolicy = 'ask' | 'never'` only. `approval.setPolicy(agent, policy)` requires a
  **live** Agent, appends durable `approval/policy` and injects a model-visible notice
  (`user/message` with `source.kind:'user-approval'`); `overrideOf(session)` returns the
  session’s logged policy or `undefined`; effective policy = `overrideOf ?? config.policy ??
  'ask'`; `approvalState` projection = `{policy, turnOpen}`. `'never'` auto-rejects **before**
  any answerer runs — it is the opposite of an allow-always switch. Do **not** offer “always
  allow” on the phone in v2; only allow-once / reject. `setPolicy` should only be exposed (if
  at all) as an explicit, clearly labelled security setting on the desktop.
- Approval routing in v15 is **exclusive to the connected phone**: when a phone client is
  connected the bridge answers the waterfall and does not call `next()`; with no phone it
  delegates to the desktop answerer. Earlier v1 builds raced `next()` concurrently, which
  left a duplicate desktop prompt behind when the phone answered first; that design was
  replaced once the plugin-rendered desktop dock could answer from the same pending list.
  Signal abort → `'cancelled'`; no expiry; first answer wins.

### Recommended frames

Keep `approval.request`; add optional `argsPreview` / `args` (bounded/sanitized) and an
`audit` id if the phone needs it. Show `displayReason` (localized) as the card body and
`reason` as secondary text. Do not add allow-always. Push `approval.resolved` for every
decision (phone or desktop) with `by: 'phone' | 'desktop'` so the other surface clears its
card; the bridge implements this via the answering-origin map.

---

## 11. Subagents / Agent Teams (low priority quick note)

```ts
// ctx.subagents (dsh-subagent) — cold-safe reads
listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>
listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<(SubagentCatalogEntry & {parentId; depth})[]>

type SubagentCatalogEntry = { id: SessionId; createdAt: number; label?: string } &
  ({ mode:'one-shot'; label? } | { mode:'external'; label? } | { mode:'continuable'; label:string } | { mode:'unknown'; label? })

// ctx.agentTeams (dsh-experimental-agent-team) — live Agent required
membership(agent): TeamMembership; listMembers(agent): TeamMemberView[];
listTasks(caller): TeamTaskView[]; getTask(caller,id); waitForChange(caller,timeoutMs,signal)
spawnTeammate/sendMessage/createTask/updateTask/interrupt (writes; do not expose on the phone in v2)
```

- `subagents.listChildren` reads the parent’s `subagentCatalog` projection via
  `sessionQuery.observeSession` — **cold-safe**, no Agent resume, but requires the
  `sessionQuery` service and the registered projection (else `SubagentError
  SUBAGENT_CONTROL_QUERY_UNAVAILABLE` / `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`).
  `listDescendants` walks catalogs with parent/depth and branch diagnostics.
- `agentTeams.*` takes an **exact live Agent** as the authority credential (Lead or teammate)
  — no cold path; `membership(agent)` throws for a non-member. Read-only phone view (members
  + tasks) is feasible for a live lead session by resolving it first; writes (spawn/send/
  interrupt/updateTask) are consequential and should stay desktop-only.
- `TeamMemberView`: `{id,name,role:'lead'|'teammate',status:'running'|'inactive'|'provisioning'|'failed',
  description?,provider?,context?:'fresh'|'fork',model?,diagnostics:string[]}`.
  `TeamTaskView`: `{id,revision,subject,description,status,blockedBy,writeScopes,ownerName?,ready,writeScopeWarnings}`.
- **Feature verdict:** a phone “teammates/tasks” read-only tab is feasible (poll
  `agentTeams.listMembers/listTasks` while the lead is live, plus `subagents.listChildren` for
  child sessions). Real-time push needs `waitForChange` (10 min max per call) or team
  projections; defer to v3. No blocker, low value.

---

## Ranked risks (5 riskiest unknowns)

1. **Live-vs-cold capability split is pervasive.** `commands.*`, `tokenMeter.measure/
   contextPressure`, `approval.setPolicy`, `agentTeams.*`, `workspaceChanges.summary/diff`
   all need a live Agent/in-memory Session/recorder; only list/search/events/projections/
   subagents are cold-safe. If the SPA assumes uniform availability it will show dead
   controls and confusing errors. Mitigation: add `agentAvailable` to sessions and hide
   live-only actions; use projections for the context meter.
2. **Image prompt shape is not yet end-to-end verified.** Inline `{type:'image', mediaType,
   data(base64)}` and staged `{type:'file', receiptId}` are both accepted by the runtime
   (code-verified), but which one the desktop chat uses and what the Typert Remote schema
   accepts from our own bridge calls for `prompt.content` is **UNVERIFIED**. Probe with one
   real image before shipping; plan a receipt fallback if inline base64 is rejected.
3. **Archived sessions still appear in `sessionController.list()`.** Archive state lives in
   the workspace registry (`archivedSessionIds`/`pinnedSessionIds`) and is broadcast only via
   `workspaceController.follow`; our bridge must read the registry getters (or follow) and
   filter. If the deployment disables the workspace feature, archive/pin and the
   filter are unavailable — degrade explicitly. Also, prompting an archived session queues
   then ends `blocked` (no error), so the phone needs an “archived — unarchive first” guard.
4. **Commands are unguarded and some are destructive.** There is no Host “remote-safe” flag;
   executing `/compact` (or preset-scoped commands) from a phone can rewrite context. Ship an
   explicit allowlist (or don't ship command execution in v2) and require live-session
   activation.
5. **Approval cards cannot show args/diff from the payload, and there is no allow-always.**
   Enrichment depends on correlating `callId` with `tool/call` arguments (lost across bridge
   restarts unless re-read from history), and the only outcomes are allow-once/reject/
   cancelled/unavailable with a binary `ask|never` policy. Don’t promise “remember this
   approval” UX.

### Feature blockers (plainly)

- No blocker for items 1–5 as read/limited-write features.
- Item 6 (`workspaceChanges`) is **live-process only** — a phone showing “changed files” for
  a cold session will see nothing; historical events are still in history if we later parse
  them, but summaries/diffs are not reconstructable from disk by the plugin.
- Item 7’s `measure()` is **live-only**; the cold path is projections only (sufficient for a
  meter).
- Item 8 execution is **live-only** and unsafe without an allowlist.
- Item 10 “always allow” is **not possible**; only per-request decisions.

---

## Recommended frame additions by batch

**Batch A — session lifecycle (rename/fork/search/pin-archive flags)**
`session.rename`, `session.fork`, `search.query` → `search.results`;
session object gains `pinned`, `archived`, `agentAvailable`; push `workspace.state`
(`archivedSessionIds`, `pinnedSessionIds`).

**Batch B — queued input & steering**
`queue.list`, `queue.update` (`edit`/`remove`/`steer`), push `queue.changed`;
`prompt` gains `mode:'queue'|'steer'`.

**Batch C — workspace changes**
`changes.list {sessionId}` (from `workspace/changes` history events),
`changes.diff {sessionId,seq,index}`; cap payloads; `diff unavailable` for cold sessions.

**Batch D — context meter**
`context.get`/`context.changed` with `projectedTokens`, `contextWindow`, `pressureTokens`,
`basis`, `tokenUsage`.

**Batch E — commands (allowlisted)**
`commands.list`, `commands.execute`; HistoryItem `kind:'command'`
(`command/run`+`command/done` pairing by commandId).

**Batch F — first-class images**
`prompt.content` image parts (or `upload.image` → `{receiptId,image}`);
`history` items `attachments:[{attachmentId,mediaType,bytes,width,height,name?}]`;
`attachment.get {attachmentId}` → base64 preview; `image.limits` frame.

**Batch G — approvals v2 (cards only)**
Extend `approval.request` with bounded `argsPreview`/`args` (from `tool/call` by `callId`)
and optional audit id; keep allow-once/reject only.

---

## Appendix — exact method inventory used here (Cordis Inspect, Host)

- `sessionController`: `list`, `search`, `create`, `selectModel`, `modelCatalog`, `rename`,
  `fork`, `prompt`, `attachment`, `updateQueue`, `cancel`, `events`, `observeEvent`,
  `observeProjections`, `state`, `observeState`, `wait`, `follow`, `projections`, `control`,
  `resolveAgent`.
- `workspaceController`: `create`, `initializeDefault`, `rename`, `delete`, `insertBefore`,
  `insertSessionBefore`, `archiveSession`, `unarchiveSession`, `pinSession`, `unpinSession`,
  `follow`.
- `workspaceChanges`: `summary`, `diff`.
- `tokenMeter`: `contextPressure`, `measure`, `estimateMessage`.
- `commands`: `register`, `registerFileReceiptResolver`, `list`, `find`, `execute`.
- `attachments`: `imageLimits` (getter), `validateImage`, `saveImages`, `admitPromptContent`,
  `admitEncodedFile`, `saveImage`, `readImage`, `saveFile`, `saveFileStream`,
  `readFileStream`, `readImageRequest`, `imageHostPath`, `fileHostPath`.
- `fileUploads`: `upload`, `uploadStream`, `uploadImageStream`, `resolve`, `bindPrompt`,
  `retirePrompt`, `registerAgentResolver`.
- `approval`: `setPolicy`, `request`, `overrideOf`.
- `subagents`: `listChildren`, `listDescendants`, `prompt`, `interruptByParent`, …
- `agentTeams`: `membership`, `listMembers`, `listTasks`, `getTask`, `waitForChange`,
  `spawnTeammate`, `sendMessage`, `createTask`, `updateTask`, `interrupt`.

Events used or recommended: `approval/request` (waterfall),
`agent/assistant-stream`, `agent/status`, `agent/error`, `session/event` (incl.
`command/run`, `command/done`, `agent/inbox/spliced`, `workspace/changes`, `session/title`,
`model/selection`, `approval/asked`, `approval/decided`), `agent/created`, `agent/disposed`,
`session/created`, `session/disposed`, `workspace/session-activity` /
`workspace/session-stop` (registry waterfall/hooks, not needed by us).
