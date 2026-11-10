#!/usr/bin/env node
/* ==========================================================================
   DSH Remote — DEV-ONLY mock server
   --------------------------------------------------------------------------
   This file is not imported or served by the plugin; it exists only for local SPA development (and is published only so a checkout can run it). It
   exists so the SPA in this folder can be exercised end to end without the
   real DeepSeek Harness host.

   It implements, with Node built-ins only (no npm dependencies):

     GET  /                 the SPA shell
     GET  /app.js           the SPA bundle
     GET  /styles.css       the stylesheet
     GET  /api/state        { paired, device, version }
     POST /api/pair         { pin } or { token } -> Set-Cookie: rm_session
     POST /api/rotate-pin   rotates the demo PIN
     POST /api/unpair       revokes this demo device
     GET  /health           { ok, version }
     WS   /ws               PROTOCOL.md frames over a hand-rolled RFC 6455
                            server (handshake, masked client frames, unmasked
                            server text frames, ping/pong, close codes)

   Run:  node mock-server.js [port]
   Env:  PORT, HOST, RM_PIN, RM_RATE_WINDOW_MS, RM_RATE_MAX
   ========================================================================== */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createECDH, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { networkInterfaces } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.argv[2] || 3456);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '0.0.5';
const PAIRING_TOKEN = randomBytes(24).toString('base64url');
const RATE_WINDOW_MS = Number(process.env.RM_RATE_WINDOW_MS || 5 * 60 * 1000);
const RATE_MAX = Number(process.env.RM_RATE_MAX || 5);
const MAX_UPLOAD_BYTES = Number(process.env.RM_MAX_UPLOAD_BYTES || 32 * 1024 * 1024);
const UPLOAD_DELAY_MS = Number(process.env.RM_UPLOAD_DELAY_MS || 0);
const UPLOAD_FILE_LIMIT = 10;
const SESSION_COOKIE = 'rm_session';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SEED_PREVIEW_PATH = '.mock-uploads/seed/screenshot.png';
const SEED_PREVIEW_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAASCAYAAABB7B6eAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAATZSURBVDhPBcEBp+psAMDxPk5EREQiosmiyaLJQxYP2ZhrrrNzTFpa8qgljyRJSpLkOI5zXdf75f7v75fLGwEF4xdFI6Rk/KZsvFEx3qkaH9SMmLoxoWFMaRozWsactrGgYyzpGoqesaJvrBkYG4SxZWhoRsYOaewZGwd840gub/6iYIYUzd+UzDfK5jsV84OqGVMzJ9TNKQ1zRtOc0zIXtM0lHVPRNVf0zDV9c8PA3CJMzdDcMTL3SPPA2DzimydyeSukYP2maL1Rst4pWx9UrJiqNaFmTalbMxrWnKa1oGUtaVuKjrWia63pWRv61paBpRHWjqG1Z2QdkNaRsXXCt87k8vZvCvYbRfudkv1B2Y6p2BOq9pSaPaNuz2nYC5r2kpataNsrOvaarr2hZ2/p25qBvUPYe4b2gZF9RNonxvYZ376QyztvFJx3is4HJSem7EyoOFOqzoyaM6fuLGg4S5qOouWsaDtrOs6GrrOl52j6zo6Bs0c4B4bOkZFzQjpnxs4F37mSy4t3CuKDoogpiQllMaUiZlTFnJpYUBdLGkLRFCtaYk1bbOiILV2h6YkdfbFnIA4IcWQoTozEGSkujMUVX9zI5d0PCm5M0Z1QcqeU3RkVd07VXVBzl9RdRcNd0XTXtNwNbXdLx9V03R09d0/fPTBwjwj3xNA9M3IvSPfK2L3hu3dyeRlTkBOKckpJzijLORW5oCqX1KSiLlc05Jqm3NCSW9pS05E7unJPTx7oyyMDeULIM0N5YSSvSHljLO/48kEu700oeFOK3oySN6fsLah4S6qeouatqHtrGt6Gprel5Wna3o6Ot6frHeh5R/reiYF3RngXht6VkXdDenfG3gPfe5LLB1MKwYxiMKcULCgHSyqBohqsqAVr6sGGRrClGWhawY52sKcTHOgGR3rBiX5wZhBcEMGVYXBjFNyRwYNx8MQPXuTy4YxCOKcYLiiFS8qhohKuqIZrauGGerilEWqa4Y5WuKcdHuiER7rhiV54ph9eGIRXRHhjGN4ZhQ9k+GQcvvDDT3L5aE4hWlCMlpQiRTlaUYnWVKMNtWhLPdI0oh3NaE8rOtCOjnSiE93oTC+60I+uDKIbIrozjB6MoicyejGOPvGjL3L5eEEhXlKMFaV4RTleU4k3VOMttVhTj3c04j3N+EArPtKOT3TiM934Qi++0o9vDOI7In4wjJ+M4hcy/mQcf+HH3+TyyZJCoigmK0rJmnKyoZJsqSaaWrKjnuxpJAeayZFWcqKdnOkkF7rJlV5yo5/cGSQPRPJkmLwYJZ/I5Itx8o2f/JDLp4pCuqKYrimlG8rplkqqqaY7aumeenqgkR5ppida6Zl2eqGTXummN3rpnX76YJA+EemLYfrJKP1Cpt+M0x/89A+5vFpRUGuKakNJbSkrTUXtqKo9NXWgro401ImmOtNSF9rqSkfd6Ko7PfWgr54M1AuhPhmqL0bqG6l+GKs/+OovuXy2ppBtKGZbSpmmnO2oZHuq2YFadqSenWhkZ5rZhVZ2pZ3d6GR3utmDXvakn70YZJ+I7Ith9s0o+0Fmfxhnf/Gzf+TyekNBbylqTUnvKOs9FX2gqo/U9Im6PtPQF5r6SkvfaOs7Hf2gq5/09Iu+/mSgvxD6m6H+YaT/IPVfxvofvv6P/wFmwtpi1twkpwAAAABJRU5ErkJggg==';
const SEED_PREVIEW_BYTES = Buffer.from(SEED_PREVIEW_BASE64, 'base64');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/sw.js': 'sw.js',
  '/favicon.svg': 'favicon.svg',
  '/icons/icon-192.png': 'icons/icon-192.png',
  '/icons/icon-512.png': 'icons/icon-512.png',
  '/icons/icon-maskable-512.png': 'icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png': 'icons/apple-touch-icon.png'
};

/* Mirrors the Host's strict CSP so the mock catches inline-script and
   cross-origin regressions before they reach the real plugin. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Web Push fixtures: a fresh, genuinely valid P-256 VAPID public key per mock
   process (65-byte uncompressed point, base64url). Mock deliveries never leave
   the process; the subscription store only proves the client wiring. */
const PUSH_ECDH = createECDH('prime256v1');
PUSH_ECDH.generateKeys();
const PUSH_PUBLIC_KEY = PUSH_ECDH.getPublicKey().toString('base64url');
const pushSubscriptions = new Map(); // endpoint -> { endpoint, deviceId, subscription }
const deviceVisibility = new Map(); // deviceId -> boolean

function log(...args) {
  console.log('[mock]', ...args);
}

function randomPin() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

/* ---------- In-memory demo state ---------------------------------------- */

let currentPin = process.env.RM_PIN || '1234';
let pairingTokenConsumed = false;
/* Simulate a read-only approval device (the Host advertises canApprove). */
const APPROVALS_READONLY = process.env.RM_APPROVAL_READONLY === '1';

const devices = []; // { id, name, createdAt, cookie }
const clients = new Set(); // WsConnection
const histories = new Map(); // sessionId -> HistoryItem[]
const runs = new Map(); // sessionId -> run token
const pendingApprovals = new Map(); // requestId -> { requestId, resolve, done }
const pendingQuestions = new Map(); // requestId -> { requestId, callId, questions, resolve, done }
const uploadedFiles = new Map(); // path -> { bytes, sessionId, mediaType, name }
const rateLimit = new Map(); // ip -> number[] timestamps
let historySeq = 1000;

uploadedFiles.set(SEED_PREVIEW_PATH, {
  bytes: SEED_PREVIEW_BYTES,
  sessionId: 'sess-release',
  mediaType: 'image/png',
  name: 'screenshot.png'
});

