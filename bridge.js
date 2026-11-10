import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

const PREVIEW_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
/** Path-reference block for non-image uploads (and legacy messages). */
const ATTACHMENT_BLOCK_MARKER = "\n\nAttached files from the user's phone (read them with your file tools; images can be opened with read_image):\n"
/** Block listing images that are also sent as real inline image parts. */
const IMAGE_ATTACHMENT_BLOCK_MARKER = "\n\nAttached images from the user's phone (shown inline in this message; already visible to you — no tool call needed):\n"
/** One attachment line inside either block: `- path (name) [mediaType]`. */
const ATTACHMENT_LINE = /^- (.*?)(?: \(([^()]*)\))? \[([^\]]+)\](?: — .*)?$/
/** Media types we can inline as image parts (must match a previewable extension). */
const INLINE_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** Defensive per-message cap, independent of the deployment's attachment limits. */
const MAX_INLINE_IMAGES = 4
/** Defensive per-image cap (5 MiB), further clamped by the attachment service. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024
/** Bounded memory for approval-card call context (oldest evicted first). */
const MAX_APPROVAL_CONTEXTS = 200
/** Bound for the approval card's argument preview. */
const MAX_APPROVAL_PREVIEW_CHARS = 600
/** Keys whose values are never cached or shown on an approval card. */
const SECRET_ARG_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|credential|authorization|cookie|private[-_]?key|session[-_]?key|access[-_]?key|bearer)/i
/** Tools whose primary argument is a shell command. */
const SHELL_TOOL_NAMES = new Set(['pwsh', 'powershell', 'bash', 'sh', 'shell', 'terminal', 'exec', 'run_command', 'command', 'process'])
/** Tools that create or overwrite a file. */
const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'create_file', 'fs_write', 'file_write', 'save_file'])
/** Tools that patch/edit an existing file. */
const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'apply_patch', 'str_replace_editor', 'patch', 'replace', 'replace_string'])
/** Argument keys that may name a file path. */
const PATH_ARG_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target', 'notebook_path']
/** Argument keys that carry a shell command. */
const COMMAND_ARG_KEYS = ['command', 'cmd', 'script', 'input', 'code', 'commandLine']
/** Argument key pairs that carry an edit's before/after text. */
const EDIT_ARG_PAIRS = [
  ['old_string', 'new_string'],
  ['oldString', 'newString'],
  ['old_str', 'new_str'],
  ['oldText', 'newText'],
  ['old_text', 'new_text'],
  ['old', 'new'],
]
/**
 * Host commands the phone must not offer even though the agent's registry lists
 * them.
 *
 * - `export`: only records a lifecycle on the Host; the desktop browser then
 *   downloads the ZIP from a Host-only route the phone server cannot proxy.
 * - `permission`: switches the session's sandbox/approval preset. One preset is
 *   `danger-full-access` (no sandbox, approvals never asked), so offering this
 *   from the phone would let a paired device disable the approval gate it is
 *   supposed to answer — including a device the desktop marked as not allowed to
 *   answer approvals. Sandbox policy stays a desktop decision.
 */
const PHONE_HIDDEN_COMMANDS = new Set(['export', 'permission'])
/**
 * First-party definitions hidden by identity as well, so renaming the command
 * (or a localized alias) cannot re-expose a policy-changing surface.
 */
const PHONE_HIDDEN_COMMAND_DEFINITION_IDS = new Set(['@deepseek-ai/dsh-permission-presets'])
/** Maximum changed-file entries the phone renders per change event. */
const MAX_CHANGE_FILES = 200
/** Maximum diff lines returned to the phone (the Host's own cap is larger). */
const MAX_DIFF_LINES = 800
/** Commands can run a compaction/model pass; give them enough time. */
const COMMAND_TIMEOUT_MS = 300000