const serverState = {
  sessions: [],
  activeSessionId: null,
  models: {
    catalog: [
      { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat' },
      {
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
        label: 'V4.1 Flash',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low', description: 'Faster answers with a short reasoning pass.' },
            { id: 'medium', name: 'Medium', description: 'The balanced default for everyday work.' },
            { id: 'high', name: 'High', description: 'Deeper reasoning; slower and more tokens.' }
          ],
          defaultEffort: 'medium'
        }
      },
      { provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4.5',
        label: 'Claude Sonnet 4.5',
        reasoning: {
          /* No defaultEffort: the sheet offers "Provider default" explicitly. */
          efforts: [
            { id: 'low', name: 'Low', description: null },
            { id: 'high', name: 'High', description: 'Extends thinking before answering.' }
          ],
          defaultEffort: null
        }
      },
      { provider: 'local', model: 'qwen2.5-coder:32b', label: 'Qwen 2.5 Coder 32B' }
    ],
    current: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: null
    }
  },
  presets: {
    presets: [
      {
        id: 'standard',
        title: 'Standard',
        description:
          'Balanced planning with full tool access. The default working preset.'
      },
      {
        id: 'ptc',
        title: 'Plan · Think · Check',
        description:
          'Explains the plan before acting and verifies each step before reporting back.'
      },
      {
        id: 'minimal',
        title: 'Minimal',
        description:
          'Fast, terse answers with minimal tool use and no commentary.'
      },
      {
        id: 'cordis',
        title: 'Cordis',
        description:
          'Plugin and harness development with Cordis-aware context and tooling.'
      }
    ],
    current: 'standard'
  },
  /* Batch D attachment limits as advertised by the live Host. */
  limits: {
    image: {
      maxBytes: 5242880,
      maxDimension: 65535,
      maxImages: 4,
      maxMessageBytes: 209715200,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    }
  }
};

/* Batch C: the live prompt queue per session (never history until claimed). */
const queues = new Map(); // sessionId -> [{ id, placement, rpcId?, text }]

function queueOf(sessionId) {
  if (!queues.has(sessionId)) queues.set(sessionId, []);
  return queues.get(sessionId);
}

function broadcastQueue(sessionId) {
  const items = queueOf(sessionId);
  broadcast({ type: 'queue.changed', sessionId, items });
}

function sendQueueFrame(conn, sessionId) {
  const session = findSession(sessionId);
  conn.sendText(
    JSON.stringify({
      type: 'queue',
      sessionId,
      items: queueOf(sessionId),
      pendingInput: [],
      running: !!(session && session.running),
      active: !!(session && session.agentAvailable)
    })
  );
}

function nextHistoryId(kind) {
  historySeq += 1;
  return kind === 'tool' ? 'tool:' + historySeq : 'seq:' + historySeq;
}

/* Demo projects shown by the project-grouped Sessions sheet. Paths are generic
   placeholders; the mock never reads them. */
const WORKSPACES = [
  {
    id: 'ws-mobile',
    title: 'dsh-remote-mobile',
    path: 'C:\\workspace\\dsh-remote-mobile',
    sessionIds: ['sess-release', 'sess-api']
  },
  {
    id: 'ws-agent',
    title: 'personal-agent',
    path: 'C:\\workspace\\personal-agent',
    sessionIds: ['sess-design']
  }
];

function seed() {
  const now = Date.now();

  const release = {
    id: 'sess-release',
    title: 'Release checklist',
    running: false,
    updatedAt: now - 3 * 60 * 1000,
    preset: 'standard',
    model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: null },
    turn: 0,
    agentAvailable: true,
    pinned: true,
    archived: false,
    workspaceId: WORKSPACES[0].id
  };
  const api = {
    id: 'sess-api',
    title: 'API refactor notes',
    running: false,
    updatedAt: now - 96 * 60 * 1000,
    preset: 'ptc',
    model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: null },
    turn: 0,
    agentAvailable: true,
    pinned: false,
    archived: false,
    workspaceId: WORKSPACES[0].id
  };
  const design = {
    id: 'sess-design',
    title: 'Design review — mobile shell',
    running: false,
    updatedAt: now - 26 * 60 * 60 * 1000,
    preset: 'minimal',
    model: { provider: 'anthropic', model: 'claude-sonnet-4.5', reasoningEffort: null },
    turn: 0,
    agentAvailable: true,
    pinned: false,
    archived: true,
    workspaceId: WORKSPACES[1].id
  };
  const notes = {
    id: 'sess-notes',
    title: 'Scratchpad',
    running: false,
    updatedAt: now - 5 * 60 * 60 * 1000,
    preset: 'standard',
    model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: null },
    turn: 0,
    agentAvailable: true,
    pinned: false,
    archived: false,
    workspaceId: null
  };

  serverState.sessions = [release, api, notes, design];
  serverState.activeSessionId = release.id;

  const releaseAttachments = [
    {
      path: SEED_PREVIEW_PATH,
      name: 'screenshot.png',
      mediaType: 'image/png',
      size: SEED_PREVIEW_BYTES.length
    },
    {
      path: '.mock-uploads/seed/release-notes.txt',
      name: 'release-notes.txt',
      mediaType: 'text/plain',
      size: 24
    }
  ];
  if (process.env.RM_BROKEN_PREVIEW_FIXTURE === '1') {
    releaseAttachments.splice(1, 0, {
      path: '.mock-uploads/seed/missing-preview.png',
      name: 'missing-preview.png',
      mediaType: 'image/png',
      size: 0
    });
  }

  histories.set(release.id, [
    {
      id: 'seq:1',
      kind: 'user',
      text: 'Give me a quick release checklist for the mobile plugin.',
      ts: now - 8 * 60 * 1000,
      attachments: releaseAttachments
    },
    {
      id: 'seq:2',
      kind: 'assistant',
      text: [
        '## Release checklist',
        '',
        'Before tagging `v1.0.0`, verify the following:',
        '',
        '1. **Protocol** — the SPA consumes only documented frames.',
        '2. **Pairing** — QR token and 4-digit PIN both pair successfully.',
        '3. `node --check app.js` and `node --check mock-server.js` pass.',
        '',
        '| Check | Status |',
        '| --- | --- |',
        '| Protocol frames | Done |',
        '| iOS Safari pairing | Open |',
        '',
        '> Remote access is local-network only. No camera, no audio, no cloud relay.',
        '',
        '```js',
        "const socket = new WebSocket('/ws');",
        "socket.addEventListener('message', (event) => {",
        "  const frame = JSON.parse(event.data);",
        "  console.log(frame.type);",
        '});',
        '```',
        '',
        '- [ ] Token pairing tested on iOS Safari',
        '- [ ] PIN rate limit shows a countdown',
        '',
        'See the [protocol notes](https://example.com/dsh-remote) for details.'
      ].join('\n'),
      ts: now - 7 * 60 * 1000
    },
    {
      id: 'tool:1',
      kind: 'tool',
      callId: 'call-history-1',
      name: 'read',
      title: 'Read file',
      argsPreview: 'mobile/app.js',
      ok: true,
      output:
        "1  (function () {\n2    'use strict';\n3    ...\n4  })();\n\n(read 1.8 kB)",
      diff: null,
      durationMs: 42,
      ts: now - 6 * 60 * 1000
    },
    {
      id: 'tool:1q',
      kind: 'tool',
      callId: 'call-history-q1',
      name: 'ask_user_question',
      title: 'Confirm deployment',
      argsPreview: '2 questions',
      ok: true,
      output: JSON.stringify({
        answers: [
          { id: 'environment', selected: ['Staging'] },
          { id: 'checks', selected: ['Unit tests'], custom: 'Also run the linter' }
        ],
        outcome: 'answered'
      }),
      diff: null,
      durationMs: 5400,
      ts: now - 5.5 * 60 * 1000,
      question: { callId: 'call-history-q1', questions: deployQuestions() }
    },
    {
      id: 'seq:3',
      kind: 'assistant',
      text: [
        'The checklist is covered in the release notes. Two things are still open:',
        '',
        '- token pairing on **iOS Safari**',
        '- the **rate-limit countdown** copy',
        '',
        'Want me to run the checks now?'
      ].join('\n'),
      ts: now - 5 * 60 * 1000
    }
  ]);

  histories.set(api.id, [
    {
      id: 'seq:4',
      kind: 'user',
      text: 'Summarise the refactor decisions from yesterday.',
      ts: now - 2 * 60 * 60 * 1000
    },
    {
      id: 'seq:5',
      kind: 'assistant',
      text: [
        '### Decisions',
        '',
        '- One **generic runtime**: `core/runtime.py` owns the tool loop.',
        '- Playbooks became data, not subclasses.',
        '- Approvals are content-bound; a changed draft asks again.',
        '',
        'The related tests moved under `tests/test_runtime.py`.'
      ].join('\n'),
      ts: now - 110 * 60 * 1000
    },
    {
      id: 'tool:2',
      kind: 'tool',
      callId: 'call-history-2',
      name: 'grep',
      title: 'Search sources',
      argsPreview: 'class .*Worker',
      ok: false,
      output: 'No matches for /class .*Worker/ in src/.',
      diff: null,
      durationMs: 18,
      ts: now - 105 * 60 * 1000
    }
  ]);

  histories.set(design.id, [
    {
      id: 'seq:6',
      kind: 'user',
      text: 'Review the mobile top bar spacing.',
      ts: now - 27 * 60 * 60 * 1000
    },
    {
      id: 'seq:7',
      kind: 'assistant',
      text: [
        'The top bar reads well at 390 px. One note: the title block sits **2 px** higher than the icon buttons because of the status dot line-height. Tighten the `session-sub` line box to `15px` and it aligns.'
      ].join('\n'),
      ts: now - 26 * 60 * 60 * 1000
    }
  ]);
}

seed();

/* ---------- Session / frame helpers ------------------------------------- */

function findSession(id) {
  return serverState.sessions.find((session) => session.id === id) || null;
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    running: !!session.running,
    updatedAt: session.updatedAt,
    preset: session.preset || null,
    model: session.model || null,
    agentAvailable: session.agentAvailable !== false,
    pinned: !!session.pinned,
    archived: !!session.archived,
    workspaceId: session.workspaceId || null
  };
}

function publicSessions() {
  return serverState.sessions.map(publicSession);
}

function historyOf(sessionId) {
  return histories.get(sessionId) || [];
}

/* Batch C3 fixtures: a live context projection, change summaries and diffs. */
function contextFor() {
  return {
    usedTokens: 11214,
    pressureTokens: 11214,
    projectedTokens: 12480,
    contextWindow: 1000000,
    basis: 'usage',
    tokenUsage: {
      inputTokens: 10400,
      outputTokens: 814,
      totalTokens: 11214,
      reasoningTokens: 0
    }
  };
}

function changesFor() {
  return [
    {
      seq: 41,
      available: true,
      turn: 2,
      total: 2,
      added: 18,
      deleted: 4,
      files: [
        {
          index: 0,
          path: 'src/app.ts',
          display: 'src/app.ts',
          added: 12,
          deleted: 3,
          binary: false,
          oversized: false
        },
        {
          index: 1,
          path: 'assets/logo.png',
          display: 'assets/logo.png',
          added: 0,
          deleted: 0,
          binary: true,
          oversized: false
        }
      ]
    },
    { seq: 40, available: false, files: [] }
  ];
}

function diffFor(seq, index) {
  const file = changesFor()
    .map((item) => (item.files || []).find((entry) => entry.index === index))
    .find(Boolean);
  if (!file) return null;
  if (file.binary) {
    return { kind: 'binary', path: file.display, coarse: false, hunks: [] };
  }
  return {
    kind: 'text',
    path: file.display,
    coarse: false,
    hunks: [
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 5,
        lines: [
          ' export function createBridge(ctx) {',
          '-  const sessions = ctx.sessions;',
          '+  const sessions = ctx.sessionController;',
          '+  const queue = ctx.queue;',
          '   return sessions;',
          ' }'
        ]
      }
    ]
  };
}

function appendHistory(sessionId, item) {
  const list = historyOf(sessionId);
  list.push(item);
  if (list.length > 400) list.splice(0, list.length - 400);
  histories.set(sessionId, list);
}

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  });
  res.end(payload);
}

function errorFrame(code, message) {
  return { type: 'error', code, message };
}

function broadcast(frame) {
  for (const client of clients) {
    client.sendText(JSON.stringify(frame));
  }
}

function broadcastSessions() {
  broadcast({
    type: 'sessions',
    sessions: publicSessions(),
    workspaces: WORKSPACES,
    activeSessionId: serverState.activeSessionId
  });
}

function broadcastStatus(sessionId, running) {
  broadcast({ type: 'session.status', sessionId, running });
}

function readProviderModel(provider, model) {
  return (
    serverState.models.catalog.find(
      (entry) => entry.provider === provider && entry.model === model
    ) || null
  );
}

/* ---------- Streaming simulation ---------------------------------------- */

function splitChunks(text) {
  return text.match(/\s*\S+/g) || [text];
}

async function streamAssistant(sessionId, turn, step, text, runToken) {
  broadcast({ type: 'assistant.start', sessionId, turn, step });
  const chunks = splitChunks(text);
  let accumulated = '';
  for (const chunk of chunks) {
    if (runToken.cancelled) break;
    accumulated += chunk;
    broadcast({
      type: 'assistant.delta',
      sessionId,
      text: chunk,
      reasoning: null
    });
    await sleep(32 + Math.floor(Math.random() * 28));
  }
  broadcast({ type: 'assistant.end', sessionId, turn, step });
  return accumulated;
}

function firstStepText(promptText, attachments) {
  if (attachments && attachments.length) {
    const names = attachments
      .map((attachment) => String(attachment.name || 'file'))
      .join(', ');
    return (
      'I received ' +
      attachments.length +
      ' attachment' +
      (attachments.length === 1 ? '' : 's') +
      ': ' +
      names +
      '. I will take a look and report back.'
    );
  }
  if (/deploy/i.test(promptText)) {
    return 'Deploying needs an approval first. The command is ready — approve it and I will run it.';
  }
  if (/test|pytest|suite/i.test(promptText)) {
    return 'Running the test suite now. I will report the failing cases and any leaked database state.';
  }
  return 'On it. Let me check the working tree first, then I will summarise what changed.';
}

function deployQuestions() {
  return [
    {
      id: 'environment',
      question: 'Which environment should I deploy to?',
      header: 'Deploy',
      detail: 'Staging is safe to retry; production carries live traffic.',
      multiSelect: false,
      options: [
        { label: 'Staging', description: 'Shared staging slot' },
        { label: 'Production', description: 'Live traffic — use with care' }
      ]
    },
    {
      id: 'checks',
      question: 'Which checks should run before the deploy?',
      header: 'Deploy',
      multiSelect: true,
      options: [
        { label: 'Unit tests', description: 'Fast pytest pass' },
        { label: 'Browser smoke', description: 'Drive the mobile SPA headlessly' },
        { label: 'Skip checks' }
      ]
    }
  ];
}

/* Ask a batch through the full tool shape: tool.start (with question) +
   question.request, then question.resolved + tool.end once the phone answers. */
async function askQuestions(sessionId, callId, questions, runToken, opts = {}) {
  const requestId = 'qst-' + randomBytes(4).toString('hex');
  const pending = {
    requestId,
    callId,
    questions,
    resolve: null,
    done: false
  };
  const decisionPromise = new Promise((resolve) => {
    pending.resolve = resolve;
  });
  pendingQuestions.set(requestId, pending);
  runToken.question = pending;

  broadcast({
    type: 'tool.start',
    sessionId,
    callId,
    name: 'ask_user_question',
    title: opts.toolTitle || 'Ask user',
    argsPreview: questions.length + ' questions',
    detail: null,
    question: { callId, questions }
  });
  broadcast({
    type: 'question.request',
    sessionId,
    requestId,
    callId,
    questions
  });

  const decision = await Promise.race([
    decisionPromise,
    sleep(120000).then(() => 'timeout')
  ]);
  pendingQuestions.delete(requestId);
  runToken.question = null;
  pending.done = true;
  if (decision !== 'timeout') await sleep(650);

  if (decision === 'timeout') {
    broadcast({
      type: 'question.resolved',
      sessionId,
      requestId,
      callId,
      answers: null,
      outcome: 'unavailable'
    });
    broadcast({
      type: 'tool.end',
      sessionId,
      callId,
      ok: false,
      output: 'Question timed out.',
      durationMs: 120000
    });
    return { answers: [], outcome: 'unavailable', requestId, callId };
  }

  const answers = Array.isArray(decision.answers) ? decision.answers : [];
  const outcome = answers.length ? 'answered' : 'declined';
  const output = JSON.stringify({ answers, outcome });

  broadcast({
    type: 'question.resolved',
    sessionId,
    requestId,
    callId,
    answers,
    outcome
  });
  broadcast({
    type: 'tool.end',
    sessionId,
    callId,
    ok: true,
    output,
    durationMs: 1200
  });
  appendHistory(sessionId, {
    id: 'tool:' + callId,
    kind: 'tool',
    callId,
    name: 'ask_user_question',
    title: opts.toolTitle || 'Ask user',
    argsPreview: questions.length + ' questions',
    ok: true,
    output,
    diff: null,
    durationMs: 1200,
    ts: Date.now(),
    question: { callId, questions }
  });
  return { answers, outcome, requestId, callId };
}

/* Blocking-question edge case: question.request with no matching tool row.
   Resends once so the SPA's dedupe + draft survival can be exercised. */