/** Return a finite number or null (projections omit fields instead of zeroing them). */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Object check usable at module scope (the bridge's own helper lives inside the factory). */
function asPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Map the Host's `contextPressure` / `tokenUsage` projections to the phone's
 * context-meter shape. `usedTokens` prefers the projected prompt size because
 * `pressureTokens` only advances after the next request reports usage.
 */
function summarizeContextValues(values) {
  const pressure = asPlainObject(values?.contextPressure) ? values.contextPressure : {}
  const usage = asPlainObject(values?.tokenUsage) ? values.tokenUsage : null
  const pressureTokens = finiteOrNull(pressure.pressureTokens)
  const projectedTokens = finiteOrNull(pressure.projectedTokens)
  const contextWindow = finiteOrNull(pressure.contextWindow)
  const usedTokens = projectedTokens ?? pressureTokens ?? null
  return {
    usedTokens,
    pressureTokens,
    projectedTokens,
    contextWindow,
    basis: usedTokens === null ? 'unknown' : pressureTokens === null ? 'estimated' : 'usage',
    tokenUsage: usage === null ? null : {
      inputTokens: finiteOrNull(usage.inputTokens),
      outputTokens: finiteOrNull(usage.outputTokens),
      totalTokens: finiteOrNull(usage.totalTokens),
      reasoningTokens: finiteOrNull(usage.reasoningTokens),
    },
  }
}


/**
 * Turn a Host file path into something safe to show on the phone: relative to the
 * session directory when possible, otherwise just the basename. Never a drive
 * letter, absolute path or home-directory prefix.
 */
function phonePath(value, cwd) {
  if (typeof value !== 'string' || value.length === 0) return ''
  let path = value.replace(/\\/g, '/')
  const base = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (base.length > 0) {
    if (path === base) return ''
    if (path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  }
  if (path.startsWith('~/')) return path.slice(2)
  if (path === '~') return ''
  if (/^[A-Za-z]:\//.test(path) || path.startsWith('/')) {
    const parts = path.split('/').filter((part) => part.length > 0)
    return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/')
  }
  return path
}

/**
 * dsh-remote-mobile — Host bridge to the DeepSeek Harness runtime.
 *
 * The bridge is the only place that knows DSH's Host vocabulary. It maps the
 * Harness services and Cordis events onto the small, transport-agnostic surface
 * declared in `PROTOCOL.md`; `server.js` owns HTTP/WS and never touches DSH.
 *
 * Design constraints (see `docs/api-notes.md` for the verified details):
 *  - Plain ESM, zero dependencies, no `@deepseek-ai/*` imports. The plugin is
 *    profile-installed and cannot resolve Harness packages at runtime, so every
 *    capability is reached through the Cordis context (`ctx.get(name)`) and the
 *    event bus (`ctx.on(name, fn, opts)`).
 *  - No top-level side effects: everything happens inside `createBridge()`.
 *  - Every returned method resolves and never rejects. Operations that return
 *    data degrade to empty data on failure; operations that would normally be
 *    `void` resolve `undefined` on success and `{ ok: false, error }` on
 *    failure. `answerApproval()` returns a boolean. `server.js` can therefore
 *    treat any object carrying `ok === false` as an error envelope.
 *  - Nothing Host-internal leaks to the phone: session payloads omit `cwd`,
 *    absolute paths are redacted from error text, and tool output is truncated.
 *
 * Verified against DeepSeek Harness 0.2.2-rc.1.
 */

/** Default bound for a tool output string sent to the phone. */
const MAX_OUTPUT_CHARS = 4000;
/** Default bound for `argsPreview`. */
const MAX_ARGS_PREVIEW_CHARS = 200;
/** Default bound for a tool `detail` string value. */
const MAX_DETAIL_STRING_CHARS = 400;
/** Default history page size (in assistant/user messages). */
const DEFAULT_HISTORY_LIMIT = 50;
/** Default per-operation timeout for Host service calls. */
const DEFAULT_TIMEOUT_MS = 15000;
/** Timeout used for cold history reads, which may hit the persistence layer. */
const HISTORY_TIMEOUT_MS = 30000;
/** Timeout used for prompt admission (attachment scan, agent resume). */
const PROMPT_TIMEOUT_MS = 30000;
/** Bounded memory for tool cards waiting for their result (oldest evicted first). */
const MAX_TOOL_STARTS = 500;
/** Recognised approval outcomes, matching dsh-user-approval. */
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/**
 * Create the Host bridge.
 *
 * @param {object} ctx - Cordis Host context of the owning plugin.
 * @param {object} [options] - bridge tuning, all optional.
 * @param {() => boolean} [options.hasApprovalPeers] - return true when at least
 *   one mobile client is connected. When supplied and false, approval requests
 *   are passed straight to the next waterfall listener (the desktop answerer),
 *   so an unpaired/closed phone never stalls an approval.
 * @param {() => boolean} [options.hasQuestionPeers] - same signal for question
 *   requests; falls back to `hasApprovalPeers` when omitted.
 * @param {number} [options.questionHandoffMs=45000] - how long a question waits
 *   for a phone to (re)connect before it is handed to the desktop chain; 0
 *   disables the handoff.
 * @param {number} [options.approvalWaitMs=0] - 0 waits for a phone answer (or
 *   turn abort) indefinitely; > 0 fails closed with `unavailable` after the
 *   deadline.
 * @param {number} [options.timeoutMs] - per-operation Host-call timeout.
 * @param {number} [options.maxOutputChars] - tool output truncation.
 * @param {number} [options.maxArgsPreviewChars] - arguments preview truncation.
 * @param {boolean} [options.redactPaths=false] - also mask absolute paths in
 *   tool arguments/output. Off by default: the phone is a paired device of the
 *   same user and the tool card is useless without its arguments.
 * @returns {object} the bridge surface documented in `PROTOCOL.md`.
 */
export function createBridge(ctx, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const log = createLogger(ctx);
  const handlers = new Set();
  const attempts = new Map(); // sessionId -> { attemptId, turn, step }
  const toolStarts = new Map(); // callId -> { sessionId, name, time }
  // Bounded approval-card context, keyed by tool call id. Populated when the
  // bridge sees `tool/call`, consumed (or not) when an approval asks for it.
  const approvalContexts = new Map(); // callId -> { argsPreview, argsKind, detail }
  const pendingApprovals = new Map(); // bridge requestId -> { sessionId, settle }
  const pendingQuestions = new Map(); // bridge requestId -> { sessionId, callId, questions, answer }
  let listenerDisposers = null;
  let disposed = false;
  let fallbackIdCounter = 0;

  const timeoutMs = positiveNumber(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = positiveNumber(opts.maxOutputChars, MAX_OUTPUT_CHARS);
  const maxArgsPreviewChars = positiveNumber(opts.maxArgsPreviewChars, MAX_ARGS_PREVIEW_CHARS);
  const redactPaths = opts.redactPaths === true;

  // ---------------------------------------------------------------------------
  // Infrastructure helpers
  // ---------------------------------------------------------------------------

  /** Look up an optional Cordis service without throwing. */
  function service(name) {
    try {
      if (typeof ctx?.get === 'function') return ctx.get(name);
      return ctx?.[name];
    } catch (error) {
      log.warn(`service lookup for "${name}" failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Return the current time in ms; never throws. */
  function now() {
    return Date.now();
  }

  /** Generate an opaque id for bridge-owned request ids. */
  function newId() {
    try {
      const crypto = globalThis.crypto;
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch {
      // fall through to the counter
    }
    fallbackIdCounter += 1;
    return `rm-${now().toString(36)}-${fallbackIdCounter}`;
  }

  /**
   * Run one Host operation with a short-lived AbortSignal.
   *
   * Several `sessionController` methods call `signal.throwIfAborted()`
   * unconditionally, so a real (or signal-shaped) value is required. The
   * signal is never aborted on success; the timer only guards a wedged read.
   */
  async function withSignal(operation, timeout) {
    let controller;
    let timer = null;
    let signal;
    try {
      controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    } catch {
      controller = undefined;
    }
    if (controller !== undefined) {
      signal = controller.signal;
      const limit = positiveNumber(timeout, timeoutMs);
      if (limit > 0) {
        timer = setTimeout(() => {
          try {
            controller.abort(new Error('bridge operation timed out'));
          } catch {
            // abort() rarely throws; ignore
          }
        }, limit);
      }
    } else {
      // Minimal duck-typed signal for exotic embeddings.
      signal = {
        aborted: false,
        reason: undefined,
        throwIfAborted() {},
        addEventListener() {},
        removeEventListener() {},
      };
    }
    try {
      return await operation(signal);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Build the `{ ok: false, error }` envelope understood by server.js.
   *
   * `server.js` does `throw new Error(value.error)`, so `error` is the human
   * message string; the protocol code travels beside it in `errorCode`.
   */
  function failure(error, fallbackCode) {
    const described = describeError(error, fallbackCode);
    return { ok: false, error: described.message, errorCode: described.code };
  }

  /** Map a thrown value onto the protocol's small error vocabulary. */
  function describeError(error, fallbackCode) {
    const code = errorCode(error);
    let mapped = typeof fallbackCode === 'string' ? fallbackCode : 'internal';
    if (code !== undefined) {
      if (code.endsWith('not-found') || code === 'SESSION_QUERY_SESSION_NOT_FOUND') mapped = 'not-found';
      else if (/(bad-request|invalid|locked|conflict|unavailable|required|unsupported|busy|steer|migration|fork|title)/.test(code)) mapped = 'bad-request';
      else if (code === 'gateway/cancelled') mapped = 'bad-request';
      else mapped = 'internal';
    } else if (error instanceof Error && /not found/i.test(error.message)) {
      mapped = 'not-found';
    }
    return { code: mapped, message: sanitize(errorMessage(error)) };
  }

  function errorCode(error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') return error.code;
    const nested = error && typeof error === 'object' ? error.cause : undefined;
    if (nested && typeof nested === 'object' && typeof nested.code === 'string') return nested.code;
    return undefined;
  }

  function errorMessage(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message || error.name || 'error';
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
    const text = String(error ?? 'unknown error');
    return text === '[object Object]' ? 'unknown error' : text;
  }

  /**
   * Remove anything that looks like a Host filesystem path and bound the text.
   * Errors from Harness services routinely embed absolute paths.
   */
  function sanitize(value) {
    let text = String(value ?? '');
    try {
      text = text.replace(/[A-Za-z]:\\[^\s"'`<>|]+/g, '<path>');
      text = text.replace(/(^|[\s("'`])\/(?:[^\s"'`<>|/]+\/)+[^\s"'`<>|)]+/g, '$1<path>');
    } catch {
      // pathological input: keep the original text
    }
    if (text.length > 600) text = `${text.slice(0, 599)}…`;
    return text;
  }

  function truncate(value, maximum) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (text.length <= maximum) return text;
    return `${text.slice(0, Math.max(0, maximum - 1))}…`;
  }

  function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function clampLimit(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT;
    return Math.min(parsed, 500);
  }

  function isSessionId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
  }

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Best-effort JSON parse for tool arguments. */
  function parseJson(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  /** Join the text blocks of a message content array. */
  function joinTextBlocks(content) {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('');
  }

  /** Build a short, single-line preview of raw/parsed tool arguments. */
  function previewArgs(raw, parsed) {
    let text = raw;
    if (parsed !== undefined) {
      try {
        text = JSON.stringify(parsed);
      } catch {
        text = raw;
      }
    }
    text = typeof text === 'string' ? text : '';
    if (redactPaths) text = sanitize(text);
    return truncate(text.replace(/\s+/g, ' ').trim(), maxArgsPreviewChars);
  }

  /** Build the bounded `detail` object for a tool card. */
  function detailFromArgs(parsed) {
    if (!isPlainObject(parsed)) return null;
    const out = {};
    let count = 0;
    for (const key of Object.keys(parsed)) {
      if (count >= 12) break;
      const value = parsed[key];
      if (typeof value === 'string') {
        out[key] = truncate(redactPaths ? sanitize(value) : value, MAX_DETAIL_STRING_CHARS);
      } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        out[key] = value;
      } else if (Array.isArray(value)) {
        out[key] = value.slice(0, 8).map((item) => {
          if (typeof item === 'string') return truncate(redactPaths ? sanitize(item) : item, 120);
          if (typeof item === 'number' || typeof item === 'boolean' || item === null) return item;
          return null;
        });
      } else if (isPlainObject(value)) {
        try {
          const text = JSON.stringify(value);
          out[key] = truncate(redactPaths ? sanitize(text) : text, 300);
        } catch {
          out[key] = null;
        }
      }
      count += 1;
    }
    return out;
  }

  /** Scrub secret-looking values from parsed tool arguments (never logged). */
  function scrubArgumentValue(value, depth = 0) {
    if (depth > 3 || value === undefined) return undefined;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubArgumentValue(item, depth + 1));
    if (isPlainObject(value)) {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        // Refuse to cache values whose key looks like a credential.
        if (SECRET_ARG_KEY.test(key)) continue;
        const scrubbed = scrubArgumentValue(child, depth + 1);
        if (scrubbed !== undefined) out[key] = scrubbed;
      }
      return out;
    }
    if (typeof value === 'string') return truncate(value, 300);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return undefined;
  }

  /** Redact secret-looking JSON values when the raw argument string did not parse. */
  function scrubRawArguments(raw) {
    return String(raw ?? '').replace(/("([^"\\]*)"\s*:\s*)"([^"\\]*)"/g, (match, prefix, key) => (
      SECRET_ARG_KEY.test(key) ? `${prefix}"…"` : match
    ));
  }

  /** Read the first non-empty string value for one of the given argument keys. */
  function firstStringArg(source, keys) {
    if (!isPlainObject(source)) return undefined;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  }

  /** Map one tool call to its bounded approval-card context (or null). */
  function describeApprovalContext(name, rawArgs, parsed) {
    const toolName = typeof name === 'string' ? name.toLowerCase() : '';
    const source = isPlainObject(parsed) ? parsed : undefined;
    const path = firstStringArg(source, PATH_ARG_KEYS);
    const isEdit = EDIT_TOOL_NAMES.has(toolName)
      || EDIT_ARG_PAIRS.some(([oldKey, newKey]) => (
        firstStringArg(source, [oldKey]) !== undefined && firstStringArg(source, [newKey]) !== undefined
      ));
    if (isEdit) {
      const pair = EDIT_ARG_PAIRS.find(([oldKey, newKey]) => (
        firstStringArg(source, [oldKey]) !== undefined && firstStringArg(source, [newKey]) !== undefined
      ));
      const oldText = pair === undefined ? '' : firstStringArg(source, [pair[0]]) ?? '';
      const newText = pair === undefined ? '' : firstStringArg(source, [pair[1]]) ?? '';
      const diffHead = [
        oldText.length > 0 ? `- ${truncate(oldText.replace(/\s+/g, ' ').trim(), 200)}` : '',
        newText.length > 0 ? `+ ${truncate(newText.replace(/\s+/g, ' ').trim(), 200)}` : '',
      ].filter(Boolean).join('\n');
      const previewParts = [path ?? 'edit', diffHead].filter((part) => part.length > 0);
      return {
        argsPreview: truncate(previewParts.join('\n'), MAX_APPROVAL_PREVIEW_CHARS),
        argsKind: 'edit',
        detail: { kind: 'edit', ...(path === undefined ? {} : { path }) },
      };
    }
    if (WRITE_TOOL_NAMES.has(toolName)) {
      if (path === undefined) return null;
      return {
        argsPreview: truncate(path, MAX_APPROVAL_PREVIEW_CHARS),
        argsKind: 'write',
        detail: { kind: 'write', path },
      };
    }
    const isShell = SHELL_TOOL_NAMES.has(toolName) || firstStringArg(source, COMMAND_ARG_KEYS) !== undefined;
    if (isShell) {
      const command = firstStringArg(source, COMMAND_ARG_KEYS);
      if (command !== undefined) {
        return {
          argsPreview: truncate(command.replace(/\r\n?/g, '\n'), MAX_APPROVAL_PREVIEW_CHARS),
          argsKind: 'command',
          detail: { kind: 'command' },
        };
      }
    }
    // Generic fallback: scrubbed argument JSON, never the raw secret-bearing blob.
    let argsPreview = '';
    if (source !== undefined) {
      const scrubbed = scrubArgumentValue(source);
      if (isPlainObject(scrubbed) && Object.keys(scrubbed).length > 0) {
        try {
          argsPreview = JSON.stringify(scrubbed);
        } catch {
          argsPreview = '';
        }
      }
    }
    if (argsPreview.length === 0 && typeof rawArgs === 'string' && rawArgs.length > 0) {
      argsPreview = scrubRawArguments(rawArgs);
    }
    if (argsPreview.length === 0) return null;
    return {
      argsPreview: truncate(argsPreview, MAX_APPROVAL_PREVIEW_CHARS),
      argsKind: 'other',
      detail: { kind: 'other', ...(path === undefined ? {} : { path }) },
    };
  }

  /** Cache one approval-card context under its call id (bounded, never logged). */
  function rememberApprovalContext(callId, name, rawArgs, parsed) {
    if (typeof callId !== 'string' || callId.length === 0) return;
    let context = null;
    try {
      context = describeApprovalContext(name, rawArgs, parsed);
    } catch {
      context = null;
    }
    if (context === null) {
      approvalContexts.delete(callId);
      return;
    }
    approvalContexts.set(callId, context);
    while (approvalContexts.size > MAX_APPROVAL_CONTEXTS) {
      const oldest = approvalContexts.keys().next().value;
      if (oldest === undefined) break;
      approvalContexts.delete(oldest);
    }
  }

  /** Look up the cached approval context for one call id. */
  function approvalContextFor(callId) {
    if (typeof callId !== 'string' || callId.length === 0) return undefined;
    return approvalContexts.get(callId);
  }

  /** Normalize one question from tool arguments or the service request shape. */
  function wireQuestion(question) {
    if (!isPlainObject(question)) return null;
    const id = typeof question.id === 'string' ? question.id : '';
    const text = typeof question.question === 'string' ? question.question : '';
    if (!id || !text) return null;
    const out = { id, question: text };
    if (typeof question.header === 'string' && question.header.length > 0) out.header = question.header;
    if (typeof question.detail === 'string' && question.detail.length > 0) out.detail = question.detail;
    if (question.multiSelect === true || question.multi_select === true) out.multiSelect = true;
    if (Array.isArray(question.options)) {
      out.options = question.options
        .filter((option) => isPlainObject(option) && typeof option.label === 'string')
        .map((option) => ({
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        }));
    }
    if (isPlainObject(question.intent)) {
      out.intent = {
        kind: question.intent.kind,
        approve: question.intent.approve,
        ...(typeof question.intent.reject === 'string' ? { reject: question.intent.reject } : {}),
        ...(typeof question.intent.always === 'string' ? { always: question.intent.always } : {}),
      };
    }
    return out;
  }

  /** Normalize a question batch (drops malformed entries). */
  function wireQuestions(list) {
    if (!Array.isArray(list)) return [];
    return list.map(wireQuestion).filter((question) => question !== null);
  }

  /** The `question` payload attached to an `ask_user_question` tool row. */
  function questionToolPayload(callId, parsed) {
    if (!isPlainObject(parsed) || !Array.isArray(parsed.questions)) return null;
    const questions = wireQuestions(parsed.questions);
    if (questions.length === 0) return null;
    return { callId, questions };
  }

  /**
   * Validate an answer batch against its questions and fill skipped items with
   * the documented blank answer `{ id, selected: [] }` (desktop Skip semantics).
   */
  function normalizeAnswerBatch(answers, questions) {
    if (!Array.isArray(answers)) throw new Error('answers must be an array');
    const known = new Set(questions.map((question) => question.id));
    const byId = new Map();
    for (const item of answers) {
      if (!isPlainObject(item) || typeof item.id !== 'string') throw new Error('every answer needs an id');
      if (!known.has(item.id)) throw new Error(`unknown answer id ${item.id}`);
      const selected = Array.isArray(item.selected)
        ? item.selected.filter((label) => typeof label === 'string')
        : [];
      const entry = { id: item.id, selected };
      if (typeof item.custom === 'string' && item.custom.length > 0) entry.custom = item.custom;
      byId.set(item.id, entry);
    }
    if (byId.size !== answers.length) throw new Error('duplicate answer ids');
    return { answers: questions.map((question) => byId.get(question.id) ?? { id: question.id, selected: [] }) };
  }

  /** Read the `answers` array out of a downstream answer object. */
  /**
   * Split the attachment blocks appended by `prompt()` out of a user message,
   * so the phone can show clean text plus structured attachment metadata.
   *
   * Supports both the legacy file-path marker and the Batch D image marker, in
   * either order; history rows keep the exact `{path,name,mediaType}` shape.
   * @returns {{ text: string, attachments: Array<{ path: string, name: string, mediaType: string }> }}
   */
  function splitAttachmentBlock(text) {
    if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', attachments: [] };
    let cut = -1;
    for (const marker of [ATTACHMENT_BLOCK_MARKER, IMAGE_ATTACHMENT_BLOCK_MARKER]) {
      const index = text.indexOf(marker);
      if (index !== -1 && (cut === -1 || index < cut)) cut = index;
    }
    if (cut === -1) return { text, attachments: [] };
    const attachments = [];
    for (const line of text.slice(cut).split('\n')) {
      const entry = ATTACHMENT_LINE.exec(line.trim());
      if (entry === null) continue;
      attachments.push({
        path: entry[1],
        name: entry[2] ?? '',
        mediaType: entry[3],
      });
    }
    return { text: text.slice(0, cut).trimEnd(), attachments };
  }

  /** One path-reference block (marker plus `- path (name) [mediaType]` lines). */
  function attachmentBlock(marker, items) {
    if (items.length === 0) return '';
    const lines = items.map((item) => {
      const label = typeof item.name === 'string' && item.name.length > 0 ? ` (${item.name})` : '';
      const type = typeof item.mediaType === 'string' && item.mediaType.length > 0 ? item.mediaType : 'file';
      return `- ${item.path}${label} [${type}]`;
    });
    return `${marker}${lines.join('\n')}`;
  }

  /** Read the deployment's image limits, or `null` when the store is absent. */
  function attachmentImageLimits() {
    try {
      const attachments = service('attachments');
      const limits = attachments?.imageLimits;
      return isPlainObject(limits) ? limits : null;
    } catch (error) {
      log.warn(`attachments.imageLimits failed: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Effective inline-image policy: our defensive caps clamped by the
   * deployment's attachment limits when the store is available.
   */
  function inlineImagePolicy() {
    const limits = attachmentImageLimits();
    const maxBytesCandidates = [MAX_INLINE_IMAGE_BYTES];
    if (Number.isFinite(limits?.maxImageBytes) && limits.maxImageBytes > 0) {
      maxBytesCandidates.push(limits.maxImageBytes);
    }
    if (Number.isFinite(limits?.maxMessageImageBytes) && limits.maxMessageImageBytes > 0) {
      maxBytesCandidates.push(limits.maxMessageImageBytes);
    }
    const maxImagesCandidates = [MAX_INLINE_IMAGES];
    if (Number.isFinite(limits?.maxImagesPerMessage) && limits.maxImagesPerMessage > 0) {
      maxImagesCandidates.push(limits.maxImagesPerMessage);
    }
    const declaredTypes = Array.isArray(limits?.mediaTypes)
      ? limits.mediaTypes.filter((type) => typeof type === 'string')
      : [];
    const mediaTypes = new Set(
      declaredTypes.length > 0
        ? declaredTypes.filter((type) => INLINE_IMAGE_MEDIA_TYPES.has(type))
        : [...INLINE_IMAGE_MEDIA_TYPES],
    );
    const messageBytes = Number.isFinite(limits?.maxMessageImageBytes) && limits.maxMessageImageBytes > 0
      ? limits.maxMessageImageBytes
      : MAX_INLINE_IMAGE_BYTES * MAX_INLINE_IMAGES;
    return {
      maxBytes: Math.min(...maxBytesCandidates),
      maxImages: Math.min(...maxImagesCandidates),
      maxMessageBytes: messageBytes,
      maxDimension: Number.isFinite(limits?.maxImageDimension) && limits.maxImageDimension > 0
        ? limits.maxImageDimension
        : null,
      mediaTypes,
    };
  }

  /** Wire-facing image limits for the SPA, or `null` when undiscoverable. */
  function imageLimitsWire() {
    const limits = attachmentImageLimits();
    if (limits === null) return null;
    const policy = inlineImagePolicy();
    return {
      image: {
        maxBytes: policy.maxBytes,
        maxDimension: policy.maxDimension,
        maxImages: policy.maxImages,
        maxMessageBytes: policy.maxMessageBytes,
        mediaTypes: [...policy.mediaTypes],
      },
    };
  }

  /** Normalize a declared media type; only image/* types are candidates. */
  function normalizeImageMediaType(value) {
    if (typeof value !== 'string') return null;
    const mediaType = value.trim().toLowerCase();
    if (!mediaType.startsWith('image/')) return null;
    return mediaType;
  }

  /**
   * Read one saved phone upload as inline image bytes.
   *
   * Containment is re-checked exactly like `readUpload()`: only files under this
   * session's `var/remote-mobile-uploads` directory with a matching previewable
   * extension are read. Any failure returns `null` and the caller falls back to
   * a path reference for that attachment.
   */
  async function readInlineImage(base, attachment, policy) {
    const mediaType = normalizeImageMediaType(attachment.mediaType);
    if (mediaType === null || !policy.mediaTypes.has(mediaType)) return null;
    if (typeof attachment.path !== 'string' || attachment.path.length === 0) return null;
    const directory = join(base, 'var', 'remote-mobile-uploads');
    let absolutePath;
    try {
      absolutePath = resolve(attachment.path);
    } catch {
      return null;
    }
    if (absolutePath !== directory && !absolutePath.startsWith(directory + sep)) return null;
    const expected = PREVIEW_MEDIA_TYPES[extname(absolutePath).toLowerCase()];
    if (expected === undefined || expected !== mediaType) return null;
    try {
      // Resolve symlinks before reading: a link created inside the upload
      // directory must not escape it.
      const realDirectory = await realpath(directory);
      const realPath = await realpath(absolutePath);
      if (realPath !== realDirectory && !realPath.startsWith(realDirectory + sep)) return null;
      const info = await stat(realPath);
      if (!info.isFile() || info.size <= 0 || info.size > policy.maxBytes) return null;
      const data = await readFile(realPath);
      if (data.length === 0 || data.length > policy.maxBytes) return null;
      const name = typeof attachment.name === 'string' && attachment.name.length > 0
        ? attachment.name
        : basename(realPath);
      return {
        path: attachment.path,
        name,
        mediaType,
        bytes: data.length,
        data: data.toString('base64'),
      };
    } catch (error) {
      log.warn(`image upload could not be read for inline delivery: ${sanitize(errorMessage(error))}`);
      return null;
    }
  }

  /** The workspace root for one session (used by uploads and preview validation). */
  async function resolveSessionBase(sessionId) {
    const workingDirectory = service('workingDirectory');
    if (workingDirectory && typeof workingDirectory.get === 'function') {
      let agent = getLiveAgent(sessionId);
      if (!agent) agent = await resolveAgentForSession(sessionId);
      if (agent) {
        try {
          const base = workingDirectory.get(agent.session);
          if (typeof base === 'string' && base.length > 0) return base;
        } catch (error) {
          log.warn(`workingDirectory.get failed: ${errorMessage(error)}`);
        }
      }
    }
    return process.cwd();
  }

  /** Map a ModelSelection-ish value onto the wire route. */
  function selectionRoute(selection) {
    if (!isPlainObject(selection)) return null;
    if (typeof selection.provider !== 'string' || selection.provider.length === 0) return null;
    if (typeof selection.model !== 'string' || selection.model.length === 0) return null;
    const effort = typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
      ? selection.reasoningEffort
      : null;
    return { provider: selection.provider, model: selection.model, reasoningEffort: effort };
  }

  /** Map a ModelSelection onto the wire `current` shape. */
  function selectionWire(selection) {
    return selectionRoute(selection);
  }

  /** Read the deployment default model without requiring any session. */
  function defaultSelection() {
    try {
      const defaults = service('agentDefaultModel');
      if (defaults && typeof defaults.currentSelection === 'function') return defaults.currentSelection();
    } catch (error) {
      log.warn(`agentDefaultModel.currentSelection failed: ${errorMessage(error)}`);
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Session summaries → wire sessions
  // ---------------------------------------------------------------------------

  /**
   * The `SessionSummary` shape from dsh-api-session-controller:
   * `{ sessionId, updatedAt, running, blank, origin?, projections?: { values } }`.
   * Title/preset/model live in `projections.values` (keys `title`,
   * `agentPreset`, `modelSelection`).
   */
  function wireSession(summary, workspace) {
    const values = isPlainObject(summary?.projections?.values) ? summary.projections.values : {};
    const title = typeof values.title === 'string' ? values.title : '';
    const preset = typeof values.agentPreset === 'string' && values.agentPreset.length > 0
      ? values.agentPreset
      : null;
    const selectionState = isPlainObject(values.modelSelection) ? values.modelSelection : undefined;
    const modelSelection = selectionState?.next ?? selectionState?.lastUsed;
    const id = typeof summary?.sessionId === 'string' ? summary.sessionId : '';
    return decorateSession({
      id,
      title,
      running: summary?.running === true,
      updatedAt: Number.isFinite(summary?.updatedAt) ? summary.updatedAt : 0,
      preset,
      model: selectionRoute(modelSelection),
      agentAvailable: typeof summary?.agentAvailable === 'boolean' ? summary.agentAvailable : agentIsLive(id),
    }, workspace);
  }

  /** Build a wire session for a live agent (fallback path). */
  function wireSessionFromAgent(agent, workspace) {
    const session = agent?.session;
    const id = typeof session?.id === 'string' ? session.id : (typeof agent?.id === 'string' ? agent.id : '');
    let preset = null;
    try {
      const presets = service('agentPresets');
      if (presets && typeof presets.presetForSession === 'function' && session) {
        const recorded = presets.presetForSession(session);
        if (typeof recorded === 'string' && recorded.length > 0) preset = recorded;
      }
    } catch (error) {
      log.warn(`presetForSession failed: ${errorMessage(error)}`);
    }
    let model = null;
    try {
      if (agent && agent.model && typeof agent.model.current === 'function') {
        model = selectionRoute(agent.model.current());
      }
    } catch (error) {
      log.warn(`agent.model.current failed: ${errorMessage(error)}`);
    }
    return decorateSession({
      id,
      title: '',
      running: agent?.status === 'running',
      updatedAt: 0,
      preset,
      model,
      agentAvailable: true,
    }, workspace);
  }

  /** Whether a summary/agent describes a subagent session (not shown on the phone). */
  function isSubagentSummary(summary) {
    return summary?.origin === 'subagent';
  }

  function isSubagentAgent(agent) {
    return agent?.session?.header?.origin === 'subagent';
  }

  /**
   * The registry-global pin/archive sets plus each session's owning workspace id.
   *
   * `bySession` is built from `workspaceRegistry.list()` membership (registry
   * order is display order). Degrades to empty sets/map when the workspace
   * feature is not composed, so session frames stay well-formed.
   */
  function workspaceIndex() {
    const empty = { pinned: new Set(), archived: new Set(), bySession: new Map(), available: false };
    try {
      const registry = service('workspaceRegistry');
      if (!registry) return empty;
      const pinned = Array.isArray(registry.pinnedSessionIds) ? registry.pinnedSessionIds : [];
      const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [];
      const bySession = new Map();
      if (typeof registry.list === 'function') {
        const workspaces = registry.list();
        for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
          const workspaceId = workspace === null || workspace === undefined ? '' : String(workspace.id ?? '');
          if (workspaceId.length === 0) continue;
          for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
            if (typeof sessionId === 'string' && sessionId.length > 0 && !bySession.has(sessionId)) {
              bySession.set(sessionId, workspaceId);
            }
          }
        }
      }
      return {
        pinned: new Set(pinned.filter((id) => typeof id === 'string')),
        archived: new Set(archived.filter((id) => typeof id === 'string')),
        bySession,
        available: true,
      };
    } catch (error) {
      log.warn(`workspace state unavailable: ${errorMessage(error)}`);
      return empty;
    }
  }

  /** Whether the Host currently has a live Agent attached for this session. */
  function agentIsLive(sessionId) {
    return getLiveAgent(sessionId) !== undefined;
  }

  /** Flatten one queue snapshot (`SessionQueuedItem[]`) to the wire shape. */
  function queueItems(queue) {
    if (!Array.isArray(queue)) return [];
    const out = [];
    for (const item of queue) {
      if (!isPlainObject(item)) continue;
      const id = typeof item.id === 'string' ? item.id : '';
      if (!id) continue;
      const placement = item.placement === 'steering'
        ? 'steering'
        : item.placement === 'context' ? 'context' : 'queued';
      out.push({
        id,
        placement,
        ...(typeof item.rpcId === 'string' && item.rpcId.length > 0 ? { rpcId: item.rpcId } : {}),
        text: joinTextBlocks(item.content),
      });
    }
    return out;
  }

  /** Synchronous queue snapshot from a live Agent's inbox (no Host await). */
  function queueItemsFromAgent(agent) {
    const inbox = agent?.inbox;
    if (!isPlainObject(inbox)) return [];
    const out = [];
    const push = (message, placement) => {
      if (!isPlainObject(message) || typeof message.id !== 'string' || message.id.length === 0) return;
      const rpcId = message.source?.rpcId;
      out.push({
        id: message.id,
        placement,
        ...(typeof rpcId === 'string' && rpcId.length > 0 ? { rpcId } : {}),
        text: joinTextBlocks(message.content),
      });
    };
    for (const message of Array.isArray(inbox.nextTurn) ? inbox.nextTurn : []) push(message, 'queued');
    for (const message of Array.isArray(inbox.nextStep) ? inbox.nextStep : []) {
      push(message, message?.source?.kind === 'user' ? 'steering' : 'context');
    }
    return out;
  }

  /** Emit a conservative queue snapshot for one live session (`onQueue`). */
  function emitQueue(sessionId) {
    const agent = getLiveAgent(sessionId);
    if (!agent) return;
    emit('onQueue', {
      sessionId,
      items: queueItemsFromAgent(agent),
      running: agent.status === 'running',
    });
  }

  /** Add the pin/archive/workspace/live fields every wire session carries. */
  function decorateSession(session, workspace, live) {
    if (!isPlainObject(session)) return session;
    const id = session.id;
    session.pinned = workspace?.pinned?.has?.(id) === true;
    session.archived = workspace?.archived?.has?.(id) === true;
    session.workspaceId = workspace?.bySession?.get?.(id) ?? null;
    if (typeof live === 'boolean') session.agentAvailable = live;
    else if (typeof session.agentAvailable !== 'boolean') session.agentAvailable = agentIsLive(id);
    return session;
  }

  /** Map workspace-registry failures onto friendly protocol errors. */
  function mapWorkspaceFailure(error, action) {
    const name = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : '';
    if (name === 'WorkspaceActiveSessionError') {
      return failure('the session is running; stop it first or retry with stopActivity', 'bad-request');
    }
    if (name === 'WorkspaceArchivedSessionPinError') {
      return failure('unarchive the session before pinning it', 'bad-request');
    }
    if (name === 'WorkspaceUnknownSessionError') {
      return failure('the session does not exist', 'not-found');
    }
    if (action === 'archive' && /active/i.test(errorMessage(error))) {
      return failure('the session is running; stop it first or retry with stopActivity', 'bad-request');
    }
    return failure(error);
  }

  /** Read all visible sessions; `null` means the controller is unavailable. */
  async function readSummaries() {
    const controller = service('sessionController');
    if (!controller || typeof controller.list !== 'function') return null;
    const result = await withSignal((signal) => controller.list({}, signal), timeoutMs);
    if (!isPlainObject(result) || !Array.isArray(result.items)) return [];
    return result.items;
  }

  /** Find one summary, or `undefined` when the controller has no such row. */
  async function findSummary(sessionId) {
    const items = await readSummaries();
    if (!items) return undefined;
    return items.find((item) => item && item.sessionId === sessionId);
  }

  /**
   * Read live execution state (`{ cursor, active, running, queue, pendingInput }`)
   * from the passive state controller. No agent is resumed.
   */
  async function readState(sessionId) {
    const controller = service('sessionController');
    if (!controller || typeof controller.state !== 'function') return undefined;
    try {
      return await withSignal((signal) => controller.state({ sessionId }, signal), timeoutMs);
    } catch (error) {
      log.warn(`session state read failed for ${sessionId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Read exact projections for a session (cold-safe, no activation). */
  async function readProjections(sessionId) {
    const controller = service('sessionController');
    if (!controller || typeof controller.projections !== 'function') return undefined;
    try {
      return await withSignal((signal) => controller.projections({ sessionId }, signal), timeoutMs);
    } catch (error) {
      log.warn(`session projections read failed for ${sessionId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Build a session object when the list projection is unavailable. Uses
   * projections plus passive state; title/preset/model may be absent.
   */
  async function synthesizeSession(sessionId, records) {
    const projections = await readProjections(sessionId);
    const values = isPlainObject(projections?.values) ? projections.values : {};
    const state = await readState(sessionId);
    let title = typeof values.title === 'string' ? values.title : '';
    if (!title && Array.isArray(records)) {
      for (const record of records) {
        const event = record?.event ?? record;
        if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
          const text = joinTextBlocks(event.data.content);
          if (text) {
            title = truncate(text.replace(/\s+/g, ' ').trim(), 80);
            break;
          }
        }
      }
    }
    const preset = typeof values.agentPreset === 'string' && values.agentPreset.length > 0
      ? values.agentPreset
      : null;
    const selectionState = isPlainObject(values.modelSelection) ? values.modelSelection : undefined;
    const selection = selectionState?.next ?? selectionState?.lastUsed;
    let updatedAt = 0;
    if (Array.isArray(records) && records.length > 0) {
      const last = records[records.length - 1]?.event ?? records[records.length - 1];
      if (last && Number.isFinite(last.time)) updatedAt = last.time;
    }
    return {
      id: sessionId,
      title,
      running: state?.running === true,
      updatedAt,
      preset,
      model: selectionRoute(selection),
    };
  }

  /** Read a passive, message-aligned history page. */
  async function readHistoryRecords(sessionId, limit) {
    const controller = service('sessionController');
    if (!controller || typeof controller.events !== 'function') return null;
    const result = await withSignal(
      (signal) => controller.events({ address: { kind: 'session', sessionId }, maxMessages: limit }, signal),
      HISTORY_TIMEOUT_MS,
    );
    if (!isPlainObject(result)) return [];
    return Array.isArray(result.records) ? result.records : [];
  }

  /**
   * Map durable Session events onto the flat HistoryItem stream.
   *
   * Sources (verified against dsh-session / dsh-agent-loop):
   *  - `user/message`      data is the UserMessage (`{id, role, content, source}`)
   *  - `assistant/message` data is `{turn, step, message, stream, ...}`
   *  - `tool/call`         data is `{turn, step, callId, name, arguments}`
   *  - `tool/result`       data is `{turn, step, message, error?}` with
   *                        `message.toolCallId` identifying the call
   *  - `turn/end`          data is `{turn, reason}`; `reason.kind === 'error'`
   *                        carries `reason.error = {message, code}`
   */
  function mapHistory(records) {
    const items = [];
    const toolItems = new Map();
    if (!Array.isArray(records)) return items;
    for (const record of records) {
      const event = record && typeof record === 'object' && record.event ? record.event : record;
      if (!isPlainObject(event) || typeof event.type !== 'string') continue;
      const seq = Number.isFinite(event.seq) ? event.seq : 0;
      const ts = Number.isFinite(event.time) ? event.time : 0;
      const data = isPlainObject(event.data) ? event.data : {};
      switch (event.type) {
        case 'user/message': {
          const source = isPlainObject(data.source) ? data.source : {};
          // Only prompts the human actually sent; injected notes (runtime
          // context, model-selection notices, approval policy) are not transcript.
          if (source.kind !== 'user') continue;
          const raw = joinTextBlocks(data.content);
          if (!raw) continue;
          const split = splitAttachmentBlock(raw);
          if (!split.text && split.attachments.length === 0) continue;
          items.push({
            id: `seq:${seq}`,
            kind: 'user',
            text: split.text,
            ts,
            ...(split.attachments.length === 0 ? {} : { attachments: split.attachments }),
          });
          break;
        }
        case 'assistant/message': {
          const message = isPlainObject(data.message) ? data.message : {};
          const text = joinTextBlocks(message.content);
          if (!text) continue;
          items.push({ id: `seq:${seq}`, kind: 'assistant', text, ts });
          break;
        }
        case 'tool/call': {
          const callId = typeof data.callId === 'string' ? data.callId : undefined;
          if (!callId) continue;
          const name = typeof data.name === 'string' ? data.name : '';
          const raw = typeof data.arguments === 'string' ? data.arguments : '';
          const parsed = parseJson(raw);
          const question = name === 'ask_user_question' ? questionToolPayload(callId, parsed) : null;
          const item = {
            id: `tool:${callId}`,
            kind: 'tool',
            callId,
            name,
            title: name,
            argsPreview: previewArgs(raw, parsed),
            ok: true,
            output: '',
            diff: null,
            durationMs: 0,
            ts,
            ...(question === null ? {} : { question }),
          };
          items.push(item);
          toolItems.set(callId, item);
          break;
        }
        case 'tool/result': {
          const message = isPlainObject(data.message) ? data.message : {};
          const callId = typeof message.toolCallId === 'string'
            ? message.toolCallId
            : typeof data.callId === 'string' ? data.callId : undefined;
          if (!callId) continue;
          const isError = message.isError === true;
          const errorRecord = isPlainObject(data.error) ? data.error : undefined;
          const errorText = typeof errorRecord?.message === 'string'
            ? errorRecord.message
            : typeof errorRecord?.reason === 'string' ? errorRecord.reason : '';
          const text = joinTextBlocks(message.content) || errorText;
          const existing = toolItems.get(callId);
          if (existing !== undefined) {
            existing.ok = !isError;
            existing.output = truncate(text, maxOutputChars);
            existing.durationMs = ts >= existing.ts ? Math.max(0, ts - existing.ts) : 0;
          } else {
            items.push({
              id: `tool:${callId}`,
              kind: 'tool',
              callId,
              name: '',
              title: '',
              argsPreview: '',
              ok: !isError,
              output: truncate(text, maxOutputChars),
              diff: null,
              durationMs: 0,
              ts,
            });
          }
          break;
        }
        case 'turn/end': {
          const reason = isPlainObject(data.reason) ? data.reason : {};
          if (reason.kind !== 'error') break;
          const errorRecord = isPlainObject(reason.error) ? reason.error : {};
          const text = typeof errorRecord.message === 'string' ? errorRecord.message : 'Run failed';
          items.push({ id: `seq:${seq}`, kind: 'error', text: sanitize(text), ts });
          break;
        }
        default:
          break;
      }
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // Live event subscriptions
  // ---------------------------------------------------------------------------

  function emit(name, payload) {
    for (const entry of handlers) {
      const callback = entry && entry[name];
      if (typeof callback !== 'function') continue;
      try {
        callback(payload);
      } catch (error) {
        log.warn(`handler ${name} threw: ${errorMessage(error)}`);
      }
    }
  }

  function hasHandler(name) {
    for (const entry of handlers) {
      if (entry && typeof entry[name] === 'function') return true;
    }
    return false;
  }

  /** `agent/assistant-stream` payload: `{ agent, frame }`. */
  function onAssistantStream(payload) {
    const agent = payload?.agent;
    const frame = payload?.frame;
    if (!agent || !frame || isSubagentAgent(agent)) return;
    const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : undefined;
    if (!sessionId) return;
    switch (frame.type) {
      case 'start': {
        const turn = Number.isFinite(frame.turn) ? frame.turn : 0;
        const step = Number.isFinite(frame.step) ? frame.step : 0;
        attempts.set(sessionId, { attemptId: frame.attemptId, turn, step });
        emit('onAssistant', { sessionId, phase: 'start', turn, step, text: '', reasoning: null });
        return;
      }
      case 'chunk': {
        const attempt = attempts.get(sessionId);
        if (!attempt) return;
        if (attempt.attemptId !== undefined && frame.attemptId !== undefined
          && attempt.attemptId !== frame.attemptId) return;
        const chunk = frame.chunk;
        if (!isPlainObject(chunk)) return;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          emit('onAssistant', {
            sessionId,
            phase: 'delta',
            turn: attempt.turn,
            step: attempt.step,
            // Incremental fragment, not cumulative text; the server may coalesce.
            text: chunk.text,
            reasoning: null,
          });
        } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          emit('onAssistant', {
            sessionId,
            phase: 'delta',
            turn: attempt.turn,
            step: attempt.step,
            text: '',
            reasoning: chunk.text,
          });
        }
        return;
      }
      case 'end': {
        const attempt = attempts.get(sessionId);
        attempts.delete(sessionId);
        emit('onAssistant', {
          sessionId,
          phase: 'end',
          turn: attempt?.turn ?? 0,
          step: attempt?.step ?? 0,
          text: '',
          reasoning: null,
        });
        return;
      }
      default:
        break;
    }
  }

  /** `session/event` payload: `(session, event)`; durable transcript facts. */
  function onSessionEvent(session, event) {
    if (!session || !isPlainObject(event) || typeof event.type !== 'string') return;
    if (session.header?.origin === 'subagent') return;
    const sessionId = typeof session.id === 'string' ? session.id : undefined;
    if (!sessionId) return;
    switch (event.type) {
      case 'tool/call': {
        const data = isPlainObject(event.data) ? event.data : {};
        const callId = typeof data.callId === 'string' ? data.callId : undefined;
        if (!callId) return;
        const name = typeof data.name === 'string' ? data.name : '';
        const raw = typeof data.arguments === 'string' ? data.arguments : '';
        const parsed = parseJson(raw);
        toolStarts.set(callId, {
          sessionId,
          name,
          time: Number.isFinite(event.time) ? event.time : now(),
        });
        while (toolStarts.size > MAX_TOOL_STARTS) {
          const oldest = toolStarts.keys().next().value;
          if (oldest === undefined) break;
          toolStarts.delete(oldest);
        }
        // Cache the bounded, scrubbed approval-card context for a later ask.
        rememberApprovalContext(callId, name, raw, parsed);
        const question = name === 'ask_user_question' ? questionToolPayload(callId, parsed) : null;
        emit('onTool', {
          sessionId,
          phase: 'start',
          callId,
          name,
          title: name === 'ask_user_question' ? 'Question' : name,
          argsPreview: previewArgs(raw, parsed),
          detail: detailFromArgs(parsed),
          ...(question === null ? {} : { question }),
        });
        return;
      }
      case 'tool/result': {
        const data = isPlainObject(event.data) ? event.data : {};
        const message = isPlainObject(data.message) ? data.message : {};
        const callId = typeof message.toolCallId === 'string'
          ? message.toolCallId
          : typeof data.callId === 'string' ? data.callId : undefined;
        if (!callId) return;
        const started = toolStarts.get(callId);
        toolStarts.delete(callId);
        const isError = message.isError === true;
        const errorRecord = isPlainObject(data.error) ? data.error : undefined;
        const errorText = typeof errorRecord?.message === 'string'
          ? errorRecord.message
          : typeof errorRecord?.reason === 'string' ? errorRecord.reason : '';
        const output = joinTextBlocks(message.content) || errorText;
        const finishedAt = Number.isFinite(event.time) ? event.time : now();
        const durationMs = started && Number.isFinite(started.time)
          ? Math.max(0, finishedAt - started.time)
          : 0;
        emit('onTool', {
          sessionId,
          phase: 'end',
          callId,
          name: started?.name ?? '',
          title: started?.name ?? '',
          argsPreview: '',
          detail: null,
          ok: !isError,
          output: truncate(redactPaths ? sanitize(output) : output, maxOutputChars),
          durationMs,
        });
        return;
      }
      case 'turn/start': {
        emit('onStatus', { sessionId, running: true });
        return;
      }
      case 'turn/end': {
        emit('onStatus', { sessionId, running: false });
        // Claiming queued input changes the queue; a turn boundary is a cheap,
        // low-frequency point to resync it for every device.
        emitQueue(sessionId);
        return;
      }
      case 'agent/inbox/spliced': {
        // Queue mutations (prompt queueing, updateQueue edit/remove/steer) are
        // durable inbox splices. Re-read the inbox instead of parsing the event.
        emitQueue(sessionId);
        return;
      }
      default:
        break;
    }
  }

  /** `agent/status` payload: `{ agent, status }` with status `'idle' | 'running'`. */
  function onAgentStatus(payload) {
    const agent = payload?.agent;
    if (!agent || isSubagentAgent(agent)) return;
    const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : undefined;
    if (!sessionId) return;
    emit('onStatus', { sessionId, running: payload.status === 'running' });
  }

  /** `agent/error` payload: `{ agent, turn, step, error }`. Close any open bubble. */
  function onAgentError(payload) {
    const agent = payload?.agent;
    if (!agent || isSubagentAgent(agent)) return;
    const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : undefined;
    if (!sessionId) return;
    // There is no live error frame in PROTOCOL.md; close the streaming bubble
    // and let the phone learn the failure from the next history load.
    if (attempts.has(sessionId)) {
      const attempt = attempts.get(sessionId);
      attempts.delete(sessionId);
      emit('onAssistant', {
        sessionId,
        phase: 'end',
        turn: attempt?.turn ?? 0,
        step: attempt?.step ?? 0,
        text: '',
        reasoning: null,
      });
    }
    log.warn(`agent error for ${sessionId}: ${sanitize(errorMessage(payload.error))}`);
  }

  /**
   * Approval waterfall listener.
   *
   * `approval/request` is a scoped Cordis waterfall dispatched with
   * `this: Scoped<Agent>` (dsh-user-approval). A global listener receives every
   * agent's request and may answer by returning an ApprovalOutcome or by
   * delegating with `next()`.
   *
   * Routing is exclusive: while a phone is connected the phone is the answerer,
   * so the desktop is never left showing a prompt that the phone already
   * settled. With no phone connected the request is delegated to the desktop
   * answerer (`next()`), preserving normal desktop behaviour.
   */
  function onApprovalRequest(request, next) {
    const continueChain = () => {
      try {
        return Promise.resolve(typeof next === 'function' ? next() : 'unavailable');
      } catch (error) {
        log.warn(`approval chain delegation failed: ${errorMessage(error)}`);
        return Promise.resolve('unavailable');
      }
    };

    // Never intercept when the phone has no connected client: leave the
    // desktop answerer (or the fail-closed default) in charge.
    if (typeof opts.hasApprovalPeers === 'function') {
      let peers = false;
      try {
        peers = opts.hasApprovalPeers() === true;
      } catch (error) {
        log.warn(`hasApprovalPeers failed: ${errorMessage(error)}`);
        peers = false;
      }
      if (!peers) return continueChain();
    }
    if (!hasHandler('onApproval')) return continueChain();
    if (!isPlainObject(request)) return continueChain();

    // The waterfall payload normally carries the agent, but accept the scoped
    // listener context or the current initiator as fallbacks so an approval is
    // never silently delegated just because the payload shape changed.
    const scoped = this && typeof this === 'object' && this.agent !== undefined ? this.agent : undefined;
    let initiator
    try {
      const registry = service('agents');
      if (registry && typeof registry.currentInitiator === 'function') {
        initiator = registry.currentInitiator();
      }
    } catch {
      initiator = undefined;
    }
    const agent = request.agent ?? scoped ?? initiator;
    if (!agent || isSubagentAgent(agent)) return continueChain();
    const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : undefined;
    if (!sessionId) return continueChain();

    const requestId = newId();
    const signal = request.signal;

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
        } catch {
          // ignore
        }
      };

      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        cleanup();
        pendingApprovals.delete(requestId);
        const normalized = APPROVAL_OUTCOMES.has(outcome) ? outcome : 'unavailable';
        emit('onApprovalResolved', { sessionId, requestId, outcome: normalized });
        resolve(normalized);
      };

      const onAbort = () => settle('cancelled');

      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          settle('cancelled');
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const waitMs = Number(opts.approvalWaitMs);
      if (Number.isFinite(waitMs) && waitMs > 0) {
        timer = setTimeout(() => settle('unavailable'), waitMs);
      }

      pendingApprovals.set(requestId, { sessionId, settle });
      emit('onApproval', approvalPayload(sessionId, requestId, request));

      // Exclusive routing: while a phone is connected it is the only answerer.
      // Delegating to the desktop here would leave its copied prompt pending
      // when the phone answers, so the desktop card could never be dismissed.
    });
  }

  function approvalPayload(sessionId, requestId, request) {
    const toolName = typeof request.toolName === 'string' ? request.toolName : '';
    const reason = typeof request.reason === 'string' ? request.reason : '';
    const displayReason = displayReasonText(request.displayReason) || reason;
    const callId = typeof request.callId === 'string' ? request.callId : null;
    // Additive card context, only when the bridge already saw this tool call.
    const context = approvalContextFor(callId);
    return {
      sessionId,
      requestId,
      toolName,
      title: toolName,
      reason,
      displayReason,
      callId,
      ...(context === undefined ? {} : {
        argsPreview: context.argsPreview,
        argsKind: context.argsKind,
        detail: context.detail,
      }),
      // No Host expiry exists today; 0 means "no known deadline".
      expiresAt: 0,
    };
  }

  function displayReasonText(value) {
    if (typeof value === 'string') return value;
    if (!isPlainObject(value)) return '';
    if (typeof value.en === 'string' && value.en.length > 0) return value.en;
    for (const key of Object.keys(value)) {
      if (typeof value[key] === 'string' && value[key].length > 0) return value[key];
    }
    return '';
  }

  /**
   * `user-questions/request` waterfall listener: when a phone is connected it is
   * the exclusive answerer (so the desktop never shows a duplicate, stale
   * question card); otherwise the request is delegated to the desktop chain.
   *
   * A request with `wait.callId` is a timed question whose tool call stays open:
   * the phone's answer is returned through this waterfall. A blocking request
   * has no callId; the SPA keys the card by `requestId` instead.
   */
  function onQuestionRequest(request, next) {
    const continueChain = () => {
      try {
        return Promise.resolve(typeof next === 'function' ? next() : undefined);
      } catch (error) {
        log.warn(`question chain delegation failed: ${errorMessage(error)}`);
        return Promise.resolve(undefined);
      }
    };
    const peersCheck = typeof opts.hasQuestionPeers === 'function'
      ? opts.hasQuestionPeers
      : opts.hasApprovalPeers;
    const phoneConnected = () => {
      if (typeof peersCheck !== 'function') return true;
      try {
        return peersCheck() === true;
      } catch (error) {
        log.warn(`hasQuestionPeers failed: ${errorMessage(error)}`);
        return false;
      }
    };
    if (!hasHandler('onQuestion')) return continueChain();
    if (!isPlainObject(request)) return continueChain();

    const agent = request.agent;
    if (!agent || isSubagentAgent(agent)) return continueChain();
    const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : undefined;
    if (!sessionId) return continueChain();
    const questions = wireQuestions(request.questions);
    if (questions.length === 0) return continueChain();

    const wait = isPlainObject(request.wait) ? request.wait : undefined;
    const callId = wait !== undefined && typeof wait.callId === 'string' ? wait.callId : null;
    const requestId = newId();
    const signal = request.signal;
    const configuredHandoff = Number(opts.questionHandoffMs);
    const handoffMs = Number.isFinite(configuredHandoff) && configuredHandoff >= 0 ? configuredHandoff : 45000;

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimer();
        pendingQuestions.delete(requestId);
        try {
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort);
          }
        } catch {
          // ignore
        }
        resolve(value);
      };

      const settleAnswers = (answers) => {
        if (settled) return;
        let batch;
        try {
          batch = normalizeAnswerBatch(answers, questions);
        } catch (error) {
          log.warn(`rejected question answer: ${errorMessage(error)}`);
          return;
        }
        const skipped = batch.answers.every((entry) =>
          entry.selected.length === 0 && (entry.custom === undefined || entry.custom.length === 0));
        emit('onQuestionResolved', {
          sessionId,
          requestId,
          callId,
          answers: batch.answers,
          outcome: skipped ? 'declined' : 'answered',
        });
        finish(batch);
      };

      const onAbort = () => {
        if (settled) return;
        emit('onQuestionResolved', { sessionId, requestId, callId, answers: null, outcome: 'declined' });
        finish(undefined);
      };

      // No phone at request time: keep the question queued for a short window so
      // a reconnecting phone can still receive it, then hand it to the desktop.
      // While a phone is connected it is the exclusive answerer (like approvals),
      // so no handoff timer runs in that case.
      const handoff = () => {
        timer = null;
        if (settled) return;
        if (phoneConnected()) {
          timer = setTimeout(handoff, handoffMs);
          timer.unref?.();
          return;
        }
        pendingQuestions.delete(requestId);
        emit('onQuestionResolved', { sessionId, requestId, callId, answers: null, outcome: 'unavailable' });
        let downstream;
        try {
          downstream = Promise.resolve(typeof next === 'function' ? next() : undefined);
        } catch (error) {
          log.warn(`question next() threw: ${errorMessage(error)}`);
          downstream = Promise.resolve(undefined);
        }
        downstream.then((value) => finish(value), () => finish(undefined));
      };

      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      pendingQuestions.set(requestId, {
        sessionId,
        callId,
        questions,
        answer: settleAnswers,
        cancel: () => {
          if (settled) return;
          emit('onQuestionResolved', { sessionId, requestId, callId, answers: null, outcome: 'declined' });
          finish(undefined);
        },
      });
      emit('onQuestion', { sessionId, requestId, callId, questions });

      if (!phoneConnected() && handoffMs > 0) {
        timer = setTimeout(handoff, handoffMs);
        timer.unref?.();
      }
    });
  }


  function installListeners() {
    if (listenerDisposers !== null || disposed) return;
    const disposers = [];
    const add = (name, callback, extra) => {
      try {
        if (typeof ctx?.on !== 'function') return;
        const handle = extra === undefined
          ? ctx.on(name, callback)
          : ctx.on(name, callback, extra);
        if (typeof handle === 'function') disposers.push(handle);
      } catch (error) {
        log.warn(`failed to listen for "${name}": ${errorMessage(error)}`);
      }
    };
    // Agent-scoped events need a global listener: the dispatcher scopes them to
    // the agent subject, while this plugin's context is not that agent.
    add('agent/assistant-stream', onAssistantStream, { global: true });
    add('session/event', onSessionEvent, { global: true });
    add('agent/status', onAgentStatus, { global: true });
    add('agent/error', onAgentError, { global: true });
    add('approval/request', onApprovalRequest, { global: true, prepend: true });
    add('user-questions/request', onQuestionRequest, { global: true, prepend: true });
    listenerDisposers = disposers;
  }

  function removeListeners() {
    if (listenerDisposers === null) return;
    const disposers = listenerDisposers;
    listenerDisposers = null;
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch (error) {
        log.warn(`listener disposer failed: ${errorMessage(error)}`);
      }
    }
  }

  function cancelPendingApprovals(outcome) {
    for (const entry of [...pendingApprovals.values()]) {
      try {
        entry.settle(outcome);
      } catch (error) {
        log.warn(`failed to settle pending approval: ${errorMessage(error)}`);
      }
    }
    pendingApprovals.clear();
  }

  function cancelPendingQuestions() {
    for (const entry of [...pendingQuestions.values()]) {
      try {
        if (typeof entry.cancel === 'function') entry.cancel();
      } catch (error) {
        log.warn(`failed to settle pending question: ${errorMessage(error)}`);
      }
    }
    pendingQuestions.clear();
  }

  // ---------------------------------------------------------------------------
  // Public bridge surface
  // ---------------------------------------------------------------------------

  return {
    /** All visible sessions, newest activity first. Subagent sessions are hidden. */
    async listSessions() {
      try {
        const workspace = workspaceIndex();
        const items = await readSummaries();
        if (items === null) {
          // Fallback: live agents only (no cold sessions).
          const agents = service('agents');
          if (!agents || typeof agents.list !== 'function') return [];
          return agents.list()
            .filter((agent) => agent && !isSubagentAgent(agent))
            .map((agent) => wireSessionFromAgent(agent, workspace))
            .filter((session) => session.id.length > 0);
        }
        return items
          .filter((item) => item && !isSubagentSummary(item))
          .map((item) => wireSession(item, workspace))
          .filter((session) => session.id.length > 0);
      } catch (error) {
        log.warn(`listSessions failed: ${errorMessage(error)}`);
        return [];
      }
    },

    /**
     * Registered project workspaces, in registry (display) order.
     * Returns `[]` when the workspace service is absent or throws. Paths and
     * titles only; never descendant session content.
     */
    async listWorkspaces() {
      try {
        const registry = service('workspaceRegistry');
        if (!registry || typeof registry.list !== 'function') return [];
        const workspaces = registry.list();
        const out = [];
        for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
          const id = workspace === null || workspace === undefined ? '' : String(workspace.id ?? '');
          if (id.length === 0) continue;
          out.push({
            id,
            title: typeof workspace.title === 'string' ? workspace.title : '',
            path: typeof workspace.path === 'string' ? workspace.path : '',
            sessionIds: (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
              .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0),
          });
        }
        return out;
      } catch (error) {
        log.warn(`listWorkspaces failed: ${errorMessage(error)}`);
        return [];
      }
    },

    /**
     * Open one session: its summary, newest history page and (when the session
     * is live) its pending queue. Passive: no Agent is resumed, so `prompt()`
     * resumes on demand.
     */
    async openSession(sessionId) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const workspace = workspaceIndex();
        let records;
        try {
          records = await readHistoryRecords(sessionId, DEFAULT_HISTORY_LIMIT);
        } catch (error) {
          // A missing session is the common failure; report it as not-found.
          if (errorCode(error) !== undefined || /not found/i.test(errorMessage(error))) throw error;
          log.warn(`history read failed for ${sessionId}: ${errorMessage(error)}`);
          records = [];
        }
        if (records === null) {
          // No sessionController at all: only a live agent can identify a session.
          const live = getLiveAgent(sessionId);
          if (!live) return failure(`session "${sessionId}" is not available`, 'not-found');
          return { session: wireSessionFromAgent(live, workspace), history: [], queue: [], context: null };
        }
        const summary = await findSummary(sessionId);
        const session = decorateSession(
          summary ? wireSession(summary, workspace) : await synthesizeSession(sessionId, records),
          workspace,
        );
        if (!session.id) session.id = sessionId;
        // Queue state is live-only; cold sessions get an empty array so the SPA
        // has one stable shape.
        let queue = [];
        if (agentIsLive(sessionId)) {
          const state = await readState(sessionId);
          if (isPlainObject(state)) {
            queue = queueItemsFromAgent(getLiveAgent(sessionId) ?? undefined);
            if (queue.length === 0) queue = queueItems(state.queue);
            if (typeof state.running === 'boolean') session.running = state.running;
          }
        }
        // Context pressure is cold-safe through the projection fold; a session
        // that never ran a turn simply reports `basis: "unknown"`.
        let context = null;
        try {
          const projectionValue = await readProjections(sessionId);
          const values = isPlainObject(projectionValue) && isPlainObject(projectionValue.values)
            ? projectionValue.values
            : {};
          context = summarizeContextValues(values);
        } catch (error) {
          log.warn(`context projection failed for ${sessionId}: ${errorMessage(error)}`);
        }
        return { session, history: mapHistory(records), queue, context };
      } catch (error) {
        return failure(error);
      }
    },

    /** Create a blank session, optionally bound to an agent preset. */
    async createSession(createOptions = {}) {
      try {
        const controller = service('sessionController');
        if (!controller || typeof controller.create !== 'function') {
          return failure('session creation is unavailable: no sessionController service', 'internal');
        }
        const request = {};
        const preset = createOptions && typeof createOptions.preset === 'string' ? createOptions.preset : '';
        if (preset.length > 0) request.agentPreset = preset;
        const cwd = createOptions && typeof createOptions.cwd === 'string' ? createOptions.cwd.trim() : '';
        if (cwd.length > 0) request.cwd = cwd;
        const created = await controller.create(request);
        const id = typeof created?.sessionId === 'string' ? created.sessionId : '';
        if (!id) return failure('session creation returned no session id', 'internal');
        const workspace = workspaceIndex();
        const summary = await findSummary(id);
        if (summary) return wireSession(summary, workspace);
        return decorateSession({
          id,
          title: '',
          running: false,
          updatedAt: now(),
          preset: typeof created?.agentPreset === 'string' && created.agentPreset.length > 0
            ? created.agentPreset
            : (preset.length > 0 ? preset : null),
          model: selectionRoute(defaultSelection()),
        }, workspace);
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Rename one session.
     *
     * The Host normalizes control characters/whitespace and truncates the title
     * to its configured UTF-8 byte budget (80 bytes in the shipped desktop
     * composition); a title with no visible characters is rejected with
     * `session/title-invalid`. Cold-safe: the controller resumes the session in
     * order to append `session/title`.
     *
     * @returns `{ ok:true, sessionId, title, seq }` or an error envelope.
     */
    async renameSession(sessionId, title) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (typeof title !== 'string') return failure('title must be a string', 'bad-request');
        if (title.trim().length === 0) {
          return failure('a title needs at least one visible character', 'bad-request');
        }
        const controller = service('sessionController');
        if (!controller || typeof controller.rename !== 'function') {
          return failure('renaming is unavailable in this deployment', 'internal');
        }
        const result = await controller.rename({ sessionId, title });
        return {
          ok: true,
          sessionId,
          title: typeof result?.title === 'string' ? result.title : title,
          seq: Number.isFinite(result?.seq) ? result.seq : 0,
        };
      } catch (error) {
        if (errorCode(error) === 'session/title-invalid') {
          return failure('a title needs at least one visible character', 'bad-request');
        }
        return failure(error);
      }
    },

    /**
     * Fork one session at an event boundary (or the latest completed turn) into
     * a new independent session. Cold-safe. `allowMigration` is left undefined
     * so the Host may migrate an old source; a source that still cannot be
     * opened yields a friendly error.
     *
     * @returns `{ ok:true, sessionId, sourceSessionId }` or an error envelope.
     */
    async forkSession(sessionId, atSeq) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const request = { sessionId };
        if (Number.isSafeInteger(atSeq) && atSeq >= 0) request.atSeq = atSeq;
        const controller = service('sessionController');
        if (!controller || typeof controller.fork !== 'function') {
          return failure('forking is unavailable in this deployment', 'internal');
        }
        const result = await controller.fork(request);
        const forkId = typeof result?.sessionId === 'string' ? result.sessionId : '';
        if (!forkId) return failure('fork returned no session id', 'internal');
        return { ok: true, sessionId: forkId, sourceSessionId: sessionId };
      } catch (error) {
        if (errorCode(error) === 'session/migration-required') {
          return failure('open this session on the desktop once before forking it', 'bad-request');
        }
        if (errorCode(error) === 'session/fork-unavailable') {
          return failure('this session has no completed turn to fork', 'bad-request');
        }
        return failure(error);
      }
    },

    /**
     * Literal message-content search across visible sessions (cold-safe).
     * The Host caps the result at 20 sessions and 240 code points per snippet.
     *
     * @returns `{ ok:true, query, results, hasMore }` or an error envelope.
     */
    async searchSessions(query) {
      try {
        if (typeof query !== 'string' || query.trim().length === 0) {
          return failure('search query must not be empty', 'bad-request');
        }
        const trimmed = query.trim();
        if (trimmed.length > 500) return failure('search query is too long', 'bad-request');
        const controller = service('sessionController');
        if (!controller || typeof controller.search !== 'function') {
          return failure('search is unavailable in this deployment', 'internal');
        }
        const value = await withSignal((signal) => controller.search({ query: trimmed }, signal), timeoutMs);
        const items = isPlainObject(value) && Array.isArray(value.items) ? value.items : [];
        const summaries = await readSummaries();
        const workspace = workspaceIndex();
        const byId = new Map();
        for (const summary of summaries ?? []) {
          if (summary && typeof summary.sessionId === 'string') byId.set(summary.sessionId, summary);
        }
        const results = [];
        for (const item of items) {
          const id = typeof item?.sessionId === 'string' ? item.sessionId : '';
          if (!id) continue;
          const summary = byId.get(id);
          const wire = summary ? wireSession(summary, workspace) : undefined;
          results.push({
            id,
            title: wire?.title ?? '',
            snippet: truncate(typeof item.snippet === 'string' ? item.snippet : '', 240),
            updatedAt: wire?.updatedAt ?? 0,
            running: wire?.running === true,
            pinned: wire?.pinned === true,
            archived: wire?.archived === true,
            agentAvailable: wire?.agentAvailable === true,
            workspaceId: wire?.workspaceId ?? null,
          });
        }
        return { ok: true, query: trimmed, results, hasMore: value?.hasMore === true };
      } catch (error) {
        if (/search is disabled|SessionQueryError/i.test(errorMessage(error))) {
          return failure('session content search is disabled in this deployment', 'unavailable');
        }
        return failure(error);
      }
    },

    /**
     * Pin or unpin one session (registry-global; cold-safe).
     *
     * @returns `{ ok:true, sessionId, pinned, archived, pinnedSessionIds,
     *   archivedSessionIds }` or an error envelope.
     */
    async setSessionPinned(sessionId, pinned) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const wantPinned = pinned === true;
        const registry = service('workspaceRegistry');
        const controller = service('workspaceController');
        if (wantPinned) {
          if (registry && typeof registry.pinSession === 'function') await registry.pinSession(sessionId);
          else if (controller && typeof controller.pinSession === 'function') await controller.pinSession({ sessionId });
          else return failure('pinning is unavailable in this deployment', 'internal');
        } else if (registry && typeof registry.unpinSession === 'function') {
          await registry.unpinSession(sessionId);
        } else if (controller && typeof controller.unpinSession === 'function') {
          await controller.unpinSession({ sessionId });
        } else {
          return failure('pinning is unavailable in this deployment', 'internal');
        }
        const workspace = workspaceIndex();
        return {
          ok: true,
          sessionId,
          pinned: workspace.pinned.has(sessionId),
          archived: workspace.archived.has(sessionId),
          pinnedSessionIds: [...workspace.pinned],
          archivedSessionIds: [...workspace.archived],
        };
      } catch (error) {
        return mapWorkspaceFailure(error, pinned === true ? 'pin' : 'unpin');
      }
    },

    /**
     * Archive or unarchive one session. Archived sessions stay listed so the
     * phone can show them separately, but they cannot run a model step until
     * unarchived. `stopActivity` stops a running turn/job first.
     *
     * @returns `{ ok:true, sessionId, pinned, archived, ... }` or an error
     *   envelope.
     */
    async setSessionArchived(sessionId, archived, stopActivity) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const wantArchived = archived === true;
        const force = stopActivity === true;
        const registry = service('workspaceRegistry');
        const controller = service('workspaceController');
        if (wantArchived) {
          if (registry && typeof registry.archiveSession === 'function') {
            await registry.archiveSession(sessionId, force ? { stopActivity: true } : {});
          } else if (controller && typeof controller.archiveSession === 'function') {
            await controller.archiveSession(force ? { sessionId, stopActivity: true } : { sessionId });
          } else {
            return failure('archiving is unavailable in this deployment', 'internal');
          }
        } else if (registry && typeof registry.unarchiveSession === 'function') {
          await registry.unarchiveSession(sessionId);
        } else if (controller && typeof controller.unarchiveSession === 'function') {
          await controller.unarchiveSession({ sessionId });
        } else {
          return failure('archiving is unavailable in this deployment', 'internal');
        }
        const workspace = workspaceIndex();
        return {
          ok: true,
          sessionId,
          pinned: workspace.pinned.has(sessionId),
          archived: workspace.archived.has(sessionId),
          pinnedSessionIds: [...workspace.pinned],
          archivedSessionIds: [...workspace.archived],
        };
      } catch (error) {
        return mapWorkspaceFailure(error, archived === true ? 'archive' : 'unarchive');
      }
    },

    /**
     * Current queue + pending-input snapshot for one live session.
     * Cold sessions cannot have a queue: returns `errorCode: 'not-live'`.
     */
    async listQueue(sessionId) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (!agentIsLive(sessionId)) {
          return { ok: false, error: 'this session is not live on the Host; open it first', errorCode: 'not-live' };
        }
        const state = await readState(sessionId);
        if (!isPlainObject(state)) return failure('session state is unavailable', 'internal');
        const items = queueItems(state.queue);
        return {
          ok: true,
          sessionId,
          items: items.length > 0 ? items : queueItemsFromAgent(getLiveAgent(sessionId)),
          pendingInput: Array.isArray(state.pendingInput)
            ? state.pendingInput.filter((kind) => typeof kind === 'string')
            : [],
          running: state.running === true,
          active: state.active === true,
        };
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Edit, remove or steer one queued message. Live-only; there is no reorder
     * action. Returns the refreshed queue items on success.
     */
    async updateQueue(sessionId, itemId, action, text) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (typeof itemId !== 'string' || itemId.length === 0) {
          return failure('itemId is required', 'bad-request');
        }
        const kind = action === 'edit' || action === 'remove' || action === 'steer' ? action : '';
        if (!kind) return failure('action must be edit, remove or steer', 'bad-request');
        if (!agentIsLive(sessionId)) {
          return { ok: false, error: 'this session is not live on the Host; open it first', errorCode: 'not-live' };
        }
        const value = { kind };
        if (kind === 'edit') {
          const body = typeof text === 'string' ? text.trim() : '';
          if (body.length === 0) return failure('edited text must not be empty', 'bad-request');
          value.content = [{ type: 'text', text: body }];
        }
        const controller = service('sessionController');
        if (!controller || typeof controller.updateQueue !== 'function') {
          return failure('queue editing is unavailable in this deployment', 'internal');
        }
        try {
          await controller.updateQueue({ sessionId, itemId, action: value });
        } catch (error) {
          const code = errorCode(error);
          if (code === 'session/queue-item-not-found') {
            return failure('that queued message is no longer pending', 'not-found');
          }
          if (code === 'session/steer-unavailable') {
            return failure('the running turn no longer accepts steering', 'bad-request');
          }
          throw error;
        }
        const state = await readState(sessionId);
        const items = queueItems(state?.queue);
        return {
          ok: true,
          sessionId,
          items: items.length > 0 ? items : queueItemsFromAgent(getLiveAgent(sessionId)),
        };
      } catch (error) {
        return failure(error);
      }
    },

    /** Newest history page for one session. */
    async history(sessionId, historyOptions = {}) {
      try {
        if (!isSessionId(sessionId)) return [];
        const limit = clampLimit(historyOptions && historyOptions.limit);
        const records = await readHistoryRecords(sessionId, limit);
        return mapHistory(records ?? []);
      } catch (error) {
        log.warn(`history failed for ${sessionId}: ${errorMessage(error)}`);
        return [];
      }
    },

    /**
     * Save one file uploaded by the phone into the session's workspace, so the
     * agent can read it with its normal file tools (images via read_image).
     *
     * @param {string} sessionId - target session
     * @param {{ name?: string, mediaType?: string, data?: Uint8Array }} upload
     * @returns {{ ok: true, name: string, path: string, relativePath: string, size: number, mediaType: string } | object}
     */
    async saveUpload(sessionId, upload = {}) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const data = upload.data;
        if (!(data instanceof Uint8Array) || data.length === 0) {
          return failure('uploaded file is empty', 'bad-request');
        }
        const rawName = typeof upload.name === 'string' && upload.name.trim().length > 0
          ? upload.name.trim()
          : 'attachment'
        const safeName = rawName.replace(/[^\w.\- ]+/g, '_').slice(-100) || 'attachment'
        const mediaType = typeof upload.mediaType === 'string' && upload.mediaType.length > 0
          ? upload.mediaType
          : 'application/octet-stream'
        const base = await resolveSessionBase(sessionId)
        const directory = join(base, 'var', 'remote-mobile-uploads')
        await mkdir(directory, { recursive: true })
        const fileName = `${Date.now()}-${safeName}`
        const absolutePath = join(directory, fileName)
        await writeFile(absolutePath, data)
        return {
          ok: true,
          name: rawName,
          path: absolutePath,
          relativePath: join('var', 'remote-mobile-uploads', fileName),
          size: data.length,
          mediaType,
        }
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Read one previously uploaded image for an inline preview in the phone UI.
     * Only files under that session's `var/remote-mobile-uploads` directory with
     * an image extension are served; everything else is refused.
     *
     * @param {string} sessionId - owning session
     * @param {string} requestedPath - absolute path from the upload result
     * @returns {{ ok: true, data: Buffer, mediaType: string, name: string } | object}
     */
    async readUpload(sessionId, requestedPath) {
      try {
        if (!isSessionId(sessionId) || typeof requestedPath !== 'string' || requestedPath.length === 0) {
          return failure('invalid upload reference', 'bad-request');
        }
        const extension = extname(requestedPath).toLowerCase();
        const mediaType = PREVIEW_MEDIA_TYPES[extension];
        if (mediaType === undefined) return failure('not a previewable image', 'bad-request');
        const base = await resolveSessionBase(sessionId);
        const directory = join(base, 'var', 'remote-mobile-uploads');
        const absolutePath = resolve(requestedPath);
        if (absolutePath !== directory && !absolutePath.startsWith(directory + sep)) {
          return failure('upload is outside this session', 'bad-request');
        }
        // Resolve symlinks before serving: a link created inside the upload
        // directory must not turn into an arbitrary file read.
        const realDirectory = await realpath(directory);
        const realPath = await realpath(absolutePath);
        if (realPath !== realDirectory && !realPath.startsWith(realDirectory + sep)) {
          return failure('upload is outside this session', 'bad-request');
        }
        const info = await stat(realPath);
        if (!info.isFile()) return failure('upload is not a file', 'bad-request');
        if (info.size > MAX_PREVIEW_BYTES) return failure('image is too large to preview', 'bad-request');
        const data = await readFile(realPath);
        return { ok: true, data, mediaType, name: basename(realPath) };
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Context-window meter for one session. Cold-safe: reads the projection fold
     * (`contextPressure`, `tokenUsage`), never resumes an Agent.
     */
    async contextFor(sessionId) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        let values = {};
        try {
          const projectionValue = await readProjections(sessionId);
          if (isPlainObject(projectionValue) && isPlainObject(projectionValue.values)) {
            values = projectionValue.values;
          }
        } catch (error) {
          log.warn(`context projection failed for ${sessionId}: ${errorMessage(error)}`);
        }
        return { ok: true, sessionId, ...summarizeContextValues(values) };
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Recent `workspace/changes` events with their in-memory file summaries.
     * The summaries live only for this Host process, so a cold/foreign session
     * yields `{ available: false }` entries instead of an error.
     */
    async changesList(sessionId, limit) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const cap = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 20) : 10;
        let records = [];
        try {
          records = await readHistoryRecords(sessionId, 400);
        } catch (error) {
          return failure(error);
        }
        const seqs = [];
        for (const record of records ?? []) {
          const event = record && typeof record === 'object' && record.event ? record.event : record;
          if (!isPlainObject(event) || event.type !== 'workspace/changes') continue;
          const seq = finiteOrNull(event.seq);
          if (seq === null || seqs.includes(seq)) continue;
          seqs.push(seq);
        }
        const changesService = service('workspaceChanges');
        const items = [];
        for (const seq of seqs.slice(-cap)) {
          let summary;
          try {
            summary = changesService && typeof changesService.summary === 'function'
              ? changesService.summary(sessionId, seq)
              : undefined;
          } catch (error) {
            summary = undefined;
          }
          if (!summary) {
            items.push({ seq, available: false, files: [] });
            continue;
          }
          const cwd = typeof summary.cwd === 'string' ? summary.cwd : '';
          items.push({
            seq,
            available: true,
            turn: finiteOrNull(summary.turn),
            total: finiteOrNull(summary.total) ?? 0,
            added: finiteOrNull(summary.added) ?? 0,
            deleted: finiteOrNull(summary.deleted) ?? 0,
            files: (Array.isArray(summary.files) ? summary.files : []).slice(0, MAX_CHANGE_FILES).map((file, index) => ({
              index,
              path: phonePath(typeof file?.path === 'string' ? file.path : '', cwd),
              display: phonePath(typeof file?.display === 'string' ? file.display : '', cwd),
              added: finiteOrNull(file?.added) ?? 0,
              deleted: finiteOrNull(file?.deleted) ?? 0,
              binary: file?.binary === true,
              oversized: file?.oversized === true,
            })),
          });
        }
        return { ok: true, sessionId, items };
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * One file diff inside a `workspace/changes` event. Live-process only: the
     * Host recorder forgets a session when it is disposed.
     */
    async changesDiff(sessionId, seq, index) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (!Number.isSafeInteger(seq) || seq < 0) return failure('seq must be a non-negative integer', 'bad-request');
        if (!Number.isSafeInteger(index) || index < 0) return failure('index must be a non-negative integer', 'bad-request');
        const changesService = service('workspaceChanges');
        if (!changesService || typeof changesService.diff !== 'function') {
          return failure('file diffs are unavailable in this deployment', 'unavailable');
        }
        const value = await withSignal((signal) => changesService.diff(sessionId, seq, index, signal), timeoutMs);
        if (!value) {
          return failure('this change is no longer available (the session is not live on this Host)', 'unavailable');
        }
        const rawPath = typeof value.path === 'string'
          ? value.path
          : typeof value.display === 'string' ? value.display : '';
        const path = phonePath(rawPath, '');
        if (value.kind === 'text') {
          const hunks = (Array.isArray(value.hunks) ? value.hunks : []).map((hunk) => ({
            oldStart: finiteOrNull(hunk?.oldStart) ?? 0,
            oldLines: finiteOrNull(hunk?.oldLines) ?? 0,
            newStart: finiteOrNull(hunk?.newStart) ?? 0,
            newLines: finiteOrNull(hunk?.newLines) ?? 0,
            lines: (Array.isArray(hunk?.lines) ? hunk.lines : [])
              .slice(0, MAX_DIFF_LINES)
              .map((line) => truncate(String(line), 400)),
          }));
          return { ok: true, sessionId, seq, index, kind: 'text', path, coarse: value.coarse === true, hunks };
        }
        return {
          ok: true,
          sessionId,
          seq,
          index,
          kind: value.kind === 'binary' ? 'binary' : 'oversized',
          path,
          coarse: false,
          hunks: [],
        };
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Every command the live Agent's registry offers, except the phone-hidden
     * set (`export`: its Host command only records a lifecycle and the desktop
     * browser then downloads a Host-only route the phone server cannot proxy).
     *
     * Listing needs a live Agent (the registry is Agent-scoped); cold sessions
     * report `available:false` instead of activating the session just to list.
     */
    async listCommands(sessionId) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (!agentIsLive(sessionId)) {
          return { ok: true, sessionId, available: false, items: [], reason: 'not-live' };
        }
        const agent = getLiveAgent(sessionId);
        if (!agent) return { ok: true, sessionId, available: false, items: [], reason: 'not-live' };
        const descriptors = await visibleCommands(agent);
        return {
          ok: true,
          sessionId,
          available: true,
          items: descriptors.map(({ name, description, hint, attachments }) => ({
            name,
            description,
            hint,
            attachments,
          })),
        };
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Execute one Host command for a live session. The name is validated against
     * the Agent's CURRENT registry (never a static set), arguments are preserved,
     * and the full trimmed line is executed. Results arrive as durable
     * `command/run` + `command/done` events, so the phone may need to reload
     * history afterwards.
     */
    async executeCommand(sessionId, line) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (typeof line !== 'string' || line.trim().length === 0) {
          return failure('command line is required', 'bad-request');
        }
        const trimmed = line.trim();
        const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
        const name = withoutSlash.split(/\s+/)[0];
        if (typeof name !== 'string' || name.length === 0 || PHONE_HIDDEN_COMMANDS.has(name)) {
          return failure('this command is not available from the phone', 'forbidden');
        }
        if (!agentIsLive(sessionId)) {
          return failure('this session is not live on the Host; send a message first', 'not-live');
        }
        const agent = getLiveAgent(sessionId);
        if (!agent) return failure('this session is not live on the Host; send a message first', 'not-live');
        const descriptors = await visibleCommands(agent);
        const command = descriptors.find((item) => item.name === name);
        if (command === undefined) {
          return failure('this command is not available from the phone', 'forbidden');
        }
        const executor = typeof command.instance?.execute === 'function'
          ? command.instance
          : service('commands');
        if (!executor || typeof executor.execute !== 'function') {
          return failure('commands are unavailable in this deployment', 'unavailable');
        }
        const value = await withSignal(
          (signal) => executor.execute(agent, trimmed, [], signal),
          COMMAND_TIMEOUT_MS,
        );
        if (!value) return failure('the command was not recognized', 'bad-request');
        const result = isPlainObject(value.result) ? value.result : {};
        return {
          ok: true,
          sessionId,
          commandId: typeof value.commandId === 'string' ? value.commandId : null,
          name,
          // Closed union in the Host: success | error | method (no listed
          // command should return `method`; treat it as a text-free success).
          kind: result.kind === 'error' ? 'error' : 'success',
          text: typeof result.text === 'string' ? truncate(result.text, 2000) : null,
          sourceEventSeq: finiteOrNull(result.sourceEventSeq),
        };
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Admit one prompt into the session's turn queue.
     * `requestId` is the caller's idempotency key (duplicate ids are ignored by
     * the Harness). Optional `attachments` are uploads returned by `saveUpload`.
     *
     * Image uploads (`mediaType` starting with `image/`) are sent as real inline
     * image content parts when they can be read back from the session's upload
     * directory; every attachment also keeps a path reference in the text so
     * history and `/api/preview` keep working. If the Host rejects the image
     * parts, the send is retried once as text-only (path references).
     *
     * `mode` is `'queue'` (default, next turn) or `'steer'` (inject into the
     * running turn; the Host rejects/no-ops it when the agent is idle).
     * Returns `undefined` on success.
     */
    async prompt(sessionId, text, requestId, attachments, mode) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const promptMode = mode === 'steer' ? 'steer' : 'queue';
        const attachmentList = Array.isArray(attachments)
          ? attachments.filter((item) => isPlainObject(item) && typeof item.path === 'string' && item.path.length > 0)
          : [];
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (trimmed.length === 0 && attachmentList.length === 0) {
          return failure('prompt text must be a non-empty string', 'bad-request');
        }
        // Partition: readable images go inline, everything else (and any image
        // that exceeds the caps or cannot be read back) keeps a path reference.
        const policy = inlineImagePolicy();
        const fileAttachments = [];
        const inlineImages = [];
        let inlineBytes = 0;
        let base;
        for (const item of attachmentList) {
          const isImage = normalizeImageMediaType(item.mediaType) !== null;
          if (!isImage || inlineImages.length >= policy.maxImages) {
            fileAttachments.push(item);
            continue;
          }
          if (base === undefined) base = await resolveSessionBase(sessionId);
          const image = await readInlineImage(base, item, policy);
          if (image === null || inlineBytes + image.bytes > policy.maxMessageBytes) {
            fileAttachments.push(item);
            continue;
          }
          inlineBytes += image.bytes;
          inlineImages.push(image);
        }
        // Normal message text: user text, file path references, then the image
        // block only for images actually delivered inline.
        let normalText = trimmed;
        normalText += attachmentBlock(ATTACHMENT_BLOCK_MARKER, fileAttachments);
        normalText += attachmentBlock(IMAGE_ATTACHMENT_BLOCK_MARKER, inlineImages);
        // Fallback text lists every attachment under the legacy file-path block,
        // so a rejected image batch still reaches the model as readable paths.
        let fallbackText = trimmed;
        fallbackText += attachmentBlock(ATTACHMENT_BLOCK_MARKER, attachmentList);
        const idempotencyKey = typeof requestId === 'string' && requestId.length > 0 ? requestId : newId();
        const normalContent = [];
        if (normalText.length > 0) normalContent.push({ type: 'text', text: normalText });
        for (const image of inlineImages) {
          normalContent.push({ type: 'image', mediaType: image.mediaType, data: image.data });
        }
        const fallbackContent = fallbackText.length > 0 ? [{ type: 'text', text: fallbackText }] : [];
        const controller = service('sessionController');
        if (controller && typeof controller.prompt === 'function') {
          const send = (content) => withSignal(
            (signal) => controller.prompt({
              sessionId,
              requestId: idempotencyKey,
              // 'queue' targets the next turn; 'steer' injects into the nearest
              // step of a running turn (the Host errors when there is none).
              mode: promptMode,
              content,
            }, signal),
            PROMPT_TIMEOUT_MS,
          );
          if (inlineImages.length > 0) {
            try {
              await send(normalContent);
              return undefined;
            } catch (error) {
              // Inline images are best-effort: a Host refusal must never make a
              // phone send fail. Retry once with readable paths only.
              log.warn(`inline image prompt rejected; retrying text-only (${inlineImages.length} image(s)): ${sanitize(errorMessage(error))}`);
              await send(fallbackContent);
              return undefined;
            }
          }
          await send(normalContent);
          return undefined;
        }
        // Controller-less fallback: the loop expects frozen, identified content
        // and we cannot build image blocks without the LLM package, so send the
        // readable path references instead.
        const agent = getLiveAgent(sessionId);
        const message = {
          id: newId(),
          role: 'user',
          content: fallbackContent,
          source: { kind: 'user', rpcId: idempotencyKey },
        };
        if (promptMode === 'steer' && typeof agent?.steer === 'function') {
          agent.steer(message);
          return undefined;
        }
        if (!agent || typeof agent.followup !== 'function') {
          return failure(`session "${sessionId}" is not available`, 'not-found');
        }
        agent.followup(message);
        return undefined;
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Deployment image limits for the SPA picker (inline-image policy applied),
     * or `null` when the attachment store is not composed.
     */
    imageLimits() {
      try {
        return imageLimitsWire();
      } catch (error) {
        log.warn(`imageLimits failed: ${errorMessage(error)}`);
        return null;
      }
    },

    /** Stop the active turn. Stopping a cold/idle session is a no-op. */
    async cancel(sessionId) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        const controller = service('sessionController');
        if (controller && typeof controller.cancel === 'function') {
          try {
            await controller.cancel({ sessionId });
          } catch (error) {
            // The Host only accepts cancellation for an attached agent; a cold
            // session has nothing to stop.
            if (errorCode(error) === 'session/not-found') return undefined;
            throw error;
          }
          return undefined;
        }
        const agent = getLiveAgent(sessionId);
        if (agent && typeof agent.cancel === 'function') {
          agent.cancel({ kind: 'user' });
          return undefined;
        }
        return undefined;
      } catch (error) {
        return failure(error);
      }
    },

    /** Model catalog plus the deployment default selection. */
    async listModels() {
      try {
        const controller = service('sessionController');
        if (controller && typeof controller.modelCatalog === 'function') {
          const catalog = await controller.modelCatalog();
          return {
            catalog: flattenCatalog(catalog),
            current: selectionWire(catalog?.default),
          };
        }
        return await catalogFromLlm();
      } catch (error) {
        log.warn(`listModels failed: ${errorMessage(error)}`);
        return { catalog: [], current: null };
      }
    },

    /** Bind a model (and optional reasoning effort) to one session. */
    async selectModel(sessionId, selection = {}) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (!isPlainObject(selection)) return failure('model selection must be an object', 'bad-request');
        const provider = typeof selection.provider === 'string' ? selection.provider : '';
        const model = typeof selection.model === 'string' ? selection.model : '';
        if (!provider || !model) return failure('provider and model are required', 'bad-request');
        const request = { sessionId, provider, model };
        if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
          request.reasoningEffort = selection.reasoningEffort;
        }
        const controller = service('sessionController');
        if (controller && typeof controller.selectModel === 'function') {
          await controller.selectModel(request);
          return undefined;
        }
        const agent = getLiveAgent(sessionId);
        if (agent && agent.model && typeof agent.model.select === 'function') {
          agent.model.select(request);
          return undefined;
        }
        return failure(`session "${sessionId}" is not available`, 'not-found');
      } catch (error) {
        return failure(error);
      }
    },

    /** Agent preset roster plus the configured default preset. */
    async listPresets() {
      try {
        const presets = service('agentPresets');
        if (!presets || typeof presets.list !== 'function') return { presets: [], current: null };
        const rows = await presets.list();
        let current = null;
        try {
          if (typeof presets.defaultId === 'string' && presets.defaultId.length > 0) current = presets.defaultId;
        } catch (error) {
          log.warn(`reading default preset failed: ${errorMessage(error)}`);
        }
        const mapped = (Array.isArray(rows) ? rows : [])
          .filter((row) => row && typeof row.id === 'string' && row.id.length > 0)
          .map((row) => ({
            id: row.id,
            title: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
            description: typeof row.description === 'string' ? row.description : '',
          }));
        return { presets: mapped, current };
      } catch (error) {
        log.warn(`listPresets failed: ${errorMessage(error)}`);
        return { presets: [], current: null };
      }
    },

    /** Bind an agent preset to a still-blank session. */
    async selectPreset(sessionId, preset) {
      try {
        if (!isSessionId(sessionId)) return failure('invalid sessionId', 'bad-request');
        if (typeof preset !== 'string' || preset.length === 0) {
          return failure('preset must be a non-empty string', 'bad-request');
        }
        const presets = service('agentPresets');
        if (!presets || typeof presets.select !== 'function') {
          return failure('agent presets are unavailable in this deployment', 'internal');
        }
        let agent = getLiveAgent(sessionId);
        if (!agent) {
          const controller = service('sessionController');
          if (controller && typeof controller.resolveAgent === 'function') {
            const resolved = await controller.resolveAgent(sessionId);
            if (resolved && resolved.error) throw resolved.error;
            agent = resolved?.agent;
          }
        }
        if (!agent) return failure(`session "${sessionId}" is not available`, 'not-found');
        await presets.select(agent, preset);
        return undefined;
      } catch (error) {
        return failure(error);
      }
    },

    /**
     * Answer a pending approval on behalf of the phone.
     * @returns true when this request id was still pending.
     */
    answerApproval(requestId, decision) {
      try {
        const entry = typeof requestId === 'string' ? pendingApprovals.get(requestId) : undefined;
        if (!entry) return false;
        const outcome = decision === 'allow'
          ? 'allowed-once'
          : decision === 'reject' ? 'rejected' : undefined;
        if (!outcome) return false;
        entry.settle(outcome);
        return true;
      } catch (error) {
        log.warn(`answerApproval failed: ${errorMessage(error)}`);
        return false;
      }
    },

    /**
     * Answer a question for the phone.
     *
     * With a `requestId` this settles a live waterfall request. With only a
     * `callId` it answers a continued (timed-out) question through
     * `ctx.userQuestions.answer`, steering the reply into the agent.
     *
     * @param {object} payload - `{ requestId?, sessionId?, callId?, answers }`
     * @returns true when accepted; an `{ ok: false }` envelope on failure.
     */
    async answerQuestion(payload) {
      try {
        if (!isPlainObject(payload) || !Array.isArray(payload.answers)) {
          return failure('answers must be an array', 'bad-request');
        }
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
        const pending = requestId === undefined ? undefined : pendingQuestions.get(requestId);
        if (pending !== undefined) {
          try {
            const batch = normalizeAnswerBatch(payload.answers, pending.questions);
            pending.answer(batch.answers);
            return true;
          } catch (error) {
            return failure(error, 'bad-request');
          }
        }
        const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
        if (callId === undefined || sessionId === undefined) {
          return failure('the question is no longer open', 'not-found');
        }
        const userQuestions = service('userQuestions');
        if (!userQuestions || typeof userQuestions.answer !== 'function') {
          return failure('user questions are unavailable in this deployment', 'internal');
        }
        let agent = getLiveAgent(sessionId);
        if (!agent) agent = await resolveAgentForSession(sessionId);
        if (!agent) return failure(`session "${sessionId}" is not available`, 'not-found');
        const answers = payload.answers
          .filter((item) => isPlainObject(item) && typeof item.id === 'string')
          .map((item) => ({
            id: item.id,
            selected: Array.isArray(item.selected)
              ? item.selected.filter((label) => typeof label === 'string')
              : [],
            ...(typeof item.custom === 'string' && item.custom.length > 0 ? { custom: item.custom } : {}),
          }));
        if (answers.length !== payload.answers.length) return failure('every answer needs an id', 'bad-request');
        const accepted = userQuestions.answer(agent, callId, { answers });
        if (accepted === true) {
          const skipped = answers.every((entry) =>
            entry.selected.length === 0 && (entry.custom === undefined || entry.custom.length === 0));
          emit('onQuestionResolved', {
            sessionId,
            requestId: null,
            callId,
            answers,
            outcome: skipped ? 'declined' : 'answered',
          });
        }
        return accepted === true;
      } catch (error) {
        log.warn(`answerQuestion failed: ${errorMessage(error)}`);
        return failure(error);
      }
    },

    /**
     * Subscribe to live bridge events.
     * @param {object} subscription - `{ onAssistant, onTool, onApproval,
     *   onApprovalResolved, onQuestion, onQuestionResolved, onQueue, onStatus }`;
     *   every handler is optional.
     * @returns {() => void} unsubscribe.
     */
    subscribe(subscription) {
      if (disposed) return () => {};
      const entry = isPlainObject(subscription) ? subscription : {};
      handlers.add(entry);
      installListeners();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        handlers.delete(entry);
        if (handlers.size === 0) {
          removeListeners();
          cancelPendingApprovals('cancelled');
          cancelPendingQuestions();
        }
      };
    },

    /** Remove every listener and settle every pending waiter owned by the bridge. */
    dispose() {
      if (disposed) return;
      disposed = true;
      removeListeners();
      cancelPendingApprovals('cancelled');
      cancelPendingQuestions();
      handlers.clear();
      attempts.clear();
      toolStarts.clear();
      approvalContexts.clear();
      pendingApprovals.clear();
      pendingQuestions.clear();
    },
  };

  // ---------------------------------------------------------------------------
  // Local helpers that need the closure (declared after the returned object for
  // readability; function declarations hoist).
  // ---------------------------------------------------------------------------

  /** Resolve (resuming if needed) the live agent for one session. */
  async function resolveAgentForSession(sessionId) {
    const controller = service('sessionController');
    if (!controller || typeof controller.resolveAgent !== 'function') return undefined;
    try {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved && resolved.error) throw resolved.error;
      return resolved?.agent;
    } catch (error) {
      log.warn(`resolveAgent(${sessionId}) failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Candidate command registries for one live Agent, preset realm first then the
   * Host instance. In the shipped composition the human commands (goal/plan/
   * compact/...) are mounted inside the Agent's preset, so a preset-scoped
   * `commands` service, when one exists, may hold descriptors the Host-plane
   * instance does not.
   */
  function commandServicesFor(agent) {
    const candidates = [];
    const seen = new Set();
    const add = (instance) => {
      if (!instance || typeof instance.list !== 'function' || seen.has(instance)) return;
      seen.add(instance);
      candidates.push(instance);
    };
    try {
      const presets = service('agentPresets');
      if (presets && typeof presets.serviceFor === 'function') {
        add(presets.serviceFor(agent, 'commands'));
      }
    } catch (error) {
      log.warn(`agentPresets.serviceFor(agent, 'commands') failed: ${errorMessage(error)}`);
    }
    add(service('commands'));
    return candidates;
  }

  /** Read one command registry's descriptor list without throwing. */
  async function readCommandDescriptors(registry, agent) {
    try {
      const value = await Promise.resolve(registry.list(agent));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      log.warn(`commands.list failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Union of every registry's visible command descriptors, preset first so a
   * preset variant shadows the host definition. The phone-hidden set is
   * excluded after the union (a hidden name is hidden from every source).
   */
  async function visibleCommands(agent) {
    const seen = new Set();
    const descriptors = [];
    for (const instance of commandServicesFor(agent)) {
      const list = await readCommandDescriptors(instance, agent);
      for (const command of list) {
        const name = typeof command?.name === 'string' ? command.name : '';
        if (!name || seen.has(name)) continue;
        seen.add(name);
        if (PHONE_HIDDEN_COMMANDS.has(name)) continue;
        if (typeof command?.definitionId === 'string'
          && PHONE_HIDDEN_COMMAND_DEFINITION_IDS.has(command.definitionId)) continue;
        descriptors.push({
          name,
          description: typeof command?.description === 'string' ? command.description : '',
          hint: typeof command?.input?.hint === 'string' ? command.input.hint : null,
          attachments: command?.input?.attachments === true,
          instance,
        });
      }
    }
    descriptors.sort((left, right) => left.name.localeCompare(right.name));
    return descriptors;
  }

  /** Look up a live agent without resuming anything. */
  function getLiveAgent(sessionId) {
    try {
      const agents = service('agents');
      if (agents && typeof agents.get === 'function') return agents.get(sessionId);
    } catch (error) {
      log.warn(`agents.get failed: ${errorMessage(error)}`);
    }
    return undefined;
  }

  /** Flatten the Host model catalog into `[{ provider, model, label }]`. */
  function flattenCatalog(catalog) {
    const out = [];
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    for (const group of groups) {
      const provider = typeof group?.id === 'string' ? group.id : '';
      if (!provider) continue;
      const models = Array.isArray(group?.models) ? group.models : [];
      for (const model of models) {
        const id = typeof model?.id === 'string' ? model.id : '';
        if (!id) continue;
        const reasoning = isPlainObject(model?.reasoning) ? model.reasoning : undefined;
        const efforts = Array.isArray(reasoning?.efforts)
          ? reasoning.efforts
            .filter((effort) => isPlainObject(effort) && typeof effort.id === 'string' && effort.id.length > 0)
            .map((effort) => ({
              id: effort.id,
              name: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id,
              description: typeof effort.description === 'string' ? effort.description : null,
            }))
          : [];
        const defaultEffort = typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort.length > 0
          ? reasoning.defaultEffort
          : null;
        out.push({
          provider,
          model: id,
          label: typeof model?.name === 'string' && model.name.length > 0 ? model.name : id,
          // Only present when the model actually exposes a reasoning control.
          ...(efforts.length > 0
            ? { reasoning: { efforts, defaultEffort } }
            : {}),
        });
      }
    }
    return out;
  }

  /** Fallback catalog built directly from the LLM registry. */
  async function catalogFromLlm() {
    const llm = service('llm');
    if (!llm || typeof llm.listProviders !== 'function') return { catalog: [], current: null };
    const catalog = [];
    let providers = [];
    try {
      providers = llm.listProviders() ?? [];
    } catch (error) {
      log.warn(`llm.listProviders failed: ${errorMessage(error)}`);
    }
    for (const provider of providers) {
      const providerId = typeof provider?.id === 'string' ? provider.id : '';
      if (!providerId) continue;
      let models = [];
      try {
        models = await llm.listModels(providerId);
      } catch (error) {
        log.warn(`llm.listModels(${providerId}) failed: ${errorMessage(error)}`);
        continue;
      }
      for (const model of models ?? []) {
        const modelId = typeof model?.id === 'string' ? model.id : '';
        if (!modelId) continue;
        let label = typeof model?.name === 'string' && model.name.length > 0 ? model.name : modelId;
        try {
          if (typeof llm.resolveModelInfo === 'function') {
            const info = await llm.resolveModelInfo(providerId, modelId);
            if (info && typeof info.name === 'string' && info.name.length > 0) label = info.name;
          }
        } catch {
          // keep the catalog name
        }
        catalog.push({ provider: providerId, model: modelId, label });
      }
    }
    return { catalog, current: selectionWire(defaultSelection()) };
  }
}

/** Build a namespaced, failure-tolerant logger. */
function createLogger(ctx) {
  const logger = ctx && typeof ctx === 'object' ? ctx.logger : undefined;
  const write = (level, message) => {
    try {
      const fn = logger && typeof logger[level] === 'function' ? logger[level] : undefined;
      if (fn) fn.call(logger, `remote-mobile/bridge: ${message}`);
    } catch {
      // logging must never break the bridge
    }
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}