async function askBlockingQuestion(sessionId, questions, runToken, opts = {}) {
  const requestId = 'qst-' + randomBytes(4).toString('hex');
  const pending = {
    requestId,
    callId: null,
    questions,
    resolve: null,
    done: false
  };
  const decisionPromise = new Promise((resolve) => {
    pending.resolve = resolve;
  });
  pendingQuestions.set(requestId, pending);
  runToken.question = pending;

  const send = () =>
    broadcast({
      type: 'question.request',
      sessionId,
      requestId,
      callId: null,
      questions
    });
  send();
  if (opts.resend) setTimeout(send, 900);

  const decision = await Promise.race([
    decisionPromise,
    sleep(120000).then(() => 'timeout')
  ]);
  pendingQuestions.delete(requestId);
  runToken.question = null;
  pending.done = true;
  if (decision !== 'timeout') await sleep(650);

  const answers =
    decision && Array.isArray(decision.answers) ? decision.answers : [];
  const outcome = decision === 'timeout' ? 'unavailable' : answers.length ? 'answered' : 'declined';
  broadcast({
    type: 'question.resolved',
    sessionId,
    requestId,
    callId: null,
    answers: outcome === 'answered' ? answers : null,
    outcome
  });
  return { answers, outcome, requestId };
}

/* Cross-session fixture: one pending approval for the active session, one
   approval and one question for non-active sessions. Used by the layout and
   scoping harness; triggered by a "cross-session fixture" prompt. */
function fixtureApproval(sessionId, displayReason) {
  const requestId = 'appr-fix-' + randomBytes(3).toString('hex');
  const entry = {
    requestId,
    done: false,
    resolve: null
  };
  entry.resolve = (decision) => {
    pendingApprovals.delete(requestId);
    broadcast({
      type: 'approval.resolved',
      requestId,
      outcome: decision === 'allow' ? 'allowed-once' : 'rejected'
    });
  };
  pendingApprovals.set(requestId, entry);
  broadcast({
    type: 'approval.request',
    sessionId,
    requestId,
    toolName: 'pwsh',
    title: 'Approval required',
    reason: 'pwsh -File scripts\\deploy.ps1 -Environment staging',
    displayReason,
    argsKind: 'command',
    argsPreview:
      'pwsh -File scripts\\deploy.ps1 -Environment staging\n' +
      '# step 1/3: verify build output\n' +
      '# step 2/3: upload to staging\n' +
      '# step 3/3: restart the staging app',
    detail: { kind: 'command', path: 'scripts\\deploy.ps1' },
    callId: null,
    expiresAt: Date.now() + 120000
  });
  return requestId;
}

function fixtureQuestion(sessionId, question) {
  const requestId = 'qst-fix-' + randomBytes(3).toString('hex');
  const entry = {
    requestId,
    callId: null,
    questions: [question],
    done: false,
    resolve: null
  };
  entry.resolve = (decision) => {
    const answers =
      decision && Array.isArray(decision.answers) ? decision.answers : [];
    pendingQuestions.delete(requestId);
    broadcast({
      type: 'question.resolved',
      sessionId,
      requestId,
      callId: null,
      answers: answers.length ? answers : null,
      outcome: answers.length ? 'answered' : 'declined'
    });
  };
  pendingQuestions.set(requestId, entry);
  broadcast({
    type: 'question.request',
    sessionId,
    requestId,
    callId: null,
    questions: [question]
  });
  return requestId;
}

function emitCrossSessionFixtures(activeSessionId) {
  const others = serverState.sessions.filter(
    (session) => session.id !== activeSessionId
  );
  const approvalSession = others[0] || null;
  const questionSession = others[1] || others[0] || null;

  /* Active approval first: it must render inline. */
  fixtureApproval(activeSessionId, 'Deploy the active-session build');
  if (approvalSession) {
    fixtureApproval(
      approvalSession.id,
      'Approve the deploy in ' + approvalSession.title
    );
  }
  if (questionSession) {
    fixtureQuestion(questionSession.id, {
      id: 'fixture-channel',
      question: 'Which release channel should I use?',
      header: 'Cross-session fixture',
      detail: 'This question belongs to ' + questionSession.title + '.',
      multiSelect: false,
      options: [{ label: 'Stable' }, { label: 'Beta' }]
    });
  }

  /* Force a history reload so the active pending approval must survive it. */
  setTimeout(() => {
    if (!findSession(activeSessionId)) return;
    broadcast({
      type: 'history',
      sessionId: activeSessionId,
      items: historyOf(activeSessionId).slice(-200),
      hasMore: false
    });
  }, 350);
}

async function runTurn(sessionId, promptText, attachments) {
  const session = findSession(sessionId);
  if (!session) return;
  if (runs.has(sessionId)) return;

  const runToken = { cancelled: false, approval: null };
  runs.set(sessionId, runToken);
  session.running = true;
  session.updatedAt = Date.now();
  const turn = (session.turn = (session.turn || 0) + 1);

  broadcastStatus(sessionId, true);
  broadcastSessions();

  try {
    let accumulated = await streamAssistant(
      sessionId,
      turn,
      1,
      firstStepText(promptText, attachments),
      runToken
    );
    appendHistory(sessionId, {
      id: nextHistoryId('assistant'),
      kind: 'assistant',
      text: accumulated,
      ts: Date.now()
    });
    if (runToken.cancelled) return;

    if (/blocking|ask me/i.test(promptText)) {
      await askBlockingQuestion(
        sessionId,
        [
          {
            id: 'workspace-name',
            question: 'What should I call this workspace?',
            header: 'Blocking question',
            detail: 'This request arrived without a tool row — a request-only question.',
            multiSelect: false,
            options: [{ label: 'Demo workspace' }, { label: 'DSH Remote' }]
          }
        ],
        runToken,
        { resend: true }
      );
      if (runToken.cancelled) return;
      accumulated = await streamAssistant(
        sessionId,
        turn,
        2,
        'Noted. I will use that name for the workspace summary.',
        runToken
      );
      appendHistory(sessionId, {
        id: nextHistoryId('assistant'),
        kind: 'assistant',
        text: accumulated,
        ts: Date.now()
      });
      return;
    }

    const callId = 'call-' + randomBytes(4).toString('hex');
    const argsPreview = 'git status --short';
    const toolOutput =
      ' M mobile/styles.css\\n M mobile/app.js\\n?? notes/todo.md\\n';
    broadcast({
      type: 'tool.start',
      sessionId,
      callId,
      name: 'pwsh',
      title: 'Run command',
      argsPreview,
      detail: { command: argsPreview, cwd: 'C:\\workspace\\demo' }
    });
    await sleep(850);
    if (runToken.cancelled) return;
    broadcast({
      type: 'tool.end',
      sessionId,
      callId,
      ok: true,
      output: toolOutput,
      durationMs: 812
    });
    appendHistory(sessionId, {
      id: 'tool:' + callId,
      kind: 'tool',
      callId,
      name: 'pwsh',
      title: 'Run command',
      argsPreview,
      ok: true,
      output: toolOutput,
      diff: null,
      durationMs: 812,
      ts: Date.now()
    });

    const wantsQuestion = /deploy/i.test(promptText);
    let asked = null;
    if (wantsQuestion) {
      const questionCallId = 'call-' + randomBytes(4).toString('hex');
      asked = await askQuestions(
        sessionId,
        questionCallId,
        deployQuestions(),
        runToken,
        { toolTitle: 'Confirm deployment' }
      );
      if (runToken.cancelled) return;
    }

    let denied = false;
    const wantsApproval = /deploy/i.test(promptText);
    if (wantsApproval) {
      const requestId = 'appr-' + randomBytes(4).toString('hex');
      const approval = { requestId, resolve: null, done: false };
      const decisionPromise = new Promise((resolve) => {
        approval.resolve = resolve;
      });
      pendingApprovals.set(requestId, approval);
      runToken.approval = approval;

      broadcast({
        type: 'approval.request',
        sessionId,
        requestId,
        toolName: 'pwsh',
        title: 'Approval required',
        reason: 'pwsh -File scripts\\deploy.ps1 -Environment staging',
        displayReason: 'Deploy the current build to staging',
        argsKind: 'command',
        argsPreview:
          'pwsh -File scripts\\deploy.ps1 -Environment staging\n' +
          'Set-Location C:\\workspace\\demo\n' +
          '$env:DEPLOY_ENV = "staging"\n' +
          '& scripts\\deploy.ps1 -Environment staging -Verbose\n' +
          '# step 1/4: verify build output\n' +
          '# step 2/4: upload artefacts\n' +
          '# step 3/4: restart staging app\n' +
          '# step 4/4: smoke check /health',
        detail: { kind: 'command', path: 'scripts\\deploy.ps1' },
        callId,
        expiresAt: Date.now() + 120000
      });

      const decision = await Promise.race([
        decisionPromise,
        sleep(120000).then(() => 'timeout')
      ]);
      pendingApprovals.delete(requestId);
      runToken.approval = null;
      approval.done = true;

      if (runToken.cancelled) {
        broadcast({
          type: 'approval.resolved',
          requestId,
          outcome: 'cancelled'
        });
        return;
      }
      if (decision === 'allow') {
        broadcast({
          type: 'approval.resolved',
          requestId,
          outcome: 'allowed-once'
        });
      } else {
        broadcast({
          type: 'approval.resolved',
          requestId,
          outcome: decision === 'timeout' ? 'unavailable' : 'rejected'
        });
        denied = true;
      }
    }
    if (runToken.cancelled) return;

    let secondText;
    if (denied) {
      secondText =
        'Understood — I did not run the deploy. Nothing was changed on the staging server.';
    } else if (wantsApproval) {
      let target = 'staging';
      if (asked) {
        const envAnswer = asked.answers.find((answer) => answer.id === 'environment');
        if (envAnswer && envAnswer.selected && envAnswer.selected.length) {
          target = String(envAnswer.selected[0]).toLowerCase();
        }
      }
      secondText =
        'Approved. The deploy command finished with exit code 0 and ' +
        target +
        ' is on the new build.';
    } else {
      secondText =
        'The working tree shows three changes. I would commit the mobile styles and app changes together and leave `notes/todo.md` uncommitted.';
    }

    accumulated = await streamAssistant(sessionId, turn, 2, secondText, runToken);
    appendHistory(sessionId, {
      id: nextHistoryId('assistant'),
      kind: 'assistant',
      text: accumulated,
      ts: Date.now()
    });
  } finally {
    const latest = findSession(sessionId);
    if (latest) {
      latest.running = false;
      latest.updatedAt = Date.now();
    }
    runs.delete(sessionId);
    broadcastStatus(sessionId, false);
    broadcastSessions();
  }
}

/* ---------- WebSocket server (RFC 6455, no dependencies) ---------------- */

class WsConnection {
  constructor(socket, head, device) {
    this.socket = socket;
    this.device = device || null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.socket.setNoDelay(true);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.onClose());
    if (head && head.length) this.consume(head);
  }

  onClose() {
    this.closed = true;
    clients.delete(this);
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clients.delete(this);
    try {
      this.socket.destroy();
    } catch (err) {
      /* ignore */
    }
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parse();
  }

  parse() {
    while (!this.closed) {
      const buf = this.buffer;
      if (buf.length < 2) return;

      const first = buf[0];
      const second = buf[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const high = buf.readUInt32BE(2);
        const low = buf.readUInt32BE(6);
        length = high * 0x100000000 + low;
        offset = 10;
      }

      if (length > 10 * 1024 * 1024) {
        this.close(1009, 'frame too large');
        return;
      }

      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + length) return;

      let payload = Buffer.from(buf.subarray(offset, offset + length));
      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }
      this.buffer = buf.subarray(offset + length);

      if (opcode === 0x8) {
        let code = 1000;
        if (payload.length >= 2) code = payload.readUInt16BE(0);
        this.close(code === 1005 || code === 0 ? 1000 : code, '');
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.onMessage(payload.toString('utf8'));
        } else {
          this.fragments = [payload];
          this.fragmentOpcode = opcode;
        }
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragments.length) continue;
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.fragmentOpcode === 0x1) {
            this.onMessage(full.toString('utf8'));
          }
          this.fragmentOpcode = 0;
        }
        continue;
      }
      /* Unknown opcodes are ignored, matching the protocol's tolerance. */
    }
  }

  onMessage(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch (err) {
      this.sendText(JSON.stringify(errorFrame('bad-request', 'Invalid JSON frame.')));
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      this.sendText(JSON.stringify(errorFrame('bad-request', 'Frame needs a type.')));
      return;
    }
    handleClientFrame(this, frame);
  }

  sendFrame(opcode, payload) {
    if (this.closed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this.destroy();
    }
  }

  sendText(text) {
    this.sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close(code, reason) {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(String(reason || ''), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code || 1000, 0);
    reasonBuffer.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.closed = true;
    clients.delete(this);
    try {
      this.socket.end();
    } catch (err) {
      this.destroy();
    }
  }
}

/* ---------- Client -> server frame handling ----------------------------- */

function handleClientFrame(conn, frame) {
  switch (frame.type) {
    case 'sessions.list':
      conn.sendText(
        JSON.stringify({
          type: 'sessions',
          sessions: publicSessions(),
          workspaces: WORKSPACES,
          activeSessionId: serverState.activeSessionId
        })
      );
      return;

    case 'sessions.open': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      serverState.activeSessionId = session.id;
      const limit = clampLimit(frame.limit, 200);
      conn.sendText(
        JSON.stringify({
          type: 'session.opened',
          session: publicSession(session),
          history: historyOf(session.id).slice(-limit),
          queue: queueOf(session.id),
          context: contextFor()
        })
      );
      return;
    }

    case 'sessions.create': {
      const preset =
        frame.preset &&
        serverState.presets.presets.some((entry) => entry.id === frame.preset)
          ? frame.preset
          : serverState.presets.current;
      const session = {
        id: 'sess-' + randomBytes(3).toString('hex'),
        title: 'New session',
        running: false,
        updatedAt: Date.now(),
        preset: preset || null,
        model: serverState.models.current
          ? {
              provider: serverState.models.current.provider,
              model: serverState.models.current.model
            }
          : null,
        turn: 0,
        agentAvailable: true,
        pinned: false,
        archived: false
      };
      serverState.sessions.unshift(session);
      histories.set(session.id, []);
      queues.set(session.id, []);
      serverState.activeSessionId = session.id;
      broadcastSessions();
      conn.sendText(
        JSON.stringify({
          type: 'session.opened',
          session: publicSession(session),
          history: [],
          queue: []
        })
      );
      return;
    }

    case 'history.load': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const limit = clampLimit(frame.limit, 200);
      const all = historyOf(session.id);
      conn.sendText(
        JSON.stringify({
          type: 'history',
          sessionId: session.id,
          items: all.slice(-limit),
          hasMore: all.length > limit
        })
      );
      return;
    }

    case 'sessions.search': {
      if (process.env.RM_SEARCH_DISABLED === '1') {
        conn.sendText(
          JSON.stringify(
            errorFrame('unavailable', 'Message search is disabled on this deployment.')
          )
        );
        return;
      }
      const query = String(frame.query || '').trim();
      if (!query) {
        conn.sendText(JSON.stringify(errorFrame('bad-request', 'Empty search query.')));
        return;
      }
      const needle = query.toLowerCase();
      const results = [];
      for (const session of serverState.sessions) {
        const hit = historyOf(session.id).find((item) => {
          const text = String(item.text || '').toLowerCase();
          return text.indexOf(needle) !== -1;
        });
        if (!hit) continue;
        const text = String(hit.text || '');
        const at = text.toLowerCase().indexOf(needle);
        const start = Math.max(0, at - 60);
        results.push({
          id: session.id,
          title: session.title,
          snippet:
            (start > 0 ? '…' : '') +
            text.slice(start, start + 220) +
            (text.length > start + 220 ? '…' : ''),
          updatedAt: session.updatedAt,
          running: !!session.running,
          pinned: !!session.pinned,
          archived: !!session.archived,
          agentAvailable: session.agentAvailable !== false
        });
      }
      results.sort((a, b) => b.updatedAt - a.updatedAt);
      conn.sendText(
        JSON.stringify({
          type: 'sessions.found',
          query,
          hasMore: results.length > 20,
          results: results.slice(0, 20)
        })
      );
      return;
    }

    case 'session.rename': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const title = String(frame.title || '').trim().slice(0, 120);
      if (!title) {
        conn.sendText(JSON.stringify(errorFrame('bad-request', 'A title is required.')));
        return;
      }
      session.title = title;
      session.updatedAt = Date.now();
      broadcast({
        type: 'session.updated',
        sessionId: session.id,
        title,
        session: publicSession(session)
      });
      broadcastSessions();
      return;
    }

    case 'session.pin':
    case 'session.unpin': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const pinned = frame.type === 'session.pin';
      if (pinned && session.archived) {
        conn.sendText(
          JSON.stringify(errorFrame('bad-request', 'Unarchive the session before pinning it.'))
        );
        return;
      }
      session.pinned = pinned;
      broadcast({
        type: 'session.pinned',
        sessionId: session.id,
        pinned,
        archived: !!session.archived
      });
      broadcastSessions();
      return;
    }

    case 'session.archive':
    case 'session.unarchive': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      if (frame.type === 'session.unarchive') {
        session.archived = false;
        broadcast({
          type: 'session.archived',
          sessionId: session.id,
          archived: false,
          pinned: !!session.pinned
        });
        broadcastSessions();
        return;
      }
      if (session.running && frame.stopActivity !== true) {
        conn.sendText(
          JSON.stringify(
            errorFrame('bad-request', 'Archive requires stopActivity for a running session.')
          )
        );
        return;
      }
      if (session.running) {
        const runToken = runs.get(session.id);
        if (runToken) {
          runToken.cancelled = true;
          if (runToken.approval) runToken.approval.resolve('cancelled');
          if (runToken.question && !runToken.question.done) runToken.question.resolve({ answers: [] });
        }
        session.running = false;
        broadcastStatus(session.id, false);
      }
      session.archived = true;
      session.pinned = false;
      broadcast({
        type: 'session.archived',
        sessionId: session.id,
        archived: true,
        pinned: false
      });
      broadcastSessions();
      return;
    }

    case 'session.fork': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const fork = {
        id: 'sess-' + randomBytes(3).toString('hex'),
        title: session.title + ' (fork)',
        running: false,
        updatedAt: Date.now(),
        preset: session.preset || null,
        model: session.model || null,
        turn: 0,
        agentAvailable: true,
        pinned: false,
        archived: false
      };
      serverState.sessions.unshift(fork);
      histories.set(fork.id, historyOf(session.id).slice());
      queues.set(fork.id, []);
      serverState.activeSessionId = fork.id;
      broadcastSessions();
      conn.sendText(
        JSON.stringify({
          type: 'session.opened',
          session: publicSession(fork),
          history: historyOf(fork.id),
          queue: []
        })
      );
      return;
    }

    case 'queue.list': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      if (session.agentAvailable === false) {
        conn.sendText(
          JSON.stringify(errorFrame('not-live', 'This session is not live on the desktop yet.'))
        );
        return;
      }
      sendQueueFrame(conn, session.id);
      return;
    }

    case 'queue.update': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      if (session.agentAvailable === false) {
        conn.sendText(
          JSON.stringify(errorFrame('not-live', 'This session is not live on the desktop yet.'))
        );
        return;
      }
      if (session.archived) {
        conn.sendText(JSON.stringify(errorFrame('bad-request', 'This session is archived.')));
        return;
      }
      const items = queueOf(session.id);
      const index = items.findIndex((item) => item.id === frame.itemId);
      if (index === -1) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown queue item.')));
        return;
      }
      if (frame.action === 'edit') {
        const text = String(frame.text || '').trim();
        if (!text) {
          conn.sendText(JSON.stringify(errorFrame('bad-request', 'Empty queue text.')));
          return;
        }
        items[index].text = text;
      } else if (frame.action === 'remove') {
        items.splice(index, 1);
      } else if (frame.action === 'steer') {
        if (items[index].placement !== 'queued' || !session.running) {
          conn.sendText(
            JSON.stringify(errorFrame('bad-request', 'Only a queued item of a running turn can steer.'))
          );
          return;
        }
        items[index].placement = 'steering';
        broadcast({
          type: 'assistant.start',
          sessionId: session.id,
          turn: 1,
          step: 1
        });
        broadcast({
          type: 'assistant.delta',
          sessionId: session.id,
          text: 'Steered: ' + items[index].text,
          reasoning: null
        });
        broadcast({
          type: 'assistant.end',
          sessionId: session.id,
          turn: 1,
          step: 1
        });
        items.splice(index, 1);
      } else {
        conn.sendText(JSON.stringify(errorFrame('bad-request', 'Unknown queue action.')));
        return;
      }
      broadcastQueue(session.id);
      sendQueueFrame(conn, session.id);
      return;
    }

    case 'limits':
      conn.sendText(JSON.stringify({ type: 'limits', image: serverState.limits.image }));
      return;

    case 'context.get': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      conn.sendText(
        JSON.stringify({ type: 'context', sessionId: session.id, ...contextFor() })
      );
      return;
    }

    case 'changes.list': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      conn.sendText(
        JSON.stringify({
          type: 'changes',
          sessionId: session.id,
          items: changesFor()
        })
      );
      return;
    }

    case 'changes.diff': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const diff = diffFor(frame.seq, Number(frame.index));
      if (!diff) {
        conn.sendText(
          JSON.stringify(errorFrame('unavailable', 'Diff is no longer available.'))
        );
        return;
      }
      conn.sendText(
        JSON.stringify({
          type: 'changes.diff',
          sessionId: session.id,
          seq: frame.seq,
          index: Number(frame.index),
          ...diff
        })
      );
      return;
    }

    case 'commands.list': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const available = session.agentAvailable !== false && !session.archived;
      conn.sendText(
        JSON.stringify({
          type: 'commands',
          sessionId: session.id,
          available,
          items: available
            ? [
                {
                  name: 'compact',
                  description: 'Compact older conversation history',
                  hint: null,
                  attachments: false
                },
                {
                  name: 'feedback',
                  description: 'Record feedback about this session',
                  hint: '<text>',
                  attachments: false
                },
                {
                  name: 'goal',
                  description: 'Set or view the goal for a long-running task',
                  hint: '[<objective>|clear|edit <objective>|pause|resume]',
                  attachments: true
                },
                {
                  name: 'plan',
                  description: 'Enter or leave plan mode',
                  hint: '[off|message]',
                  attachments: true
                }
              ]
            : [],
          reason: available ? null : 'not-live'
        })
      );
      return;
    }

    case 'commands.execute': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      if (session.agentAvailable === false) {
        conn.sendText(
          JSON.stringify(errorFrame('not-live', 'This session is not live on the desktop yet.'))
        );
        return;
      }
      const line = String(frame.line || '').trim();
      const name = line.replace(/^\//, '').split(/\s+/)[0];
      if (!['compact', 'feedback', 'goal', 'plan'].includes(name)) {
        conn.sendText(
          JSON.stringify(errorFrame('forbidden', 'That command is not allowed from the phone.'))
        );
        return;
      }
      const results = {
        compact: 'Compacted 4 history items (~909 tokens).',
        feedback: 'Feedback recorded (mock).',
        goal: 'No goal is currently set.',
        plan: 'Plan mode on.'
      };
      appendHistory(session.id, {
        id: nextHistoryId('system'),
        kind: 'system',
        text: 'Command /' + name + ' completed (mock).',
        ts: Date.now()
      });
      broadcast({
        type: 'command.result',
        sessionId: session.id,
        commandId: 'cmd-' + randomBytes(3).toString('hex'),
        name,
        kind: 'success',
        text: results[name],
        sourceEventSeq: 42
      });
      return;
    }

    case 'prompt': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const attachments = Array.isArray(frame.attachments)
        ? frame.attachments
            .filter(
              (attachment) =>
                attachment && typeof attachment.name === 'string' && attachment.name
            )
            .slice(0, UPLOAD_FILE_LIMIT)
            .map((attachment) => ({
              name: String(attachment.name),
              size: Number(attachment.size) || 0,
              mediaType: attachment.mediaType
                ? String(attachment.mediaType)
                : 'application/octet-stream',
              path: attachment.path ? String(attachment.path) : '',
              relativePath: attachment.relativePath
                ? String(attachment.relativePath)
                : ''
            }))
        : [];
      const promptText = typeof frame.text === 'string' ? frame.text : '';
      if (!promptText.trim() && !attachments.length) {
        conn.sendText(JSON.stringify(errorFrame('bad-request', 'Empty prompt.')));
        return;
      }
      if (session.archived) {
        conn.sendText(
          JSON.stringify(errorFrame('bad-request', 'This session is archived.'))
        );
        return;
      }
      const mode = frame.mode === 'steer' ? 'steer' : 'queue';
      if (mode === 'steer') {
        if (!session.running) {
          conn.sendText(
            JSON.stringify(
              errorFrame('bad-request', 'The agent is not running; nothing to steer.')
            )
          );
          return;
        }
        queueOf(session.id).push({
          id: 'q-' + randomBytes(3).toString('hex'),
          placement: 'steering',
          rpcId: frame.requestId ? String(frame.requestId) : '',
          text: promptText
        });
        broadcastQueue(session.id);
        return;
      }
      if (runs.has(session.id) || session.running) {
        queueOf(session.id).push({
          id: 'q-' + randomBytes(3).toString('hex'),
          placement: 'queued',
          rpcId: frame.requestId ? String(frame.requestId) : '',
          text: promptText
        });
        broadcastQueue(session.id);
        return;
      }
      const historyItem = {
        id: nextHistoryId('user'),
        kind: 'user',
        text: promptText,
        ts: Date.now()
      };
      if (attachments.length) {
        historyItem.attachments = attachments.map((attachment) => ({
          name: attachment.name,
          size: attachment.size,
          mediaType: attachment.mediaType,
          path: attachment.path,
          relativePath: attachment.relativePath
        }));
      }
      appendHistory(session.id, historyItem);
      session.updatedAt = Date.now();
      broadcastSessions();
      if (/cross-session fixture|fixture test/i.test(promptText)) {
        emitCrossSessionFixtures(session.id);
        return;
      }
      runTurn(session.id, promptText, attachments);
      return;
    }

    case 'stop': {
      const runToken = runs.get(frame.sessionId);
      if (runToken) {
        runToken.cancelled = true;
        if (runToken.approval) runToken.approval.resolve('cancelled');
        if (runToken.question && !runToken.question.done) {
          runToken.question.resolve({ answers: [] });
        }
      }
      return;
    }

    case 'question.answer': {
      let question = frame.requestId
        ? pendingQuestions.get(frame.requestId)
        : null;
      if (!question && frame.callId) {
        for (const entry of pendingQuestions.values()) {
          if (entry.callId === frame.callId) {
            question = entry;
            break;
          }
        }
      }
      if (!question || question.done) {
        conn.sendText(
          JSON.stringify(
            errorFrame('not-found', 'Question is unknown or already resolved.')
          )
        );
        return;
      }
      question.done = true;
      question.resolve({
        answers: Array.isArray(frame.answers) ? frame.answers : []
      });
      return;
    }

    case 'approval.answer': {
      const approval = pendingApprovals.get(frame.requestId);
      if (!approval || approval.done) {
        conn.sendText(
          JSON.stringify(
            errorFrame('not-found', 'Approval is unknown or already resolved.')
          )
        );
        return;
      }
      approval.done = true;
      approval.resolve(frame.decision === 'allow' ? 'allow' : 'reject');
      return;
    }

    case 'model.list':
      conn.sendText(
        JSON.stringify({
          type: 'models',
          catalog: serverState.models.catalog,
          current: serverState.models.current
        })
      );
      return;

    case 'model.select': {
      const session = findSession(frame.sessionId);
      const entry = readProviderModel(frame.provider, frame.model);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      if (!entry) {
        conn.sendText(JSON.stringify(errorFrame('bad-request', 'Unknown model.')));
        return;
      }
      const requestedEffort =
        typeof frame.reasoningEffort === 'string' && frame.reasoningEffort
          ? frame.reasoningEffort
          : null;
      /* Reason about effort ids exactly like the Host: an id is only legal for a
         model that advertises it; absent/null means the provider default. */
      if (requestedEffort) {
        const efforts =
          entry.reasoning && Array.isArray(entry.reasoning.efforts)
            ? entry.reasoning.efforts
            : [];
        if (!efforts.some((effort) => effort && effort.id === requestedEffort)) {
          conn.sendText(
            JSON.stringify(errorFrame('bad-request', 'Unknown reasoning effort.'))
          );
          return;
        }
      }
      session.model = {
        provider: entry.provider,
        model: entry.model,
        reasoningEffort: requestedEffort
      };
      serverState.models.current = {
        provider: entry.provider,
        model: entry.model,
        reasoningEffort: requestedEffort
      };
      conn.sendText(
        JSON.stringify({
          type: 'models',
          catalog: serverState.models.catalog,
          current: serverState.models.current
        })
      );
      broadcastSessions();
      return;
    }

    case 'preset.list':
      conn.sendText(
        JSON.stringify({
          type: 'presets',
          presets: serverState.presets.presets,
          current: serverState.presets.current
        })
      );
      return;

    case 'preset.select': {
      const session = findSession(frame.sessionId);
      if (!session) {
        conn.sendText(JSON.stringify(errorFrame('not-found', 'Unknown session.')));
        return;
      }
      const entry = serverState.presets.presets.find(
        (preset) => preset.id === frame.preset
      );
      if (!entry) {
        conn.sendText(JSON.stringify(errorFrame('bad-request', 'Unknown preset.')));
        return;
      }
      session.preset = entry.id;
      serverState.presets.current = entry.id;
      conn.sendText(
        JSON.stringify({
          type: 'presets',
          presets: serverState.presets.presets,
          current: serverState.presets.current
        })
      );
      broadcastSessions();
      return;
    }

    case 'client.visibility': {
      const visible = frame.visible === true;
      if (conn.device) deviceVisibility.set(conn.device.id, visible);
      conn.sendText(JSON.stringify({ type: 'visibility', visible }));
      return;
    }

    case 'ping':
      conn.sendText(JSON.stringify({ type: 'pong', t: frame.t || 0 }));
      return;

    default:
      conn.sendText(
        JSON.stringify(
          errorFrame('bad-request', 'Unknown frame type: ' + frame.type)
        )
      );
  }
}

function clampLimit(value, max) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), max);
}

/* ---------- HTTP helpers ------------------------------------------------ */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header)
    .split(';')
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index < 0) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    });
  return out;
}

function deviceForRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const cookie = cookies[SESSION_COOKIE];
  if (!cookie) return null;
  return devices.find((device) => device.cookie === cookie) || null;
}

function readJsonBody(req, limit) {
  const max = limit || 64 * 1024;
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/* Raw body for the upload endpoint. Resolves null when the limit is exceeded
   so the handler can answer 413 without buffering an oversized payload. */
function readRawBody(req, max) {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(over ? null : Buffer.concat(chunks));
    });
    req.on('error', () => resolve(null));
  });
}

function safeUploadName(name) {
  let base = String(name || 'file')
    .split(/[\\/]/)
    .pop();
  base = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+$/, 'file')
    .trim();
  if (!base) base = 'file';
  return base.slice(0, 160);
}

function mintDevice(req) {
  const ua = String(req.headers['user-agent'] || '');
  let name = 'Demo phone';
  if (/iPhone/i.test(ua)) name = 'iPhone · Safari';
  else if (/Android/i.test(ua)) name = 'Android · Chrome';
  else if (/iPad/i.test(ua)) name = 'iPad · Safari';
  const device = {
    id: 'dev-' + randomBytes(4).toString('hex'),
    name,
    createdAt: Date.now(),
    cookie: randomBytes(24).toString('base64url')
  };
  devices.push(device);
  if (devices.length > 8) {
    const dropped = devices.shift();
    for (const client of [...clients]) {
      if (client.device && client.device.id === dropped.id) client.close(4401, 'revoked');
    }
  }
  return device;
}

function sessionCookie(device, secure) {
  const parts = [
    SESSION_COOKIE + '=' + encodeURIComponent(device.cookie),
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=86400'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function recentFailures(ip) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const list = (rateLimit.get(ip) || []).filter((ts) => ts > cutoff);
  rateLimit.set(ip, list);
  return list;
}

function rateLimitedResponse(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const failures = recentFailures(ip);
  if (failures.length < RATE_MAX) return false;
  const retryAfterMs = Math.max(
    1000,
    RATE_WINDOW_MS - (Date.now() - failures[0])
  );
  sendJson(res, 429, { error: 'rate-limited', retryAfterMs });
  return true;
}

function noteFailure(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const list = recentFailures(ip);
  list.push(Date.now());
  rateLimit.set(ip, list);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

/* ---------- Static + API ------------------------------------------------ */

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const name = STATIC_FILES[url.pathname];
  if (!name) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end('Not found');
    return;
  }
  try {
    const body = await readFile(join(HERE, name));
    const headers = {
      'Content-Type': MIME[extname(name)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    };
    if (name === 'sw.js') {
      /* The service worker is served from the root so its scope is "/";
         never let the HTTP cache pin an old worker. */
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache';
    }
    if (name.endsWith('.html')) {
      headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end('Could not read ' + name + ': ' + err.message);
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (path === '/health') {
    sendJson(res, 200, { ok: true, version: VERSION });
    return;
  }

  if (path === '/api/state' && req.method === 'GET') {
    const device = deviceForRequest(req);
    sendJson(res, 200, {
      paired: !!device,
      device: device
        ? { id: device.id, name: device.name, createdAt: device.createdAt }
        : null,
      version: VERSION
    });
    return;
  }

  if (path === '/api/push/key' && req.method === 'GET') {
    /* Unauthenticated by design: the VAPID public key is public. */
    sendJson(res, 200, { enabled: true, publicKey: PUSH_PUBLIC_KEY });
    return;
  }

  if (path.startsWith('/api/push/') && req.method === 'POST') {
    const device = deviceForRequest(req);
    if (!device) {
      req.resume();
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const body = await readJsonBody(req);
    if (path === '/api/push/subscribe') {
      const subscription =
        body && body.subscription && typeof body.subscription === 'object'
          ? body.subscription
          : null;
      const endpoint =
        subscription && typeof subscription.endpoint === 'string'
          ? subscription.endpoint
          : '';
      const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(endpoint);
      if (!endpoint || (!/^https:\/\//.test(endpoint) && !loopback)) {
        sendJson(res, 400, { error: 'invalid-subscription' });
        return;
      }
      pushSubscriptions.set(endpoint, {
        endpoint,
        deviceId: device.id,
        subscription
      });
      log('push subscription stored for', device.name);
      sendJson(res, 200, { ok: true, deviceId: device.id });
      return;
    }
    if (path === '/api/push/unsubscribe') {
      const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : '';
      if (!endpoint) {
        sendJson(res, 400, { error: 'bad-request' });
        return;
      }
      const entry = pushSubscriptions.get(endpoint);
      if (entry && entry.deviceId === device.id) pushSubscriptions.delete(endpoint);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/api/push/report') {
      /* Service-worker/SPA diagnostics are a bounded no-op in the mock. */
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/api/push/test') {
      let stored = 0;
      for (const entry of pushSubscriptions.values()) {
        if (entry.deviceId === device.id) stored += 1;
      }
      /* The mock cannot reach a real push service; report one accepted test
         notification so the client's success path is exercisable. */
      sendJson(res, 200, { ok: true, sent: stored || 1, gone: 0 });
      return;
    }
    sendJson(res, 404, { error: 'not-found' });
    return;
  }

  /* Web Share Target: the manifest points Android's share sheet here; we
     bounce back into the SPA with the payload in the query string. */
  if (path === '/share-target' && req.method === 'GET') {
    const payload = encodeURIComponent(JSON.stringify({
      title: (url.searchParams.get('title') || '').slice(0, 200),
      text: (url.searchParams.get('text') || '').slice(0, 4000),
      url: (url.searchParams.get('url') || '').slice(0, 2000)
    }));
    res.writeHead(302, {
      Location: '/?share=' + payload,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    });
    res.end();
    return;
  }

  if (path === '/api/upload' && req.method === 'POST') {
    const device = deviceForRequest(req);
    if (!device) {
      req.resume();
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const sessionId = String(req.headers['x-dsh-session'] || '').trim();
    const filename = safeUploadName(req.headers['x-dsh-filename']);
    let mediaType = String(req.headers['x-dsh-media-type'] || '')
      .replace(/[\r\n]+/g, '')
      .trim();
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) {
      mediaType = 'application/octet-stream';
    }
    const session = sessionId ? findSession(sessionId) : null;
    if (!sessionId || !session) {
      req.resume();
      sendJson(res, sessionId ? 404 : 400, {
        ok: false,
        error: sessionId ? 'unknown-session' : 'missing-session'
      });
      return;
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD_BYTES) {
      req.resume();
      sendJson(res, 413, { ok: false, error: 'too-large' });
      return;
    }
    const body = await readRawBody(req, MAX_UPLOAD_BYTES);
    if (body === null) {
      sendJson(res, 413, { ok: false, error: 'too-large' });
      return;
    }
    if (!body.length) {
      sendJson(res, 400, { ok: false, error: 'empty-file' });
      return;
    }
    if (UPLOAD_DELAY_MS > 0) await sleep(UPLOAD_DELAY_MS);
    const stored = Date.now().toString(36) + '-' + filename;
    const relativePath = '.mock-uploads/' + device.id + '/' + stored;
    const absolutePath = 'C:\\mock-uploads\\' + device.id + '\\' + stored;
    uploadedFiles.set(absolutePath, {
      bytes: body,
      sessionId,
      mediaType,
      name: filename
    });
    if (uploadedFiles.size > 64) {
      uploadedFiles.delete(uploadedFiles.keys().next().value);
    }
    log('upload', filename, body.length + ' bytes', 'session', sessionId);
    sendJson(res, 200, {
      ok: true,
      name: filename,
      path: absolutePath,
      relativePath,
      size: body.length,
      mediaType
    });
    return;
  }

  if (path === '/api/preview' && req.method === 'GET') {
    const device = deviceForRequest(req);
    if (!device) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const sessionId = String(url.searchParams.get('session') || '');
    const filePath = String(url.searchParams.get('path') || '');
    if (!sessionId || !filePath) {
      sendJson(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    const file = uploadedFiles.get(filePath);
    if (!file || file.sessionId !== sessionId) {
      sendJson(res, 404, { ok: false, error: 'not-found' });
      return;
    }
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.mediaType)) {
      sendJson(res, 415, { ok: false, error: 'unsupported-media' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.mediaType,
      'Content-Length': file.bytes.length,
      'Cache-Control': 'no-store'
    });
    res.end(file.bytes);
    return;
  }

  if (path === '/api/pair' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const secure = !!req.socket.encrypted;

    if (typeof body.token === 'string' && body.token) {
      if (pairingTokenConsumed || body.token !== PAIRING_TOKEN) {
        sendJson(res, 401, { error: 'invalid-token' });
        return;
      }
      pairingTokenConsumed = true;
      const device = mintDevice(req);
      log('paired via token as', device.name);
      sendJson(
        res,
        200,
        {
          paired: true,
          device: { id: device.id, name: device.name, createdAt: device.createdAt, canApprove: !APPROVALS_READONLY }
        },
        { 'Set-Cookie': sessionCookie(device, secure) }
      );
      return;
    }

    if (rateLimitedResponse(req, res)) return;

    const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    if (!pin) {
      sendJson(res, 400, { error: 'bad-request' });
      return;
    }
    if (pin !== currentPin) {
      noteFailure(req);
      sendJson(res, 401, { error: 'invalid-pin' });
      return;
    }

    const device = mintDevice(req);
    log('paired via PIN as', device.name);
    sendJson(
      res,
      200,
      {
        paired: true,
        device: { id: device.id, name: device.name, createdAt: device.createdAt, canApprove: !APPROVALS_READONLY }
      },
      { 'Set-Cookie': sessionCookie(device, secure) }
    );
    if (process.env.RM_KEEP_PIN !== '1') {
      currentPin = randomPin();
      log('new PIN:', currentPin);
    }
    return;
  }

  if (path === '/api/rotate-pin' && req.method === 'POST') {
    const device = deviceForRequest(req);
    if (!device) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    currentPin = randomPin();
    log('rotated PIN:', currentPin);
    sendJson(res, 200, { pin: currentPin, pinExpiresAt: Date.now() + 300000 });
    return;
  }

  if (path === '/api/unpair' && req.method === 'POST') {
    const device = deviceForRequest(req);
    if (!device) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const index = devices.indexOf(device);
    if (index >= 0) devices.splice(index, 1);
    deviceVisibility.delete(device.id);
    for (const [endpoint, entry] of pushSubscriptions) {
      if (entry.deviceId === device.id) pushSubscriptions.delete(endpoint);
    }
    for (const client of [...clients]) {
      if (client.device && client.device.id === device.id) {
        client.close(1000, 'unpaired');
      }
    }
    log('unpaired', device.name);
    sendJson(
      res,
      200,
      { ok: true },
      {
        'Set-Cookie':
          SESSION_COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      }
    );
    return;
  }

  if (path.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
}

/* ---------- Server ------------------------------------------------------ */

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log('request error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal', message: 'Mock server error.' });
    } else {
      try {
        res.end();
      } catch (nextErr) {
        /* ignore */
      }
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  let path = '/';
  try {
    path = new URL(req.url, 'http://localhost').pathname;
  } catch (err) {
    path = '/';
  }
  if (path !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      accept +
      '\r\n\r\n'
  );

  const device = deviceForRequest(req);
  const conn = new WsConnection(socket, head, device);

  if (!device) {
    conn.close(4401, 'unauthorized');
    return;
  }

  clients.add(conn);
  conn.sendText(
    JSON.stringify({
      type: 'ready',
      version: VERSION,
      device: {
        id: device.id,
        name: device.name,
        canApprove: !APPROVALS_READONLY
      },
      sessions: publicSessions(),
      workspaces: WORKSPACES,
      activeSessionId: serverState.activeSessionId,
      queue: [],
      limits: serverState.limits
    })
  );
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[mock] Port ' + PORT + ' is already in use.');
  } else {
    console.error('[mock] Server error:', err);
  }
  process.exit(1);
});

function lanAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log('');
  console.log('  DSH Remote — mock server (DEV ONLY)');
  console.log('  -----------------------------------');
  console.log('  Local:    http://localhost:' + PORT + '/');
  if (lan) console.log('  Network:  http://' + lan + ':' + PORT + '/');
  console.log('  PIN:      ' + currentPin + '   (rotates after a successful PIN pair)');
  console.log(
    '  One-tap:  http://localhost:' + PORT + '/?t=' + PAIRING_TOKEN
  );
  if (lan) {
    console.log('            http://' + lan + ':' + PORT + '/?t=' + PAIRING_TOKEN);
  }
  console.log('');
  console.log('  Type "deploy" in a prompt to trigger the approval card.');
  console.log('  Rate limit wire-compatible; set RM_RATE_WINDOW_MS=20000 for demos.');
  console.log('');
});

function shutdown() {
  log('shutting down');
  for (const client of [...clients]) client.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
