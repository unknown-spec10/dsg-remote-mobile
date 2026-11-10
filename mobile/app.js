/* ==========================================================================
   DSH Remote — mobile SPA
   Vanilla JS, zero dependencies, no build step.

   Security note: this file never assigns untrusted text with innerHTML.
   Markdown and syntax highlighting are rendered by building DOM nodes and
   writing every server/model string through textContent, so escaping is
   structural rather than string-based. Links are protocol-checked.
   ========================================================================== */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var FALLBACK_VERSION = '0.0.5';
  var LS_ACTIVE = 'dshrm.activeSession.v1';
  var PIN_LENGTH = 4;
  var MAX_TOOL_OUTPUT = 120000;
  var MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
  var MAX_ATTACHMENTS = 10;

  /* Resilience tuning. The Host answers every ping; the pong watchdog only
     recovers a socket that has gone silent while the page is visible. Mobile
     OSes freeze a backgrounded page and frequently drop its socket, so resume
     recovery is deliberately immediate rather than waiting for the backoff. */
  var PING_INTERVAL_MS = 5000;
  var PONG_TIMEOUT_MS = 15000;
  var WATCHDOG_INTERVAL_MS = 5000;
  var RESUME_PONG_AGE_MS = 10000;
  var RESUME_TOAST_GAP_MS = 2000;

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    reduceMotion = false;
  }

  /* ---------- Tiny DOM helpers ------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      if (props.class) node.className = props.class;
      if (props.text !== undefined && props.text !== null) {
        node.textContent = String(props.text);
      }
      if (props.attrs) {
        for (var key in props.attrs) {
          if (!Object.prototype.hasOwnProperty.call(props.attrs, key)) continue;
          var value = props.attrs[key];
          if (value === null || value === undefined || value === false) continue;
          node.setAttribute(key, value === true ? '' : String(value));
        }
      }
      if (props.dataset) {
        for (var dkey in props.dataset) {
          if (Object.prototype.hasOwnProperty.call(props.dataset, dkey)) {
            node.dataset[dkey] = props.dataset[dkey];
          }
        }
      }
      if (props.on) {
        for (var evt in props.on) {
          if (Object.prototype.hasOwnProperty.call(props.on, evt)) {
            node.addEventListener(evt, props.on[evt]);
          }
        }
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(
        typeof child === 'string' ? document.createTextNode(child) : child
      );
    }
    return node;
  }

  function icon(name, extraClass) {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'icon' + (extraClass ? ' ' + extraClass : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function logoSvg() {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'logo-glyph');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', '#i-mark');
    svg.appendChild(use);
    return svg;
  }

  function preNode(text, cls) {
    var node = document.createElement('pre');
    if (cls) node.className = cls;
    node.textContent = text === null || text === undefined ? '' : String(text);
    return node;
  }

  var store = {
    get: function (key) {
      try {
        return window.localStorage.getItem(key) || '';
      } catch (err) {
        return '';
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (err) {
        /* private mode */
      }
    },
    del: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (err) {
        /* ignore */
      }
    }
  };

  /* Recently used working directories for "New session". Stored locally on the
     phone; the Host validates the path when the session is created. */
  var LS_CWDS = 'dsh-remote-cwds';

  function recentCwds() {
    try {
      var parsed = JSON.parse(store.get(LS_CWDS) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(function (entry) {
          return typeof entry === 'string' && entry.length > 0;
        })
        .slice(0, 5);
    } catch (err) {
      return [];
    }
  }

  function rememberCwd(dir) {
    var value = String(dir || '').trim();
    if (!value) return;
    var list = recentCwds().filter(function (entry) {
      return entry !== value;
    });
    list.unshift(value);
    store.set(LS_CWDS, JSON.stringify(list.slice(0, 5)));
  }

  /* ---------- Theme ------------------------------------------------------- */

  var LS_THEME = 'dsh-remote-theme';
  var THEME_COLORS = { light: '#F7F5F2', dark: '#161616' };
  var themeMedia = null;
  try {
    themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  } catch (err) {
    themeMedia = null;
  }

  function themePref() {
    var value = store.get(LS_THEME);
    return value === 'light' || value === 'dark' ? value : 'auto';
  }

  function applyTheme(pref) {
    var p = pref === 'light' || pref === 'dark' ? pref : 'auto';
    var theme = p === 'auto' ? (themeMedia && themeMedia.matches ? 'dark' : 'light') : p;
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-pref', p);
    /* index.html carries one media-scoped theme-color meta per scheme; keep
       both in sync with the effective (possibly manually chosen) theme. */
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) {
      metas[i].setAttribute('content', THEME_COLORS[theme]);
    }
    return theme;
  }

  function setTheme(pref) {
    var p = pref === 'light' || pref === 'dark' ? pref : 'auto';
    applyTheme(p);
    store.set(LS_THEME, p);
    haptic(8);
    if (S.sheet === 'menu') buildSheet();
    toast('Theme: ' + (p === 'auto' ? 'Auto' : p === 'light' ? 'Light' : 'Dark'));
  }

  function onThemeMediaChange() {
    if (themePref() !== 'auto') return;
    applyTheme('auto');
    if (S.sheet === 'menu') buildSheet();
  }

  function themeSegmented() {
    var current = themePref();
    var group = el('div', {
      class: 'segmented theme-seg',
      attrs: { role: 'group', 'aria-label': 'Theme' }
    });
    [
      ['auto', 'Auto'],
      ['light', 'Light'],
      ['dark', 'Dark']
    ].forEach(function (pair) {
      var active = current === pair[0];
      var button = el('button', {
        class: 'seg-btn' + (active ? ' is-active' : ''),
        attrs: {
          type: 'button',
          'data-theme-choice': pair[0],
          'aria-pressed': String(active)
        },
        text: pair[1]
      });
      button.addEventListener('click', function () {
        setTheme(pair[0]);
      });
      group.appendChild(button);
    });
    return group;
  }

  function haptic(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (err) {
      /* vibration unsupported */
    }
  }

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (err) {
      /* fall through */
    }
    return (
      'req-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }

  /* ---------- Formatting helpers ----------------------------------------- */

  function timeAgo(ts) {
    var t = Number(ts) || 0;
    if (!t) return 'just now';
    var diff = Date.now() - t;
    if (diff < 45000) return 'just now';
    var min = Math.round(diff / 60000);
    if (min < 60) return min + 'm ago';
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h ago';
    var day = Math.round(hr / 24);
    if (day < 7) return day + 'd ago';
    try {
      return new Date(t).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric'
      });
    } catch (err) {
      return '';
    }
  }

  function fmtClock(ts) {
    var d = new Date(Number(ts) || Date.now());
    try {
      return d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (err) {
      return '';
    }
  }

  function fmtMsgTime(ts) {
    var t = Number(ts) || 0;
    if (!t) return '';
    try {
      return new Date(t).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return '';
    }
  }

  function isoTime(ts) {
    var t = Number(ts) || 0;
    if (!t) return '';
    try {
      return new Date(t).toISOString();
    } catch (err) {
      return '';
    }
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    var mins = Math.floor(ms / 60000);
    var secs = Math.round((ms % 60000) / 1000);
    return mins + 'm ' + secs + 's';
  }

  function formatElapsed(ms) {
    if (!ms || ms < 1000) return '0s';
    var secs = Math.floor(ms / 1000);
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ' + (secs % 60) + 's';
    var hrs = Math.floor(mins / 60);
    return hrs + 'h ' + (mins % 60) + 'm';
  }

  function formatCountdown(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
  }

  function formatDetail(detail) {
    if (detail === null || detail === undefined || detail === '') return '';
    if (typeof detail === 'string') return detail;
    try {
      return JSON.stringify(detail, null, 2);
    } catch (err) {
      return String(detail);
    }
  }

  /* Device metadata is additive: canApprove defaults true for older Hosts. */
  function normalizeDevice(device) {
    if (!device || typeof device !== 'object') return null;
    return {
      id: device.id ? String(device.id) : '',
      name: device.name ? String(device.name) : '',
      createdAt: Number(device.createdAt) || 0,
      canApprove: device.canApprove !== false
    };
  }

  function deviceCanApprove() {
    return !S.device || S.device.canApprove !== false;
  }

  /* ---------- State ------------------------------------------------------- */

  var S = {
    phase: 'boot', // boot | pairing | app
    version: '',
    device: null,
    paired: false,

    conn: 'idle', // idle | connecting | online | reconnecting | offline
    reconnectAttempt: 0,
    ready: false,

    sessions: [],
    activeSessionId: null,
    session: null,
    pendingOpen: null,
    openTimer: null,
    userChoseSession: false,
    creatingSession: false,
    createTimer: null,
    cwdDraft: '',
    cwdRecents: [],
    sessionQuery: '',
    actionItem: null,

    /* Project workspaces (owning registry) and the archived-session toggle. */
    workspaces: [],
    showArchived: false,
    projectCollapsed: null,

    /* Batch C: prompt queue/steer, image limits, grouped sessions/search. */
    promptMode: 'queue',
    queue: {
      sessionId: null,
      items: [],
      pendingInput: [],
      running: false,
      active: false,
      expanded: false
    },
    imageLimits: null,
    search: {
      timer: null,
      inFlight: false,
      unavailable: false,
      showedToast: false,
      query: '',
      activeQuery: '',
      results: [],
      hasMore: false
    },
    archivedExpanded: false,
    renameDraft: '',
    confirmArchive: false,
    confirmArchiveTimer: null,
    confirmFork: false,
    confirmForkTimer: null,
    queueAction: null,
    queueRemoveConfirm: false,
    pendingSteer: null,
    steerTimer: null,

    /* Batch C3: context meter, changed-files review, command palette. */
    context: null,
    changes: { sessionId: null, items: [], loading: false },
    pendingDiff: null,
    commands: { sessionId: null, available: false, items: [], reason: '', loading: false },
    commandsLoadTimer: null,
    commandConfirmName: '',
    commandPending: '',
    commandDraft: '',
    commandInputItem: null,

    messages: [],
    live: null,
    typing: false,
    activeTools: new Set(),
    approvals: new Map(),
    questions: new Map(),
    uploads: [],
    uploadPump: false,
    pendingPromptCount: 0,

    view: 'chat',
    pinned: true,
    unreadBelow: false,
    unseenActivity: 0,
    activity: [],
    activityFilter: 'all',
    activityOpen: new Set(),
    activityPinned: true,

    models: null,
    modelsLoading: false,
    modelLoadTimer: null,
    /* Model whose reasoning-effort sheet is open; scoped to the session it was
       opened from so a session switch can never apply a stale choice. */
    reasoningTarget: null,
    presets: null,

    /* Web Push + resume recovery. The service worker owns delivery; this page
       owns the subscription lifecycle and reports foreground visibility. */
    push: {
      capability: 'unsupported',
      permission: 'default',
      subscribed: false,
      endpoint: '',
      busy: false,
      testing: false,
      lastError: ''
    },
    sessionLink: null,
    sessionLinkTimer: null,
    hiddenAt: 0,
    resumeToastPending: false,
    presetsLoading: false,
    presetLoadTimer: null,

    sheet: null,
    sheetOpener: null,
    sheetHideTimer: null,
    confirmUnpair: false,
    confirmUnpairTimer: null,

    pin: '',
    pinBusy: false,
    pinError: false,
    rateLimitedUntil: 0,
    pairToken: null,
    rateTimer: null,

    runningSince: 0,
    stopPending: false,

    runSeq: 0,
    shareDraft: '',
    attention: false
  };

  /* Voice input. SpeechRecognition is optional and feature-detected; the mic
     button stays hidden when the API or the microphone is unavailable. */
  var voice = {
    supported: false,
    recognizer: null,
    active: false,
    stopping: false,
    error: false,
    base: '',
    finalText: '',
    interim: '',
    restarts: 0,
    restartTimer: null
  };

  /* System notifications: dedupe one alert per requestId / per turn. */
  var notifiedKeys = {};
  var ATTENTION_TITLE = 'DSH Remote';

  /* Service worker registration state: reload at most once on controllerchange. */
  var swHadController = false;
  var swReloading = false;

  /* Batch E2: client-side WebAuthn app lock (privacy gate, not server auth). */
  var LS_APP_LOCK = 'dsh-remote-applock.v1';
  var LOCK_GRACE_MS = 5 * 60 * 1000;
  var LOCK_HIDDEN_MS = 30 * 1000;
  var appLock = {
    enabled: false,
    credentialId: '',
    deviceId: '',
    enabledAt: 0,
    unlockedAt: 0,
    locked: false,
    sessionVerified: false,
    hiddenAt: 0,
    busy: false,
    coldStartChecked: false
  };

  var refs = {};

  function cacheRefs() {
    var ids = [
      'boot',
      'boot-sub',
      'pairing',
      'pair-status',
      'pair-status-spin',
      'pair-status-text',
      'pair-status-action',
      'pair-form',
      'pin-slots',
      'pin-input',
      'pair-error',
      'pair-submit',
      'pair-version',
      'app',
      'btn-sessions',
      'btn-new',
      'btn-menu',
      'session-title',
      'session-state',
      'status-dot',
      'tab-chat',
      'tab-activity',
      'tab-badge',
      'banner',
      'banner-text',
      'banner-action',
      'view-chat',
      'view-activity',
      'chat-scroll',
      'messages',
      'jump',
      'jump-label',
      'activity-filter',
      'activity-scroll',
      'activity-list',
      'activity-live',
      'composer-input',
      'btn-stop',
      'btn-mic',
      'btn-send',
      'composer-note',
      'composer-model',
      'context-meter',
      'context-label',
      'context-fill',
      'context-est',
      'changes-panel',
      'app-lock',
      'app-lock-unlock',
      'app-lock-error',
      'prompt-mode',
      'queue-strip',
      'archived-banner',
      'btn-unarchive',
      'composer',
      'scrim',
      'sheet',
      'sheet-grab',
      'sheet-title',
      'sheet-sub',
      'sheet-close',
      'sheet-body',
      'sheet-foot',
      'toast'
    ];
    refs = {};
    ids.forEach(function (id) {
      var key = id.replace(/-([a-z])/g, function (m, c) {
        return c.toUpperCase();
      });
      refs[key] = document.getElementById(id);
    });
    refs.bannerIconUse = null;
    var bannerSvg = refs.banner ? refs.banner.querySelector('use') : null;
    refs.bannerIconUse = bannerSvg;
  }

  /* ---------- WebSocket lifecycle ---------------------------------------- */

  var ws = null;
  var reconnectTimer = null;
  var pingTimer = null;
  var watchdogTimer = null;
  var connectStartedAt = 0;
  var lastPong = 0;

  function connect() {
    if (S.phase !== 'app') return;
    teardownSocket();
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    setConn(S.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    var socket;
    try {
      var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(proto + '//' + window.location.host + '/ws');
    } catch (err) {
      scheduleReconnect();
      return;
    }
    ws = socket;
    connectStartedAt = Date.now();

    socket.addEventListener('open', function () {
      if (ws !== socket) return;
      onSocketOpen();
    });
    socket.addEventListener('message', function (event) {
      if (ws !== socket) return;
      handleSocketData(event.data);
    });
    socket.addEventListener('close', function (event) {
      if (ws !== socket) return;
      ws = null;
      onSocketClose(event);
    });
    socket.addEventListener('error', function () {
      /* the close event carries the actionable information */
    });
  }

  function teardownSocket() {
    stopPing();
    if (ws) {
      var old = ws;
      ws = null;
      try {
        old.close();
      } catch (err) {
        /* ignore */
      }
    }
  }

  function onSocketOpen() {
    S.reconnectAttempt = 0;
    S.ready = false;
    lastPong = Date.now();
    setConn('online');
    startPing();
    /* Tell the Host this page is foregrounded as early as possible: it gates
       Web Push on this flag (unknown counts as backgrounded). */
    sendVisibility(!document.hidden);
    resync();
  }

  function resync() {
    sendFrame({ type: 'sessions.list' });
    if (S.activeSessionId) {
      sendFrame({
        type: 'history.load',
        sessionId: S.activeSessionId,
        limit: 50
      });
      sendFrame({ type: 'context.get', sessionId: S.activeSessionId });
      sendFrame({
        type: 'changes.list',
        sessionId: S.activeSessionId,
        limit: 10
      });
    }
    if (S.models) sendFrame({ type: 'model.list' });
    if (S.presets) sendFrame({ type: 'preset.list' });
  }

  function onSocketClose(event) {
    stopPing();
    if (S.phase !== 'app') return;
    if (event && event.code === 4401) {
      handleAuthLost();
      return;
    }
    scheduleReconnect();
  }

  /**
   * The app is installed behind a service worker; a stale cached shell can leave
   * the page running old JS or an old CSP while HTTP still works. After several
   * failed WebSocket opens (and never having been ready), drop the registrations
   * and caches once and reload. The session flag prevents a reload loop.
   */
  function resetStaleServiceWorker() {
    try {
      var FLAG = 'dsh-remote-sw-reset.v1';
      if (window.sessionStorage && sessionStorage.getItem(FLAG)) return false;
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return false;
      if (window.sessionStorage) sessionStorage.setItem(FLAG, '1');
      var jobs = [
        navigator.serviceWorker.getRegistrations()
          .then(function (list) {
            return Promise.all(list.map(function (registration) { return registration.unregister(); }));
          })
          .catch(function () {}),
      ];
      if (window.caches && caches.keys) {
        jobs.push(
          caches.keys()
            .then(function (keys) {
              return Promise.all(keys.map(function (key) { return caches.delete(key); }));
            })
            .catch(function () {})
        );
      }
      Promise.all(jobs)
        .catch(function () {})
        .then(function () {
          setTimeout(function () {
            try {
              window.location.reload();
            } catch (err) {
              /* ignore */
            }
          }, 250);
        });
      return true;
    } catch (err) {
      return false;
    }
  }

  function scheduleReconnect() {
    if (S.phase !== 'app') return;
    S.reconnectAttempt = Math.min(S.reconnectAttempt + 1, 12);
    if (S.reconnectAttempt >= 4 && !S.ready && resetStaleServiceWorker()) return;
    if (!navigator.onLine) setConn('offline');
    else setConn('reconnecting');

    var base = Math.min(8000, 500 * Math.pow(2, Math.max(0, S.reconnectAttempt - 1)));
    var delay = Math.round(base * (0.85 + Math.random() * 0.3));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function forceReconnect() {
    if (S.phase !== 'app') return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    S.reconnectAttempt = 0;
    teardownSocket();
    connect();
  }

  function startPing() {
    stopPing();
    lastPong = Date.now();
    pingTimer = setInterval(function () {
      if (!ws || ws.readyState !== 1) return;
      sendFrame({ type: 'ping', t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  /**
   * The pong watchdog only runs while the app is in the foreground. A frozen
   * phone page stops its timers, so this is not an attempt to keep the page
   * alive: it detects a silently dead socket on the visible page and forces an
   * immediate reconnect instead of waiting through the exponential backoff.
   */
  function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function watchdogTick() {
    if (S.phase !== 'app' || document.hidden) return;
    var missingSocket = !ws || ws.readyState !== 1;
    /* Do not tear down a handshake that only just started: a slow mobile
       network gets one watchdog period to finish opening. */
    if (
      ws &&
      ws.readyState === 0 &&
      connectStartedAt &&
      Date.now() - connectStartedAt < WATCHDOG_INTERVAL_MS
    ) {
      return;
    }
    var stalePong = Date.now() - lastPong > PONG_TIMEOUT_MS;
    if (!missingSocket && !stalePong) return;
    reconnectNow();
  }

  function reconnectNow() {
    if (S.phase !== 'app') return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    S.reconnectAttempt = 0;
    teardownSocket();
    connect();
  }

  function sendVisibility(visible) {
    if (S.phase !== 'app') return false;
    if (!ws || ws.readyState !== 1) return false;
    return sendFrame({ type: 'client.visibility', visible: visible === true });
  }

  /**
   * Called when the page becomes visible again. A frozen page usually comes
   * back with a dead socket and a stale pong; reconnect immediately rather than
   * waiting for the next backoff tick, and surface one quiet toast when the gap
   * was long enough to notice.
   */
  function resumeFromBackground() {
    if (S.phase !== 'app') return;
    var now = Date.now();
    var gap = S.hiddenAt ? now - S.hiddenAt : 0;
    S.hiddenAt = 0;
    var missingSocket = !ws || ws.readyState !== 1;
    var stalePong = now - lastPong > RESUME_PONG_AGE_MS;
    if (missingSocket || stalePong) {
      S.resumeToastPending = gap > RESUME_TOAST_GAP_MS;
      reconnectNow();
    }
    sendVisibility(true);
  }

  function sendFrame(frame) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(frame));
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  }

  function handleSocketData(data) {
    var frame;
    try {
      frame = JSON.parse(String(data));
    } catch (err) {
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return;
    handleFrame(frame);
  }

  function handleFrame(frame) {
    /* Any frame proves the socket is alive, not just a pong: approvals,
       sessions and stream deltas all reset the watchdog. */
    lastPong = Date.now();
    switch (frame.type) {
      case 'ready':
        onReady(frame);
        break;
      case 'sessions':
        onSessions(frame);
        break;
      case 'session.opened':
        onSessionOpened(frame);
        break;
      case 'history':
        onHistory(frame);
        break;
      case 'assistant.start':
        onAssistantStart(frame);
        break;
      case 'assistant.delta':
        onAssistantDelta(frame);
        break;
      case 'assistant.end':
        onAssistantEnd(frame);
        break;
      case 'tool.start':
        onToolStart(frame);
        break;
      case 'tool.end':
        onToolEnd(frame);
        break;
      case 'approval.request':
        onApprovalRequest(frame);
        break;
      case 'approval.resolved':
        onApprovalResolved(frame);
        break;
      case 'question.request':
        onQuestionRequest(frame);
        break;
      case 'question.resolved':
        onQuestionResolved(frame);
        break;
      case 'session.status':
        onSessionStatus(frame);
        break;
      case 'session.updated':
        onSessionUpdated(frame);
        break;
      case 'sessions.found':
        onSessionsFound(frame);
        break;
      case 'session.pinned':
        onSessionPinned(frame);
        break;
      case 'session.archived':
        onSessionArchived(frame);
        break;
      case 'queue':
        onQueueFrame(frame);
        break;
      case 'queue.changed':
        onQueueChanged(frame);
        break;
      case 'limits':
        onLimits(frame);
        break;
      case 'context':
        onContext(frame);
        break;
      case 'changes':
        onChanges(frame);
        break;
      case 'changes.diff':
        onChangesDiff(frame);
        break;
      case 'commands':
        onCommands(frame);
        break;
      case 'command.result':
        onCommandResult(frame);
        break;
      case 'models':
        onModels(frame);
        break;
      case 'presets':
        onPresets(frame);
        break;
      case 'pong':
        lastPong = Date.now();
        break;
      case 'error':
        onServerError(frame);
        break;
      default:
        break;
    }
  }

  /* ---------- Connection state / banner ---------------------------------- */

  function setConn(state) {
    S.conn = state;
    if (state !== 'online') stopVoice({ quiet: true, commit: true });
    renderBanner();
    renderHeaderState();
    renderComposerMeta();
    updateSendState();
  }

  function renderBanner() {
    if (S.phase !== 'app') {
      refs.banner.hidden = true;
      return;
    }
    if (S.conn === 'online') {
      refs.banner.hidden = true;
      return;
    }
    refs.banner.hidden = false;
    refs.banner.classList.toggle('is-offline', S.conn === 'offline');
    if (refs.bannerIconUse) {
      refs.bannerIconUse.setAttribute(
        'href',
        S.conn === 'offline' ? '#i-wifi-off' : '#i-refresh'
      );
    }
    refs.bannerText.textContent =
      S.conn === 'offline'
        ? 'Offline — check your Wi-Fi or network.'
        : S.conn === 'connecting'
          ? 'Connecting to DeepSeek Harness…'
          : 'Reconnecting… attempt ' + Math.max(1, S.reconnectAttempt);
    refs.bannerAction.textContent = S.conn === 'offline' ? 'Retry' : 'Retry now';
  }

  /* ---------- Boot -------------------------------------------------------- */

  function init() {
    applyTheme(themePref());
    if (themeMedia) {
      if (themeMedia.addEventListener) {
        themeMedia.addEventListener('change', onThemeMediaChange);
      } else if (themeMedia.addListener) {
        themeMedia.addListener(onThemeMediaChange);
      }
    }
    cacheRefs();
    readShareParams();
    S.sessionLink = readSessionLink();
    buildAttachmentUI();
    buildLightbox();
    setupVoice();
    registerServiceWorker();
    syncViewportHeight();
    bindPairingUI();
    bindApp();
    bindSheetUI();
    bindScroll();
    bindMessageActions();
    updatePinSlots();
    updateActivityBadge();
    setInterval(function () {
      if (S.phase === 'app' && S.session && S.session.running) renderHeaderState();
    }, 1000);
    boot();
  }

  function syncViewportHeight() {
    var vv = window.visualViewport;
    if (!vv) return;
    var apply = function () {
      document.documentElement.style.setProperty(
        '--app-h',
        Math.round(vv.height) + 'px'
      );
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  }

  async function fetchState() {
    var res = await fetch('/api/state', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('state ' + res.status);
    return res.json();
  }

  async function postJSON(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  async function fetchJSON(url) {
    var res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    var data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  async function boot() {
    S.phase = 'boot';
    refs.boot.hidden = false;
    refs.pairing.hidden = true;
    refs.app.hidden = true;
    refs.bootSub.textContent = 'Connecting to DeepSeek Harness…';

    S.pairToken = readPairToken();

    try {
      var state = await fetchState();
      S.version = state.version || FALLBACK_VERSION;
      S.paired = !!state.paired;
      S.device = normalizeDevice(state.device);
      if (state.paired) {
        cleanPairToken();
        startApp(state);
        return;
      }
      showPairing();
      if (S.pairToken) {
        attemptTokenPair(S.pairToken);
      }
    } catch (err) {
      showPairing();
      setPairFormVisible(false);
      setPairStatus(
        "Can't reach DeepSeek Harness. Make sure the desktop app is running and you're on the same Wi-Fi.",
        {
          error: true,
          spinner: false,
          actionLabel: 'Retry',
          action: function () {
            boot();
          }
        }
      );
    }
  }

  function startApp(state) {
    S.phase = 'app';
    S.paired = true;
    if (state) {
      if (state.device) S.device = normalizeDevice(state.device);
      if (state.version) S.version = state.version;
    }
    refs.boot.hidden = true;
    refs.pairing.hidden = true;
    refs.app.hidden = false;
    loadAppLockState();
    maybeLockOnColdStart();
    renderTranscript();
    renderActivity();
    renderHeader();
    renderComposerMeta();
    updateSendState();
    setConn('connecting');
    startWatchdog();
    connect();
  }

  /* ---------- Pairing ----------------------------------------------------- */

  function readPairToken() {
    try {
      return new URL(window.location.href).searchParams.get('t');
    } catch (err) {
      return null;
    }
  }

  function cleanPairToken() {
    try {
      var url = new URL(window.location.href);
      if (url.searchParams.has('t')) {
        url.searchParams.delete('t');
        var qs = url.searchParams.toString();
        window.history.replaceState(
          null,
          '',
          url.pathname + (qs ? '?' + qs : '') + url.hash
        );
      }
    } catch (err) {
      /* ignore */
    }
    S.pairToken = null;
  }

  function showPairing() {
    S.phase = 'pairing';
    hideLockOverlay(true);
    refs.boot.hidden = true;
    refs.app.hidden = true;
    refs.pairing.hidden = false;
    refs.pairVersion.textContent =
      'DSH Remote v' + (S.version || FALLBACK_VERSION);
    setPairFormVisible(true);
    setPairStatus(null);
    refs.pinInput.disabled = false;
    refs.pinInput.value = '';
    S.pin = '';
    updatePinSlots();
    pairError('');
    if (S.rateLimitedUntil > Date.now()) {
      refs.pinInput.disabled = true;
      startRateLimitTicker();
    }
  }

  function setPairFormVisible(visible) {
    refs.pairForm.hidden = !visible;
  }

  function setPairStatus(text, opts) {
    opts = opts || {};
    if (!text) {
      refs.pairStatus.hidden = true;
      refs.pairStatusSpin.hidden = true;
      refs.pairStatusAction.hidden = true;
      return;
    }
    refs.pairStatus.hidden = false;
    refs.pairStatusText.textContent = text;
    refs.pairStatusSpin.hidden = !opts.spinner;
    refs.pairStatusAction.hidden = !opts.action;
    refs.pairStatus.classList.toggle('is-error', !!opts.error);
    if (opts.action) {
      refs.pairStatusAction.textContent = opts.actionLabel || 'Retry';
      refs.pairStatusAction.onclick = opts.action;
    }
  }

  function pairError(message) {
    S.pinError = !!message;
    refs.pairError.textContent = message || '';
    refs.pairError.hidden = !message;
  }

  function setPairBusy(busy) {
    S.pinBusy = busy;
    refs.pinInput.disabled = busy || S.rateLimitedUntil > Date.now();
    refs.pairSubmit.disabled =
      busy ||
      S.rateLimitedUntil > Date.now() ||
      S.pin.length !== PIN_LENGTH;
  }

  function updatePinSlots() {
    for (var i = 0; i < PIN_LENGTH; i++) {
      var slot = refs.pinSlots.querySelector('[data-slot="' + i + '"]');
      if (!slot) continue;
      var digit = S.pin[i] || '';
      slot.textContent = digit;
      slot.classList.toggle('is-filled', !!digit);
    }
    refs.pairSubmit.disabled =
      S.pinBusy ||
      S.rateLimitedUntil > Date.now() ||
      S.pin.length !== PIN_LENGTH;
  }

  function onPinInput() {
    if (S.pinBusy) return;
    var digits = String(refs.pinInput.value || '')
      .replace(/\D+/g, '')
      .slice(0, PIN_LENGTH);
    refs.pinInput.value = digits;
    S.pin = digits;
    pairError('');
    updatePinSlots();
    if (digits.length === PIN_LENGTH) submitPin();
  }

  function rejectPin(message) {
    S.pin = '';
    refs.pinInput.value = '';
    updatePinSlots();
    refs.pinSlots.classList.remove('is-error');
    /* force reflow so the shake can restart */
    void refs.pinSlots.offsetWidth;
    refs.pinSlots.classList.add('is-error');
    pairError(message);
    setPairBusy(false);
    try {
      refs.pinInput.focus({ preventScroll: true });
    } catch (err) {
      /* ignore */
    }
  }

  async function submitPin() {
    if (S.pinBusy || S.pin.length !== PIN_LENGTH) return;
    if (S.rateLimitedUntil > Date.now()) return;
    setPairBusy(true);
    pairError('');
    try {
      var res = await postJSON('/api/pair', { pin: S.pin });
      if (res.ok) {
        await completePairing(res.data);
        return;
      }
      if (res.status === 401) {
        rejectPin("That PIN didn't match. Check the desktop app and try again.");
        return;
      }
      if (res.status === 429) {
        setPairBusy(false);
        applyRateLimit(res.data && res.data.retryAfterMs);
        return;
      }
      setPairBusy(false);
      pairError('Pairing failed. Try again.');
    } catch (err) {
      setPairBusy(false);
      pairError(
        "Can't reach DeepSeek Harness. Make sure you're on the same Wi-Fi."
      );
    }
  }

  async function attemptTokenPair(token) {
    showPairing();
    setPairFormVisible(false);
    setPairStatus('Pairing this device…', { spinner: true });
    try {
      var res = await postJSON('/api/pair', { token: token });
      if (res.ok) {
        await completePairing(res.data);
        return;
      }
      if (res.status === 429) {
        setPairFormVisible(true);
        applyRateLimit(res.data && res.data.retryAfterMs);
        return;
      }
      cleanPairToken();
      setPairStatus(null);
      setPairFormVisible(true);
      pairError(
        'This pairing link has expired. Enter the PIN from your desktop instead.'
      );
      try {
        refs.pinInput.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    } catch (err) {
      setPairStatus("Can't reach DeepSeek Harness over the local network.", {
        error: true,
        spinner: false,
        actionLabel: 'Retry',
        action: function () {
          attemptTokenPair(token);
        }
      });
    }
  }

  async function completePairing(data) {
    S.paired = true;
    if (data && data.device) S.device = normalizeDevice(data.device);
    cleanPairToken();
    var state = null;
    try {
      state = await fetchState();
    } catch (err) {
      state = { paired: true, device: S.device, version: S.version };
    }
    if (!state || !state.paired) {
      state = { paired: true, device: S.device, version: S.version };
    }
    startApp(state);
  }

  function applyRateLimit(retryAfterMs) {
    var wait = Number(retryAfterMs);
    if (!isFinite(wait) || wait <= 0) wait = 300000;
    S.rateLimitedUntil = Date.now() + wait;
    S.pin = '';
    refs.pinInput.value = '';
    updatePinSlots();
    refs.pinInput.disabled = true;
    refs.pairSubmit.disabled = true;
    pairError('Too many attempts. Try again in ' + formatCountdown(wait) + '.');
    startRateLimitTicker();
  }

  function startRateLimitTicker() {
    if (S.rateTimer) clearInterval(S.rateTimer);
    S.rateTimer = setInterval(function () {
      var left = S.rateLimitedUntil - Date.now();
      if (left <= 0) {
        clearInterval(S.rateTimer);
        S.rateTimer = null;
        S.rateLimitedUntil = 0;
        pairError('');
        refs.pinInput.disabled = false;
        updatePinSlots();
        try {
          refs.pinInput.focus({ preventScroll: true });
        } catch (err) {
          /* ignore */
        }
        return;
      }
      pairError('Too many attempts. Try again in ' + formatCountdown(left) + '.');
    }, 250);
  }

  function handleAuthLost() {
    S.phase = 'pairing';
    teardownSocket();
    clearAttachments();
    refs.app.hidden = true;
    refs.pairing.hidden = false;
    refs.boot.hidden = true;
    showPairing();
    pairError('This device is no longer paired. Pair again to reconnect.');
  }

  /* ---------- Frame handlers --------------------------------------------- */

  function onReady(frame) {
    if (frame.device) {
      var priorCanApprove = S.device ? S.device.canApprove : true;
      S.device = normalizeDevice(frame.device);
      /* Older Hosts omitted canApprove on ready.device: keep /api/state's value. */
      if (frame.device.canApprove === undefined && S.device) {
        S.device.canApprove = priorCanApprove;
      }
    }
    if (frame.version) S.version = frame.version;
    S.imageLimits =
      frame.limits && frame.limits.image !== undefined
        ? normalizeImageLimits(frame.limits.image)
        : null;
    S.sessions = Array.isArray(frame.sessions) ? frame.sessions : [];
    S.workspaces = Array.isArray(frame.workspaces) ? frame.workspaces : [];
    if (!S.activeSessionId) {
      S.queue = {
        sessionId: null,
        items: [],
        pendingInput: [],
        running: false,
        active: false,
        expanded: false
      };
    }
    S.ready = true;
    sendVisibility(!document.hidden);
    if (S.resumeToastPending) {
      S.resumeToastPending = false;
      toast('Reconnected');
    }
    /* Never prompt automatically, but refresh the existing subscription and
       re-POST it after every (re)connect: the Host prunes 404/410 endpoints and
       the registration survives reconnects. */
    syncPushSubscription();
    var linked = consumeSessionLink(S.sessions);
    if (!linked) pickInitialSession(frame);
    renderHeader();
    renderComposerMeta();
    renderQueueStrip();
    renderArchivedBanner();
    updateSendState();
    refreshApprovalsForPermission();
    if (S.sheet === 'sessions') buildSheet();
  }

  function pickInitialSession(frame) {
    if (S.activeSessionId) return;
    if (!S.sessions.length) {
      if (S.shareDraft) {
        toast('Shared content ready — start a session to send it.');
      }
      renderTranscript();
      return;
    }
    var ids = {};
    S.sessions.forEach(function (s) {
      ids[s.id] = true;
    });
    var stored = store.get(LS_ACTIVE);
    var id = null;
    if (frame.activeSessionId && ids[frame.activeSessionId]) {
      id = frame.activeSessionId;
    }
    if (!id && stored && ids[stored]) id = stored;
    if (!id) id = S.sessions[0].id;
    openSession(id, { initial: true, silent: true });
  }

  function onSessions(frame) {
    S.sessions = Array.isArray(frame.sessions) ? frame.sessions : [];
    S.workspaces = Array.isArray(frame.workspaces) ? frame.workspaces : [];
    var consumedLink = consumeSessionLink(S.sessions);
    if (S.activeSessionId) {
      var current = null;
      for (var i = 0; i < S.sessions.length; i++) {
        if (S.sessions[i].id === S.activeSessionId) {
          current = S.sessions[i];
          break;
        }
      }
      if (current) {
        S.session = mergeSession(S.session, current);
        if (S.session.running !== !!current.running) {
          setRunning(!!current.running);
        } else {
          renderHeaderState();
        }
        renderQueueStrip();
        renderArchivedBanner();
        updateSendState();
      }
    }
    if (
      !consumedLink &&
      !S.activeSessionId &&
      !S.pendingOpen &&
      !S.creatingSession &&
      !S.userChoseSession &&
      S.sessions.length
    ) {
      openSession(S.sessions[0].id, { initial: true, silent: true });
    }
    if (S.sheet === 'sessions') buildSheet();
    renderComposerMeta();
  }

  /* ---------- Deep links (?session=<id> / service-worker message) --------- */

  /**
   * A push notification opens `/?session=<id>` (or messages a running page via
   * the service worker). The link is consumed once, only after the sessions
   * frame confirms the id exists, so pairing, unknown sessions and a slow
   * connect can never open the wrong session.
   */
  function readSessionLink() {
    try {
      var id = new URL(window.location.href).searchParams.get('session');
      if (!id) return null;
      return id.slice(0, 200);
    } catch (err) {
      return null;
    }
  }

  function clearSessionLinkParam() {
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.has('session')) return;
      url.searchParams.delete('session');
      var query = url.searchParams.toString();
      window.history.replaceState(
        null,
        '',
        url.pathname + (query ? '?' + query : '') + url.hash
      );
    } catch (err) {
      /* ignore: the link is cosmetic once consumed */
    }
  }

  function consumeSessionLink(sessions) {
    if (S.phase !== 'app' || !S.sessionLink) return false;
    var list = Array.isArray(sessions) ? sessions : S.sessions;
    var exists = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === S.sessionLink) {
        exists = true;
        break;
      }
    }
    if (!exists) return false;
    var target = S.sessionLink;
    S.sessionLink = null;
    clearTimeout(S.sessionLinkTimer);
    S.sessionLinkTimer = null;
    clearSessionLinkParam();
    if (target !== S.activeSessionId) {
      openSession(target, { initial: true, silent: true });
    }
    return true;
  }

  function handleOpenSessionLink(sessionId) {
    var id = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 200) : null;
    if (!id) return;
    S.sessionLink = id;
    if (S.phase !== 'app') return;
    if (consumeSessionLink(S.sessions)) return;
    /* The sessions frame may still be in flight (cold open from a push tap);
       try again when it lands. */
    clearTimeout(S.sessionLinkTimer);
    S.sessionLinkTimer = setTimeout(function () {
      S.sessionLinkTimer = null;
      if (S.sessionLink === id && S.phase === 'app') {
        consumeSessionLink(S.sessions);
      }
    }, 8000);
  }

  function mergeSession(existing, incoming) {
    var base = existing && existing.id === incoming.id ? existing : { id: incoming.id };
    base.id = incoming.id;
    base.title = incoming.title || base.title || 'Session';
    base.running = !!incoming.running;
    base.preset = incoming.preset === undefined ? base.preset || null : incoming.preset;
    base.model = incoming.model === undefined ? base.model || null : incoming.model;
    base.agentAvailable =
      incoming.agentAvailable === undefined
        ? !!base.agentAvailable
        : !!incoming.agentAvailable;
    base.pinned = incoming.pinned === undefined ? !!base.pinned : !!incoming.pinned;
    base.archived =
      incoming.archived === undefined ? !!base.archived : !!incoming.archived;
    return base;
  }

  function openSession(sessionId, opts) {
    opts = opts || {};
    if (!sessionId) return;
    if (S.pendingOpen === sessionId) return;
    S.pendingOpen = sessionId;
    if (!opts.initial) S.userChoseSession = true;
    if (!sendFrame({ type: 'sessions.open', sessionId: sessionId })) {
      S.pendingOpen = null;
      toast('Not connected — try again in a moment.');
      return;
    }
    if (!opts.silent) closeSheet();
    var meta = null;
    for (var i = 0; i < S.sessions.length; i++) {
      if (S.sessions[i].id === sessionId) {
        meta = S.sessions[i];
        break;
      }
    }
    if (meta) {
      S.session = mergeSession(
        S.session && S.session.id === sessionId ? S.session : null,
        meta
      );
      renderHeader();
    }
    clearTimeout(S.openTimer);
    S.openTimer = setTimeout(function () {
      if (S.pendingOpen === sessionId) {
        S.pendingOpen = null;
        toast('Could not open that session.');
      }
    }, 12000);
  }

  function onSessionOpened(frame) {
    var session = frame.session || {};
    if (!session.id) return;
    var switched = S.activeSessionId !== session.id;

    clearTimeout(S.openTimer);
    clearTimeout(S.createTimer);
    S.pendingOpen = null;
    S.creatingSession = false;
    S.userChoseSession = true;
    S.activeSessionId = session.id;

    S.session = {
      id: session.id,
      title: session.title || 'Session',
      running: !!session.running,
      preset: session.preset || null,
      model: session.model || null,
      agentAvailable: session.agentAvailable !== false,
      pinned: !!session.pinned,
      archived: !!session.archived
    };
    store.set(LS_ACTIVE, session.id);
    S.approvals.forEach(function (approval) {
      approval.otherSession = isForeignInteraction(approval);
    });
    S.questions.forEach(function (question) {
      question.otherSession = isForeignInteraction(question);
    });

    if (switched) {
      stopVoice({ quiet: true, commit: true });
      clearAttachments();
      S.live = null;
      S.typing = false;
      S.activeTools.clear();
      S.activity = [];
      S.activityOpen.clear();
      S.unseenActivity = 0;
      S.stopPending = false;
      S.queue = {
        sessionId: session.id,
        items: [],
        pendingInput: [],
        running: false,
        active: false,
        expanded: false
      };
      S.promptMode = 'queue';
      clearTimeout(S.search.timer);
      S.search.inFlight = false;
      S.changes = { sessionId: session.id, items: [], loading: false };
      S.pendingDiff = null;
      S.context = null;
      S.commands = {
        sessionId: session.id,
        available: false,
        items: [],
        reason: '',
        loading: false
      };
      S.commandConfirmName = '';
      S.commandPending = '';
    }

    S.context =
      frame.context === undefined || frame.context === null
        ? null
        : normalizeContext(frame.context, session.id);

    applyQueueFrame(
      session.id,
      Array.isArray(frame.queue) ? frame.queue : [],
      {
        running: !!session.running,
        active: session.agentAvailable !== false,
        pendingInput: []
      }
    );
    if (session.agentAvailable !== false) {
      sendFrame({ type: 'queue.list', sessionId: session.id });
    }
    setRunning(!!session.running, true);
    replaceTranscript(Array.isArray(frame.history) ? frame.history : []);
    S.pinned = true;
    S.unreadBelow = false;
    renderTranscript();
    reattachPendingInteractions();
    renderActivity();
    renderHeader();
    renderComposerMeta();
    updateSendState();
    updateActivityBadge();
    renderQueueStrip();
    renderArchivedBanner();
    renderChangesPanel();
    requestContext();
    requestChanges();
    closeSheet();
    scrollToBottom(false);
    applyShareDraft();
  }

  function onHistory(frame) {
    if (!frame || frame.sessionId !== S.activeSessionId) return;
    replaceTranscript(Array.isArray(frame.items) ? frame.items : []);
    renderTranscript();
    if (S.pinned) scrollToBottom(false);
  }

  /* ---------- Batch C frame handlers ------------------------------------- */

  function findSessionRow(sessionId) {
    for (var i = 0; i < S.sessions.length; i += 1) {
      if (S.sessions[i].id === sessionId) return S.sessions[i];
    }
    return null;
  }

  function onSessionUpdated(frame) {
    if (!frame || !frame.sessionId) return;
    var row = findSessionRow(frame.sessionId);
    var next = frame.session || null;
    var title = frame.title || (next && next.title) || '';
    if (row) {
      if (title) row.title = title;
      if (next) {
        if (next.running !== undefined) row.running = !!next.running;
        if (next.agentAvailable !== undefined) row.agentAvailable = !!next.agentAvailable;
        if (next.pinned !== undefined) row.pinned = !!next.pinned;
        if (next.archived !== undefined) row.archived = !!next.archived;
      }
    }
    if (S.activeSessionId === frame.sessionId && S.session) {
      if (title) S.session.title = title;
      if (next) S.session = mergeSession(S.session, next);
      renderHeader();
      renderQueueStrip();
      renderArchivedBanner();
      updateSendState();
    }
    if (S.sheet === 'sessions' || S.sheet === 'menu') buildSheet();
  }

  function onSessionsFound(frame) {
    if (!frame) return;
    var query = String(frame.query || '').trim().toLowerCase();
    S.search.inFlight = false;
    S.search.activeQuery = query;
    S.search.results = Array.isArray(frame.results) ? frame.results : [];
    S.search.hasMore = !!frame.hasMore;
    S.search.unavailable = false;
    if (S.sheet === 'sessions') refreshFoundSection();
  }

  function onSessionPinned(frame) {
    if (!frame) return;
    var row = findSessionRow(frame.sessionId);
    if (row) row.pinned = !!frame.pinned;
    if (S.activeSessionId === frame.sessionId && S.session) {
      S.session.pinned = !!frame.pinned;
    }
    if (S.sheet === 'sessions' || S.sheet === 'menu') buildSheet();
  }

  function onSessionArchived(frame) {
    if (!frame) return;
    var row = findSessionRow(frame.sessionId);
    if (row) {
      row.archived = !!frame.archived;
      row.pinned = !!frame.pinned;
    }
    if (S.activeSessionId === frame.sessionId && S.session) {
      S.session.archived = !!frame.archived;
      S.session.pinned = !!frame.pinned;
      if (S.session.archived) S.promptMode = 'queue';
      renderHeader();
      renderComposerMeta();
      renderQueueStrip();
      renderArchivedBanner();
      updateSendState();
    }
    if (S.sheet === 'sessions' || S.sheet === 'menu') buildSheet();
  }

  function onLimits(frame) {
    if (!frame) return;
    if (frame.image !== undefined) {
      S.imageLimits = normalizeImageLimits(frame.image);
    }
    if (S.sheet === 'attach') buildSheet();
  }

  function onQueueFrame(frame) {
    if (!frame || !frame.sessionId) return;
    applyQueueFrame(frame.sessionId, Array.isArray(frame.items) ? frame.items : [], {
      running: !!frame.running,
      active: frame.active !== false,
      pendingInput: Array.isArray(frame.pendingInput) ? frame.pendingInput : []
    });
  }

  function onQueueChanged(frame) {
    if (!frame || !frame.sessionId) return;
    applyQueueFrame(frame.sessionId, Array.isArray(frame.items) ? frame.items : [], {
      running: !!(S.session && S.session.running),
      active: !!(S.session && S.session.agentAvailable),
      pendingInput: S.queue.pendingInput
    });
  }

  /* ---------- Batch C3 frame handlers ------------------------------------ */

  function onContext(frame) {
    if (!frame || !frame.sessionId || frame.sessionId !== S.activeSessionId) return;
    S.context = normalizeContext(frame, frame.sessionId);
    renderContextMeter();
  }

  function onChanges(frame) {
    if (!frame || !frame.sessionId || frame.sessionId !== S.activeSessionId) return;
    S.changes = {
      sessionId: frame.sessionId,
      items: Array.isArray(frame.items) ? frame.items.slice(0, 12) : [],
      loading: false
    };
    renderChangesPanel();
  }

  function onChangesDiff(frame) {
    if (!frame || !frame.sessionId || frame.sessionId !== S.activeSessionId) return;
    var pending = S.pendingDiff;
    if (!pending || pending.seq !== frame.seq || pending.index !== frame.index) {
      return;
    }
    if (S.sheet === 'diff') renderDiffSheet(frame);
  }

  function onCommands(frame) {
    if (!frame || !frame.sessionId || frame.sessionId !== S.activeSessionId) return;
    clearTimeout(S.commandsLoadTimer);
    S.commandsLoadTimer = null;
    S.commands = {
      sessionId: frame.sessionId,
      available: frame.available !== false,
      items: Array.isArray(frame.items) ? frame.items.slice(0, 20) : [],
      reason: frame.reason ? String(frame.reason) : '',
      loading: false
    };
    /* Rebuild through buildSheet(): it clears the body first, so the loading
       spinner can never survive under the loaded rows. */
    if (S.sheet === 'commands') buildSheet();
  }

  function onCommandResult(frame) {
    if (!frame || !frame.sessionId || frame.sessionId !== S.activeSessionId) return;
    var name = frame.name || S.commandPending || 'Command';
    var failed = frame.kind === 'error';
    var text = frame.text == null ? '' : String(frame.text).trim();
    var label = name + ' — ' + (failed ? 'error' : 'success');
    toast(text && text.length <= 120 ? label + ': ' + text : label);
    S.commandPending = '';
    S.commandConfirmName = '';
    if (S.activeSessionId) {
      sendFrame({
        type: 'history.load',
        sessionId: S.activeSessionId,
        limit: 50
      });
    }
    requestContext();
    requestChanges();
  }

  function onAssistantStart(frame) {
    if (frame.sessionId !== S.activeSessionId) return;
    finalizeLive();
    S.typing = false;
    S.pendingPromptCount = Math.max(0, S.pendingPromptCount - 1);
    var item = {
      kind: 'assistant',
      id: 'live-assistant-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      sessionId: S.activeSessionId,
      text: '',
      reasoning: '',
      streaming: true,
      turn: frame.turn,
      step: frame.step,
      ts: Date.now(),
      _textDirty: false,
      _reasonDirty: false
    };
    S.live = item;
    appendMessage(item);
    pushActivity({
      kind: 'step',
      title: 'Assistant step started',
      sub:
        'Turn ' + (frame.turn == null ? '?' : frame.turn) +
        ' · step ' + (frame.step == null ? '?' : frame.step)
    });
    renderHeaderState();
    updateTyping();
  }

  function onAssistantDelta(frame) {
    if (frame.sessionId !== S.activeSessionId) return;
    var item = S.live;
    if (!item || item.sessionId !== S.activeSessionId) {
      onAssistantStart({
        sessionId: frame.sessionId,
        turn: null,
        step: null
      });
      item = S.live;
    }
    if (!item) return;
    if (typeof frame.text === 'string' && frame.text) {
      item.text += frame.text;
      item._textDirty = true;
    }
    if (typeof frame.reasoning === 'string' && frame.reasoning) {
      item.reasoning = (item.reasoning || '') + frame.reasoning;
      item._reasonDirty = true;
    }
    schedulePaintLive();
  }

  function onAssistantEnd(frame) {
    if (frame.sessionId !== S.activeSessionId) return;
    var item = S.live;
    if (!item) return;
    finalizeLive();
    pushActivity({
      kind: 'step',
      title: 'Assistant step finished',
      sub:
        'Turn ' + (frame.turn == null ? '?' : frame.turn) +
        ' · step ' + (frame.step == null ? '?' : frame.step)
    });
    S.typing = false;
    renderHeaderState();
    updateTyping();
    requestContext();
    requestChanges();
    if (S.pinned) scrollToBottom(false);
  }

  function finalizeLive() {
    var item = S.live;
    if (!item) return;
    item.streaming = false;
    S.live = null;
    if (item.node) item.node.classList.remove('is-streaming');
    if (item.mdEl) item.mdEl.replaceChildren(renderMarkdown(item.text || ''));
    if (item.reasonItem) item.reasonItem.hidden = !item.reasoning;
    if (item.reasonBody && item.reasoning) {
      item.reasonBody.replaceChildren(renderMarkdown(item.reasoning));
    }
  }

  var liveFrame = 0;

  function schedulePaintLive() {
    if (liveFrame) return;
    liveFrame = window.requestAnimationFrame(function () {
      liveFrame = 0;
      paintLive();
    });
  }

  function paintLive() {
    var item = S.live;
    if (!item || !item.node) return;
    if (item.reasonItem) {
      if (item.reasoning) {
        item.reasonItem.hidden = false;
        if (item._reasonDirty && item.reasonBody) {
          item.reasonBody.replaceChildren(renderMarkdown(item.reasoning));
          item._reasonDirty = false;
        }
        if (!item.text) item.reasonItem.open = true;
      } else {
        item.reasonItem.hidden = true;
      }
    }
    if (item._textDirty && item.mdEl) {
      item.mdEl.replaceChildren(
        renderMarkdown(item.text || '', { cursor: true })
      );
      item._textDirty = false;
    }
    if (S.pinned) scrollToBottom(false);
  }

  function onToolStart(frame) {
    /* Question tool frames are handled before the session guard so a
       non-active session's question can be remembered for the notice bar
       instead of being dropped or rendered inline. */
    if (frame.question || frame.name === 'ask_user_question') {
      startQuestionFromTool(frame);
      return;
    }
    if (frame.sessionId !== S.activeSessionId) return;
    S.typing = false;
    var callId = frame.callId || 'call-' + Date.now();
    var item = {
      kind: 'tool',
      id: 'live-tool:' + callId,
      callId: frame.callId || null,
      name: frame.name || 'tool',
      title: frame.title || '',
      argsPreview: frame.argsPreview || '',
      detail: frame.detail || null,
      output: null,
      ok: null,
      durationMs: null,
      ts: Date.now(),
      expanded: false
    };
    S.activeTools.add(callId);
    appendMessage(item);
    pushActivity({
      kind: 'tool',
      callId: item.callId,
      ok: null,
      title: item.name + (item.title ? ' — ' + item.title : ''),
      sub: item.argsPreview || '',
      args: formatDetail(item.detail) || item.argsPreview || '',
      output: '',
      status: 'running'
    });
    updateTyping();
  }

  function onToolEnd(frame) {
    if (frame.sessionId !== S.activeSessionId) return;
    var questionItem = null;
    if (frame.callId) {
      for (var q = 0; q < S.messages.length; q++) {
        if (
          S.messages[q].kind === 'question' &&
          S.messages[q].callId === frame.callId
        ) {
          questionItem = S.messages[q];
          break;
        }
      }
    }
    if (questionItem) {
      if (isQuestionReady(questionItem)) {
        var parsed = parseQuestionOutput(frame.output);
        var outcome = frame.ok === false
          ? 'unavailable'
          : parsed && parsed.outcome === 'declined'
            ? 'declined'
            : 'answered';
        questionItem.status = outcome;
        questionItem.outcome = outcome;
        questionItem.resolvedAnswers = parsed ? parsed.answers : null;
        questionItem.rawOutput =
          frame.output == null
            ? ''
            : String(frame.output).slice(0, MAX_TOOL_OUTPUT);
        questionItem.readOnly = true;
        unregisterQuestion(questionItem);
        if (questionItem.node) refreshQuestionNode(questionItem);
        syncQuestionActivity(questionItem);
        reconcileQuestionDuplicates(questionItem);
      } else if (frame.output) {
        questionItem.rawOutput = String(frame.output).slice(0, MAX_TOOL_OUTPUT);
      }
      if (frame.callId) S.activeTools.delete(frame.callId);
      updateTyping();
      if (S.pinned) scrollToBottom(false);
      return;
    }
    var item = null;
    for (var i = 0; i < S.messages.length; i++) {
      var m = S.messages[i];
      if (m.kind === 'tool' && m.callId && m.callId === frame.callId && m.ok === null) {
        item = m;
        break;
      }
    }
    if (!item && frame.callId) {
      item = {
        kind: 'tool',
        id: 'tool:' + frame.callId,
        callId: frame.callId,
        name: frame.name || 'tool',
        title: frame.title || '',
        argsPreview: '',
        detail: null,
        output: '',
        ok: null,
        durationMs: null,
        ts: Date.now(),
        expanded: false
      };
      appendMessage(item);
    }
    if (item) {
      item.ok = !!frame.ok;
      item.output =
        frame.output == null
          ? ''
          : String(frame.output).slice(0, MAX_TOOL_OUTPUT);
      item.durationMs =
        typeof frame.durationMs === 'number' ? frame.durationMs : null;
      if (!frame.ok) item.expanded = true;
      refreshToolNode(item);
    }
    if (frame.callId) S.activeTools.delete(frame.callId);
    updateActivityToolEnd(frame);
    updateTyping();
    if (S.pinned) scrollToBottom(false);
  }

  function onApprovalRequest(frame) {
    if (!frame || !frame.requestId) return;
    if (S.approvals.has(frame.requestId)) return;
    var item = {
      kind: 'approval',
      id: 'approval:' + frame.requestId,
      requestId: frame.requestId,
      sessionId: frame.sessionId || null,
      toolName: frame.toolName || 'tool',
      title: frame.title || 'Approval required',
      reason: frame.reason || '',
      displayReason: frame.displayReason || '',
      argsPreview: frame.argsPreview ? String(frame.argsPreview).slice(0, 600) : '',
      argsKind: frame.argsKind ? String(frame.argsKind) : '',
      detail:
        frame.detail && typeof frame.detail === 'object' ? frame.detail : null,
      callId: frame.callId || null,
      expiresAt: Number(frame.expiresAt) || 0,
      resolved: false,
      outcome: null,
      answering: false,
      ts: Date.now()
    };
    S.approvals.set(item.requestId, item);
    item.otherSession = !!(S.activeSessionId && frame.sessionId && frame.sessionId !== S.activeSessionId);
    item.sessionLabel = sessionLabelFor(frame.sessionId);
    stopVoice({ quiet: true, commit: true });
    notifyIncomingApproval(item);
    if (item.otherSession) {
      toast('Approval needed in ' + (item.sessionLabel || 'another session'));
      haptic(10);
      renderSessionNotice();
      return;
    }

    appendMessage(item);
    pushActivity({
      kind: 'approval',
      requestId: item.requestId,
      title: 'Approval requested',
      sub: item.toolName,
      reason: item.displayReason || item.reason,
      args: item.argsPreview,
      argsKind: item.argsKind,
      detail: item.detail,
      status: 'pending',
      ok: null
    });
    toast('Approval required: ' + item.toolName);
    haptic(10);
    renderSessionNotice();
  }

  function onApprovalResolved(frame) {
    var item = S.approvals.get(frame.requestId);
    if (!item) return;
    item.resolved = true;
    item.outcome = frame.outcome || 'unavailable';
    item.answering = false;
    S.approvals.delete(frame.requestId);
    refreshApprovalNode(item);
    updateActivityApproval(item);
    renderSessionNotice();
    var approvalVerb =
      item.outcome === 'allowed-once'
        ? 'Approved'
        : item.outcome === 'rejected'
          ? 'Rejected'
          : item.outcome === 'cancelled'
            ? 'Approval cancelled'
            : 'Approval is no longer available';
    // First answer wins: if the other surface settled it, say so, because the
    // phone may still have been looking at its own card.
    toast(frame.by === 'desktop' ? approvalVerb + ' on desktop' : approvalVerb);
  }

  /* ---------- Questions (ask_user_question) ------------------------------ */

  var QUESTION_STATUS_READY = {
    pending: true,
    submitting: true,
    waiting: true
  };

  function normalizeQuestions(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (raw, index) {
      if (!raw || typeof raw !== 'object') return;
      var id = raw.id === null || raw.id === undefined ? 'q' + index : String(raw.id);
      var options = [];
      (Array.isArray(raw.options) ? raw.options : []).forEach(function (opt) {
        if (typeof opt === 'string') {
          options.push({ label: opt, description: '' });
          return;
        }
        if (!opt || opt.label === null || opt.label === undefined) return;
        options.push({
          label: String(opt.label),
          description: opt.description ? String(opt.description) : ''
        });
      });
      out.push({
        id: id,
        question: raw.question ? String(raw.question) : '',
        header: raw.header ? String(raw.header) : '',
        detail: raw.detail ? String(raw.detail) : '',
        multiSelect: !!raw.multiSelect,
        options: options
      });
    });
    return out;
  }

  function normalizeAnswers(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      if (raw.id === null || raw.id === undefined) return;
      var selected = [];
      if (Array.isArray(raw.selected)) {
        raw.selected.forEach(function (label) {
          if (label !== null && label !== undefined) selected.push(String(label));
        });
      } else if (typeof raw.selected === 'string' && raw.selected) {
        selected.push(raw.selected);
      }
      var answer = { id: String(raw.id), selected: selected };
      if (raw.custom !== null && raw.custom !== undefined && String(raw.custom).trim()) {
        answer.custom = String(raw.custom);
      }
      out.push(answer);
    });
    return out;
  }

  function parseQuestionOutput(output) {
    if (output === null || output === undefined) return null;
    var text = String(output).trim();
    if (!text) return null;
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      var braceStart = text.indexOf('{');
      var braceEnd = text.lastIndexOf('}');
      if (braceStart >= 0 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch (err2) {
          parsed = null;
        }
      }
      if (!parsed) {
        var arrStart = text.indexOf('[');
        var arrEnd = text.lastIndexOf(']');
        if (arrStart >= 0 && arrEnd > arrStart) {
          try {
            parsed = JSON.parse(text.slice(arrStart, arrEnd + 1));
          } catch (err3) {
            parsed = null;
          }
        }
      }
    }
    if (parsed === null || parsed === undefined) return null;
    var outcome = null;
    var list = null;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && Array.isArray(parsed.answers)) {
      list = parsed.answers;
      if (parsed.outcome) outcome = String(parsed.outcome);
    } else if (parsed && parsed.selected !== undefined) {
      list = [parsed];
    } else if (parsed && typeof parsed === 'object' && parsed.outcome) {
      outcome = String(parsed.outcome);
    }
    return { answers: normalizeAnswers(list), outcome: outcome };
  }

  function newQuestionDraft(questions) {
    var draft = {};
    questions.forEach(function (q) {
      draft[q.id] = { selected: [], custom: '' };
    });
    return draft;
  }

  function ensureQuestionDraft(item, questionId) {
    if (!item.draft) item.draft = {};
    if (!item.draft[questionId]) {
      item.draft[questionId] = { selected: [], custom: '' };
    }
    return item.draft[questionId];
  }

  function isQuestionReady(item) {
    return !!(item && QUESTION_STATUS_READY[item.status]);
  }

  function questionKey(item) {
    if (item.requestId) return 'r:' + item.requestId;
    if (item.callId) return 'c:' + item.callId;
    return 'i:' + item.id;
  }

  function registerQuestion(item) {
    var key = questionKey(item);
    S.questions.forEach(function (value, existingKey) {
      if (value === item && existingKey !== key) S.questions.delete(existingKey);
    });
    S.questions.set(key, item);
  }

  function unregisterQuestion(item) {
    if (!item) return;
    S.questions.forEach(function (value, key) {
      if (value === item) S.questions.delete(key);
    });
  }

  function questionSignature(questions) {
    return (questions || [])
      .map(function (q) {
        return q.id;
      })
      .join('\u0000');
  }

  /**
   * One ask_user_question produces both a `tool.start` card (with the tool call
   * id) and a `question.request` card (with the request id). Match them by
   * session and question ids so only one card is ever rendered and answered.
   */
  function findPendingQuestionByContent(frame, questions) {
    if (!frame || !questions || !questions.length) return null;
    var signature = questionSignature(questions);
    for (var i = 0; i < S.messages.length; i += 1) {
      var item = S.messages[i];
      if (!item || item.kind !== 'question' || item.readOnly) continue;
      if (!isQuestionReady(item)) continue;
      /* Only merge frames that belong to the same session; a tool.start and
         question.request pair may omit one of the ids, but sessionId is
         authoritative and must not be crossed. */
      if (frame.sessionId || item.sessionId) {
        if (frame.sessionId !== item.sessionId) continue;
      }
      if (questionSignature(item.questions) !== signature) continue;
      return item;
    }
    return null;
  }

  function reconcileQuestionDuplicates(source) {
    if (!source || !source.questions || !source.questions.length) return;
    var signature = questionSignature(source.questions);
    S.messages.forEach(function (item) {
      if (!item || item === source || item.kind !== 'question') return;
      if (item.readOnly || !isQuestionReady(item)) return;
      if (source.sessionId || item.sessionId) {
        if (source.sessionId !== item.sessionId) return;
      }
      if (questionSignature(item.questions) !== signature) return;
      item.status = source.outcome;
      item.outcome = source.outcome;
      item.resolvedAnswers = source.resolvedAnswers;
      item.rawOutput = source.rawOutput || '';
      item.readOnly = true;
      unregisterQuestion(item);
      if (item.node) refreshQuestionNode(item);
      syncQuestionActivity(item);
    });
  }

  function findQuestionItem(requestId, callId) {
    for (var i = 0; i < S.messages.length; i++) {
      var message = S.messages[i];
      if (message.kind !== 'question') continue;
      if (requestId && message.requestId === requestId) return message;
      if (callId && message.callId === callId) return message;
    }
    var found = null;
    S.questions.forEach(function (item) {
      if (found) return;
      if (requestId && item.requestId === requestId) found = item;
      else if (callId && item.callId === callId) found = item;
    });
    return found;
  }

  function createQuestionItem(frame, questions) {
    var requestId =
      frame.requestId ||
      (frame.question && frame.question.requestId) ||
      null;
    var callId =
      frame.callId || (frame.question && frame.question.callId) || null;
    return {
      kind: 'question',
      id: 'question:' + (requestId || callId || Date.now()),
      sessionId: frame.sessionId || null,
      requestId: requestId,
      callId: callId,
      title: frame.title || '',
      questions: questions,
      draft: newQuestionDraft(questions),
      status: 'pending',
      outcome: null,
      resolvedAnswers: null,
      rawOutput: '',
      readOnly: false,
      ts: Date.now()
    };
  }

  function mergeQuestion(item, frame, questions) {
    var incomingRequestId =
      frame.requestId ||
      (frame.question && frame.question.requestId) ||
      null;
    var incomingCallId =
      frame.callId || (frame.question && frame.question.callId) || null;
    if (incomingRequestId) item.requestId = incomingRequestId;
    if (incomingCallId) item.callId = incomingCallId;
    if (frame.sessionId) item.sessionId = frame.sessionId;
    if (frame.title) item.title = frame.title;
    if (questions.length) {
      var nextDraft = {};
      questions.forEach(function (q) {
        var prior = item.draft && item.draft[q.id];
        nextDraft[q.id] = prior
          ? { selected: prior.selected.slice(), custom: prior.custom || '' }
          : { selected: [], custom: '' };
      });
      item.questions = questions;
      item.draft = nextDraft;
    }
    if (!isQuestionReady(item)) {
      item.status = 'pending';
      item.outcome = null;
      item.resolvedAnswers = null;
      item.readOnly = false;
    }
    registerQuestion(item);
  }

  function firstQuestionText(questions) {
    if (!questions || !questions.length) return 'Question from Harness';
    return questions[0].question || 'Question from Harness';
  }

  function formatQuestionsText(questions) {
    return (questions || [])
      .map(function (q, index) {
        var lines = [index + 1 + '. ' + (q.question || 'Question')];
        q.options.forEach(function (opt) {
          lines.push(
            '   - ' + opt.label + (opt.description ? ' — ' + opt.description : '')
          );
        });
        return lines.join('\n');
      })
      .join('\n\n');
  }

  function answerForQuestion(item, question, index) {
    var answers = item.resolvedAnswers || [];
    for (var i = 0; i < answers.length; i++) {
      if (answers[i].id === question.id) return answers[i];
    }
    if (Number.isInteger(index) && answers[index]) return answers[index];
    return null;
  }

  function answerSummary(item, question, index) {
    var answer = answerForQuestion(item, question, index);
    if (!answer) {
      if (item.outcome === 'declined') return 'Skipped';
      if (item.outcome === 'unavailable') return 'No answer';
      var draft = item.draft && item.draft[question.id];
      if (draft) {
        var parts = [];
        if (draft.selected && draft.selected.length) {
          parts.push(draft.selected.join(', '));
        }
        if (String(draft.custom || '').trim()) {
          parts.push('Other: ' + String(draft.custom).trim());
        }
        if (parts.length) return parts.join(' · ');
      }
      return 'Answered';
    }
    var selected = [];
    if (answer.selected && answer.selected.length) {
      selected.push(answer.selected.join(', '));
    }
    if (answer.custom) selected.push('Other: ' + answer.custom);
    return selected.length ? selected.join(' · ') : 'Answered';
  }

  function formatAnswersText(item) {
    var lines = [];
    (item.questions || []).forEach(function (q, index) {
      lines.push(
        index + 1 + '. ' + (q.question || 'Question') + '\n   → ' + answerSummary(item, q, index)
      );
    });
    if (!lines.length && item.resolvedAnswers && item.resolvedAnswers.length) {
      item.resolvedAnswers.forEach(function (answer) {
        var value = answer.selected.length
          ? answer.selected.join(', ')
          : answer.custom || 'Answered';
        lines.push(answer.id + ': ' + value);
      });
    }
    return lines.join('\n\n');
  }

  function hasDraftAnswer(item) {
    for (var i = 0; i < item.questions.length; i++) {
      var draft = item.draft && item.draft[item.questions[i].id];
      if (!draft) continue;
      if ((draft.selected && draft.selected.length) || String(draft.custom || '').trim()) {
        return true;
      }
    }
    return false;
  }

  function buildQuestionAnswers(item) {
    var answers = [];
    item.questions.forEach(function (q) {
      var draft = item.draft && item.draft[q.id];
      if (!draft) return;
      var selected = (draft.selected || []).slice();
      var custom = String(draft.custom || '').trim();
      if (!selected.length && !custom) return;
      var answer = { id: q.id, selected: selected };
      if (custom) answer.custom = custom;
      answers.push(answer);
    });
    return answers;
  }

  function sessionLabelFor(sessionId) {
    if (!sessionId) return '';
    for (var i = 0; i < S.sessions.length; i += 1) {
      if (S.sessions[i].id === sessionId) return S.sessions[i].title || '';
    }
    return '';
  }

  function findApprovalMessage(requestId) {
    for (var i = 0; i < S.messages.length; i += 1) {
      var item = S.messages[i];
      if (item.kind === 'approval' && item.requestId === requestId) return item;
    }
    return null;
  }

  /** True when an interaction belongs to a session other than the active one. */
  function isForeignInteraction(item) {
    return !!(
      item &&
      item.sessionId &&
      S.activeSessionId &&
      item.sessionId !== S.activeSessionId
    );
  }

  /** Pending interactions owned by another session, surfaced as a global bar. */
  function pendingOtherInteractions() {
    var out = [];
    S.approvals.forEach(function (item) {
      if (item.resolved) return;
      if (!S.activeSessionId || !item.sessionId || item.sessionId === S.activeSessionId) return;
      out.push({ kind: 'approval', item: item });
    });
    S.questions.forEach(function (item) {
      if (!isQuestionReady(item)) return;
      if (!S.activeSessionId || !item.sessionId || item.sessionId === S.activeSessionId) return;
      out.push({ kind: 'question', item: item });
    });
    return out;
  }

  function renderSessionNotice() {
    var existing = document.getElementById('session-notice');
    var pending = pendingOtherInteractions();
    if (!pending.length) {
      if (existing) existing.remove();
      return;
    }
    var bar = existing;
    if (!bar) {
      bar = el('div', {
        class: 'session-notice',
        attrs: { id: 'session-notice', role: 'status' }
      });
      var appRoot = document.getElementById('app');
      var connectionBanner = document.getElementById('banner');
      if (appRoot && connectionBanner && connectionBanner.parentNode === appRoot) {
        appRoot.insertBefore(bar, connectionBanner);
      } else if (appRoot) {
        appRoot.appendChild(bar);
      } else {
        var anchor = document.getElementById('view-chat');
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
        else document.body.appendChild(bar);
      }
    }
    bar.textContent = '';
    var first = pending[0].item;
    var label = pending[0].kind === 'approval' ? 'Approval needed' : 'Question asked';
    var title = sessionLabelFor(first.sessionId) || 'another session';
    bar.appendChild(
      el('span', {
        class: 'session-notice-text',
        text: label + ' in ' + title + (pending.length > 1 ? ' (+' + (pending.length - 1) + ')' : '')
      })
    );
    var open = el('button', {
      class: 'btn btn-ghost',
      attrs: { type: 'button' },
      text: 'Open'
    });
    open.addEventListener('click', function () {
      openSession(first.sessionId, {});
    });
    bar.appendChild(open);
  }

  /** Re-attach pending interactions for the session that just opened. */
  function reattachPendingInteractions() {
    if (!S.activeSessionId) return;
    S.approvals.forEach(function (item) {
      if (item.resolved) return;
      if (!item.sessionId || item.sessionId !== S.activeSessionId) return;
      if (findApprovalMessage(item.requestId)) return;
      appendMessage(item);
    });
    S.questions.forEach(function (item) {
      if (!isQuestionReady(item)) return;
      if (!item.sessionId || item.sessionId !== S.activeSessionId) return;
      if (S.messages.indexOf(item) >= 0) return;
      appendMessage(item);
    });
    renderSessionNotice();
  }

  function findQuestionActivity(item) {
    for (var i = 0; i < S.activity.length; i++) {
      var entry = S.activity[i];
      if (entry.kind !== 'question') continue;
      if (item.requestId && entry.requestId === item.requestId) return entry;
      if (item.callId && entry.callId === item.callId) return entry;
    }
    return null;
  }

  function pushQuestionActivity(item) {
    pushActivity({
      kind: 'question',
      callId: item.callId,
      requestId: item.requestId,
      title: 'Question asked',
      sub: firstQuestionText(item.questions),
      args: formatQuestionsText(item.questions),
      output: '',
      status: 'pending',
      ok: null
    });
  }

  function revealQuestionCard(item) {
    if (!item || !item.node) return;
    try {
      item.node.scrollIntoView({
        block: 'start',
        behavior: reduceMotion ? 'auto' : 'smooth'
      });
    } catch (err) {
      try {
        item.node.scrollIntoView(true);
      } catch (err2) {
        /* ignore */
      }
    }
    S.pinned = false;
    S.unreadBelow = false;
    updateJump();
  }

  function syncQuestionActivity(item) {
    var entry = findQuestionActivity(item);
    if (!entry) return;
    entry.requestId = item.requestId || entry.requestId;
    entry.callId = item.callId || entry.callId;
    entry.sub = firstQuestionText(item.questions);
    entry.args = formatQuestionsText(item.questions);
    if (isQuestionReady(item)) {
      entry.status = 'pending';
      entry.outcome = null;
      entry.ok = null;
      entry.title = 'Question asked';
      entry.output = '';
    } else {
      entry.status = 'resolved';
      entry.outcome = item.outcome;
      entry.ok = item.outcome === 'answered';
      entry.title =
        item.outcome === 'answered'
          ? 'Question answered'
          : item.outcome === 'declined'
            ? 'Question declined'
            : 'Question unavailable';
      entry.output =
        formatAnswersText(item) ||
        (item.outcome === 'answered' ? 'Answered' : '');
    }
    if (S.view === 'activity') renderActivity();
  }

  function startQuestionFromTool(frame) {
    var rawQuestions =
      frame.question && Array.isArray(frame.question.questions)
        ? frame.question.questions
        : [];
    var questions = normalizeQuestions(rawQuestions);
    var callId =
      frame.callId || (frame.question && frame.question.callId) || null;
    var otherSession = !!(
      frame.sessionId &&
      S.activeSessionId &&
      frame.sessionId !== S.activeSessionId
    );
    var item = findQuestionItem(null, callId);
    if (item && frame.sessionId && item.sessionId && item.sessionId !== frame.sessionId) {
      item = null;
    }
    if (item) {
      mergeQuestion(item, frame, questions);
      syncQuestionActivity(item);
      if (item.node) refreshQuestionNode(item);
      if (otherSession) {
        item.otherSession = true;
        item.sessionLabel = sessionLabelFor(frame.sessionId);
        renderSessionNotice();
        return;
      }
    } else {
      var twin = otherSession
        ? null
        : findPendingQuestionByContent(frame, questions);
      if (twin) {
        mergeQuestion(twin, frame, questions);
        syncQuestionActivity(twin);
        if (twin.node) refreshQuestionNode(twin);
        updateTyping();
        return;
      }
      item = createQuestionItem(frame, questions);
      registerQuestion(item);
      item.otherSession = otherSession;
      item.sessionLabel = sessionLabelFor(frame.sessionId);
      if (otherSession) {
        haptic(10);
        toast('Question in ' + (item.sessionLabel || 'another session'));
        renderSessionNotice();
        return;
      }
      appendMessage(item);
      pushQuestionActivity(item);
      haptic(10);
      revealQuestionCard(item);
    }
    if (otherSession) {
      renderSessionNotice();
      return;
    }
    if (callId) S.activeTools.add(callId);
    updateTyping();
    if (S.pinned) scrollToBottom(false);
  }

  function onQuestionRequest(frame) {
    if (!frame) return;
    var requestId = frame.requestId || null;
    var callId = frame.callId || null;
    if (!requestId && !callId) return;
    var questions = normalizeQuestions(frame.questions);
    stopVoice({ quiet: true, commit: true });
    notifyQuestionFrame(frame, questions);
    var otherSession = !!(
      frame.sessionId &&
      S.activeSessionId &&
      frame.sessionId !== S.activeSessionId
    );
    var item = findQuestionItem(requestId, callId);
    if (item && frame.sessionId && item.sessionId && item.sessionId !== frame.sessionId) {
      item = null;
    }

    if (item && !isQuestionReady(item)) {
      /* Already settled — a duplicate/retried frame must not re-open it. */
      return;
    }
    if (item) {
      mergeQuestion(item, frame, questions);
      syncQuestionActivity(item);
      if (item.node) refreshQuestionNode(item);
      item.otherSession = otherSession;
      if (otherSession) {
        item.sessionLabel = sessionLabelFor(frame.sessionId);
        renderSessionNotice();
        return;
      }
      updateTyping();
      return;
    }

    var twin =
      !otherSession && !callId
        ? findPendingQuestionByContent(frame, questions)
        : null;
    if (twin) {
      mergeQuestion(twin, frame, questions);
      syncQuestionActivity(twin);
      if (twin.node) refreshQuestionNode(twin);
      updateTyping();
      return;
    }

    item = createQuestionItem(frame, questions);
    registerQuestion(item);
    item.otherSession = otherSession;
    item.sessionLabel = sessionLabelFor(frame.sessionId);
    if (item.otherSession) {
      toast('Question in ' + (item.sessionLabel || 'another session'));
      haptic(10);
      renderSessionNotice();
      return;
    }
    appendMessage(item);
    pushQuestionActivity(item);
    haptic(10);
    revealQuestionCard(item);
    toast('Question asked');
    updateTyping();
    if (S.pinned) scrollToBottom(false);
  }

  function onQuestionResolved(frame) {
    if (!frame) return;
    var item = findQuestionItem(frame.requestId || null, frame.callId || null);
    if (!item) return;
    var outcome = frame.outcome;
    if (outcome !== 'answered' && outcome !== 'declined' && outcome !== 'unavailable') {
      outcome = 'unavailable';
    }
    item.status = outcome;
    item.outcome = outcome;
    item.resolvedAnswers = normalizeAnswers(frame.answers);
    item.readOnly = true;
    unregisterQuestion(item);
    if (item.node) refreshQuestionNode(item);
    syncQuestionActivity(item);
    reconcileQuestionDuplicates(item);
    if (item.callId) S.activeTools.delete(item.callId);
    updateTyping();
    renderSessionNotice();
    if (item.sessionId && S.activeSessionId && item.sessionId !== S.activeSessionId) {
      return;
    }
    toast(
      outcome === 'answered'
        ? 'Answers sent to Harness.'
        : outcome === 'declined'
          ? 'Question skipped.'
          : 'Moved to the desktop to answer.'
    );
    if (S.pinned) scrollToBottom(false);
  }

  function sendQuestionAnswer(item, answers, skipping) {
    if (!item || item.status !== 'pending') return;
    if (S.conn !== 'online') {
      toast('Still reconnecting — try again in a moment.');
      return;
    }
    var frame = {
      type: 'question.answer',
      sessionId: item.sessionId || S.activeSessionId,
      answers: answers
    };
    if (item.requestId) frame.requestId = item.requestId;
    if (item.callId) frame.callId = item.callId;
    item.status = 'waiting';
    item.skipped = !!skipping;
    refreshQuestionNode(item);
    updateTyping();
    if (!sendFrame(frame)) {
      item.status = 'pending';
      item.skipped = false;
      refreshQuestionNode(item);
      updateTyping();
      toast('Could not send your answer.');
      return;
    }
    haptic(skipping ? 8 : 10);
    if (S.pinned) scrollToBottom(false);
  }

  function submitQuestion(item) {
    if (!item || !isQuestionReady(item) || item.status !== 'pending') return;
    var answers = buildQuestionAnswers(item);
    if (!answers.length) {
      toast('Choose an option or type an answer first.');
      return;
    }
    sendQuestionAnswer(item, answers, false);
  }

  function skipQuestion(item) {
    if (!item || !isQuestionReady(item) || item.status !== 'pending') return;
    sendQuestionAnswer(item, [], true);
  }

  function onSessionStatus(frame) {
    if (!frame) return;
    if (frame.sessionId && frame.sessionId !== S.activeSessionId) {
      for (var i = 0; i < S.sessions.length; i++) {
        if (S.sessions[i].id === frame.sessionId && typeof frame.running === 'boolean') {
          S.sessions[i].running = frame.running;
        }
      }
      return;
    }
    if (!S.session) return;
    setRunning(!!frame.running);
    for (var j = 0; j < S.sessions.length; j++) {
      if (S.sessions[j].id === frame.sessionId) {
        S.sessions[j].running = !!frame.running;
        break;
      }
    }
    if (S.sheet === 'sessions') buildSheet();
  }

  function onModels(frame) {
    S.modelsLoading = false;
    clearTimeout(S.modelLoadTimer);
    S.models = {
      catalog: Array.isArray(frame.catalog) ? frame.catalog : [],
      current: frame.current || null
    };
    if (S.sheet === 'model') buildSheet();
    renderComposerMeta();
  }

  function onPresets(frame) {
    S.presetsLoading = false;
    clearTimeout(S.presetLoadTimer);
    S.presets = {
      list: Array.isArray(frame.presets) ? frame.presets : [],
      current: frame.current || null
    };
    if (S.sheet === 'new-session' || S.sheet === 'preset') buildSheet();
    renderHeader();
  }

  function onServerError(frame) {
    var message = frame.message || 'The Harness reported an error.';
    if (frame.code === 'unavailable' && (S.search.inFlight || S.search.activeQuery)) {
      /* Content search is disabled on this deployment: stay on the local
         filter and explain once per session. */
      sessionSearchUnavailable();
      return;
    }
    if (frame.code === 'bad-request' && S.pendingSteer) {
      /* A rejected steer must not leave an optimistic bubble behind. */
      rollbackSteer(message);
      return;
    }
    if (
      S.commandPending &&
      (frame.code === 'forbidden' ||
        frame.code === 'not-live' ||
        frame.code === 'bad-request')
    ) {
      var commandName = S.commandPending;
      S.commandPending = '';
      S.commandConfirmName = '';
      toast(
        frame.code === 'forbidden'
          ? 'That command is not allowed from the phone.'
          : frame.code === 'not-live'
            ? 'This session is not live on the desktop yet.'
            : message || commandName + ' could not run.'
      );
      return;
    }
    if (S.pendingDiff && frame.code === 'unavailable') {
      var diffPending = S.pendingDiff;
      S.pendingDiff = null;
      if (S.sheet === 'diff') {
        renderDiffSheet({
          unavailable: true,
          seq: diffPending.seq,
          index: diffPending.index,
          path: diffPending.path
        });
      }
      return;
    }
    if (frame.code === 'not-live') {
      toast('This session is not live on the desktop yet.');
      pushActivity({
        kind: 'error',
        title: 'This session is not live on the desktop yet.',
        sub: message
      });
      return;
    }
    if (frame.code === 'forbidden') {
      toast(
        'This device is not allowed to answer approvals. Approve on the desktop or another phone.'
      );
      return;
    }
    toast(message);
    pushActivity({
      kind: 'error',
      title: message,
      sub: frame.code ? 'Code: ' + frame.code : ''
    });
    if (frame.code === 'not-found') {
      clearTimeout(S.openTimer);
      S.pendingOpen = null;
      if (
        S.activeSessionId &&
        !S.sessions.some(function (s) {
          return s.id === S.activeSessionId;
        })
      ) {
        resetSession();
      }
    }
  }

  function setRunning(running, initial) {
    var was = S.session ? !!S.session.running : false;
    if (S.session) S.session.running = !!running;
    if (running && !was) {
      S.runningSince = Date.now();
      S.runSeq += 1;
    }
    if (!running) {
      S.stopPending = false;
      S.runningSince = 0;
    }
    if (!initial && running !== was) {
      pushActivity({
        kind: 'status',
        title: running ? 'Run started' : 'Run finished'
      });
      if (!running) notifyReplyReady(S.runSeq);
    }
    renderHeaderState();
    renderComposerMeta();
    updateTyping();
  }

  function resetSession() {
    clearAttachments();
    revokeMessagePreviewUrls(S.messages);
    S.activeSessionId = null;
    S.session = null;
    S.messages = [];
    S.live = null;
    S.typing = false;
    S.activeTools.clear();
    S.approvals.clear();
    S.questions.clear();
    S.activity = [];
    S.activityOpen.clear();
    S.unseenActivity = 0;
    S.stopPending = false;
    S.promptMode = 'queue';
    S.pendingSteer = null;
    clearTimeout(S.steerTimer);
    S.context = null;
    S.changes = { sessionId: null, items: [], loading: false };
    S.pendingDiff = null;
    S.commands = {
      sessionId: null,
      available: false,
      items: [],
      reason: '',
      loading: false
    };
    S.queue = {
      sessionId: null,
      items: [],
      pendingInput: [],
      running: false,
      active: false,
      expanded: false
    };
    store.del(LS_ACTIVE);
    renderTranscript();
    renderActivity();
    renderHeader();
    renderQueueStrip();
    renderArchivedBanner();
    renderChangesPanel();
    updateActivityBadge();
  }

  /* ---------- Transcript model ------------------------------------------- */

  function normalizeHistoryItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var kind = raw.kind;
    var ts = Number(raw.ts) || 0;
    if (kind === 'user') {
      var userAttachments = [];
      if (Array.isArray(raw.attachments)) {
        raw.attachments.forEach(function (attachment) {
          if (!attachment || attachment.name === undefined) return;
          var entry = {
            name: String(attachment.name),
            size: Number(attachment.size) || 0,
            mediaType: attachment.mediaType ? String(attachment.mediaType) : '',
            path: attachment.path ? String(attachment.path) : '',
            relativePath: attachment.relativePath
              ? String(attachment.relativePath)
              : ''
          };
          userAttachments.push(entry);
        });
      }
      return {
        kind: 'user',
        id: raw.id || 'u-' + ts,
        text: raw.text == null ? '' : String(raw.text),
        ts: ts,
        attachments: userAttachments.length ? userAttachments : null
      };
    }
    if (kind === 'assistant') {
      return {
        kind: 'assistant',
        id: raw.id || 'a-' + ts,
        text: raw.text == null ? '' : String(raw.text),
        ts: ts
      };
    }
    if (kind === 'tool') {
      var rawQuestionPayload = raw.question;
      var hasQuestionPayload =
        rawQuestionPayload &&
        (Array.isArray(rawQuestionPayload.questions)
          ? rawQuestionPayload.questions.length > 0
          : raw.name === 'ask_user_question');
      if (rawQuestionPayload && hasQuestionPayload) {
        var historyQuestions = normalizeQuestions(rawQuestionPayload.questions);
        var parsedHistory = parseQuestionOutput(raw.output);
        var historyOutcome = raw.ok === false
          ? 'unavailable'
          : parsedHistory && parsedHistory.outcome === 'declined'
            ? 'declined'
            : 'answered';
        return {
          kind: 'question',
          id: raw.id || 'tool:' + (raw.callId || ts),
          sessionId: null,
          callId: raw.callId || raw.question.callId || null,
          requestId: raw.requestId || raw.question.requestId || null,
          title: raw.title || '',
          questions: historyQuestions,
          draft: newQuestionDraft(historyQuestions),
          status: historyOutcome,
          outcome: historyOutcome,
          resolvedAnswers: parsedHistory ? parsedHistory.answers : null,
          rawOutput: raw.output == null ? '' : String(raw.output).slice(0, MAX_TOOL_OUTPUT),
          readOnly: true,
          ts: ts
        };
      }
      return {
        kind: 'tool',
        id: raw.id || 'tool:' + (raw.callId || ts),
        callId: raw.callId || null,
        name: raw.name || 'tool',
        title: raw.title || '',
        argsPreview: raw.argsPreview || '',
        detail: raw.detail || null,
        output: raw.output == null ? '' : String(raw.output).slice(0, MAX_TOOL_OUTPUT),
        diff: raw.diff || null,
        ok: raw.ok === undefined || raw.ok === null ? null : !!raw.ok,
        durationMs:
          typeof raw.durationMs === 'number' ? raw.durationMs : null,
        ts: ts,
        expanded: false
      };
    }
    if (kind === 'error') {
      return {
        kind: 'error',
        id: raw.id || 'e-' + ts,
        text: raw.text == null ? '' : String(raw.text),
        ts: ts
      };
    }
    if (kind === 'system') {
      return {
        kind: 'system',
        id: raw.id || 's-' + ts,
        text: raw.text == null ? '' : String(raw.text),
        ts: ts
      };
    }
    return null;
  }

  function replaceTranscript(items) {
    var previous = S.messages;
    var oldPreviewUrls = [];
    previous.forEach(function (m) {
      if (m.kind !== 'user') return;
      (m.attachments || []).forEach(function (attachment) {
        if (attachment && attachment.previewUrl) {
          oldPreviewUrls.push(attachment.previewUrl);
        }
      });
    });
    var oldTools = {};
    previous.forEach(function (m) {
      if (m.kind !== 'tool') return;
      if (m.callId) oldTools['c:' + m.callId] = m;
      if (m.id) oldTools['i:' + m.id] = m;
    });
    var oldApprovals = {};
    previous.forEach(function (m) {
      if (m.kind === 'approval' && m.requestId) oldApprovals[m.requestId] = m;
    });
    var oldQuestions = {};
    previous.forEach(function (m) {
      if (m.kind !== 'question') return;
      if (m.callId) oldQuestions['c:' + m.callId] = m;
      if (m.requestId) oldQuestions['r:' + m.requestId] = m;
      if (m.id) oldQuestions['i:' + m.id] = m;
    });

    function markQuestionSeen(seenSet, question) {
      if (question.callId) seenSet.add('call:' + question.callId);
      if (question.id) seenSet.add('id:' + question.id);
      if (question.requestId) seenSet.add('r:' + question.requestId);
    }

    function questionAlreadySeen(seenSet, question) {
      return !!(
        (question.callId && seenSet.has('call:' + question.callId)) ||
        (question.id && seenSet.has('id:' + question.id)) ||
        (question.requestId && seenSet.has('r:' + question.requestId))
      );
    }

    var list = [];
    var seen = new Set();
    var userTexts = [];

    items.forEach(function (raw) {
      var item = normalizeHistoryItem(raw);
      if (!item) return;
      var deDupeKey =
        (item.kind === 'tool' || item.kind === 'question') && item.callId
          ? 'call:' + item.callId
          : item.id
            ? 'id:' + item.id
            : null;
      if (deDupeKey && seen.has(deDupeKey)) return;
      if (deDupeKey) seen.add(deDupeKey);

      if (item.kind === 'tool') {
        var oldTool =
          (item.callId && oldTools['c:' + item.callId]) ||
          (item.id && oldTools['i:' + item.id]) ||
          null;
        if (oldTool) {
          item.expanded = oldTool.expanded;
          if (item.ok === null && oldTool.ok !== null) item.ok = oldTool.ok;
        }
        if (item.id) seen.add('id:' + item.id);
      }

      if (item.kind === 'question') {
        var oldQuestion =
          (item.callId && oldQuestions['c:' + item.callId]) ||
          (item.requestId && oldQuestions['r:' + item.requestId]) ||
          (item.id && oldQuestions['i:' + item.id]) ||
          null;
        markQuestionSeen(seen, item);
        if (oldQuestion && isQuestionReady(oldQuestion)) {
          /* Keep the live, answerable card (and its draft) rather than the
             settled history row while the question is still open. */
          list.push(oldQuestion);
          markQuestionSeen(seen, oldQuestion);
          return;
        }
      }

      list.push(item);
      if (item.kind === 'user') userTexts.push(item.text.trim());
    });

    /* Keep optimistic messages that the durable transcript has not confirmed. */
    previous.forEach(function (m) {
      if (m.kind !== 'user' || !m.optimistic) return;
      if (m.sessionId && m.sessionId !== S.activeSessionId) return;
      var text = m.text.trim();
      var idx = userTexts.indexOf(text);
      if (idx >= 0) {
        userTexts.splice(idx, 1);
        if (m.attachments && m.attachments.length) {
          /* Carry the visible attachment names onto the durable row. */
          for (var li = 0; li < list.length; li++) {
            var candidate = list[li];
            if (
              candidate.kind === 'user' &&
              candidate.text.trim() === text &&
              (!candidate.attachments || !candidate.attachments.length)
            ) {
              candidate.attachments = m.attachments;
              break;
            }
          }
        }
        return;
      }
      list.push(m);
    });

    /* Preserve the in-flight assistant bubble across a history reload. */
    if (S.live && (!S.live.sessionId || S.live.sessionId === S.activeSessionId)) {
      list.push(S.live);
    }

    /* Pending approvals are not part of the durable transcript. */
    S.approvals.forEach(function (approval) {
      if (approval.resolved) return;
      if (approval.sessionId && approval.sessionId !== S.activeSessionId) return;
      var existing = oldApprovals[approval.requestId];
      if (existing && existing.node) approval.node = existing.node;
      if (seen.has('id:' + approval.id)) return;
      list.push(approval);
    });

    /* Open questions stay answerable across a history reload. */
    S.questions.forEach(function (question) {
      if (!isQuestionReady(question)) return;
      if (question.sessionId && question.sessionId !== S.activeSessionId) return;
      if (questionAlreadySeen(seen, question)) return;
      list.push(question);
      markQuestionSeen(seen, question);
    });

    /* A just-settled question also survives until the durable row lands. */
    previous.forEach(function (message) {
      if (message.kind !== 'question' || isQuestionReady(message)) return;
      if (message.sessionId && message.sessionId !== S.activeSessionId) return;
      if (questionAlreadySeen(seen, message)) return;
      list.push(message);
      markQuestionSeen(seen, message);
    });

    var usedPreviewUrls = usedMessagePreviewUrls(list);
    oldPreviewUrls.forEach(function (url) {
      if (!usedPreviewUrls[url]) revokePreviewObjectUrl(url);
    });

    S.messages = list;
  }

  /* ---------- Transcript rendering --------------------------------------- */

  function renderTranscript() {
    var container = refs.messages;
    container.replaceChildren();
    if (!S.session) {
      renderEmptySession(container);
      renderTypingNode();
      updateJump();
      return;
    }
    if (!S.messages.length) {
      renderEmptyChat(container);
      renderTypingNode();
      updateJump();
      return;
    }
    for (var i = 0; i < S.messages.length; i++) {
      container.appendChild(renderItem(S.messages[i]));
    }
    renderTypingNode();
    updateJump();
  }

  function appendMessage(item) {
    /* Defensive boundary: an interaction owned by another session must never
       enter the active transcript, whatever frame path produced it. */
    if (
      (item.kind === 'approval' || item.kind === 'question') &&
      item.sessionId &&
      S.activeSessionId &&
      item.sessionId !== S.activeSessionId
    ) {
      item.otherSession = true;
      item.sessionLabel =
        item.sessionLabel || sessionLabelFor(item.sessionId);
      renderSessionNotice();
      return;
    }
    S.messages.push(item);
    var empty = refs.messages.querySelector('.empty');
    if (empty) empty.remove();
    var typing = refs.messages.querySelector('.typing');
    if (typing) typing.remove();
    var node = renderItem(item);
    node.__rmItem = item;
    refs.messages.appendChild(node);
    renderTypingNode();
    if (S.pinned) scrollToBottom(false);
    else markUnreadBelow();
  }

  function renderItem(item) {
    switch (item.kind) {
      case 'user':
        return renderUser(item);
      case 'assistant':
        return renderAssistant(item);
      case 'tool':
        return renderTool(item);
      case 'question':
        return renderQuestion(item);
      case 'approval':
        return renderApproval(item);
      case 'error':
        return renderError(item);
      case 'system':
        return renderSystem(item);
      default:
        return el('div');
    }
  }

  function renderAttachmentPill(attachment, note) {
    var pill = el(
      'span',
      { class: 'bubble-file' + (note ? ' is-missing' : '') },
      attachmentGlyph(attachment.mediaType),
      el('span', {
        class: 'bubble-file-name',
        text: String(attachment.name || 'file')
      })
    );
    if (note) {
      pill.appendChild(
        el('span', { class: 'bubble-file-note', text: note })
      );
    }
    return pill;
  }

  function renderBubbleThumb(attachment, src) {
    var name = String(attachment.name || 'image');
    var thumb = el('button', {
      class: 'bubble-thumb',
      attrs: { type: 'button', 'aria-label': 'Open ' + name }
    });
    var image = el('img', {
      class: 'bubble-thumb-img',
      attrs: { src: src, alt: name, decoding: 'async' }
    });
    image.addEventListener('error', function () {
      thumb.replaceWith(renderAttachmentPill(attachment, 'Preview unavailable'));
    });
    thumb.appendChild(image);
    thumb.addEventListener('click', function (event) {
      event.stopPropagation();
      openLightbox(src, name);
    });
    return thumb;
  }

  function renderUser(item) {
    var wrap = el('div', {
      class: 'msg msg-user' + (item.showTs ? ' is-time-shown' : '')
    });
    var attachments = Array.isArray(item.attachments) ? item.attachments : [];
    var images = [];
    var files = [];
    attachments.forEach(function (file) {
      var src = previewSrcForAttachment(file);
      if (src) images.push({ file: file, src: src });
      else files.push(file);
    });
    var bubble = el('div', {
      class:
        'bubble' +
        (!item.text ? ' is-attachment-only' : '') +
        (images.length ? ' has-thumbs' : '')
    });

    if (images.length) {
      var thumbs = el('div', {
        class: 'bubble-thumbs' + (images.length === 1 ? ' is-single' : '')
      });
      images.forEach(function (entry) {
        thumbs.appendChild(renderBubbleThumb(entry.file, entry.src));
      });
      bubble.appendChild(thumbs);
    }

    if (item.text) {
      bubble.appendChild(
        el('span', { class: 'bubble-text', text: item.text || '' })
      );
    }

    if (files.length) {
      var fileWrap = el('div', { class: 'bubble-files' });
      files.forEach(function (file) {
        var note =
          isImageMediaType(file.mediaType) && !previewSrcForAttachment(file)
            ? 'Preview unavailable'
            : '';
        fileWrap.appendChild(renderAttachmentPill(file, note));
      });
      bubble.appendChild(fileWrap);
    }

    wrap.appendChild(bubble);
    var timeText = fmtMsgTime(item.ts);
    if (timeText) {
      wrap.appendChild(
        el('time', {
          class: 'msg-time',
          attrs: { datetime: isoTime(item.ts) },
          text: timeText
        })
      );
    }
    bubble.addEventListener('click', function () {
      item.showTs = !item.showTs;
      wrap.classList.toggle('is-time-shown', !!item.showTs);
    });
    item.node = wrap;
    return wrap;
  }

  function renderAssistant(item) {
    var wrap = el('div', {
      class:
        'msg msg-assistant' +
        (item.streaming ? ' is-streaming' : '') +
        (item.showTs ? ' is-time-shown' : '')
    });

    var details = el('details', {
      class: 'reasoning',
      attrs: { hidden: item.reasoning ? null : '' }
    });
    details.appendChild(el('summary', { text: 'Reasoning' }));
    var reasonBody = el('div', { class: 'reasoning-body' });
    if (item.reasoning) {
      reasonBody.appendChild(renderMarkdown(item.reasoning));
      if (item.streaming) details.open = true;
    }
    details.appendChild(reasonBody);
    wrap.appendChild(details);

    var md = el('div', { class: 'md' });
    if (item.text) {
      md.appendChild(renderMarkdown(item.text, { cursor: !!item.streaming }));
    } else if (item.streaming) {
      md.appendChild(el('p', { class: 'md-p' }, cursorNode()));
    }
    wrap.appendChild(md);

    /* Per-message actions: copy the prose, or tap the message to reveal
       its timestamp (kept out of the way until asked for). */
    var foot = el('div', { class: 'msg-foot' });
    var copy = el('button', {
      class: 'msg-action',
      attrs: { type: 'button', 'aria-label': 'Copy message' }
    });
    copy.append(icon('copy'), el('span', { text: 'Copy' }));
    copy.addEventListener('click', function () {
      copyText(item.text || '', copy, 'Copy');
    });
    foot.appendChild(copy);
    var timeText = fmtMsgTime(item.ts);
    if (timeText) {
      foot.appendChild(
        el('time', {
          class: 'msg-time',
          attrs: { datetime: isoTime(item.ts) },
          text: timeText
        })
      );
    }
    wrap.appendChild(foot);

    md.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('a, button')) return;
      item.showTs = !item.showTs;
      wrap.classList.toggle('is-time-shown', !!item.showTs);
    });

    item.node = wrap;
    item.mdEl = md;
    item.reasonItem = details;
    item.reasonBody = reasonBody;
    return wrap;
  }

  function cursorNode() {
    return el('span', { class: 'cursor', attrs: { 'aria-hidden': 'true' } });
  }

  function toolSymbol(name) {
    var n = String(name || '').toLowerCase();
    if (/^(pwsh|powershell|bash|sh|zsh|shell|cmd|terminal|exec|run)/.test(n)) {
      return 'terminal';
    }
    if (/^(read|write|edit|file|patch|apply|notebook)/.test(n)) return 'file';
    if (/^(grep|search|glob|find|rg|ls|list)/.test(n)) return 'search';
    if (/^(browser|web|fetch|http|globe)/.test(n)) return 'globe';
    return 'layers';
  }

  function renderTool(item) {
    var open = !!item.expanded;
    var wrap = el('div', {
      class:
        'tool' +
        (item.ok === false ? ' is-error' : '') +
        (open ? ' is-open' : '')
    });
    var head = el('button', {
      class: 'tool-head',
      attrs: { type: 'button', 'aria-expanded': open ? 'true' : 'false' }
    });
    var side = el('span', { class: 'tool-side' });
    var main = el('span', { class: 'tool-main' });
    main.appendChild(el('span', { class: 'tool-name', text: item.name || 'tool' }));
    main.appendChild(
      el('span', {
        class: 'tool-title',
        text: item.title || item.argsPreview || ''
      })
    );
    head.append(
      el('span', { class: 'tool-glyph' }, icon(toolSymbol(item.name))),
      main,
      side
    );
    fillToolSide(side, item);
    wrap.appendChild(head);

    /* The body uses a grid-row height transition; the inner wrapper clips it,
       and the padded child keeps its spacing without forcing height when
       collapsed. */
    var body = el('div', { class: 'tool-body' });
    var inner = el('div', { class: 'tool-body-inner' });
    var pad = el('div', { class: 'tool-body-pad' });
    var argText = formatDetail(item.detail) || item.argsPreview || '';
    if (argText) {
      pad.appendChild(el('p', { class: 'tool-section-label', text: 'Input' }));
      pad.appendChild(preNode(argText, 'tool-args'));
    }
    if (item.output) {
      pad.appendChild(
        el('p', {
          class: 'tool-section-label',
          text: item.ok === false ? 'Error output' : 'Output'
        })
      );
      pad.appendChild(preNode(item.output, 'tool-output'));
    } else if (item.ok === null || item.ok === undefined) {
      pad.appendChild(
        el('p', {
          class: 'tool-empty',
          text: 'Waiting for the tool to finish…'
        })
      );
    }
    inner.appendChild(pad);
    body.appendChild(inner);
    wrap.appendChild(body);

    head.addEventListener('click', function () {
      item.expanded = !item.expanded;
      wrap.classList.toggle('is-open', item.expanded);
      head.setAttribute('aria-expanded', item.expanded ? 'true' : 'false');
      if (item.expanded && S.pinned) scrollToBottom(false);
    });

    item.node = wrap;
    item.expanded = open;
    return wrap;
  }

  function fillToolSide(side, item) {
    side.replaceChildren();
    if (item.ok === null || item.ok === undefined) {
      side.appendChild(
        el('span', { class: 'spin', attrs: { 'aria-label': 'Running' } })
      );
      side.appendChild(
        el('span', { class: 'tool-status is-running', text: 'Running' })
      );
    } else {
      if (typeof item.durationMs === 'number') {
        side.appendChild(
          el('span', {
            class: 'tool-dur',
            text: formatDuration(item.durationMs)
          })
        );
      }
      side.appendChild(
        el('span', {
          class: 'tool-status ' + (item.ok ? 'is-ok' : 'is-error'),
          text: item.ok ? 'Done' : 'Failed'
        })
      );
    }
    side.appendChild(el('span', { class: 'tool-chevron' }, icon('chevron-down')));
  }

  function refreshToolNode(item) {
    var old = item.node;
    if (!old || !old.parentNode) return;
    var fresh = renderTool(item);
    old.parentNode.replaceChild(fresh, old);
  }

  /* ---------- Question cards ---------------------------------------------- */

  function questionStatusChip(item) {
    var text = 'Needs answer';
    var cls = 'is-pending';
    if (item.status === 'waiting' || item.status === 'submitting') {
      text = 'Waiting';
      cls = 'is-waiting';
    } else if (item.status === 'answered') {
      text = 'Answered';
      cls = 'is-answered';
    } else if (item.status === 'declined') {
      text = 'Skipped';
      cls = 'is-declined';
    } else if (item.status === 'unavailable') {
      text = 'Unavailable';
      cls = 'is-unavailable';
    }
    return el('span', { class: 'question-status ' + cls, text: text });
  }

  function renderQuestionOption(item, q, opt) {
    var draft = ensureQuestionDraft(item, q.id);
    var checked = draft.selected.indexOf(opt.label) !== -1;
    var input = el('input', {
      class: 'q-input',
      attrs: {
        type: q.multiSelect ? 'checkbox' : 'radio',
        name: 'q-' + item.id + '-' + q.id,
        value: opt.label
      }
    });
    input.checked = checked;
    var option = el('label', { class: 'q-option' + (checked ? ' is-selected' : '') });
    var control = el('span', { class: 'q-control', attrs: { 'aria-hidden': 'true' } });
    var textWrap = el(
      'span',
      { class: 'q-option-text' },
      el('span', { class: 'q-option-label', text: opt.label })
    );
    if (opt.description) {
      textWrap.appendChild(
        el('span', { class: 'q-option-desc', text: opt.description })
      );
    }
    option.append(input, control, textWrap);

    input.addEventListener('change', function () {
      var current = ensureQuestionDraft(item, q.id);
      if (q.multiSelect) {
        var index = current.selected.indexOf(opt.label);
        if (input.checked && index === -1) current.selected.push(opt.label);
        if (!input.checked && index !== -1) current.selected.splice(index, 1);
        option.classList.toggle('is-selected', input.checked);
      } else {
        current.selected = input.checked ? [opt.label] : [];
        var group = option.parentNode;
        if (group) {
          Array.prototype.forEach.call(group.children, function (node) {
            if (!node.classList || !node.classList.contains('q-option')) return;
            var selected = node === option && input.checked;
            node.classList.toggle('is-selected', selected);
            var sibling = node.querySelector('.q-input');
            if (sibling && sibling !== input) sibling.checked = false;
          });
        }
      }
      updateQuestionControls(item);
    });
    return option;
  }

  function renderQuestionCustom(item, q) {
    var draft = ensureQuestionDraft(item, q.id);
    var wrap = el('label', { class: 'q-custom' });
    wrap.appendChild(el('span', { class: 'q-custom-label', text: 'Other' }));
    var input = el('input', {
      class: 'q-custom-input',
      attrs: {
        type: 'text',
        maxlength: '280',
        placeholder: 'Type your own answer (optional)',
        autocomplete: 'off',
        'aria-label': 'Custom answer for ' + (q.question || 'question')
      }
    });
    input.value = draft.custom || '';
    input.addEventListener('input', function () {
      ensureQuestionDraft(item, q.id).custom = input.value;
      updateQuestionControls(item);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function renderQuestionBlock(item, q, index, resolved) {
    var block = el('div', { class: 'q-block' });
    var meta = el('div', { class: 'q-meta' });
    if (item.questions.length > 1) {
      meta.appendChild(
        el('span', {
          class: 'q-index',
          text: 'Question ' + (index + 1) + ' of ' + item.questions.length
        })
      );
    }
    if (meta.childNodes.length) block.appendChild(meta);
    block.appendChild(el('p', { class: 'q-label', text: q.question || 'Question' }));
    if (q.detail) block.appendChild(el('p', { class: 'q-detail', text: q.detail }));

    if (resolved) {
      var summary = answerSummary(item, q, index);
      block.appendChild(
        el(
          'div',
          { class: 'q-answer' + (summary === 'Answered' ? ' is-generic' : '') },
          el('span', { class: 'q-answer-label', text: 'Answer' }),
          el('span', { class: 'q-answer-value', text: summary })
        )
      );
      return block;
    }

    if (q.options.length) {
      var options = el('div', {
        class: 'q-options',
        attrs: {
          role: q.multiSelect ? 'group' : 'radiogroup',
          'aria-label': q.question || 'Question'
        }
      });
      q.options.forEach(function (opt) {
        options.appendChild(renderQuestionOption(item, q, opt));
      });
      block.appendChild(options);
    }
    block.appendChild(renderQuestionCustom(item, q));
    return block;
  }

  function renderQuestionOutcome(item) {
    var positive = item.outcome === 'answered';
    var label =
      item.outcome === 'answered'
        ? 'Answered'
        : item.outcome === 'declined'
          ? 'Skipped'
          : 'No longer available';
    return el(
      'div',
      {
        class:
          'question-outcome' +
          (positive
            ? ' is-answered'
            : item.outcome === 'declined'
              ? ' is-declined'
              : ' is-unavailable')
      },
      icon(positive ? 'check' : 'x'),
      el('span', { text: label })
    );
  }

  function updateQuestionControls(item) {
    if (!item.submitNode) return;
    item.submitNode.disabled = !hasDraftAnswer(item);
  }

  function renderQuestion(item) {
    var ready = isQuestionReady(item);
    var waiting = item.status === 'waiting' || item.status === 'submitting';
    var wrap = el('div', {
      class:
        'question' +
        (ready ? (waiting ? ' is-waiting' : ' is-pending') : ' is-resolved') +
        (item.readOnly ? ' is-readonly' : '')
    });

    var eyebrow = 'Question';
    if (item.questions.length && item.questions[0].header) {
      eyebrow = item.questions[0].header;
    } else if (item.title) {
      eyebrow = item.title;
    }
    var titles = el(
      'div',
      { class: 'question-titles' },
      el('p', { class: 'question-eyebrow', text: eyebrow })
    );
    if (item.questions.length > 1) {
      titles.appendChild(
        el('p', {
          class: 'question-progress',
          text: item.questions.length + ' questions'
        })
      );
    }
    var head = el('div', { class: 'question-head' }, titles, questionStatusChip(item));
    wrap.appendChild(head);

    var foreignSession = isForeignInteraction(item);
    item.otherSession = foreignSession;
    if (foreignSession) {
      var foreignLabel =
        sessionLabelFor(item.sessionId) ||
        item.sessionLabel ||
        'another session';
      var sessionRow = el(
        'div',
        { class: 'question-session' },
        el('span', { text: 'In ' + foreignLabel })
      );
      var openSessionButton = el('button', {
        class: 'btn btn-ghost',
        attrs: { type: 'button' },
        text: 'Open session'
      });
      openSessionButton.addEventListener('click', function () {
        openSession(item.sessionId, {});
      });
      sessionRow.appendChild(openSessionButton);
      wrap.appendChild(sessionRow);
    }

    if (!item.questions.length) {
      wrap.appendChild(
        el('p', {
          class: 'question-empty',
          text:
            item.status === 'pending'
              ? 'Waiting for the question from the Harness…'
              : 'No question details were recorded.'
        })
      );
    }

    item.questions.forEach(function (q, index) {
      wrap.appendChild(renderQuestionBlock(item, q, index, !ready || waiting));
    });

    if (!ready) {
      wrap.appendChild(renderQuestionOutcome(item));
      item.submitNode = null;
    } else if (waiting) {
      wrap.appendChild(
        el(
          'div',
          { class: 'question-waiting', attrs: { role: 'status' } },
          el('span', { class: 'spin' }),
          el('span', { text: 'Waiting for Harness…' })
        )
      );
      wrap.appendChild(
        el(
          'div',
          { class: 'question-actions' },
          el('button', {
            class: 'btn btn-ghost',
            attrs: { type: 'button', disabled: true },
            text: 'Skip'
          }),
          el('button', {
            class: 'btn btn-primary',
            attrs: { type: 'button', disabled: true },
            text: 'Submit'
          })
        )
      );
      item.submitNode = null;
    } else {
      var skip = el('button', {
        class: 'btn btn-ghost',
        attrs: { type: 'button' },
        text: 'Skip'
      });
      var submit = el('button', {
        class: 'btn btn-primary',
        attrs: { type: 'button' },
        text: 'Submit'
      });
      submit.disabled = !hasDraftAnswer(item);
      skip.addEventListener('click', function () {
        skipQuestion(item);
      });
      submit.addEventListener('click', function () {
        submitQuestion(item);
      });
      wrap.appendChild(el('div', { class: 'question-actions' }, skip, submit));
      wrap.appendChild(
        el('p', {
          class: 'question-hint',
          text: 'Answer any questions, then submit the batch — or skip it.'
        })
      );
      item.submitNode = submit;
    }

    item.node = wrap;
    return wrap;
  }

  function refreshQuestionNode(item) {
    var old = item.node;
    if (!old || !old.parentNode) return;
    var fresh = renderQuestion(item);
    old.parentNode.replaceChild(fresh, old);
    item.node = fresh;
  }

  function approvalArgsLabel(item) {
    var kind = item.argsKind || (item.detail && item.detail.kind) || '';
    if (kind === 'command') return 'Command';
    if (kind === 'write') return 'File write';
    if (kind === 'edit') return 'Edit';
    return 'Details';
  }

  function approvalArgsBlock(item) {
    var preview = String(item.argsPreview || '');
    var path = item.detail && item.detail.path ? String(item.detail.path) : '';
    if (!preview && !path) return null;
    var block = el('div', { class: 'approval-args' });
    var head = el(
      'div',
      { class: 'approval-args-head' },
      el('span', { class: 'approval-tag', text: approvalArgsLabel(item) })
    );
    if (path) head.appendChild(el('span', { class: 'approval-path', text: path }));
    block.appendChild(head);
    if (preview) {
      var lines = preview.split('\n');
      var expanded = !!item.argsExpanded;
      var shown =
        expanded || lines.length <= 6
          ? preview
          : lines.slice(0, 6).join('\n') + '\n…';
      var pre = preNode(shown, 'approval-args-pre');
      block.appendChild(pre);
      if (lines.length > 6) {
        pre.classList.add('is-collapsible');
        pre.addEventListener('click', function () {
          item.argsExpanded = !item.argsExpanded;
          refreshApprovalNode(item);
        });
        var toggle = el('button', {
          class: 'approval-args-toggle',
          attrs: { type: 'button', 'aria-expanded': expanded ? 'true' : 'false' }
        });
        toggle.appendChild(
          el('span', {
            class: 'approval-args-more',
            text: expanded ? 'Show less' : 'Show more'
          })
        );
        toggle.addEventListener('click', function () {
          item.argsExpanded = !item.argsExpanded;
          refreshApprovalNode(item);
        });
        block.appendChild(toggle);
      }
    }
    return block;
  }

  function refreshApprovalsForPermission() {
    var seen = [];
    S.approvals.forEach(function (item) {
      if (seen.indexOf(item) !== -1) return;
      seen.push(item);
      refreshApprovalNode(item);
    });
    S.messages.forEach(function (message) {
      if (message.kind !== 'approval') return;
      if (seen.indexOf(message) !== -1) return;
      seen.push(message);
      refreshApprovalNode(message);
    });
    if (S.view === 'activity') renderActivity();
    renderSessionNotice();
  }

  function renderApproval(item) {
    var wrap = el('div', {
      class: 'approval' + (item.resolved ? ' is-resolved' : '')
    });
    wrap.appendChild(
      el(
        'div',
        { class: 'approval-head' },
        el('span', { class: 'approval-glyph' }, icon('alert')),
        el(
          'div',
          { class: 'approval-titles' },
          el('p', {
            class: 'approval-eyebrow',
            text: item.title || 'Approval required'
          }),
          el('p', { class: 'approval-tool', text: item.toolName || 'tool' })
        )
      )
    );

    var reasonText = item.displayReason || item.reason;
    if (reasonText) {
      wrap.appendChild(el('p', { class: 'approval-reason', text: reasonText }));
    }
    var argsBlock = approvalArgsBlock(item);
    if (argsBlock) wrap.appendChild(argsBlock);
    if (item.callId) {
      wrap.appendChild(
        el('p', { class: 'approval-meta', text: 'Call ' + item.callId })
      );
    }
    var foreignApproval = isForeignInteraction(item);
    item.otherSession = foreignApproval;
    if (foreignApproval) {
      var foreignApprovalLabel =
        sessionLabelFor(item.sessionId) ||
        item.sessionLabel ||
        'another session';
      wrap.appendChild(
        el('p', {
          class: 'approval-meta',
          text: 'This approval belongs to ' + foreignApprovalLabel
        })
      );
      var openSessionBtn = el('button', {
        class: 'btn btn-ghost',
        attrs: { type: 'button' },
        text: 'Open ' + foreignApprovalLabel
      });
      openSessionBtn.addEventListener('click', function () {
        openSession(item.sessionId, {});
      });
      wrap.appendChild(el('div', { class: 'approval-actions' }, openSessionBtn));
    }

    var canApprove = deviceCanApprove();
    if (item.resolved) {
      wrap.appendChild(approvalOutcomeNode(item));
    } else {
      var reject = el('button', {
        class: 'btn btn-ghost',
        attrs: { type: 'button' },
        text: item.answering ? 'Sending…' : 'Reject'
      });
      var allow = el('button', {
        class: 'btn btn-primary',
        attrs: { type: 'button' },
        text: item.answering ? 'Sending…' : 'Approve'
      });
      if (item.answering || !canApprove) {
        reject.disabled = true;
        allow.disabled = true;
      }
      reject.addEventListener('click', function () {
        answerApproval(item, 'reject');
      });
      allow.addEventListener('click', function () {
        answerApproval(item, 'allow');
      });
      wrap.appendChild(
        el('div', { class: 'approval-actions' }, reject, allow)
      );
      if (!canApprove) {
        wrap.appendChild(
          el('p', {
            class: 'approval-readonly',
            text:
              "This device can't answer approvals — answer on the desktop or another phone."
          })
        );
      }
    }

    item.node = wrap;
    return wrap;
  }

  function approvalOutcomeNode(item) {
    var label = 'Resolved';
    var positive = false;
    if (item.outcome === 'allowed-once') {
      label = 'Approved';
      positive = true;
    } else if (item.outcome === 'rejected') {
      label = 'Rejected';
    } else if (item.outcome === 'cancelled') {
      label = 'Cancelled';
    } else if (item.outcome === 'unavailable') {
      label = 'No longer available';
    }
    return el(
      'div',
      {
        class:
          'approval-outcome' +
          (positive
            ? ' is-allowed'
            : item.outcome === 'rejected'
              ? ' is-rejected'
              : '')
      },
      icon(positive ? 'check' : 'x'),
      el('span', { text: label })
    );
  }

  function refreshApprovalNode(item) {
    var old = item.node;
    if (!old || !old.parentNode) return;
    var fresh = renderApproval(item);
    old.parentNode.replaceChild(fresh, old);
    item.node = fresh;
  }

  function answerApproval(item, decision) {
    if (!item || item.resolved || item.answering) return;
    if (!deviceCanApprove()) {
      toast(
        "This device can't answer approvals — answer on the desktop or another phone."
      );
      return;
    }
    if (S.conn !== 'online') {
      toast('Still reconnecting — try again in a moment.');
      return;
    }
    item.answering = true;
    refreshApprovalNode(item);
    var sent = sendFrame({
      type: 'approval.answer',
      requestId: item.requestId,
      decision: decision
    });
    if (!sent) {
      item.answering = false;
      refreshApprovalNode(item);
      toast('Could not send your answer.');
      return;
    }
    haptic(decision === 'allow' ? 12 : 10);
    setTimeout(function () {
      if (item.answering && !item.resolved) {
        item.answering = false;
        refreshApprovalNode(item);
      }
    }, 15000);
  }

  function renderError(item) {
    var wrap = el(
      'div',
      { class: 'msg msg-error' },
      icon('alert'),
      el('span', { text: item.text || 'Something went wrong.' })
    );
    item.node = wrap;
    return wrap;
  }

  function renderSystem(item) {
    var wrap = el('div', {
      class: 'msg msg-system',
      text: item.text || ''
    });
    item.node = wrap;
    return wrap;
  }

  function renderEmptySession(container) {
    var inner = el('div', { class: 'empty-inner' });
    inner.appendChild(
      el('div', { class: 'logo-mark empty-mark' }, logoSvg())
    );
    inner.appendChild(
      el('h2', {
        class: 'empty-title',
        text: S.sessions.length ? 'No session open' : 'No sessions yet'
      })
    );
    inner.appendChild(
      el('p', {
        class: 'empty-sub',
        text: S.sessions.length
          ? 'Pick a session from your desktop, or start a fresh one.'
          : 'Start a session to control DeepSeek Harness from this phone.'
      })
    );
    var actions = el('div', { class: 'empty-actions' });
    if (S.sessions.length) {
      actions.appendChild(
        el('button', {
          class: 'btn btn-ghost',
          attrs: { type: 'button' },
          text: 'Browse sessions',
          on: {
            click: function () {
              openSheet('sessions');
            }
          }
        })
      );
    }
    actions.appendChild(
      el('button', {
        class: 'btn btn-primary',
        attrs: { type: 'button' },
        text: 'New session',
        on: {
          click: function () {
            openSheet('new-session');
          }
        }
      })
    );
    inner.appendChild(actions);
    container.appendChild(el('div', { class: 'empty' }, inner));
  }

  function renderEmptyChat(container) {
    var inner = el('div', { class: 'empty-inner' });
    inner.appendChild(
      el('h2', {
        class: 'empty-title',
        text: S.session && S.session.title ? S.session.title : 'New session'
      })
    );
    inner.appendChild(
      el('p', {
        class: 'empty-sub',
        text: 'This session is empty. Send a message below — tool calls, approvals and step boundaries will appear here as the agent works.'
      })
    );
    var chips = el('div', { class: 'chips' });
    [
      'Summarise what changed in this repo today.',
      'Continue where we left off.',
      'Run the tests and report any failures.'
    ].forEach(function (text) {
      chips.appendChild(
        el('button', {
          class: 'chip',
          attrs: { type: 'button' },
          text: text,
          on: {
            click: function () {
              refs.composerInput.value = text;
              autosizeComposer();
              try {
                refs.composerInput.focus({ preventScroll: true });
              } catch (err) {
                /* ignore */
              }
            }
          }
        })
      );
    });
    inner.appendChild(chips);
    container.appendChild(el('div', { class: 'empty' }, inner));
  }

  function renderTypingNode() {
    var existing = refs.messages.querySelector('.typing');
    if (existing) existing.remove();
    if (S.phase !== 'app' || S.view !== 'chat') return;
    if (!S.session || !S.messages.length) return;
    if (S.conn !== 'online') return;
    /* While an approval is open the agent is waiting on the user, not typing. */
    var pendingApproval = false;
    S.approvals.forEach(function (approval) {
      if (
        !approval.resolved &&
        (!approval.sessionId || approval.sessionId === S.activeSessionId)
      ) {
        pendingApproval = true;
      }
    });
    if (pendingApproval) return;
    /* A waiting question means the agent is waiting on the user too. */
    var pendingQuestion = false;
    S.questions.forEach(function (question) {
      if (
        isQuestionReady(question) &&
        (!question.sessionId || question.sessionId === S.activeSessionId)
      ) {
        pendingQuestion = true;
      }
    });
    if (pendingQuestion) return;
    var show =
      S.typing ||
      (!!(S.session && S.session.running) && !S.live && S.activeTools.size === 0);
    if (!show) return;
    refs.messages.appendChild(
      el(
        'div',
        {
          class: 'typing',
          attrs: { role: 'status', 'aria-label': 'Assistant is working' }
        },
        el('span', { class: 'typing-dot' }),
        el('span', { class: 'typing-dot' }),
        el('span', { class: 'typing-dot' })
      )
    );
  }

  function updateTyping() {
    if (S.view === 'chat') renderTypingNode();
  }

  /* ---------- Header / composer chrome ----------------------------------- */

  function renderHeader() {
    if (!S.session) {
      refs.sessionTitle.textContent = S.sessions.length
        ? 'Select a session'
        : 'Sessions';
    } else {
      refs.sessionTitle.textContent = S.creatingSession
        ? 'Creating session…'
        : S.session.title || 'Session';
    }
    renderHeaderState();
    renderComposerMeta();
  }

  function renderHeaderState() {
    var dot = refs.statusDot;
    dot.className = 'statusdot';
    var stateText = '';

    if (S.conn === 'offline') {
      dot.classList.add('is-offline');
      stateText = 'Offline';
    } else if (S.conn !== 'online') {
      stateText = S.conn === 'connecting' ? 'Connecting…' : 'Reconnecting…';
    } else if (S.session && S.session.running) {
      dot.classList.add('is-running');
      stateText =
        'Working' +
        (S.runningSince ? ' · ' + formatElapsed(Date.now() - S.runningSince) : '');
    } else if (S.session) {
      stateText = 'Ready';
    } else {
      stateText = 'No session';
    }

    refs.sessionState.textContent = stateText;

    var running = !!(S.session && S.session.running);
    refs.btnStop.hidden = !running || sessionIsArchived();
    refs.btnStop.disabled = S.stopPending;
    refs.btnStop.classList.toggle('is-stopping', S.stopPending);
  }

  function currentModel() {
    if (S.session && S.session.model && S.session.model.provider) {
      return S.session.model;
    }
    if (S.models && S.models.current) return S.models.current;
    return null;
  }

  function modelLabel() {
    var current = currentModel();
    if (!current) return '';
    if (S.models && S.models.catalog) {
      for (var i = 0; i < S.models.catalog.length; i++) {
        var m = S.models.catalog[i];
        if (m.provider === current.provider && m.model === current.model) {
          return m.label || m.model || '';
        }
      }
    }
    return current.model || '';
  }

  function catalogEntry(provider, model) {
    if (!S.models || !S.models.catalog) return null;
    for (var i = 0; i < S.models.catalog.length; i++) {
      var m = S.models.catalog[i];
      if (m && m.provider === provider && m.model === model) return m;
    }
    return null;
  }

  /**
   * Resolve the effort entry a model would use for a given selection id. A null
   * id means "provider default": the advertised defaultEffort when there is one,
   * otherwise no named effort. Returns null when the model has no reasoning
   * control or no effort can be resolved.
   */
  function effortEntry(model, effortId) {
    if (!model || !model.reasoning) return null;
    var efforts = Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
    var wanted = effortId || model.reasoning.defaultEffort || null;
    if (!wanted) return null;
    for (var i = 0; i < efforts.length; i++) {
      if (efforts[i] && efforts[i].id === wanted) return efforts[i];
    }
    return null;
  }

  function effortName(model, effortId) {
    var entry = effortEntry(model, effortId);
    return entry ? entry.name || entry.id || '' : '';
  }

  /**
   * Bottom-right chip and ⋯ menu label: the model label alone when the model has
   * no reasoning control (or no effort is active), `Label · Effort` when it does.
   */
  function modelDisplayLabel() {
    var current = currentModel();
    var label = modelLabel();
    if (!current || !label) return '';
    var entry = catalogEntry(current.provider, current.model);
    if (!entry || !entry.reasoning) return label;
    var suffix = effortName(entry, current.reasoningEffort);
    return suffix ? label + ' · ' + suffix : label;
  }

  /**
   * True while the active session is archived. Archived sessions are readable
   * but must not send, attach, dictate or stop; the server refuses work on them.
   */
  function sessionIsArchived() {
    return !!(S.session && S.session.archived === true);
  }

  function presetLabel(presetId) {
    var id = presetId || (S.presets && S.presets.current);
    if (!id) return '';
    if (S.presets && S.presets.list) {
      for (var i = 0; i < S.presets.list.length; i++) {
        if (S.presets.list[i].id === id) {
          return S.presets.list[i].title || id;
        }
      }
    }
    return id;
  }

  function renderComposerMeta() {
    var note = refs.composerNote;
    var running = !!(S.session && S.session.running);
    var uploading = isUploading();
    var failed = failedAttachments();
    var ready = readyAttachments();
    note.classList.toggle('is-running', running || uploading);

    if (uploading) {
      var pendingCount = S.uploads.filter(function (entry) {
        return entry.status === 'queued' || entry.status === 'uploading';
      }).length;
      note.textContent =
        'Uploading ' +
        pendingCount +
        ' file' +
        (pendingCount === 1 ? '' : 's') +
        '…';
    } else if (failed.length) {
      note.textContent =
        'Remove failed upload' + (failed.length === 1 ? '' : 's') + ' to send';
    } else if (S.conn === 'offline') {
      note.textContent = 'Offline — messages will not send';
    } else if (S.conn !== 'online') {
      note.textContent = 'Reconnecting…';
    } else if (sessionIsArchived()) {
      note.textContent = 'Archived — read only';
    } else if (running) {
      note.textContent = S.stopPending
        ? 'Stopping…'
        : S.promptMode === 'steer'
          ? 'Steering the current step'
          : 'Working — you can queue or steer';
    } else if (!S.session) {
      note.textContent = 'Choose a session to start';
    } else {
      note.textContent = 'Ready';
    }

    renderPromptMode();
    renderContextMeter();
    var modeVisible = !!(
      S.session &&
      S.session.running &&
      S.session.agentAvailable &&
      !S.session.archived
    );
    var label = modelDisplayLabel();
    refs.composerModel.textContent = label;
    refs.composerModel.hidden = !label || modeVisible;

    if (voice.active) {
      refs.composerInput.placeholder = 'Listening…';
    } else if (sessionIsArchived()) {
      refs.composerInput.placeholder = 'Archived session — read only';
    } else if (!S.session) {
      refs.composerInput.placeholder = 'Choose a session to start…';
    } else if (ready.length) {
      refs.composerInput.placeholder = 'Add a message… (optional)';
    } else {
      refs.composerInput.placeholder = 'Message…';
    }
  }

  function updateSendState() {
    var text = refs.composerInput.value.trim();
    var uploading = isUploading();
    var ready = readyAttachments();
    var failed = failedAttachments();
    var archived = sessionIsArchived();
    refs.btnSend.disabled =
      (!text && !ready.length) ||
      uploading ||
      failed.length > 0 ||
      S.phase !== 'app' ||
      S.conn !== 'online' ||
      archived;
    if (refs.attachBtn) {
      refs.attachBtn.disabled =
        S.phase !== 'app' || S.conn !== 'online' || !S.activeSessionId || archived;
      refs.attachBtn.setAttribute(
        'aria-disabled',
        refs.attachBtn.disabled ? 'true' : 'false'
      );
    }
    if (refs.btnMic) {
      refs.btnMic.disabled = archived;
    }
  }

  function updateActivityBadge() {
    var show = S.unseenActivity > 0;
    refs.tabBadge.hidden = !show;
    if (show) {
      refs.tabBadge.setAttribute(
        'aria-label',
        S.unseenActivity + ' new activity events'
      );
    } else {
      refs.tabBadge.removeAttribute('aria-label');
    }
  }

  /* ---------- Attachments ------------------------------------------------- */

  var MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg'
  };

  function formatBytes(bytes) {
    var size = Number(bytes) || 0;
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) {
      return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
    }
    if (size < 1024 * 1024 * 1024) {
      return (size / (1024 * 1024)).toFixed(1) + ' MB';
    }
    return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function guessMediaType(name, fallback) {
    var type = String(fallback || '').trim();
    if (type) return type;
    var parts = String(name || '').split('.');
    var ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }

  /* HTTP header values are byte strings: replace non-Latin-1 characters and
     control characters with "_" so the filename survives the header boundary.
     The UI always keeps the original file name. */
  function headerSafeName(name) {
    var source = String(name || 'file')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    var out = '';
    for (var i = 0; i < source.length && out.length < 180; i++) {
      var code = source.charCodeAt(i);
      if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
        out += source.charAt(i);
      } else {
        out += '_';
      }
    }
    return out || 'file';
  }

  function headerSafeMediaType(type) {
    var clean = String(type || '')
      .replace(/[\r\n]+/g, '')
      .trim();
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(clean)) {
      return 'application/octet-stream';
    }
    return clean;
  }

  function svgNode(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          node.setAttribute(key, attrs[key]);
        }
      }
    }
    return node;
  }

  function attachmentGlyph(mediaType) {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (/^image\//i.test(String(mediaType || ''))) {
      svg.appendChild(
        svgNode('rect', { x: '3.4', y: '4.4', width: '17.2', height: '15.2', rx: '2.6' })
      );
      svg.appendChild(svgNode('circle', { cx: '8.8', cy: '9.8', r: '1.6' }));
      svg.appendChild(
        svgNode('path', { d: 'm4.6 17.2 4.4-4.4 3.2 3.2 2.8-2.8 4.6 4.6' })
      );
    } else {
      svg.appendChild(
        svgNode('path', {
          d: 'M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'
        })
      );
    }
    return svg;
  }

  function buildAttachmentUI() {
    if (!refs.composer || refs.attachBtn) return;
    var shell = refs.composer.querySelector('.composer-shell');
    var box = refs.composer.querySelector('.composer-box');
    if (!shell || !box) return;

    refs.attachmentTray = el('div', {
      class: 'attachments',
      attrs: { hidden: '', 'aria-live': 'polite' }
    });
    shell.insertBefore(refs.attachmentTray, box);

    refs.attachBtn = el(
      'button',
      {
        class: 'attach-btn',
        attrs: {
          type: 'button',
          'aria-label': 'Attach files',
          title: 'Attach files'
        }
      },
      attachmentGlyph()
    );
    box.insertBefore(refs.attachBtn, refs.composerInput);

    refs.attachInput = el('input', {
      class: 'attach-input',
      attrs: {
        type: 'file',
        multiple: '',
        tabindex: '-1',
        'aria-hidden': 'true'
      }
    });
    document.body.appendChild(refs.attachInput);
    refs.attachmentTray.hidden = true;
  }

  var lightboxHideTimer = null;

  function buildLightbox() {
    if (refs.lightbox) return;
    var overlay = el('div', {
      class: 'lightbox',
      attrs: {
        hidden: '',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Attachment preview'
      }
    });
    var image = el('img', { class: 'lightbox-img', attrs: { alt: '' } });
    var close = el(
      'button',
      {
        class: 'lightbox-close',
        attrs: { type: 'button', 'aria-label': 'Close preview' }
      },
      icon('x')
    );
    var caption = el('p', { class: 'lightbox-caption' });
    overlay.append(image, close, caption);
    document.body.appendChild(overlay);
    refs.lightbox = overlay;
    refs.lightboxImg = image;
    refs.lightboxClose = close;
    refs.lightboxCaption = caption;

    close.addEventListener('click', function (event) {
      event.stopPropagation();
      closeLightbox();
    });
    overlay.addEventListener('click', function (event) {
      if (
        event.target === overlay ||
        event.target === image ||
        event.target === caption
      ) {
        closeLightbox();
      }
    });
    image.addEventListener('error', function () {
      overlay.classList.add('is-error');
      caption.textContent = 'Preview unavailable';
      caption.hidden = false;
    });
    image.addEventListener('load', function () {
      overlay.classList.remove('is-error');
    });
  }

  function openLightbox(src, name) {
    if (!refs.lightbox || !src) return;
    clearTimeout(lightboxHideTimer);
    refs.lightboxOpener = document.activeElement;
    refs.lightbox.classList.remove('is-error');
    refs.lightboxImg.src = src;
    refs.lightboxImg.alt = name ? String(name) : 'Attachment preview';
    refs.lightboxCaption.textContent = name ? String(name) : '';
    refs.lightboxCaption.hidden = !name;
    refs.lightbox.hidden = false;
    window.requestAnimationFrame(function () {
      refs.lightbox.classList.add('is-open');
    });
    try {
      refs.lightboxClose.focus({ preventScroll: true });
    } catch (err) {
      /* ignore */
    }
    haptic(6);
  }

  function closeLightbox() {
    if (!refs.lightbox || refs.lightbox.hidden) return;
    refs.lightbox.classList.remove('is-open');
    var opener = refs.lightboxOpener;
    refs.lightboxOpener = null;
    clearTimeout(lightboxHideTimer);
    lightboxHideTimer = setTimeout(
      function () {
        if (!refs.lightbox.classList.contains('is-open')) {
          refs.lightbox.hidden = true;
          refs.lightboxImg.removeAttribute('src');
          refs.lightbox.classList.remove('is-error');
        }
      },
      reduceMotion ? 0 : 220
    );
    if (opener && document.contains(opener) && typeof opener.focus === 'function') {
      try {
        opener.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    }
  }

  function isUploading() {
    for (var i = 0; i < S.uploads.length; i++) {
      var status = S.uploads[i].status;
      if (status === 'queued' || status === 'uploading') return true;
    }
    return false;
  }

  function readyAttachments() {
    var out = [];
    S.uploads.forEach(function (entry) {
      if (entry.status === 'done' && entry.result) out.push(entry.result);
    });
    return out;
  }

  function failedAttachments() {
    return S.uploads.filter(function (entry) {
      return entry.status === 'error';
    });
  }

  function attachmentMetadata() {
    var out = [];
    S.uploads.forEach(function (entry) {
      if (entry.status !== 'done') return;
      var image = isImageMediaType(entry.mediaType);
      out.push({
        name: entry.name,
        size: entry.size,
        mediaType: entry.mediaType,
        path:
          entry.result && entry.result.path ? String(entry.result.path) : '',
        relativePath:
          entry.result && entry.result.relativePath
            ? String(entry.result.relativePath)
            : '',
        previewUrl: image ? createPreviewObjectUrl(entry.file) : ''
      });
    });
    return out;
  }

  function createPreviewObjectUrl(file) {
    if (!file || !window.URL || typeof window.URL.createObjectURL !== 'function') {
      return '';
    }
    try {
      return window.URL.createObjectURL(file);
    } catch (err) {
      return '';
    }
  }

  function revokePreviewObjectUrl(url) {
    if (!url || String(url).indexOf('blob:') !== 0) return '';
    try {
      window.URL.revokeObjectURL(url);
    } catch (err) {
      /* ignore */
    }
    return '';
  }

  function isImageMediaType(mediaType) {
    return /^image\//i.test(String(mediaType || ''));
  }

  function isPreviewableImageMediaType(mediaType) {
    return /^image\/(png|jpe?g|webp|gif)$/i.test(String(mediaType || ''));
  }

  function previewSrcForAttachment(attachment) {
    if (!attachment) return '';
    if (attachment.previewUrl) return String(attachment.previewUrl);
    if (!isPreviewableImageMediaType(attachment.mediaType)) return '';
    if (!attachment.path || !S.activeSessionId) return '';
    return (
      '/api/preview?session=' +
      encodeURIComponent(S.activeSessionId) +
      '&path=' +
      encodeURIComponent(String(attachment.path))
    );
  }

  function revokeAttachmentPreviewUrls(attachments) {
    if (!Array.isArray(attachments)) return;
    attachments.forEach(function (attachment) {
      if (attachment && attachment.previewUrl) {
        attachment.previewUrl = revokePreviewObjectUrl(attachment.previewUrl);
      }
    });
  }

  function revokeMessagePreviewUrls(messages) {
    (messages || []).forEach(function (message) {
      if (message && message.kind === 'user') {
        revokeAttachmentPreviewUrls(message.attachments);
      }
    });
  }

  function usedMessagePreviewUrls(messages) {
    var used = {};
    (messages || []).forEach(function (message) {
      if (!message || message.kind !== 'user') return;
      (message.attachments || []).forEach(function (attachment) {
        if (attachment && attachment.previewUrl) {
          used[String(attachment.previewUrl)] = true;
        }
      });
    });
    return used;
  }

  function updateAttachmentMeta(entry) {
    if (!entry.metaNode) return;
    entry.metaNode.textContent = '';
    var text = formatBytes(entry.size);
    if (entry.status === 'queued') text += ' · Queued';
    else if (entry.status === 'uploading') {
      text += ' · Uploading' + (entry.progress > 0 ? ' ' + entry.progress + '%' : '…');
    } else if (entry.status === 'error') {
      text += ' · ' + entry.error;
    } else {
      text += ' · Uploaded';
    }
    entry.metaNode.textContent = text;
  }

  function renderAttachments() {
    var tray = refs.attachmentTray;
    if (!tray) return;
    tray.replaceChildren();
    if (!S.uploads.length) {
      tray.hidden = true;
      return;
    }
    tray.hidden = false;
    S.uploads.forEach(function (entry) {
      var chip = el('div', {
        class: 'attachment-chip is-' + entry.status
      });
      var glyph = el('span', { class: 'attachment-glyph' });
      if (entry.status === 'uploading') {
        glyph.appendChild(el('span', { class: 'spin' }));
      } else if (isImageMediaType(entry.mediaType) && entry.previewUrl) {
        var chipThumb = el('img', {
          class: 'attachment-chip-img',
          attrs: { src: entry.previewUrl, alt: '' }
        });
        chipThumb.addEventListener('error', function () {
          chipThumb.replaceWith(attachmentGlyph(entry.mediaType));
        });
        glyph.appendChild(chipThumb);
      } else {
        glyph.appendChild(attachmentGlyph(entry.mediaType));
      }
      var info = el('div', { class: 'attachment-info' });
      info.appendChild(
        el('span', { class: 'attachment-name', text: entry.name })
      );
      var meta = el('span', { class: 'attachment-meta' });
      info.appendChild(meta);
      entry.metaNode = meta;
      if (entry.status === 'queued' || entry.status === 'uploading') {
        var bar = el(
          'span',
          { class: 'attachment-bar' },
          el('span')
        );
        info.appendChild(bar);
        entry.barFill = bar.firstChild;
      } else {
        entry.barFill = null;
      }
      var remove = el('button', {
        class: 'attachment-remove',
        attrs: {
          type: 'button',
          'aria-label': 'Remove ' + entry.name,
          title: 'Remove ' + entry.name
        }
      });
      remove.appendChild(icon('x'));
      remove.addEventListener('click', function () {
        removeAttachment(entry);
      });
      chip.append(glyph, info, remove);
      entry.node = chip;
      tray.appendChild(chip);
      updateAttachmentMeta(entry);
      if (entry.barFill) {
        entry.barFill.style.width = Math.max(4, entry.progress || 0) + '%';
      }
    });
  }

  function updateAttachmentProgress(entry) {
    if (S.uploads.indexOf(entry) === -1) return;
    if (entry.metaNode) updateAttachmentMeta(entry);
    if (entry.barFill) {
      entry.barFill.style.width = Math.max(4, entry.progress || 0) + '%';
    }
  }

  function removeAttachment(entry) {
    if (!entry) return;
    if (entry.xhr) {
      try {
        entry.xhr.abort();
      } catch (err) {
        /* ignore */
      }
      entry.xhr = null;
    }
    var index = S.uploads.indexOf(entry);
    if (index !== -1) S.uploads.splice(index, 1);
    entry.previewUrl = revokePreviewObjectUrl(entry.previewUrl);
    renderAttachments();
    updateSendState();
    renderComposerMeta();
  }

  function clearAttachments() {
    S.uploads.forEach(function (entry) {
      entry.previewUrl = revokePreviewObjectUrl(entry.previewUrl);
      if (!entry.xhr) return;
      try {
        entry.xhr.abort();
      } catch (err) {
        /* ignore */
      }
      entry.xhr = null;
    });
    S.uploads = [];
    S.uploadPump = false;
    renderAttachments();
    updateSendState();
    renderComposerMeta();
  }

  function queueAttachmentFiles(files) {
    if (!files || !files.length) return;
    if (S.phase !== 'app' || S.conn !== 'online') {
      toast('Reconnecting — try again in a moment.');
      return;
    }
    if (!S.activeSessionId) {
      toast('Open a session first.');
      openSheet('sessions');
      return;
    }
    if (sessionIsArchived()) {
      toast('Archived session — unarchive to attach files.');
      return;
    }
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    var room = MAX_ATTACHMENTS - S.uploads.length;
    if (room <= 0) {
      toast('You can attach up to ' + MAX_ATTACHMENTS + ' files.');
      return;
    }
    if (list.length > room) {
      toast('Only ' + room + ' more file' + (room === 1 ? '' : 's') + ' can be attached.');
      list = list.slice(0, room);
    }
    list.forEach(function (file) {
      var name = file.name || 'file';
      var tooLarge = (file.size || 0) > MAX_UPLOAD_BYTES;
      var mediaType = guessMediaType(name, file.type);
      var entry = {
        id:
          'att-' +
          Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2, 7),
        file: file,
        name: name,
        size: Number(file.size) || 0,
        mediaType: mediaType,
        previewUrl: isImageMediaType(mediaType)
          ? createPreviewObjectUrl(file)
          : '',
        status: tooLarge ? 'error' : 'queued',
        progress: 0,
        error: tooLarge ? 'File is too large (max 32 MB).' : '',
        result: null,
        xhr: null
      };
      S.uploads.push(entry);
      if (tooLarge) toast(name + ': File is too large (max 32 MB).');
    });
    renderAttachments();
    updateSendState();
    renderComposerMeta();
    pumpUploadQueue();
  }

  function uploadAttachment(entry) {
    return new Promise(function (resolve) {
      if (S.uploads.indexOf(entry) === -1) {
        resolve();
        return;
      }
      if (entry.size > MAX_UPLOAD_BYTES) {
        entry.status = 'error';
        entry.error = 'File is too large (max 32 MB).';
        resolve();
        return;
      }
      var sessionId = S.activeSessionId;
      if (!sessionId) {
        entry.status = 'error';
        entry.error = 'No active session.';
        resolve();
        return;
      }

      var xhr = new XMLHttpRequest();
      entry.xhr = xhr;
      var finished = false;

      function finish(status, message, result) {
        if (finished) return;
        finished = true;
        entry.xhr = null;
        if (S.uploads.indexOf(entry) === -1) {
          resolve();
          return;
        }
        if (status === 'done') {
          entry.status = 'done';
          entry.progress = 100;
          entry.error = '';
          entry.result = result;
        } else {
          entry.status = 'error';
          entry.progress = 0;
          entry.error = message || 'Upload failed.';
          toast(entry.name + ': ' + entry.error);
        }
        resolve();
      }

      try {
        xhr.open('POST', '/api/upload', true);
        xhr.withCredentials = true;
        xhr.timeout = 120000;
        xhr.setRequestHeader('x-dsh-session', sessionId);
        xhr.setRequestHeader('x-dsh-filename', headerSafeName(entry.name));
        xhr.setRequestHeader(
          'x-dsh-media-type',
          headerSafeMediaType(entry.mediaType)
        );
      } catch (err) {
        finish('error', 'Could not start the upload.');
        return;
      }

      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable || !event.total) return;
        entry.progress = Math.min(
          99,
          Math.round((event.loaded / event.total) * 100)
        );
        updateAttachmentProgress(entry);
      };

      xhr.onload = function () {
        var data = null;
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch (err) {
          data = null;
        }
        if (xhr.status === 413) {
          finish('error', 'File is too large for the server (max 32 MB).');
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300 || !data || !data.ok) {
          var message =
            data && data.error
              ? String(data.error)
              : 'Upload failed (' + xhr.status + ').';
          if (/too.?large|size|413/i.test(message)) {
            message = 'File is too large (max 32 MB).';
          }
          finish('error', message);
          return;
        }
        var required = ['name', 'path', 'relativePath', 'size', 'mediaType'];
        var complete = true;
        required.forEach(function (key) {
          if (data[key] === undefined || data[key] === null) complete = false;
        });
        if (!complete) {
          finish('error', 'The server returned an incomplete upload response.');
          return;
        }
        finish('done', '', data);
      };
      xhr.onerror = function () {
        finish('error', 'Upload failed — check your connection.');
      };
      xhr.ontimeout = function () {
        finish('error', 'Upload timed out. Try a smaller file.');
      };
      xhr.onabort = function () {
        finish('error', 'Upload cancelled.');
      };

      try {
        xhr.send(entry.file);
      } catch (err) {
        finish('error', 'Could not read the file.');
      }
    });
  }

  function pumpUploadQueue() {
    if (S.uploadPump) return;
    var next = null;
    for (var i = 0; i < S.uploads.length; i++) {
      if (S.uploads[i].status === 'queued') {
        next = S.uploads[i];
        break;
      }
    }
    if (!next) return;
    S.uploadPump = true;
    next.status = 'uploading';
    next.progress = 0;
    renderAttachments();
    updateSendState();
    renderComposerMeta();
    uploadAttachment(next).then(function () {
      S.uploadPump = false;
      renderAttachments();
      updateSendState();
      renderComposerMeta();
      pumpUploadQueue();
    });
  }

  function onAttachClick() {
    if (S.phase !== 'app' || S.conn !== 'online') {
      toast('Reconnecting — try again in a moment.');
      return;
    }
    if (!S.activeSessionId) {
      toast('Open a session first.');
      openSheet('sessions');
      return;
    }
    if (sessionIsArchived()) {
      toast('Archived session — unarchive to attach files.');
      return;
    }
    if (!refs.attachInput) return;
    openSheet('attach');
  }

  /* One hidden input, reconfigured per source. The camera path uses
     capture="environment"; the library/file paths do not, so iOS Safari and
     Android Chrome open the expected picker. */
  function pickAttachment(mode) {
    closeSheet();
    var input = refs.attachInput;
    if (!input) return;
    if (mode === 'camera') {
      input.setAttribute('accept', 'image/*');
      input.setAttribute('capture', 'environment');
      input.removeAttribute('multiple');
    } else if (mode === 'photos') {
      input.setAttribute('accept', 'image/*');
      input.removeAttribute('capture');
      input.setAttribute('multiple', '');
    } else {
      input.removeAttribute('accept');
      input.removeAttribute('capture');
      input.setAttribute('multiple', '');
    }
    try {
      input.value = '';
      input.click();
    } catch (err) {
      toast('Could not open the file picker.');
    }
  }

  function onAttachFilesPicked(event) {
    var target = event && event.target;
    var files =
      target && target.files ? Array.prototype.slice.call(target.files) : [];
    if (target) {
      try {
        target.value = '';
      } catch (err) {
        /* ignore */
      }
    }
    queueAttachmentFiles(precheckImageFiles(files));
  }

  /* ---------- Composer behaviour ----------------------------------------- */

  function autosizeComposer() {
    var input = refs.composerInput;
    input.style.height = 'auto';
    var height = Math.min(148, Math.max(26, input.scrollHeight));
    input.style.height = height + 'px';
    updateSendState();
  }

  function onComposerKeydown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    var finePointer = false;
    try {
      finePointer = window.matchMedia('(pointer: fine)').matches;
    } catch (err) {
      finePointer = false;
    }
    if (finePointer) {
      event.preventDefault();
      sendPrompt();
    }
  }

  function sendPrompt() {
    var input = refs.composerInput;
    /* Sending ends dictation and commits any pending interim words first. */
    stopVoice({ quiet: true, commit: true });
    var text = input.value.trim();
    var uploading = isUploading();
    var failed = failedAttachments();
    var ready = readyAttachments();

    if (uploading) {
      toast('Wait for the uploads to finish.');
      return;
    }
    if (failed.length) {
      toast('Remove the failed upload' + (failed.length === 1 ? '' : 's') + ' before sending.');
      return;
    }
    if (!text && !ready.length) return;
    if (S.conn !== 'online') {
      toast('Reconnecting — try again in a moment.');
      return;
    }
    if (!S.activeSessionId) {
      toast('Open or create a session first.');
      openSheet('sessions');
      return;
    }
    if (sessionIsArchived()) {
      toast('Archived session — unarchive to continue.');
      return;
    }

    var mode =
      S.promptMode === 'steer' &&
      S.session &&
      S.session.running &&
      S.session.agentAvailable
        ? 'steer'
        : 'queue';
    var requestId = uuid();
    var attachmentMeta = attachmentMetadata();
    var item = {
      kind: 'user',
      id: 'pending:' + requestId,
      sessionId: S.activeSessionId,
      text: text,
      ts: Date.now(),
      optimistic: true,
      requestId: requestId,
      attachments: attachmentMeta.length ? attachmentMeta : null
    };
    S.typing = true;
    S.pendingPromptCount++;
    appendMessage(item);
    input.value = '';
    autosizeComposer();

    var frame = {
      type: 'prompt',
      sessionId: S.activeSessionId,
      text: text,
      requestId: requestId,
      mode: mode
    };
    if (ready.length) frame.attachments = ready;

    var sent = sendFrame(frame);
    if (!sent) {
      revokeAttachmentPreviewUrls(item.attachments);
      S.messages = S.messages.filter(function (m) {
        return m !== item;
      });
      if (item.node && item.node.parentNode) item.node.remove();
      S.typing = false;
      S.pendingPromptCount = Math.max(0, S.pendingPromptCount - 1);
      input.value = text;
      autosizeComposer();
      renderTypingNode();
      toast('Message not sent — connection lost. Files kept.');
      renderComposerMeta();
      updateSendState();
      return;
    }
    if (mode === 'steer') {
      S.pendingSteer = {
        requestId: requestId,
        item: item,
        text: text,
        attachments: item.attachments
      };
      clearTimeout(S.steerTimer);
      S.steerTimer = setTimeout(function () {
        S.pendingSteer = null;
      }, 6000);
      S.promptMode = 'queue';
    }
    clearAttachments();
    haptic(8);
    scrollToBottom(false);
    updateTyping();
  }

  function stopGeneration() {
    if (!S.session || !S.session.running || S.stopPending) return;
    if (!sendFrame({ type: 'stop', sessionId: S.session.id })) {
      toast('Not connected — try again in a moment.');
      return;
    }
    S.stopPending = true;
    renderHeaderState();
    renderComposerMeta();
    toast('Stop requested.');
    haptic(6);
  }

  /* ---------- Trajectory / activity ------------------------------------- */

  var activitySeq = 0;

  function pushActivity(entry) {
    var item = {};
    for (var key in entry) {
      if (Object.prototype.hasOwnProperty.call(entry, key)) item[key] = entry[key];
    }
    item.id = 'act-' + ++activitySeq;
    if (!item.ts) item.ts = Date.now();
    S.activity.push(item);
    if (S.activity.length > 600) {
      S.activity.splice(0, S.activity.length - 600);
    }
    if (S.view === 'activity') {
      renderActivity();
      scrollActivityToBottom();
    } else {
      S.unseenActivity = Math.min(S.unseenActivity + 1, 99);
      updateActivityBadge();
    }
    return item;
  }

  function updateActivityToolEnd(frame) {
    var entry = null;
    for (var i = 0; i < S.activity.length; i++) {
      if (
        S.activity[i].kind === 'tool' &&
        S.activity[i].callId &&
        S.activity[i].callId === frame.callId
      ) {
        entry = S.activity[i];
        break;
      }
    }
    if (!entry) return;
    entry.ok = !!frame.ok;
    entry.status = frame.ok ? 'done' : 'error';
    entry.output =
      frame.output == null
        ? ''
        : String(frame.output).slice(0, MAX_TOOL_OUTPUT);
    entry.durationMs =
      typeof frame.durationMs === 'number' ? frame.durationMs : null;
    if (S.view === 'activity') {
      var atBottom = nearBottom(refs.activityScroll);
      renderActivity();
      if (atBottom) scrollActivityToBottom();
    }
  }

  function updateActivityApproval(item) {
    var entry = null;
    for (var i = 0; i < S.activity.length; i++) {
      if (
        S.activity[i].kind === 'approval' &&
        S.activity[i].requestId === item.requestId
      ) {
        entry = S.activity[i];
        break;
      }
    }
    if (!entry) return;
    entry.status = 'resolved';
    entry.outcome = item.outcome;
    entry.ok = item.outcome === 'allowed-once';
    entry.title =
      item.outcome === 'allowed-once'
        ? 'Approval approved'
        : item.outcome === 'rejected'
          ? 'Approval rejected'
          : item.outcome === 'cancelled'
            ? 'Approval cancelled'
            : 'Approval unavailable';
    if (S.view === 'activity') renderActivity();
  }

  function activityMatches(entry) {
    if (S.activityFilter === 'tools') {
      return entry.kind === 'tool' || entry.kind === 'question';
    }
    if (S.activityFilter === 'errors') {
      return (
        entry.kind === 'error' ||
        (entry.kind === 'tool' && entry.ok === false) ||
        (entry.kind === 'question' && entry.outcome === 'unavailable') ||
        (entry.kind === 'approval' && entry.outcome === 'rejected')
      );
    }
    return true;
  }

  function renderActivity() {
    if (!refs.activityList) return;
    var atBottom = nearBottom(refs.activityScroll);
    refs.activityLive.classList.toggle('is-offline', S.conn !== 'online');
    var filtered = S.activity.filter(activityMatches);
    refs.activityList.replaceChildren();

    if (!filtered.length) {
      refs.activityList.appendChild(
        el('p', {
          class: 'act-empty',
          text: S.activity.length
            ? 'No activity matches this filter.'
            : 'Activity appears here as the agent works — tool calls, approvals and step boundaries.'
        })
      );
      return;
    }

    filtered.forEach(function (entry) {
      refs.activityList.appendChild(renderActivityEntry(entry));
    });
    if (atBottom) scrollActivityToBottom();
  }

  function activityStatus(entry) {
    if (entry.kind === 'tool') {
      if (entry.status === 'running') return { text: 'Running', cls: '' };
      if (entry.ok === true) return { text: 'Done', cls: 'is-ok' };
      if (entry.ok === false) return { text: 'Failed', cls: 'is-error' };
      return { text: '', cls: '' };
    }
    if (entry.kind === 'approval') {
      if (entry.status === 'pending') return { text: 'Pending', cls: '' };
      if (entry.ok === true) return { text: 'Approved', cls: 'is-ok' };
      if (entry.outcome === 'rejected') return { text: 'Rejected', cls: 'is-error' };
      return { text: 'Resolved', cls: '' };
    }
    if (entry.kind === 'question') {
      if (entry.status === 'pending') return { text: 'Pending', cls: '' };
      if (entry.outcome === 'answered' || entry.ok === true) {
        return { text: 'Answered', cls: 'is-ok' };
      }
      if (entry.outcome === 'declined') return { text: 'Skipped', cls: '' };
      if (entry.outcome === 'unavailable' || entry.ok === false) {
        return { text: 'Unavailable', cls: 'is-error' };
      }
      return { text: 'Answered', cls: 'is-ok' };
    }
    return { text: '', cls: '' };
  }

  function renderActivityEntry(entry) {
    var expandable =
      entry.kind === 'tool' ||
      entry.kind === 'question' ||
      entry.kind === 'approval' ||
      entry.kind === 'error';
    var open = S.activityOpen.has(entry.id);
    var wrap = el('div', {
      class:
        'act is-' +
        entry.kind +
        (entry.kind === 'tool' && entry.ok === false ? ' is-error' : '') +
        (expandable ? ' act-expandable' : '') +
        (open ? ' is-open' : '')
    });
    var rail = el(
      'div',
      { class: 'act-rail' },
      el('span', { class: 'act-dot' })
    );
    var content = el('div', { class: 'act-content' });
    var status = activityStatus(entry);

    function headline(expandableRow) {
      var line = el('div', { class: 'act-headline' });
      line.appendChild(el('span', { class: 'act-title', text: entry.title || '' }));
      if (status.text) {
        line.appendChild(
          el('span', {
            class: 'act-status' + (status.cls ? ' ' + status.cls : ''),
            text: status.text
          })
        );
      }
      if (expandableRow) {
        line.appendChild(icon('chevron-down', 'act-chevron'));
      }
      line.appendChild(el('span', { class: 'act-time', text: fmtClock(entry.ts) }));
      return line;
    }

    if (expandable) {
      var head = el(
        'button',
        {
          class: 'act-head',
          attrs: {
            type: 'button',
            'aria-expanded': open ? 'true' : 'false'
          }
        },
        headline(true)
      );
      content.appendChild(head);
      if (entry.sub) {
        content.appendChild(el('span', { class: 'act-sub', text: entry.sub }));
      }
      if (entry.kind === 'approval' && !deviceCanApprove()) {
        content.appendChild(
          el('span', { class: 'act-note', text: 'Read-only on this device' })
        );
      }
      var body = el('div', { class: 'act-body' });
      var inner = el('div', { class: 'act-body-inner' });
      var pad = el('div', { class: 'act-body-pad' });
      if (entry.args) {
        pad.appendChild(
          el('p', {
            class: 'act-label',
            text:
              entry.kind === 'approval' ? approvalArgsLabel(entry) : 'Input'
          })
        );
        pad.appendChild(preNode(entry.args, 'act-pre'));
      }
      if (entry.output) {
        pad.appendChild(
          el('p', {
            class: 'act-label',
            text: entry.ok === false ? 'Error output' : 'Output'
          })
        );
        pad.appendChild(preNode(entry.output, 'act-pre'));
      }
      if (entry.reason) {
        pad.appendChild(el('p', { class: 'act-label', text: 'Reason' }));
        pad.appendChild(preNode(entry.reason, 'act-pre'));
      }
      if (!pad.childNodes.length) {
        pad.appendChild(
          el('span', {
            class: 'act-sub',
            text:
              entry.status === 'running'
                ? 'Waiting for this tool to finish…'
                : entry.kind === 'question' && entry.status === 'pending'
                  ? 'Waiting for an answer…'
                  : 'No further detail.'
          })
        );
      }
      inner.appendChild(pad);
      body.appendChild(inner);
      content.appendChild(body);

      head.addEventListener('click', function () {
        var isOpen = S.activityOpen.has(entry.id);
        if (isOpen) S.activityOpen.delete(entry.id);
        else S.activityOpen.add(entry.id);
        wrap.classList.toggle('is-open', !isOpen);
        head.setAttribute('aria-expanded', String(!isOpen));
      });
    } else {
      content.appendChild(headline(false));
      if (entry.sub) {
        content.appendChild(el('span', { class: 'act-sub', text: entry.sub }));
      }
    }

    wrap.append(rail, content);
    return wrap;
  }

  /* ---------- Scroll behaviour ------------------------------------------- */

  function bindScroll() {
    refs.chatScroll.addEventListener('scroll', onChatScroll, { passive: true });
    refs.activityScroll.addEventListener(
      'scroll',
      function () {
        S.activityPinned = nearBottom(refs.activityScroll);
      },
      { passive: true }
    );
  }

  /* Long-press on a chat message opens copy / quote actions. Text nodes inside
     buttons and code blocks keep their native behaviour. */
  function bindMessageActions() {
    var timer = null;
    var startX = 0;
    var startY = 0;
    var target = null;

    var cancel = function () {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      target = null;
    };

    refs.messages.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      var element = event.target;
      if (!element || typeof element.closest !== 'function') return;
      var node = element.closest('.msg');
      if (!node || !node.__rmItem) return;
      if (element.closest('button, a, input, textarea, summary, pre, .md-copy')) return;
      cancel();
      startX = event.clientX;
      startY = event.clientY;
      target = node;
      timer = setTimeout(function () {
        timer = null;
        if (!target) return;
        haptic(12);
        openMessageActions(target);
        target = null;
      }, 480);
    });
    refs.messages.addEventListener('pointermove', function (event) {
      if (timer === null) return;
      if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
      refs.messages.addEventListener(name, cancel);
    });
    refs.messages.addEventListener('contextmenu', function (event) {
      var element = event.target;
      var node = element && typeof element.closest === 'function' ? element.closest('.msg') : null;
      if (!node || !node.__rmItem) return;
      if (element.closest('button, a, input, textarea, summary, pre, .md-copy')) return;
      event.preventDefault();
      openMessageActions(node);
    });
  }

  function openMessageActions(node) {
    var item = node.__rmItem;
    if (!item || (item.kind !== 'user' && item.kind !== 'assistant')) return;
    S.actionItem = item;
    openSheet('message');
  }

  function onChatScroll() {
    var node = refs.chatScroll;
    var distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    var pinned = distance < 72;
    if (pinned && !S.pinned) {
      /* re-pinned: nothing special beyond clearing unread */
    }
    S.pinned = pinned;
    if (pinned) S.unreadBelow = false;
    updateJump();
  }

  function scrollToBottom(smooth) {
    var node = refs.chatScroll;
    try {
      node.scrollTo({
        top: node.scrollHeight,
        behavior: smooth && !reduceMotion ? 'smooth' : 'auto'
      });
    } catch (err) {
      node.scrollTop = node.scrollHeight;
    }
    S.pinned = true;
    S.unreadBelow = false;
    updateJump();
  }

  function markUnreadBelow() {
    if (S.pinned) return;
    S.unreadBelow = true;
    updateJump();
  }

  function updateJump() {
    var show =
      S.view === 'chat' &&
      !!S.session &&
      S.messages.length > 0 &&
      !S.pinned;
    refs.jump.hidden = !show;
    if (show) {
      refs.jumpLabel.textContent = S.unreadBelow
        ? 'New messages'
        : 'Jump to latest';
    }
  }

  function nearBottom(node) {
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  }

  function scrollActivityToBottom() {
    var node = refs.activityScroll;
    try {
      node.scrollTop = node.scrollHeight;
    } catch (err) {
      /* ignore */
    }
    S.activityPinned = true;
  }

  /* ---------- Views ------------------------------------------------------- */

  function setView(view) {
    if (view !== 'chat' && view !== 'activity') return;
    if (S.view === view) return;
    S.view = view;
    var chat = view === 'chat';
    if (!chat) stopVoice({ quiet: true, commit: true });
    refs.viewChat.hidden = !chat;
    refs.viewActivity.hidden = chat;
    refs.tabChat.classList.toggle('is-active', chat);
    refs.tabActivity.classList.toggle('is-active', !chat);
    refs.tabChat.setAttribute('aria-selected', String(chat));
    refs.tabActivity.setAttribute('aria-selected', String(!chat));

    if (!chat) {
      S.unseenActivity = 0;
      updateActivityBadge();
      renderActivity();
      scrollActivityToBottom();
    } else {
      renderTypingNode();
      updateJump();
      if (S.pinned) scrollToBottom(false);
    }
  }

  /* ---------- Sheets ------------------------------------------------------ */

  function bindSheetUI() {
    refs.scrim.addEventListener('click', closeSheet);
    refs.sheetClose.addEventListener('click', closeSheet);
    refs.sheet.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeSheet();
      }
    });
    bindSheetDrag();
  }

  function bindSheetDrag() {
    var startY = 0;
    var startAt = 0;
    var dragging = false;

    refs.sheetGrab.addEventListener('pointerdown', function (event) {
      if (!S.sheet) return;
      if (event.button !== undefined && event.button !== 0) return;
      startY = event.clientY;
      startAt = Date.now();
      dragging = true;
      refs.sheet.style.transition = 'none';
      try {
        refs.sheetGrab.setPointerCapture(event.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    refs.sheetGrab.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      var dy = Math.max(0, event.clientY - startY);
      refs.sheet.style.transform = 'translateY(' + dy + 'px)';
    });

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      var dy = Math.max(0, (event && event.clientY) - startY);
      var velocity = dy / Math.max(1, Date.now() - startAt);
      refs.sheet.style.transition = '';
      refs.sheet.style.transform = '';
      if (dy > 110 || velocity > 0.55) closeSheet();
    }

    refs.sheetGrab.addEventListener('pointerup', endDrag);
    refs.sheetGrab.addEventListener('pointercancel', endDrag);
  }

  function openSheet(kind) {
    /* A sheet takes the user away from the composer; never leave the mic hot. */
    stopVoice({ quiet: true, commit: true });
    var wasOpen = !!S.sheet;
    S.sheet = kind;
    if (!wasOpen) {
      S.sheetOpener = document.activeElement;
      S.confirmUnpair = false;
    }
    buildSheet();
    if (kind === 'menu') refreshPushStatus();
    if (!wasOpen) {
      clearTimeout(S.sheetHideTimer);
      refs.scrim.hidden = false;
      refs.sheet.hidden = false;
      refs.sheet.setAttribute('tabindex', '-1');
      window.requestAnimationFrame(function () {
        refs.scrim.classList.add('is-open');
        refs.sheet.classList.add('is-open');
        try {
          refs.sheet.focus({ preventScroll: true });
        } catch (err) {
          /* ignore */
        }
      });
    }
  }

  function closeSheet() {
    if (!S.sheet) return;
    if (S.sheet === 'command-input') {
      S.commandDraft = '';
      S.commandInputItem = null;
    }
    if (S.sheet === 'commands') {
      clearTimeout(S.commandsLoadTimer);
      S.commandsLoadTimer = null;
    }
    var restore = S.sheetOpener;
    S.sheet = null;
    S.sheetOpener = null;
    S.confirmUnpair = false;
    clearTimeout(S.confirmUnpairTimer);
    refs.sheet.style.transition = '';
    refs.sheet.style.transform = '';
    refs.sheet.classList.remove('is-open');
    refs.scrim.classList.remove('is-open');
    clearTimeout(S.sheetHideTimer);
    S.sheetHideTimer = setTimeout(function () {
      if (!S.sheet) {
        refs.sheet.hidden = true;
        refs.scrim.hidden = true;
      }
    }, reduceMotion ? 0 : 340);
    if (restore && typeof restore.focus === 'function' && document.contains(restore)) {
      try {
        restore.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    }
  }

  function buildSheet() {
    if (!S.sheet) return;
    refs.sheetBody.replaceChildren();
    refs.sheetFoot.replaceChildren();
    refs.sheetFoot.hidden = true;
    refs.sheetSub.hidden = true;
    refs.sheetSub.textContent = '';
    switch (S.sheet) {
      case 'sessions':
        buildSessionsSheet();
        break;
      case 'new-session':
        buildNewSessionSheet();
        break;
      case 'model':
        buildModelSheet();
        break;
      case 'reasoning':
        buildReasoningSheet();
        break;
      case 'preset':
        buildPresetSheet();
        break;
      case 'message':
        buildMessageSheet();
        break;
      case 'menu':
        buildMenuSheet();
        break;
      case 'attach':
        buildAttachSheet();
        break;
      case 'rename':
        buildRenameSheet();
        break;
      case 'queue-item':
        buildQueueItemSheet();
        break;
      case 'queue-edit':
        buildQueueEditSheet();
        break;
      case 'diff':
        buildDiffSheet();
        break;
      case 'commands':
        buildCommandsSheet();
        break;
      case 'command-input':
        buildCommandInputSheet();
        break;
      default:
        break;
    }
  }

  function setSheetHead(title, sub) {
    refs.sheetTitle.textContent = title;
    if (sub) {
      refs.sheetSub.textContent = sub;
      refs.sheetSub.hidden = false;
    }
  }

  function setSheetFoot(node) {
    refs.sheetFoot.replaceChildren();
    if (node) {
      refs.sheetFoot.appendChild(node);
      refs.sheetFoot.hidden = false;
    } else {
      refs.sheetFoot.hidden = true;
    }
  }

  function row(opts) {
    var button = el('button', {
      class:
        'row' +
        (opts.active ? ' is-active' : '') +
        (opts.accent ? ' is-accent' : '') +
        (opts.danger ? ' is-danger' : ''),
      attrs: { type: 'button' }
    });
    if (opts.leading) {
      button.appendChild(el('span', { class: 'row-icon' }, opts.leading));
    } else if (opts.icon) {
      button.appendChild(
        el('span', { class: 'row-icon' }, icon(opts.icon))
      );
    }
    var main = el('span', { class: 'row-main' });
    main.appendChild(el('span', { class: 'row-title', text: opts.title || '' }));
    if (opts.sub) {
      main.appendChild(el('span', { class: 'row-sub', text: opts.sub }));
    }
    button.appendChild(main);
    if (opts.trailing) button.appendChild(opts.trailing);
    if (opts.disabled) {
      button.disabled = true;
      button.classList.add('is-disabled');
    }
    if (opts.onClick) button.addEventListener('click', opts.onClick);
    return button;
  }

  /* ---------- Project grouping helpers (sessions sheet) ------------------- */

  var LS_PROJECTS = 'dsh-remote-projects.v1';

  function baseName(path) {
    var value = String(path || '').replace(/[\\/]+$/, '');
    var slash = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
    return slash >= 0 ? value.slice(slash + 1) : value;
  }

  function projectTitle(ws) {
    return (ws && (ws.title || baseName(ws.path))) || 'Project';
  }

  function projectPathLabel(ws) {
    var value = ws && ws.path ? String(ws.path) : '';
    return value.replace(/[\\/]+$/, '');
  }

  function readCollapsedProjects() {
    try {
      var parsed = JSON.parse(store.get(LS_PROJECTS) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(function (id) {
          return typeof id === 'string' && id;
        })
        .slice(0, 100);
    } catch (err) {
      return [];
    }
  }

  function collapsedProjects() {
    if (!Array.isArray(S.projectCollapsed)) {
      S.projectCollapsed = readCollapsedProjects();
    }
    return S.projectCollapsed;
  }

  function saveCollapsedProjects(list) {
    S.projectCollapsed = list.slice(0, 100);
    store.set(LS_PROJECTS, JSON.stringify(S.projectCollapsed));
  }

  /* Stable "pinned first, then incoming frame order" ordering. */
  function sortPinnedFirst(list) {
    return list.slice().sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
      return 0;
    });
  }

  function sessionRowNode(session, options) {
    options = options || {};
    var active = session.id === S.activeSessionId;
    var meta = [];
    if (session.running) meta.push('Working now');
    else meta.push('Updated ' + timeAgo(session.updatedAt));
    var preset = presetLabel(session.preset);
    if (preset) meta.push(preset);
    var label = session.title || 'Untitled session';
    var trailing = el('span', { class: 'row-meta' });
    if (session.pinned) {
      trailing.appendChild(
        el('span', { class: 'row-pin', attrs: { 'aria-label': 'Pinned' } }, icon('pin'))
      );
    }
    if (session.archived) {
      trailing.appendChild(el('span', { class: 'row-tag', text: 'Archived' }));
    }
    if (active) {
      trailing.appendChild(el('span', { class: 'row-check' }, icon('check')));
    } else if (session.running) {
      trailing.appendChild(el('span', { class: 'row-running' }));
    }
    var node = row({
      leading: el('span', {
        class: session.running ? 'row-running' : 'row-idle'
      }),
      title: label,
      sub: meta.join(' · '),
      active: active,
      trailing: trailing,
      onClick: function () {
        openSession(session.id);
      }
    });
    if (session.archived) node.classList.add('is-archived');
    node.setAttribute('data-search', label + ' ' + (preset || ''));
    return node;
  }

  function updateSessionNoMatch() {
    var noMatch = document.getElementById('session-no-match');
    if (!noMatch) return;
    var listBox = document.getElementById('session-list');
    var foundBox = document.getElementById('session-found');
    var anyVisible = false;
    if (listBox) {
      Array.prototype.forEach.call(
        listBox.querySelectorAll('.sheet-session-section .row'),
        function (rowNode) {
          if (rowNode.hidden) return;
          var section = rowNode.closest
            ? rowNode.closest('.sheet-session-section')
            : null;
          if (section && section.hidden) return;
          var projectBody = rowNode.closest
            ? rowNode.closest('.project-body')
            : null;
          if (projectBody && projectBody.hidden) return;
          anyVisible = true;
        }
      );
    }
    noMatch.hidden =
      anyVisible || !!(foundBox && foundBox.childNodes.length);
  }

  function buildSessionsSheet() {
    setSheetHead(
      'Sessions',
      S.sessions.length ? S.sessions.length + ' in this Harness' : 'No sessions yet'
    );
    var body = refs.sheetBody;

    body.appendChild(
      row({
        icon: 'plus',
        accent: true,
        title: 'New session',
        sub: 'Start a fresh conversation',
        onClick: function () {
          openSheet('new-session');
        }
      })
    );

    if (!S.sessions.length) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'No sessions are available yet. Create one to get started.'
        })
      );
    } else {
      var search = el('input', {
        class: 'sheet-search',
        attrs: {
          type: 'search',
          placeholder: 'Search sessions and messages',
          'aria-label': 'Search sessions',
          autocomplete: 'off',
          spellcheck: 'false'
        }
      });
      search.value = S.sessionQuery || '';
      body.appendChild(search);

      var foundBox = el('div', {
        class: 'sheet-found',
        attrs: { id: 'session-found' }
      });
      body.appendChild(foundBox);

      var listBox = el('div', {
        class: 'sheet-session-list',
        attrs: { id: 'session-list' }
      });
      body.appendChild(listBox);
      var noMatch = el('p', {
        class: 'sheet-note',
        text: 'No sessions match that search.',
        attrs: { id: 'session-no-match' }
      });
      noMatch.hidden = true;
      body.appendChild(noMatch);

      var sectionNodes = [];
      var visibleSessions = S.sessions.filter(function (session) {
        return !session.archived;
      });
      var archivedSessions = S.sessions.filter(function (session) {
        return !!session.archived;
      });
      var workspaces = Array.isArray(S.workspaces) ? S.workspaces : [];
      var workspaceIds = {};
      workspaces.forEach(function (ws) {
        if (ws && ws.id) workspaceIds[String(ws.id)] = true;
      });

      function appendFlatSection(title, sessions) {
        if (!sessions.length) return;
        var section = el('div', { class: 'sheet-session-section' });
        if (title) {
          section.appendChild(el('p', { class: 'sheet-section', text: title }));
        }
        sortPinnedFirst(sessions).forEach(function (session) {
          section.appendChild(sessionRowNode(session));
        });
        listBox.appendChild(section);
        sectionNodes.push(section);
      }

      function buildProjectSection(ws, members, archivedMembers) {
        var workspaceId = String(ws.id);
        var collapsed = collapsedProjects().indexOf(workspaceId) !== -1;
        var section = el('div', {
          class: 'sheet-session-section project-section',
          dataset: { workspaceId: workspaceId }
        });
        var header = el('button', {
          class: 'project-header' + (collapsed ? ' is-collapsed' : ''),
          attrs: {
            type: 'button',
            'aria-expanded': collapsed ? 'false' : 'true'
          }
        });
        header.appendChild(icon('chevron-down', 'project-chevron'));
        header.appendChild(el('span', { class: 'project-folder' }, icon('folder')));
        var info = el('span', { class: 'project-info' });
        info.appendChild(
          el('span', { class: 'project-title', text: projectTitle(ws) })
        );
        var pathLabel = projectPathLabel(ws);
        if (pathLabel) {
          info.appendChild(
            el('span', {
              class: 'project-path',
              text: pathLabel,
              attrs: { title: pathLabel }
            })
          );
        }
        header.appendChild(info);
        header.appendChild(
          el('span', {
            class: 'project-count',
            text: String(
              members.length + (S.showArchived ? archivedMembers.length : 0)
            )
          })
        );
        header.addEventListener('click', function () {
          var list = collapsedProjects().slice();
          var index = list.indexOf(workspaceId);
          if (index === -1) list.push(workspaceId);
          else list.splice(index, 1);
          saveCollapsedProjects(list);
          buildSheet();
        });
        section.appendChild(header);

        var projectBody = el('div', { class: 'project-body' });
        projectBody.hidden = collapsed;
        sortPinnedFirst(members).forEach(function (session) {
          projectBody.appendChild(sessionRowNode(session));
        });
        if (S.showArchived) {
          sortPinnedFirst(archivedMembers).forEach(function (session) {
            projectBody.appendChild(sessionRowNode(session));
          });
        }
        section.appendChild(projectBody);
        listBox.appendChild(section);
        sectionNodes.push(section);
      }

      if (workspaces.length) {
        workspaces.forEach(function (ws) {
          if (!ws || !ws.id) return;
          var members = visibleSessions.filter(function (session) {
            return session.workspaceId === ws.id;
          });
          var archivedMembers = archivedSessions.filter(function (session) {
            return session.workspaceId === ws.id;
          });
          if (!members.length && !(S.showArchived && archivedMembers.length)) {
            return;
          }
          buildProjectSection(ws, members, archivedMembers);
        });

        var ungroupedVisible = visibleSessions.filter(function (session) {
          return (
            !session.workspaceId ||
            !workspaceIds[String(session.workspaceId)]
          );
        });
        appendFlatSection('Ungrouped', ungroupedVisible);

        if (S.showArchived) {
          var ungroupedArchived = archivedSessions.filter(function (session) {
            return (
              !session.workspaceId ||
              !workspaceIds[String(session.workspaceId)]
            );
          });
          appendFlatSection('Archived', ungroupedArchived);
        }
      } else {
        appendFlatSection(
          'Pinned',
          visibleSessions.filter(function (session) {
            return !!session.pinned;
          })
        );
        appendFlatSection(
          'Recent',
          visibleSessions.filter(function (session) {
            return !session.pinned;
          })
        );
        if (S.showArchived) appendFlatSection('Archived', archivedSessions);
      }

      if (archivedSessions.length) {
        var archiveFilter = el('button', {
          class: 'sheet-filter',
          attrs: { type: 'button' },
          text: S.showArchived
            ? 'Hide archived'
            : 'Show archived (' + archivedSessions.length + ')'
        });
        archiveFilter.addEventListener('click', function () {
          S.showArchived = !S.showArchived;
          buildSheet();
        });
        /* The archived filter sits above the list, not at its end: the list can
           be long, and a control below forty rows is not discoverable. */
        body.insertBefore(archiveFilter, listBox);
      }

      var applyFilter = function () {
        var q = String(search.value || '').trim().toLowerCase();
        S.sessionQuery = q;
        var visible = 0;
        Array.prototype.forEach.call(
          listBox.querySelectorAll('.sheet-session-section .row'),
          function (rowNode) {
            var haystack = String(
              rowNode.getAttribute('data-search') || ''
            ).toLowerCase();
            var show = q.length === 0 || haystack.indexOf(q) !== -1;
            rowNode.hidden = !show;
            if (show) visible += 1;
          }
        );

        Array.prototype.forEach.call(
          listBox.querySelectorAll('.project-section'),
          function (section) {
            var header = section.querySelector('.project-header');
            var projectBody = section.querySelector('.project-body');
            var workspaceId = section.getAttribute('data-workspace-id') || '';
            var rows = Array.prototype.slice.call(section.querySelectorAll('.row'));
            var matching = rows.filter(function (rowNode) {
              return !rowNode.hidden;
            });
            if (q.length) {
              section.hidden = matching.length === 0;
              if (projectBody) projectBody.hidden = false;
              if (header) {
                header.classList.remove('is-collapsed');
                header.setAttribute('aria-expanded', 'true');
              }
            } else {
              section.hidden = rows.length === 0;
              var isCollapsed =
                collapsedProjects().indexOf(workspaceId) !== -1;
              if (projectBody) projectBody.hidden = isCollapsed;
              if (header) {
                header.classList.toggle('is-collapsed', isCollapsed);
                header.setAttribute('aria-expanded', String(!isCollapsed));
              }
            }
          }
        );

        sectionNodes.forEach(function (section) {
          if (section.classList.contains('project-section')) return;
          var any = Array.prototype.some.call(
            section.querySelectorAll('.row'),
            function (rowNode) {
              return !rowNode.hidden;
            }
          );
          section.hidden = !any;
        });
        noMatch.hidden = visible > 0 || !!foundBox.childNodes.length;
      };

      search.addEventListener('input', function () {
        applyFilter();
        scheduleSessionSearch(search.value);
      });
      S.sessionQuery = String(search.value || '').trim().toLowerCase();
      refreshFoundSection();
      applyFilter();
    }

    var deviceName = S.device && S.device.name ? S.device.name : 'this device';
    setSheetFoot(
      el(
        'span',
        { class: 'mono' },
        'Paired as ' + deviceName + ' · v' + (S.version || FALLBACK_VERSION)
      )
    );
  }

  function buildNewSessionSheet() {
    setSheetHead('New session', 'Choose how the agent should work');
    var body = refs.sheetBody;

    body.appendChild(el('p', { class: 'sheet-section', text: 'Working directory' }));
    var cwdInput = el('input', {
      class: 'sheet-search',
      attrs: {
        type: 'text',
        placeholder: 'Default working directory',
        'aria-label': 'Working directory',
        autocomplete: 'off',
        spellcheck: 'false'
      }
    });
    cwdInput.value = S.cwdDraft || '';
    cwdInput.addEventListener('input', function () {
      S.cwdDraft = cwdInput.value;
    });
    body.appendChild(cwdInput);
    var projects = Array.isArray(S.workspaces) ? S.workspaces : [];
    if (projects.length) {
      body.appendChild(el('p', { class: 'sheet-section', text: 'Projects' }));
      var projectChips = el('div', { class: 'chip-row' });
      projects.forEach(function (ws) {
        if (!ws || !ws.path) return;
        var projectPath = String(ws.path);
        var chip = el('button', {
          class: 'chip',
          attrs: { type: 'button', title: projectPath },
          text: projectTitle(ws)
        });
        chip.addEventListener('click', function () {
          S.cwdDraft = projectPath;
          cwdInput.value = projectPath;
          try {
            cwdInput.focus({ preventScroll: true });
          } catch (err) {
            /* ignore */
          }
        });
        projectChips.appendChild(chip);
      });
      if (projectChips.childNodes.length) body.appendChild(projectChips);
    }
    var recent = recentCwds();
    if (recent.length) {
      var recentChips = el('div', { class: 'chip-row' });
      recent.forEach(function (dir) {
        recentChips.appendChild(
          el('button', {
            class: 'chip',
            attrs: { type: 'button', title: dir },
            text: dir,
            on: {
              click: function () {
                cwdInput.value = dir;
                S.cwdDraft = dir;
                try {
                  cwdInput.focus({ preventScroll: true });
                } catch (err) {
                  /* ignore */
                }
              }
            }
          })
        );
      });
      body.appendChild(recentChips);
    }
    body.appendChild(
      el('p', {
        class: 'sheet-note',
        text: 'Leave empty to use the Harness default directory.'
      })
    );

    if (!S.presets) {
      body.appendChild(
        el(
          'div',
          { class: 'sheet-loading' },
          el('span', { class: 'spin' }),
          el('span', { text: 'Loading agent presets…' })
        )
      );
      requestPresets();
      return;
    }

    if (!S.presets.list.length) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'No presets were reported by the Harness. You can still start a session with the default preset.'
        })
      );
      body.appendChild(
        row({
          icon: 'plus',
          accent: true,
          title: 'Start session',
          sub: 'Use the default agent preset',
          onClick: function () {
            createSession(null, S.cwdDraft);
          }
        })
      );
      return;
    }

    S.presets.list.forEach(function (preset) {
      var isCurrent = preset.id === S.presets.current;
      body.appendChild(
        row({
          icon: 'sliders',
          title: preset.title || preset.id,
          sub: preset.description || '',
          trailing: isCurrent
            ? el(
                'span',
                { class: 'row-meta' },
                el('span', { class: 'row-tag', text: 'Default' })
              )
            : null,
          onClick: function () {
            createSession(preset.id, S.cwdDraft);
          }
        })
      );
    });

    body.appendChild(
      el('p', {
        class: 'sheet-note',
        text: 'The preset controls planning, tool use and reporting style. You can change it later in the session menu.'
      })
    );
    setSheetFoot(
      el('span', { text: 'Presets come from DeepSeek Harness.' })
    );
  }

  function buildMessageSheet() {
    var item = S.actionItem;
    if (!item) {
      closeSheet();
      return;
    }
    var text = typeof item.text === 'string' ? item.text : '';
    var excerpt = function (value, max) {
      var flat = String(value || '').replace(/\s+/g, ' ').trim();
      return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
    };
    var fence = text.match(/```[^\n]*\n([\s\S]*?)```/);

    setSheetHead('Message', item.kind === 'user' ? 'Your message' : 'Assistant message');
    var body = refs.sheetBody;

    body.appendChild(
      row({
        icon: 'copy',
        title: 'Copy text',
        sub: excerpt(text, 90) || 'Nothing to copy',
        onClick: function () {
          if (!text) {
            toast('Nothing to copy.');
            return;
          }
          copyToClipboard(text, function () {
            closeSheet();
            toast('Copied');
          });
        }
      })
    );

    if (fence && fence[1].trim()) {
      body.appendChild(
        row({
          icon: 'terminal',
          title: 'Copy code block',
          sub: excerpt(fence[1], 90),
          onClick: function () {
            copyToClipboard(fence[1].trim(), function () {
              closeSheet();
              toast('Code copied');
            });
          }
        })
      );
    }

    body.appendChild(
      row({
        icon: 'compose',
        title: 'Quote reply',
        sub: 'Insert this message into the composer',
        onClick: function () {
          quoteMessage(item);
        }
      })
    );

    setSheetFoot(
      el('span', { text: 'Long-press any message for these actions.' })
    );
  }

  function quoteMessage(item) {
    var text = typeof item.text === 'string' ? item.text : '';
    if (!text) return;
    var quoted = text
      .split('\n')
      .map(function (line) {
        return line ? '> ' + line : '>';
      })
      .join('\n');
    var existing = refs.composerInput.value.trim();
    refs.composerInput.value = (existing ? existing + '\n\n' : '') + quoted + '\n';
    closeSheet();
    autosizeComposer();
    try {
      refs.composerInput.focus({ preventScroll: true });
    } catch (err) {
      /* ignore */
    }
    toast('Quoted');
  }

  function requestPresets() {
    if (S.presetsLoading) return;
    S.presetsLoading = true;
    sendFrame({ type: 'preset.list' });
    clearTimeout(S.presetLoadTimer);
    S.presetLoadTimer = setTimeout(function () {
      S.presetsLoading = false;
      if (!S.presets) {
        S.presets = { list: [], current: null, unavailable: true };
        if (S.sheet === 'new-session' || S.sheet === 'preset') buildSheet();
      }
    }, 4000);
  }

  function requestModels() {
    if (S.modelsLoading) return;
    S.modelsLoading = true;
    sendFrame({ type: 'model.list' });
    clearTimeout(S.modelLoadTimer);
    S.modelLoadTimer = setTimeout(function () {
      S.modelsLoading = false;
      if (!S.models) {
        S.models = { catalog: [], current: null, unavailable: true };
        if (S.sheet === 'model') buildSheet();
      }
    }, 4000);
  }

  function buildModelSheet() {
    setSheetHead('Model', 'Choose the model for this session');
    var body = refs.sheetBody;

    if (!S.session) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'Open a session first to choose its model.'
        })
      );
      return;
    }

    if (!S.models) {
      body.appendChild(
        el(
          'div',
          { class: 'sheet-loading' },
          el('span', { class: 'spin' }),
          el('span', { text: 'Loading available models…' })
        )
      );
      requestModels();
      return;
    }

    if (!S.models.catalog.length) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'No model catalog is available right now.'
        })
      );
      return;
    }

    var current = currentModel();
    var groups = [];
    var byProvider = {};
    S.models.catalog.forEach(function (m) {
      var provider = m.provider || 'Other';
      if (!byProvider[provider]) {
        byProvider[provider] = [];
        groups.push(provider);
      }
      byProvider[provider].push(m);
    });

    groups.forEach(function (provider) {
      body.appendChild(
        el('p', { class: 'sheet-section', text: provider })
      );
      byProvider[provider].forEach(function (m) {
        var isCurrent =
          current &&
          current.provider === m.provider &&
          current.model === m.model;
        var trailing = null;
        if (m.reasoning) {
          /* Reasoning models advertise a control: show the effort that would
             apply, plus a chevron that reveals the drill-in sheet. */
          var currentEffortId = isCurrent ? current.reasoningEffort : null;
          var tag = effortName(m, currentEffortId) || 'Default';
          trailing = el('span', { class: 'row-meta' });
          trailing.appendChild(el('span', { class: 'row-effort', text: tag }));
          trailing.appendChild(
            el('span', { class: 'row-chevron' }, icon('chevron-right'))
          );
          if (isCurrent) {
            trailing.appendChild(el('span', { class: 'row-check' }, icon('check')));
          }
        } else if (isCurrent) {
          trailing = el('span', { class: 'row-check' }, icon('check'));
        }
        var node = row({
          title: m.label || m.model,
          sub: m.provider + '/' + m.model,
          active: isCurrent,
          trailing: trailing,
          onClick: function () {
            if (m.reasoning) {
              S.reasoningTarget = {
                sessionId: S.session.id,
                provider: m.provider,
                model: m.model
              };
              openSheet('reasoning');
              return;
            }
            selectModel(m.provider, m.model, null);
          }
        });
        if (m.reasoning) {
          node.setAttribute(
            'aria-label',
            (m.label || m.model) + ' — choose reasoning effort'
          );
        }
        body.appendChild(node);
      });
    });

    setSheetFoot(
      el('span', { text: 'Changes apply to this session only.' })
    );
  }

  /**
   * Effort picker for a reasoning-capable model. The sheet is scoped to the
   * session and model captured when the model row was tapped: a stale target
   * (session switched, catalog refreshed) renders an explanation instead of
   * emitting a model.select for the wrong session.
   */
  function buildReasoningSheet() {
    var target = S.reasoningTarget;
    if (!target || !S.session || target.sessionId !== S.session.id) {
      setSheetHead('Reasoning effort', null);
      refs.sheetBody.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'Open a session and choose a model first.'
        })
      );
      return;
    }
    var entry = catalogEntry(target.provider, target.model);
    var efforts =
      entry && entry.reasoning && Array.isArray(entry.reasoning.efforts)
        ? entry.reasoning.efforts.filter(function (effort) {
            return !!(effort && effort.id);
          })
        : [];
    if (!efforts.length) {
      setSheetHead('Reasoning effort', null);
      refs.sheetBody.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'This model does not expose a reasoning effort right now.'
        })
      );
      return;
    }
    var body = refs.sheetBody;
    var reasoning = entry.reasoning;
    var defaultEffort = reasoning.defaultEffort || null;
    var current = currentModel();
    var isCurrentModel = !!(
      current &&
      current.provider === entry.provider &&
      current.model === entry.model
    );
    var selectedId =
      isCurrentModel && current.reasoningEffort
        ? String(current.reasoningEffort)
        : null;
    /* With no explicit effort the advertised default is what the Host uses. */
    var activeId = selectedId || (isCurrentModel ? defaultEffort : null);
    var label = entry.label || entry.model;

    setSheetHead(label, 'How hard the model should reason');

    if (!defaultEffort) {
      var defaultActive = isCurrentModel && !activeId;
      var providerDefault = row({
        title: 'Provider default',
        sub: 'Let the provider pick the effort for each request',
        active: defaultActive,
        trailing: defaultActive
          ? el('span', { class: 'row-check' }, icon('check'))
          : null,
        onClick: function () {
          selectModel(entry.provider, entry.model, null);
        }
      });
      if (defaultActive) providerDefault.setAttribute('aria-current', 'true');
      body.appendChild(providerDefault);
    }

    efforts.forEach(function (effort) {
      var id = String(effort.id);
      var isActive = activeId === id;
      var isDefault = defaultEffort === id;
      var trailing = el('span', { class: 'row-meta' });
      if (isDefault) {
        trailing.appendChild(el('span', { class: 'row-effort', text: 'Default' }));
      }
      if (isActive) {
        trailing.appendChild(el('span', { class: 'row-check' }, icon('check')));
      }
      var node = row({
        title: effort.name || id,
        sub: effort.description || '',
        active: isActive,
        trailing: trailing.childNodes.length ? trailing : null,
        onClick: (function (effortId) {
          return function () {
            selectModel(entry.provider, entry.model, effortId);
          };
        })(id)
      });
      if (isActive) node.setAttribute('aria-current', 'true');
      body.appendChild(node);
    });

    setSheetFoot(
      el('span', { text: 'Applies to the next turn in this session.' })
    );
  }

  function buildPresetSheet() {
    setSheetHead('Agent preset', 'How the agent plans, works and reports');
    var body = refs.sheetBody;

    if (!S.session) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'Open a session first to change its preset.'
        })
      );
      return;
    }

    if (!S.presets) {
      body.appendChild(
        el(
          'div',
          { class: 'sheet-loading' },
          el('span', { class: 'spin' }),
          el('span', { text: 'Loading agent presets…' })
        )
      );
      requestPresets();
      return;
    }

    if (!S.presets.list.length) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'No presets are available for this Harness.'
        })
      );
      return;
    }

    var current = (S.session && S.session.preset) || S.presets.current;
    S.presets.list.forEach(function (preset) {
      var isCurrent = preset.id === current;
      body.appendChild(
        row({
          icon: 'sliders',
          title: preset.title || preset.id,
          sub: preset.description || '',
          active: isCurrent,
          trailing: isCurrent
            ? el('span', { class: 'row-check' }, icon('check'))
            : null,
          onClick: function () {
            selectPreset(preset.id);
          }
        })
      );
    });

    setSheetFoot(
      el('span', { text: 'Applies to this session from the next turn.' })
    );
  }

  function buildMenuSheet() {
    setSheetHead(
      S.session ? S.session.title || 'Session' : 'Session',
      S.session ? 'Session options' : null
    );
    var body = refs.sheetBody;

    body.appendChild(
      row({
        icon: 'drawer',
        title: 'Sessions',
        sub: S.sessions.length + ' available',
        onClick: function () {
          openSheet('sessions');
        }
      })
    );

    body.appendChild(
      row({
        icon: 'activity',
        title: S.view === 'activity' ? 'Show chat' : 'Show activity',
        sub: 'Live tool calls, approvals and steps',
        onClick: function () {
          closeSheet();
          setView(S.view === 'activity' ? 'chat' : 'activity');
        }
      })
    );

    body.appendChild(
      row({
        icon: 'layers',
        title: 'Model',
        sub: 'For this session',
        trailing: el('span', { class: 'row-meta', text: modelDisplayLabel() || 'Default' }),
        onClick: function () {
          openSheet('model');
        }
      })
    );

    body.appendChild(
      row({
        icon: 'sliders',
        title: 'Agent preset',
        sub: 'For this session',
        trailing: el('span', { class: 'row-meta', text: presetLabel() || 'Default' }),
        onClick: function () {
          openSheet('preset');
        }
      })
    );

    if (S.session) {
      body.appendChild(el('p', { class: 'sheet-section', text: 'Session' }));
      body.appendChild(
        row({
          icon: 'compose',
          title: 'Rename session',
          sub: 'Change the title on the desktop',
          onClick: openRenameSheet
        })
      );
      body.appendChild(
        row({
          icon: 'pin',
          title: S.session.pinned ? 'Unpin session' : 'Pin session',
          sub: S.session.pinned
            ? 'Move back to the Recent group'
            : 'Keep this session at the top',
          onClick: toggleSessionPin
        })
      );
      body.appendChild(
        row({
          icon: 'archive',
          danger: !S.session.archived,
          title: S.session.archived
            ? 'Unarchive session'
            : S.confirmArchive
              ? 'Tap again to archive'
              : 'Archive session',
          sub: S.session.archived
            ? 'Make this session writable again'
            : S.session.running && S.confirmArchive
              ? 'This stops the current run.'
              : S.session.running
                ? 'Stops the current run first'
                : 'Move to the Archived group',
          onClick: requestArchiveSession
        })
      );
      body.appendChild(
        row({
          icon: 'fork',
          title: 'Fork session',
          sub: S.confirmFork
            ? 'Tap again to fork at the latest completed turn'
            : 'Continue from the latest completed turn',
          onClick: requestForkSession
        })
      );
      body.appendChild(
        row({
          icon: 'terminal',
          title: 'Commands',
          sub: 'Run a Harness command',
          onClick: openCommands
        })
      );
    }

    body.appendChild(el('p', { class: 'sheet-section', text: 'Appearance' }));
    body.appendChild(el('div', { class: 'theme-row' }, themeSegmented()));
    body.appendChild(
      el('p', {
        class: 'sheet-note',
        text: 'Auto follows your phone’s light or dark setting.'
      })
    );

    body.appendChild(el('p', { class: 'sheet-section', text: 'Alerts' }));
    var pushState = pushStatus();
    var enabling = S.push.busy;
    body.appendChild(
      row({
        icon: 'bell',
        title: 'Background notifications',
        sub: enabling ? 'Enabling…' : pushStatusText(pushState),
        trailing: switchNode(pushState === 'enabled', 'Background notifications'),
        disabled: enabling || pushState === 'insecure' || pushState === 'unsupported',
        onClick: function () {
          if (pushStatus() === 'enabled') disablePushNotifications();
          else enablePushNotifications();
        }
      })
    );
    body.appendChild(
      row({
        icon: 'refresh',
        title: 'Send test notification',
        sub: S.push.subscribed
          ? S.push.testing
            ? 'Sending…'
            : 'Send a test push to this phone'
          : 'Enable background notifications first',
        disabled: !S.push.subscribed || S.push.testing || enabling,
        onClick: function () {
          sendTestPush();
        }
      })
    );

    body.appendChild(el('p', { class: 'sheet-section', text: 'Privacy' }));
    body.appendChild(
      row({
        icon: 'lock',
        title: 'App lock',
        sub: !appLockSupported()
          ? 'Needs HTTPS (Tailscale) and a biometric-capable browser.'
          : appLock.enabled
            ? 'Locks after 5 min or 30 s in the background'
            : 'Require biometrics to open the app',
        trailing: switchNode(appLock.enabled, 'App lock'),
        disabled: !appLockSupported(),
        onClick: toggleAppLock
      })
    );

    body.appendChild(el('div', { class: 'sheet-divider' }));

    body.appendChild(
      row({
        icon: 'plus',
        title: 'New session',
        sub: 'Choose a preset and start fresh',
        onClick: function () {
          openSheet('new-session');
        }
      })
    );

    body.appendChild(
      row({
        icon: 'trash',
        danger: true,
        title: S.confirmUnpair ? 'Tap again to unpair' : 'Unpair this phone',
        sub: S.confirmUnpair
          ? 'This immediately revokes access.'
          : 'Remove this device from the desktop',
        onClick: function () {
          requestUnpair();
        }
      })
    );

    var deviceName = S.device && S.device.name ? S.device.name : 'this device';
    setSheetFoot(
      el(
        'span',
        { class: 'mono' },
        deviceName + ' · ' + (S.conn === 'online' ? 'Connected' : 'Disconnected') +
          ' · v' + (S.version || FALLBACK_VERSION)
      )
    );
  }

  function requestUnpair() {
    if (!S.confirmUnpair) {
      S.confirmUnpair = true;
      buildSheet();
      clearTimeout(S.confirmUnpairTimer);
      S.confirmUnpairTimer = setTimeout(function () {
        S.confirmUnpair = false;
        if (S.sheet === 'menu') buildSheet();
      }, 4000);
      return;
    }
    S.confirmUnpair = false;
    unpairDevice();
  }

  async function unpairDevice() {
    try {
      await postJSON('/api/unpair', {});
    } catch (err) {
      /* proceed regardless; cookie may already be gone */
    }
    teardownSocket();
    hideLockOverlay(true);
    S.phase = 'pairing';
    S.paired = false;
    S.sessions = [];
    S.activeSessionId = null;
    S.session = null;
    S.context = null;
    S.changes = { sessionId: null, items: [], loading: false };
    S.pendingDiff = null;
    S.commands = {
      sessionId: null,
      available: false,
      items: [],
      reason: '',
      loading: false
    };
    revokeMessagePreviewUrls(S.messages);
    S.messages = [];
    S.live = null;
    clearAttachments();
    S.approvals.clear();
    S.questions.clear();
    S.activity = [];
    S.activityOpen.clear();
    S.device = null;
    S.typing = false;
    store.del(LS_ACTIVE);
    closeSheet();
    refs.app.hidden = true;
    refs.pairing.hidden = false;
    refs.boot.hidden = true;
    showPairing();
    setPairStatus('This device is no longer paired. Enter the PIN to pair again.', {
      spinner: false
    });
  }

  function selectModel(provider, model, reasoningEffort) {
    if (!S.session) {
      toast('Open a session first.');
      return;
    }
    var effortId =
      typeof reasoningEffort === 'string' && reasoningEffort
        ? reasoningEffort
        : null;
    var entry = catalogEntry(provider, model);
    /* Never send an effort id to a model that does not advertise one. */
    if (!entry || !entry.reasoning || !effortEntry(entry, effortId)) {
      effortId = null;
    }
    var sent = sendFrame({
      type: 'model.select',
      sessionId: S.session.id,
      provider: provider,
      model: model,
      reasoningEffort: effortId
    });
    if (!sent) {
      toast('Not connected — try again in a moment.');
      return;
    }
    S.session.model = {
      provider: provider,
      model: model,
      reasoningEffort: effortId
    };
    var suffix =
      entry && entry.reasoning ? effortName(entry, effortId) || 'Default' : '';
    closeSheet();
    renderComposerMeta();
    toast(
      suffix
        ? 'Model set to ' + (modelLabel() || model) + ' · ' + suffix
        : 'Model set to ' + (modelLabel() || model) + '.'
    );
  }

  function selectPreset(presetId) {
    if (!S.session) {
      toast('Open a session first.');
      return;
    }
    var sent = sendFrame({
      type: 'preset.select',
      sessionId: S.session.id,
      preset: presetId
    });
    if (!sent) {
      toast('Not connected — try again in a moment.');
      return;
    }
    S.session.preset = presetId;
    closeSheet();
    renderHeader();
    toast('Preset set to ' + (presetLabel(presetId) || presetId) + '.');
  }

  function createSession(presetId, cwd) {
    closeSheet();
    var frame = { type: 'sessions.create' };
    if (presetId) frame.preset = presetId;
    var dir = typeof cwd === 'string' ? cwd.trim() : '';
    if (dir) frame.cwd = dir;
    if (!sendFrame(frame)) {
      toast('Not connected — try again in a moment.');
      return;
    }
    if (dir) rememberCwd(dir);
    S.creatingSession = true;
    refs.sessionTitle.textContent = 'Creating session…';
    renderHeaderState();
    clearTimeout(S.createTimer);
    S.createTimer = setTimeout(function () {
      if (S.creatingSession) {
        S.creatingSession = false;
        renderHeader();
        if (S.conn !== 'online') {
          /* The creation frame never had a live socket to travel over (a
             backgrounded phone can come back half-connected). Reconnect now
             instead of leaving the user staring at a stale banner. */
          reconnectNow();
          toast('Session creation timed out — reconnecting…');
        } else {
          toast('Session creation timed out.');
        }
      }
    }, 12000);
  }

  /* ---------- UI bindings ------------------------------------------------- */

  function bindPairingUI() {
    refs.pinInput.addEventListener('input', onPinInput);
    refs.pinInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (S.pin.length === PIN_LENGTH) submitPin();
      }
    });
    refs.pairForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (S.pin.length === PIN_LENGTH) submitPin();
    });
    refs.pinSlots.addEventListener('click', function (event) {
      if (event.target === refs.pinInput) return;
      try {
        refs.pinInput.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    });
  }

  function bindApp() {
    refs.btnSessions.addEventListener('click', function () {
      openSheet('sessions');
    });
    refs.btnNew.addEventListener('click', function () {
      openSheet('new-session');
    });
    refs.btnMenu.addEventListener('click', function () {
      openSheet('menu');
    });
    refs.tabChat.addEventListener('click', function () {
      setView('chat');
    });
    refs.tabActivity.addEventListener('click', function () {
      setView('activity');
    });
    refs.jump.addEventListener('click', function () {
      scrollToBottom(true);
    });
    refs.btnSend.addEventListener('click', sendPrompt);
    refs.btnStop.addEventListener('click', stopGeneration);
    refs.attachBtn.addEventListener('click', onAttachClick);
    refs.attachInput.addEventListener('change', onAttachFilesPicked);
    refs.composerInput.addEventListener('input', autosizeComposer);
    refs.composerInput.addEventListener('keydown', onComposerKeydown);
    refs.bannerAction.addEventListener('click', forceReconnect);

    refs.promptMode.addEventListener('click', function (event) {
      var target = event.target;
      while (
        target &&
        target !== refs.promptMode &&
        !target.getAttribute('data-mode')
      ) {
        target = target.parentNode;
      }
      if (!target || target === refs.promptMode) return;
      setPromptMode(target.getAttribute('data-mode'));
    });

    if (refs.btnUnarchive) {
      refs.btnUnarchive.addEventListener('click', function () {
        if (!sendSessionCommand({ type: 'session.unarchive' })) return;
        toast('Unarchiving session…');
      });
    }

    refs.activityFilter.addEventListener('click', function (event) {
      var target = event.target;
      while (target && target !== refs.activityFilter && !target.hasAttribute('data-filter')) {
        target = target.parentNode;
      }
      if (!target || target === refs.activityFilter) return;
      var filter = target.getAttribute('data-filter') || 'all';
      S.activityFilter = filter;
      refs.activityFilter.querySelectorAll('.seg-btn').forEach(function (btn) {
        var active = btn === target;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
      renderActivity();
      scrollActivityToBottom();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (refs.lightbox && !refs.lightbox.hidden) {
        closeLightbox();
        return;
      }
      if (S.sheet) closeSheet();
    });

    window.addEventListener('online', function () {
      if (S.phase === 'app' && S.conn !== 'online') forceReconnect();
    });
    window.addEventListener('offline', function () {
      if (S.phase === 'app') setConn('offline');
    });

    if (refs.appLockUnlock) {
      refs.appLockUnlock.addEventListener('click', onUnlockClick);
    }

    document.addEventListener('visibilitychange', function () {
      if (S.phase === 'app') sendVisibility(!document.hidden);
      if (document.hidden) {
        if (S.phase === 'app') S.hiddenAt = Date.now();
        /* No microphone stays hot in the background. */
        stopVoice({ quiet: true, commit: true });
        if (appLock.enabled) appLock.hiddenAt = Date.now();
        return;
      }
      setAttention(false);
      syncAppLockOnResume();
      if (S.phase === 'app') {
        /* Fast resume: a frozen page usually wakes with a dead socket. */
        resumeFromBackground();
        if (!appLock.locked) {
          requestContext();
          requestChanges();
        }
      }
    });
    window.addEventListener('focus', function () {
      if (!document.hidden) setAttention(false);
    });
  }

  /* ---------- Service worker (installable PWA) --------------------------- */

  /* Register only where the API exists and the page is a secure context
     (localhost counts). Failures are silent: the app works without it. */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      swHadController = !!navigator.serviceWorker.controller;
      window.addEventListener('controllerchange', function () {
        if (swReloading) return;
        if (!swHadController) {
          /* First install claimed the page: no reload needed, and reloading
             here would fight the install that is still settling. */
          swHadController = true;
          return;
        }
        swReloading = true;
        try {
          window.location.reload();
        } catch (err) {
          /* ignore */
        }
      });
      navigator.serviceWorker.addEventListener('message', function (event) {
        var data = event ? event.data : null;
        if (!data || data.type !== 'open-session') return;
        handleOpenSessionLink(data.sessionId);
      });
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(function () {
          /* unsupported / blocked: the SPA still runs from the network */
        });
    } catch (err) {
      /* ignore */
    }
  }

  /* ---------- Voice input (Web Speech API) ------------------------------- */

  function setupVoice() {
    var Ctor = null;
    try {
      Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    } catch (err) {
      Ctor = null;
    }
    voice.supported = !!Ctor;
    if (!Ctor || !refs.btnMic) {
      if (refs.btnMic) refs.btnMic.hidden = true;
      return;
    }
    refs.btnMic.hidden = false;
    refs.btnMic.addEventListener('click', toggleVoice);

    var recognizer = new Ctor();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    recognizer.lang = navigator.language || 'en-US';
    recognizer.onresult = onVoiceResult;
    recognizer.onerror = onVoiceError;
    recognizer.onend = onVoiceEnd;
    voice.recognizer = recognizer;
  }

  function toggleVoice() {
    if (voice.active) stopVoice({ commit: true });
    else startVoice();
  }

  function startVoice() {
    if (!voice.supported || !voice.recognizer) {
      toast('Voice input is not supported in this browser.');
      return;
    }
    if (S.phase !== 'app' || S.conn !== 'online') {
      toast('Reconnecting — try again in a moment.');
      return;
    }
    if (!S.activeSessionId) {
      toast('Open a session first.');
      return;
    }
    if (sessionIsArchived()) {
      toast('Archived session — unarchive to use voice input.');
      return;
    }
    if (voice.active) return;
    voice.base = refs.composerInput.value;
    voice.finalText = '';
    voice.interim = '';
    voice.error = false;
    voice.stopping = false;
    voice.restarts = 0;
    voice.active = true;
    refs.btnMic.classList.add('is-listening');
    refs.btnMic.setAttribute('aria-pressed', 'true');
    renderComposerMeta();
    try {
      voice.recognizer.start();
      haptic(8);
    } catch (err) {
      voice.active = false;
      refs.btnMic.classList.remove('is-listening');
      refs.btnMic.setAttribute('aria-pressed', 'false');
      renderComposerMeta();
      toast('Could not start voice input.');
    }
  }

  function stopVoice(options) {
    options = options || {};
    if (!voice.active) return;
    var commit = options.commit !== false;
    voice.active = false;
    voice.stopping = true;
    clearTimeout(voice.restartTimer);
    voice.restartTimer = null;
    if (commit && voice.interim) {
      voice.finalText = joinSpeech(voice.finalText, voice.interim);
      voice.interim = '';
      updateVoiceComposer();
    }
    if (refs.btnMic) {
      refs.btnMic.classList.remove('is-listening');
      refs.btnMic.setAttribute('aria-pressed', 'false');
    }
    try {
      if (voice.recognizer) voice.recognizer.abort();
    } catch (err) {
      /* ignore */
    }
    renderComposerMeta();
  }

  function joinSpeech(existing, addition) {
    var left = String(existing || '').trim();
    var right = String(addition || '').trim();
    if (!left) return right;
    if (!right) return left;
    return left + ' ' + right;
  }

  function voiceSpokenText() {
    var spoken = voice.finalText;
    if (voice.interim) spoken = joinSpeech(spoken, voice.interim);
    return spoken;
  }

  function updateVoiceComposer() {
    var spoken = voiceSpokenText();
    var base = voice.base || '';
    var text;
    if (!base.trim()) text = spoken;
    else if (!spoken) text = base;
    else text = /\s$/.test(base) ? base + spoken : base + ' ' + spoken;
    refs.composerInput.value = text;
    autosizeComposer();
    updateSendState();
  }

  function onVoiceResult(event) {
    if (!voice.active || !event) return;
    var interim = '';
    try {
      for (var i = event.resultIndex; i < event.results.length; i += 1) {
        var result = event.results[i];
        var transcript =
          result && result[0] && result[0].transcript ? result[0].transcript : '';
        if (!transcript) continue;
        if (result.isFinal) {
          voice.finalText = joinSpeech(voice.finalText, transcript);
        } else {
          interim = joinSpeech(interim, transcript);
        }
      }
    } catch (err) {
      return;
    }
    voice.interim = interim;
    /* Speech keeps the restart budget fresh, so a long dictation is not cut
       off by the guard that protects against an instant end-loop. */
    voice.restarts = 0;
    updateVoiceComposer();
  }

  function onVoiceError(event) {
    var code = event && event.error ? String(event.error) : '';
    if (code === 'aborted') return;
    voice.error = true;
    if (voice.active) stopVoice({ quiet: true, commit: true });
    var messages = {
      'not-allowed': 'Microphone access is blocked. Allow it in browser settings.',
      'service-not-allowed': 'Microphone access is blocked. Allow it in browser settings.',
      'no-speech': 'No speech detected. Try again.',
      network: 'Voice recognition needs a network connection.',
      'audio-capture': 'No microphone was found.'
    };
    toast(messages[code] || 'Voice input stopped.');
  }

  function onVoiceEnd() {
    if (!voice.active) return;
    if (voice.error) {
      stopVoice({ quiet: true, commit: true });
      return;
    }
    voice.restarts += 1;
    if (voice.restarts > 6) {
      stopVoice({ quiet: true, commit: true });
      return;
    }
    clearTimeout(voice.restartTimer);
    voice.restartTimer = setTimeout(function () {
      if (!voice.active) return;
      try {
        voice.recognizer.start();
      } catch (err) {
        stopVoice({ quiet: true, commit: true });
      }
    }, 160);
  }

  /* ---------- Background notifications (Web Push) ------------------------ */

  /**
   * What the browser can do here:
   *   insecure    — no secure context, so no service worker and no push
   *   unsupported — secure, but no Notification/PushManager/service worker
   *   supported   — the full lifecycle is available
   */
  function pushCapability() {
    try {
      if (!window.isSecureContext) return 'insecure';
      if (typeof window.Notification !== 'function') return 'unsupported';
      if (!('serviceWorker' in navigator)) return 'unsupported';
      if (typeof window.PushManager !== 'function') return 'unsupported';
      if (typeof navigator.serviceWorker.getRegistration !== 'function') return 'unsupported';
      return 'supported';
    } catch (err) {
      return 'unsupported';
    }
  }

  function notificationPermission() {
    try {
      return typeof window.Notification === 'function'
        ? window.Notification.permission
        : 'denied';
    } catch (err) {
      return 'denied';
    }
  }

  function pushStatus() {
    var capability = pushCapability();
    if (capability === 'insecure') return 'insecure';
    if (capability === 'unsupported') return 'unsupported';
    if (notificationPermission() === 'denied') return 'denied';
    if (S.push.lastError === 'subscribe') return 'error';
    if (S.push.subscribed) return 'enabled';
    return 'off';
  }

  function pushStatusText(status) {
    if (status === 'enabled') return 'Enabled — alerts while closed';
    if (status === 'insecure') return 'Needs HTTPS or localhost';
    if (status === 'unsupported') return 'Unsupported — install to Home Screen';
    if (status === 'denied') return 'Permission denied in browser settings';
    if (status === 'error') return 'Subscription error — tap to retry';
    return 'Off — enable background alerts';
  }

  function requestNotificationPermission() {
    return new Promise(function (resolve) {
      if (notificationPermission() === 'granted') {
        resolve('granted');
        return;
      }
      var settled = false;
      function finish(permission) {
        if (settled) return;
        settled = true;
        resolve(permission === 'granted' ? 'granted' : permission || 'default');
      }
      try {
        var result = window.Notification.requestPermission(function (permission) {
          finish(permission);
        });
        if (result && typeof result.then === 'function') {
          result.then(finish).catch(function () {
            finish('denied');
          });
        }
      } catch (err) {
        finish('denied');
      }
    });
  }

  function decodeBase64Url(value) {
    var text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4 !== 0) text += '=';
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* A browser without a reachable push service can leave subscribe() pending
     forever; bound it so the sheet never sticks on "Enabling…" indefinitely. */
  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error(message || 'timeout'));
      }, ms);
      Promise.resolve(promise).then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Resolve the active service worker registration without hanging forever. */
  function getPushRegistration() {
    if (pushCapability() !== 'supported') return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration().then(function (registration) {
      if (registration) return registration;
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          resolve(null);
        }, 8000);
        navigator.serviceWorker.ready
          .then(function (ready) {
            clearTimeout(timer);
            resolve(ready || null);
          })
          .catch(function () {
            clearTimeout(timer);
            resolve(null);
          });
      });
    }).catch(function () {
      return null;
    });
  }

  /**
   * Idempotent start/reconnect sync: never prompts, never creates a
   * subscription. It only re-POSTs the one the browser already has, which keeps
   * the Host's per-device store fresh after a rotation.
   */
  function syncPushSubscription() {
    S.push.capability = pushCapability();
    S.push.permission = notificationPermission();
    if (S.push.capability !== 'supported' || S.push.permission !== 'granted') {
      return;
    }
    getPushRegistration().then(function (registration) {
      if (!registration || !registration.pushManager || typeof registration.pushManager.getSubscription !== 'function') {
        return null;
      }
      return registration.pushManager.getSubscription().then(function (subscription) {
        if (!subscription) {
          S.push.subscribed = false;
          S.push.endpoint = '';
          if (S.sheet === 'menu') buildSheet();
          return null;
        }
        S.push.subscribed = true;
        S.push.endpoint = subscription.endpoint;
        if (S.sheet === 'menu') buildSheet();
        var json = null;
        try {
          json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : null;
        } catch (err) {
          json = null;
        }
        if (!json) return null;
        return postJSON('/api/push/subscribe', { subscription: json }).catch(function () {});
      });
    }).catch(function () {
      /* best effort: the row falls back to Off and the user can retry */
    });
  }

  function refreshPushStatus() {
    S.push.capability = pushCapability();
    S.push.permission = notificationPermission();
    if (S.push.capability !== 'supported' || S.push.permission !== 'granted') {
      S.push.subscribed = false;
      S.push.endpoint = '';
      if (S.sheet === 'menu') buildSheet();
      return;
    }
    getPushRegistration().then(function (registration) {
      if (!registration || !registration.pushManager || typeof registration.pushManager.getSubscription !== 'function') {
        S.push.subscribed = false;
        S.push.endpoint = '';
        if (S.sheet === 'menu') buildSheet();
        return null;
      }
      return registration.pushManager.getSubscription().then(function (subscription) {
        S.push.subscribed = !!subscription;
        S.push.endpoint = subscription ? subscription.endpoint : '';
      }).catch(function () {
        S.push.subscribed = false;
        S.push.endpoint = '';
      }).then(function () {
        if (S.sheet === 'menu') buildSheet();
      });
    }).catch(function () {
      if (S.sheet === 'menu') buildSheet();
    });
  }

  /** Bounded diagnostic beacon for push troubleshooting (no endpoints/keys). */
function reportPushClient(kind, detail) {
  try {
    fetch('/api/push/report', {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: String(kind || 'client').slice(0, 40),
        detail: String(detail || '').slice(0, 180),
        scope: String(window.location.origin || '')
      })
    }).catch(function () {});
  } catch (err) {
    /* diagnostics must never break the UI */
  }
}

async function enablePushNotifications() {
    if (S.push.busy) return;
    var status = pushStatus();
    if (status === 'insecure') {
      toast('Background notifications need HTTPS (Tailscale Serve) or localhost.');
      return;
    }
    if (status === 'unsupported') {
      toast('This browser cannot show background notifications. On iPhone, add the app to your Home Screen first.');
      return;
    }
    if (status === 'denied') {
      toast('Notifications are blocked — allow them in browser settings first.');
      return;
    }
    S.push.busy = true;
    S.push.lastError = '';
    if (S.sheet === 'menu') buildSheet();
    try {
      var permission = await requestNotificationPermission();
      S.push.permission = permission;
      if (permission !== 'granted') {
        S.push.lastError = '';
        toast(
          permission === 'denied'
            ? 'Notifications are blocked in browser settings.'
            : 'Notification permission was not granted.'
        );
        return;
      }
      var keyResponse = await fetchJSON('/api/push/key');
      var keyData = keyResponse.data || {};
      if (!keyResponse.ok || keyData.enabled !== true || typeof keyData.publicKey !== 'string') {
        S.push.lastError = 'subscribe';
        toast('Background notifications are not enabled on the Host.');
        return;
      }
      var registration = await getPushRegistration();
      if (!registration || !registration.pushManager) {
        S.push.lastError = 'subscribe';
        toast('The service worker is not ready yet — try again in a moment.');
        return;
      }
      var subscription = null;
      try {
        subscription = await withTimeout(registration.pushManager.getSubscription(), 5000, 'get');
      } catch (err) {
        subscription = null;
      }
      if (!subscription) {
        subscription = await withTimeout(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeBase64Url(keyData.publicKey)
          }),
          15000,
          'subscribe'
        );
      }
      var json = null;
      try {
        json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : null;
      } catch (err) {
        json = null;
      }
      if (!json) throw new Error('subscription');
      var subscribed = await postJSON('/api/push/subscribe', { subscription: json });
      if (!subscribed.ok) {
        S.push.lastError = 'subscribe';
        if (subscribed.status === 429) {
          toast('Too many subscribed phones — remove one on the desktop first.');
        } else {
          toast('The Host rejected the push subscription.');
        }
        return;
      }
      S.push.subscribed = true;
      S.push.endpoint = subscription.endpoint || '';
      S.push.lastError = '';
      reportPushClient(
        'push-enabled',
        'permission=' + (notificationPermission() || 'unknown')
      );
      toast('Background notifications on');
    } catch (err) {
      S.push.lastError = 'subscribe';
      toast(
        notificationPermission() === 'denied'
          ? 'Notifications are blocked in browser settings.'
          : 'Could not enable background notifications.'
      );
    } finally {
      S.push.busy = false;
      if (S.sheet === 'menu') buildSheet();
    }
  }

  async function disablePushNotifications() {
    if (S.push.busy) return;
    S.push.busy = true;
    try {
      var endpoint = S.push.endpoint || '';
      var registration = await getPushRegistration();
      var subscription = null;
      if (registration && registration.pushManager && typeof registration.pushManager.getSubscription === 'function') {
        try {
          subscription = await registration.pushManager.getSubscription();
        } catch (err) {
          subscription = null;
        }
      }
      if (subscription) {
        endpoint = subscription.endpoint || endpoint;
        try {
          await subscription.unsubscribe();
        } catch (err) {
          /* the Host-side removal below is still worth trying */
        }
      }
      if (endpoint) {
        await postJSON('/api/push/unsubscribe', { endpoint: endpoint }).catch(function () {});
      }
      S.push.subscribed = false;
      S.push.endpoint = '';
      S.push.lastError = '';
      toast('Background notifications off');
    } catch (err) {
      toast('Could not turn off background notifications.');
    } finally {
      S.push.busy = false;
      if (S.sheet === 'menu') buildSheet();
    }
  }

  async function sendTestPush() {
    if (!S.push.subscribed || S.push.testing) {
      toast('Enable background notifications first.');
      return;
    }
    S.push.testing = true;
    if (S.sheet === 'menu') buildSheet();
    try {
      var result = await postJSON('/api/push/test', {});
      var data = result.data || {};
      if (result.ok && data.sent > 0) {
        toast('Test notification sent');
      } else if (result.ok && data.sent === 0) {
        if (Array.isArray(data.failures) && data.failures.length > 0) {
          var status = data.failures[0].status;
          toast(status ? 'Push service rejected it (HTTP ' + status + ').' : 'Push service is unreachable.');
        } else {
          toast('No subscription on the Host — enable again.');
        }
      } else {
        toast('Could not send the test notification.');
      }
    } catch (err) {
      toast('Could not send the test notification.');
    } finally {
      S.push.testing = false;
      if (S.sheet === 'menu') buildSheet();
    }
  }

  function switchNode(on, label) {
    return el(
      'span',
      {
        class: 'switch' + (on ? ' is-on' : ''),
        attrs: {
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': label || 'Notifications'
        }
      },
      el('span', { class: 'switch-thumb', attrs: { 'aria-hidden': 'true' } })
    );
  }

  function setAttention(on) {
    S.attention = !!on;
    try {
      document.title = S.attention ? '● ' + ATTENTION_TITLE : ATTENTION_TITLE;
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * Page-level `new Notification` is only a fallback for a hidden page whose
   * permission is granted but where Web Push is not (or could not be) enabled.
   * With a live push subscription the service worker is the single notifier.
   */
  function pageNotificationFallbackAllowed() {
    if (!document.hidden) return false;
    if (notificationPermission() !== 'granted') return false;
    return !S.push.subscribed;
  }

  function sendSystemNotification(title, body, tag, sessionId) {
    if (!pageNotificationFallbackAllowed()) return;
    var key = String(tag || '') + '|' + String(sessionId || '');
    if (notifiedKeys[key]) return;
    notifiedKeys[key] = Date.now();
    var keys = Object.keys(notifiedKeys);
    if (keys.length > 60) {
      keys.sort(function (a, b) {
        return notifiedKeys[a] - notifiedKeys[b];
      });
      for (var i = 0; i < keys.length - 40; i += 1) delete notifiedKeys[keys[i]];
    }
    setAttention(true);
    try {
      var notification = new window.Notification(title, {
        body: String(body || '').slice(0, 160),
        tag: tag ? String(tag) : undefined,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png'
      });
      notification.onclick = function () {
        try {
          window.focus();
        } catch (err) {
          /* ignore */
        }
        if (sessionId && sessionId !== S.activeSessionId) {
          openSession(sessionId, {});
        }
        try {
          notification.close();
        } catch (err) {
          /* ignore */
        }
        setAttention(false);
      };
    } catch (err) {
      /* some embedded browsers expose Notification but refuse the constructor */
    }
  }

  function notifyIncomingApproval(item) {
    var reason = item.displayReason || item.reason || '';
    sendSystemNotification(
      'Approval needed',
      (item.toolName || 'Tool') + (reason ? ' — ' + reason : ''),
      'approval:' + item.requestId,
      item.sessionId
    );
  }

  function notifyQuestionFrame(frame, questions) {
    var first = firstQuestionText(questions);
    var id = frame.requestId || frame.callId || '';
    sendSystemNotification(
      'Question from Harness',
      first,
      'question:' + id,
      frame.sessionId || null
    );
  }

  function notifyReplyReady(seq) {
    if (!S.session || !S.activeSessionId) return;
    sendSystemNotification(
      'Reply ready',
      S.session.title || 'Your reply is ready.',
      'reply:' + S.activeSessionId + ':' + (seq || 0),
      S.activeSessionId
    );
  }

  /* ---------- Share target (?share= / defensive aliases) ------------------ */

  function readShareParams() {
    var url = null;
    try {
      url = new URL(window.location.href);
    } catch (err) {
      return;
    }
    var params = url.searchParams;
    var shared = params.get('share');
    if (
      shared === null &&
      !params.has('share_text') &&
      !params.has('share_url') &&
      !params.has('share_title')
    ) {
      return;
    }

    var payload = null;
    if (shared) {
      try {
        payload = JSON.parse(shared);
      } catch (err) {
        payload = null;
      }
    }
    function stringOf(value) {
      return typeof value === 'string' ? value : '';
    }
    var title = stringOf(payload && payload.title) || stringOf(params.get('share_title'));
    var text = stringOf(payload && payload.text) || stringOf(params.get('share_text'));
    var link = stringOf(payload && payload.url) || stringOf(params.get('share_url'));

    var parts = [];
    if (title.trim()) parts.push(title.trim().slice(0, 300));
    if (text.trim()) parts.push(text.trim().slice(0, 7500));
    if (link.trim()) {
      var joined = parts.join('\n');
      if (joined.indexOf(link.trim()) === -1) parts.push(link.trim().slice(0, 2000));
    }
    var draft = parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (draft) S.shareDraft = draft.slice(0, 7800);

    params.delete('share');
    params.delete('share_text');
    params.delete('share_url');
    params.delete('share_title');
    var qs = params.toString();
    try {
      window.history.replaceState(
        null,
        '',
        url.pathname + (qs ? '?' + qs : '') + url.hash
      );
    } catch (err) {
      /* ignore */
    }
  }

  function applyShareDraft() {
    if (!S.shareDraft) return;
    var draft = S.shareDraft;
    S.shareDraft = '';
    var input = refs.composerInput;
    if (!input) return;
    var current = input.value.trim();
    input.value = current ? current + '\n\n' + draft : draft;
    autosizeComposer();
    setView('chat');
    if (!S.pinned) scrollToBottom(false);
    toast('Shared content added to the message box.');
  }

  /* ---------- Attachment source sheet ------------------------------------ */

  function buildAttachSheet() {
    setSheetHead('Add attachment', 'Choose a source');
    var body = refs.sheetBody;
    body.appendChild(
      row({
        icon: 'camera',
        title: 'Take photo',
        sub: 'Open the camera and shoot one image',
        onClick: function () {
          pickAttachment('camera');
        }
      })
    );
    body.appendChild(
      row({
        icon: 'image',
        title: 'Photo library',
        sub: 'Choose one or more images',
        onClick: function () {
          pickAttachment('photos');
        }
      })
    );
    body.appendChild(
      row({
        icon: 'file',
        title: 'File',
        sub: 'Pick any file from this device',
        onClick: function () {
          pickAttachment('file');
        }
      })
    );
    var limitHint = attachLimitHint();
    if (limitHint) {
      body.appendChild(
        el('p', { class: 'sheet-note sheet-limit-hint', text: limitHint })
      );
    }
    setSheetFoot(
      el('span', {
        text: 'Attachments upload to this session and are referenced in your message.'
      })
    );
  }

  /* ---------- Batch C: queue/steer, archived, session management, limits -- */

  function normalizeImageLimits(image) {
    if (!image || typeof image !== 'object') return null;
    var maxBytes = Number(image.maxBytes);
    var maxImages = Number(image.maxImages);
    var maxDimension = Number(image.maxDimension);
    var maxMessageBytes = Number(image.maxMessageBytes);
    var mediaTypes = Array.isArray(image.mediaTypes)
      ? image.mediaTypes.filter(function (type) {
          return typeof type === 'string';
        }).slice(0, 12)
      : [];
    var normalized = {
      maxBytes: isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null,
      maxDimension: isFinite(maxDimension) && maxDimension > 0 ? maxDimension : null,
      maxImages: isFinite(maxImages) && maxImages > 0 ? Math.floor(maxImages) : null,
      maxMessageBytes:
        isFinite(maxMessageBytes) && maxMessageBytes > 0 ? maxMessageBytes : null,
      mediaTypes: mediaTypes
    };
    if (!normalized.maxBytes && !normalized.maxImages) return null;
    return normalized;
  }

  function queuePlacementLabel(placement) {
    if (placement === 'steering') return 'Steering';
    if (placement === 'context') return 'Context';
    return 'Queued';
  }

  function applyQueueFrame(sessionId, items, meta) {
    /* Strict session scoping: a queue frame for another session is dropped. */
    if (!sessionId || sessionId !== S.activeSessionId) return;
    var normalized = [];
    (items || []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var text = item.text == null ? '' : String(item.text);
      if (!text.trim()) return;
      normalized.push({
        id: String(item.id || 'q-' + normalized.length),
        placement:
          item.placement === 'steering' || item.placement === 'context'
            ? item.placement
            : 'queued',
        rpcId: item.rpcId ? String(item.rpcId) : '',
        text: text
      });
    });
    var keptExpanded = S.queue.expanded && S.queue.sessionId === sessionId;
    S.queue = {
      sessionId: sessionId,
      items: normalized,
      pendingInput:
        meta && Array.isArray(meta.pendingInput) ? meta.pendingInput.slice(0, 8) : [],
      running: !!(meta && meta.running),
      active: !(meta && meta.active === false),
      expanded: keptExpanded
    };
    if (
      S.pendingSteer &&
      normalized.some(function (item) {
        return item.rpcId === S.pendingSteer.requestId;
      })
    ) {
      clearTimeout(S.steerTimer);
      S.pendingSteer = null;
    }
    renderQueueStrip();
    renderComposerMeta();
    updateSendState();
  }

  function queueVisible() {
    return !!(
      S.session &&
      !S.session.archived &&
      S.session.agentAvailable &&
      S.queue.items.length &&
      S.queue.sessionId === S.activeSessionId
    );
  }

  function renderQueueStrip() {
    var strip = refs.queueStrip;
    if (!strip) return;
    if (!queueVisible()) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    strip.hidden = false;
    var items = S.queue.items;
    var expanded = !!S.queue.expanded;
    var head = el(
      'button',
      {
        class: 'queue-head',
        attrs: { type: 'button', 'aria-expanded': expanded ? 'true' : 'false' }
      },
      el('span', { class: 'queue-dot', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'queue-count', text: items.length + ' queued' }),
      el(
        'span',
        { class: 'queue-head-meta' },
        el('span', {
          class: 'queue-hint',
          text: S.session && S.session.running ? 'Steer available' : 'Next turn'
        }),
        icon('chevron-down', 'queue-chevron')
      )
    );
    head.addEventListener('click', function () {
      S.queue.expanded = !S.queue.expanded;
      if (
        S.queue.expanded &&
        S.session &&
        S.session.agentAvailable &&
        !S.session.archived
      ) {
        sendFrame({ type: 'queue.list', sessionId: S.session.id });
      }
      renderQueueStrip();
    });
    strip.replaceChildren(head);
    if (!expanded) return;
    var list = el('div', { class: 'queue-list' });
    items.forEach(function (item) {
      var button = el('button', { class: 'queue-item', attrs: { type: 'button' } });
      button.appendChild(el('span', { class: 'queue-item-text', text: item.text }));
      button.appendChild(
        el(
          'span',
          { class: 'queue-item-meta' },
          el('span', {
            class: 'queue-tag is-' + item.placement,
            text: queuePlacementLabel(item.placement)
          }),
          el('span', { class: 'queue-open', text: 'Manage' })
        )
      );
      button.addEventListener('click', function () {
        S.queueAction = item;
        S.queueRemoveConfirm = false;
        openSheet('queue-item');
      });
      list.appendChild(button);
    });
    strip.appendChild(list);
  }

  function buildQueueItemSheet() {
    var item = S.queueAction;
    if (!item) {
      closeSheet();
      return;
    }
    setSheetHead(
      'Queued message',
      queuePlacementLabel(item.placement) + ' · ' + S.queue.items.length + ' in queue'
    );
    var body = refs.sheetBody;
    body.appendChild(el('p', { class: 'queue-preview', text: item.text }));
    var steerable = !!(
      item.placement === 'queued' &&
      S.session &&
      S.session.running &&
      S.session.agentAvailable &&
      !S.session.archived
    );
    if (steerable) {
      body.appendChild(
        row({
          icon: 'arrow-up',
          accent: true,
          title: 'Steer now',
          sub: 'Inject into the current step',
          onClick: function () {
            steerQueueItem(item);
          }
        })
      );
    }
    body.appendChild(
      row({
        icon: 'compose',
        title: 'Edit message',
        sub: 'Change the queued text',
        onClick: function () {
          openSheet('queue-edit');
        }
      })
    );
    body.appendChild(
      row({
        icon: 'trash',
        danger: true,
        title: S.queueRemoveConfirm ? 'Tap again to remove' : 'Remove from queue',
        sub: S.queueRemoveConfirm
          ? 'This discards the queued message.'
          : 'Discard this queued message',
        onClick: function () {
          requestQueueRemove(item);
        }
      })
    );
    setSheetFoot(el('span', { text: 'Queue changes apply to this live session only.' }));
  }

  function buildQueueEditSheet() {
    var item = S.queueAction;
    if (!item) {
      closeSheet();
      return;
    }
    setSheetHead('Edit queued message', 'Saved into the session queue');
    var body = refs.sheetBody;
    var area = el('textarea', {
      class: 'sheet-textarea',
      attrs: { rows: '4', maxlength: '4000', 'aria-label': 'Queued message text' }
    });
    area.value = item.text;
    body.appendChild(area);
    var save = el('button', {
      class: 'btn btn-primary btn-block',
      attrs: { type: 'button' },
      text: 'Save'
    });
    var sync = function () {
      save.disabled = !area.value.trim();
    };
    area.addEventListener('input', sync);
    sync();
    save.addEventListener('click', function () {
      var text = area.value.trim();
      if (!text || !S.session) return;
      if (
        !sendFrame({
          type: 'queue.update',
          sessionId: S.session.id,
          itemId: item.id,
          action: 'edit',
          text: text
        })
      ) {
        toast('Not connected — try again in a moment.');
        return;
      }
      item.text = text;
      renderQueueStrip();
      closeSheet();
    });
    body.appendChild(save);
    window.requestAnimationFrame(function () {
      try {
        area.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    });
  }

  function steerQueueItem(item) {
    if (!S.session || !item) return;
    if (
      !sendFrame({
        type: 'queue.update',
        sessionId: S.session.id,
        itemId: item.id,
        action: 'steer'
      })
    ) {
      toast('Not connected — try again in a moment.');
      return;
    }
    S.queue.items = S.queue.items.filter(function (queued) {
      return queued.id !== item.id;
    });
    renderQueueStrip();
    closeSheet();
    toast('Steering the current step.');
  }

  function requestQueueRemove(item) {
    if (!item || !S.session) return;
    if (!S.queueRemoveConfirm) {
      S.queueRemoveConfirm = true;
      buildSheet();
      return;
    }
    S.queueRemoveConfirm = false;
    if (
      !sendFrame({
        type: 'queue.update',
        sessionId: S.session.id,
        itemId: item.id,
        action: 'remove'
      })
    ) {
      toast('Not connected — try again in a moment.');
      return;
    }
    S.queue.items = S.queue.items.filter(function (queued) {
      return queued.id !== item.id;
    });
    renderQueueStrip();
    closeSheet();
    toast('Removed from the queue.');
  }

  function renderArchivedBanner() {
    var banner = refs.archivedBanner;
    if (!banner) return;
    var show = !!(S.session && S.session.archived);
    banner.hidden = !show;
    if (S.session) {
      refs.sessionTitle.classList.toggle('is-archived', show);
    }
  }

  function renderPromptMode() {
    var group = refs.promptMode;
    if (!group) return;
    var show = !!(
      S.session &&
      S.session.running &&
      S.session.agentAvailable &&
      !S.session.archived
    );
    if (!show) S.promptMode = 'queue';
    group.hidden = !show;
    /* The narrow-phone CSS hides the decorative meter track while Queue/Steer
       shares the meta row, so the centred meter cannot push the cluster off. */
    var meta = refs.composerNote ? refs.composerNote.parentElement : null;
    if (meta && meta.classList) meta.classList.toggle('has-mode', show);
    var buttons = group.querySelectorAll('.prompt-mode-btn');
    Array.prototype.forEach.call(buttons, function (button) {
      var active = button.getAttribute('data-mode') === S.promptMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setPromptMode(mode) {
    var next = mode === 'steer' ? 'steer' : 'queue';
    var available = !!(
      S.session &&
      S.session.running &&
      S.session.agentAvailable &&
      !S.session.archived
    );
    if (next === 'steer' && !available) {
      toast('Steering is available while the agent is running.');
      next = 'queue';
    }
    S.promptMode = next;
    /* renderComposerMeta owns the prompt-mode and context-meter refresh. */
    renderComposerMeta();
    haptic(4);
  }

  function sendSessionCommand(frame, label) {
    if (!S.session) return false;
    frame.sessionId = S.session.id;
    if (!sendFrame(frame)) {
      toast('Not connected — try again in a moment.');
      return false;
    }
    haptic(6);
    if (label) toast(label);
    return true;
  }

  function openRenameSheet() {
    if (!S.session) return;
    openSheet('rename');
  }

  function buildRenameSheet() {
    setSheetHead('Rename session', 'The desktop may shorten very long titles');
    var body = refs.sheetBody;
    var input = el('input', {
      class: 'sheet-text-input',
      attrs: {
        type: 'text',
        maxlength: '200',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'Session title',
        placeholder: 'Session title'
      }
    });
    input.value = (S.session && S.session.title) || '';
    var save = el('button', {
      class: 'btn btn-primary btn-block',
      attrs: { type: 'button' },
      text: 'Save title'
    });
    var sync = function () {
      save.disabled = !input.value.trim();
    };
    input.addEventListener('input', sync);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        save.click();
      }
    });
    save.addEventListener('click', function () {
      var title = input.value.trim();
      if (!title || !S.session) return;
      if (!sendSessionCommand({ type: 'session.rename', title: title })) return;
      S.renameDraft = title;
      closeSheet();
    });
    body.appendChild(
      el('p', {
        class: 'sheet-note',
        text: 'The title updates on the desktop and in this list.'
      })
    );
    body.appendChild(input);
    body.appendChild(save);
    sync();
    window.requestAnimationFrame(function () {
      try {
        input.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    });
  }

  function toggleSessionPin() {
    if (!S.session) return;
    var pinned = !!S.session.pinned;
    if (!sendSessionCommand({ type: pinned ? 'session.unpin' : 'session.pin' })) return;
    closeSheet();
  }

  function requestArchiveSession() {
    if (!S.session) return;
    if (S.session.archived) {
      if (!sendSessionCommand({ type: 'session.unarchive' })) return;
      closeSheet();
      return;
    }
    var running = !!S.session.running;
    if (running && !S.confirmArchive) {
      S.confirmArchive = true;
      buildSheet();
      clearTimeout(S.confirmArchiveTimer);
      S.confirmArchiveTimer = setTimeout(function () {
        S.confirmArchive = false;
        if (S.sheet === 'menu') buildSheet();
      }, 4000);
      return;
    }
    S.confirmArchive = false;
    var frame = { type: 'session.archive' };
    if (running) frame.stopActivity = true;
    if (!sendSessionCommand(frame)) return;
    closeSheet();
    toast(running ? 'Archiving — stopping the current run…' : 'Archiving session…');
  }

  function requestForkSession() {
    if (!S.session) return;
    if (!S.confirmFork) {
      S.confirmFork = true;
      buildSheet();
      clearTimeout(S.confirmForkTimer);
      S.confirmForkTimer = setTimeout(function () {
        S.confirmFork = false;
        if (S.sheet === 'menu') buildSheet();
      }, 4000);
      return;
    }
    S.confirmFork = false;
    /* The fork arrives as a new session.opened: drop stale live state first. */
    stopVoice({ quiet: true, commit: true });
    S.live = null;
    S.typing = false;
    S.activeTools.clear();
    S.queue.items = [];
    S.promptMode = 'queue';
    if (!sendSessionCommand({ type: 'session.fork' })) return;
    closeSheet();
    toast('Forking this session…');
  }

  function scheduleSessionSearch(query) {
    var q = String(query || '').trim();
    clearTimeout(S.search.timer);
    if (S.search.unavailable) return;
    if (q.length < 3) {
      S.search.results = [];
      S.search.activeQuery = '';
      S.search.inFlight = false;
      refreshFoundSection();
      return;
    }
    S.search.timer = setTimeout(function () {
      if (S.search.unavailable) return;
      S.search.activeQuery = q.toLowerCase();
      S.search.inFlight = true;
      if (!sendFrame({ type: 'sessions.search', query: q })) {
        S.search.inFlight = false;
      }
    }, 350);
  }

  function sessionSearchUnavailable() {
    S.search.unavailable = true;
    S.search.inFlight = false;
    S.search.results = [];
    clearTimeout(S.search.timer);
    if (!S.search.showedToast) {
      S.search.showedToast = true;
      toast('Message search is not available on this desktop.');
    }
    refreshFoundSection();
  }

  function refreshFoundSection() {
    var box = document.getElementById('session-found');
    if (!box) return;
    box.replaceChildren();
    if (S.search.unavailable) return;
    if (!S.search.results.length) return;
    if (S.search.activeQuery !== S.sessionQuery) return;
    var known = {};
    S.sessions.forEach(function (session) {
      known[session.id] = true;
    });
    var results = S.search.results.filter(function (result) {
      return result && result.id && !known[result.id];
    });
    if (!results.length) return;
    box.appendChild(el('p', { class: 'sheet-section', text: 'Messages' }));
    results.forEach(function (result) {
      var rowNode = el('button', { class: 'row row-found', attrs: { type: 'button' } });
      rowNode.appendChild(el('span', { class: 'row-icon' }, icon('search')));
      rowNode.appendChild(
        el(
          'span',
          { class: 'row-main' },
          el('span', {
            class: 'row-title',
            text: result.title || 'Untitled session'
          }),
          el('span', {
            class: 'row-sub row-snippet',
            text: result.snippet || ''
          })
        )
      );
      rowNode.appendChild(
        el('span', { class: 'row-meta', text: timeAgo(result.updatedAt) })
      );
      rowNode.addEventListener('click', function () {
        openSession(result.id);
      });
      box.appendChild(rowNode);
    });
    if (S.search.hasMore) {
      box.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'Showing up to 20 matching sessions.'
        })
      );
    }
    updateSessionNoMatch();
  }

  function attachLimitHint() {
    var limits = S.imageLimits;
    if (!limits) return '';
    var parts = [];
    if (limits.maxImages) {
      parts.push(
        'up to ' + limits.maxImages + ' photo' + (limits.maxImages === 1 ? '' : 's')
      );
    }
    if (limits.maxBytes) {
      parts.push(
        Math.max(1, Math.round(limits.maxBytes / (1024 * 1024))) + ' MB each'
      );
    }
    if (!parts.length) return '';
    return 'Photos go straight to the model · ' + parts.join(' · ');
  }

  function precheckImageFiles(files) {
    var limits = S.imageLimits;
    if (!limits || (!limits.maxBytes && !limits.maxImages)) return files;
    var existingImages = S.uploads.filter(function (entry) {
      return entry.status !== 'error' && isImageMediaType(entry.mediaType);
    }).length;
    var remaining = limits.maxImages
      ? Math.max(0, limits.maxImages - existingImages)
      : Infinity;
    var accepted = [];
    var sizeToasted = false;
    var countToasted = false;
    files.forEach(function (file) {
      var mediaType = guessMediaType(file.name || 'file', file.type);
      if (!isImageMediaType(mediaType)) {
        accepted.push(file);
        return;
      }
      if (limits.maxBytes && Number(file.size) > limits.maxBytes) {
        if (!sizeToasted) {
          toast(
            'Image is larger than the ' +
              Math.max(1, Math.round(limits.maxBytes / (1024 * 1024))) +
              ' MB limit'
          );
          sizeToasted = true;
        }
        return;
      }
      if (remaining <= 0) {
        if (!countToasted) {
          toast(
            'Only ' +
              limits.maxImages +
              ' photo' +
              (limits.maxImages === 1 ? '' : 's') +
              ' per message'
          );
          countToasted = true;
        }
        return;
      }
      remaining -= 1;
      accepted.push(file);
    });
    return accepted;
  }

  function rollbackSteer(message) {
    var pending = S.pendingSteer;
    S.pendingSteer = null;
    clearTimeout(S.steerTimer);
    if (pending) {
      if (pending.item) {
        S.messages = S.messages.filter(function (entry) {
          return entry !== pending.item;
        });
        if (pending.item.node && pending.item.node.parentNode) {
          pending.item.node.remove();
        }
      }
      if (!refs.composerInput.value.trim() && pending.text) {
        refs.composerInput.value = pending.text;
        autosizeComposer();
      }
      if (pending.attachments) {
        revokeAttachmentPreviewUrls(pending.attachments);
      }
    }
    S.promptMode = 'queue';
    renderComposerMeta();
    updateSendState();
    toast(message || 'Steering failed — the message was not sent.');
  }

  /* ---------- Batch C3: context meter, changes, commands ----------------- */

  function formatTokenCount(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) n = 0;
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) {
      var k = n / 1000;
      return (
        (k >= 100 ? String(Math.round(k)) : String(Math.round(k * 10) / 10)) + 'k'
      );
    }
    var m = n / 1000000;
    return (
      (m >= 10 ? String(Math.round(m)) : String(Math.round(m * 10) / 10)) + 'M'
    );
  }

  function normalizeContext(raw, sessionId) {
    if (!raw || typeof raw !== 'object') return null;
    var basis =
      raw.basis === 'usage' || raw.basis === 'estimated' ? raw.basis : 'unknown';
    if (basis === 'unknown') return null;
    var windowSize = Number(raw.contextWindow);
    if (!isFinite(windowSize) || windowSize <= 0) return null;
    var used = Number(raw.usedTokens);
    if (!isFinite(used) || used < 0) {
      used = Math.max(
        Number(raw.projectedTokens) || 0,
        Number(raw.pressureTokens) || 0
      );
    }
    return {
      sessionId: sessionId || null,
      usedTokens: Math.max(0, used),
      pressureTokens: Number(raw.pressureTokens) || 0,
      projectedTokens: Number(raw.projectedTokens) || 0,
      contextWindow: windowSize,
      basis: basis,
      tokenUsage:
        raw.tokenUsage && typeof raw.tokenUsage === 'object'
          ? raw.tokenUsage
          : null
    };
  }

  function renderContextMeter() {
    var meter = refs.contextMeter;
    if (!meter) return;
    var ctx = S.context;
    if (
      !ctx ||
      !S.activeSessionId ||
      (ctx.sessionId && ctx.sessionId !== S.activeSessionId) ||
      !(ctx.contextWindow > 0) ||
      ctx.basis === 'unknown'
    ) {
      meter.hidden = true;
      return;
    }
    meter.hidden = false;
    var used = formatTokenCount(ctx.usedTokens);
    var windowSize = formatTokenCount(ctx.contextWindow);
    var estimated = ctx.basis === 'estimated';
    var pct = Math.max(
      0,
      Math.min(100, Math.round((ctx.usedTokens / ctx.contextWindow) * 100))
    );
    /* Visible label stays tiny for the meta row; screen readers get the full
       sentence from the group's aria-label instead of the fragments. */
    if (refs.contextLabel) refs.contextLabel.textContent = used + ' / ' + windowSize;
    if (refs.contextEst) refs.contextEst.hidden = !estimated;
    if (refs.contextFill) refs.contextFill.style.width = pct + '%';
    meter.classList.toggle('is-high', pct >= 85);
    meter.setAttribute(
      'aria-label',
      'Context: ' +
        used +
        ' of ' +
        windowSize +
        ' tokens used (' +
        pct +
        '%' +
        (estimated ? ', estimated' : '') +
        ')'
    );
    meter.setAttribute(
      'title',
      'Context ' + used + ' / ' + windowSize + (estimated ? ' est.' : '') + ' · ' + pct + '%'
    );
  }

  function requestContext() {
    if (!S.activeSessionId || S.conn !== 'online') return;
    sendFrame({ type: 'context.get', sessionId: S.activeSessionId });
  }

  function requestChanges() {
    if (!S.activeSessionId || S.conn !== 'online') return;
    S.changes.loading = true;
    sendFrame({
      type: 'changes.list',
      sessionId: S.activeSessionId,
      limit: 10
    });
    renderChangesPanel();
  }

  function renderChangesPanel() {
    var panel = refs.changesPanel;
    if (!panel) return;
    panel.replaceChildren();
    if (
      !S.session ||
      !S.activeSessionId ||
      S.changes.sessionId !== S.activeSessionId
    ) {
      panel.hidden = true;
      return;
    }
    if (!S.changes.items.length) {
      if (!S.changes.loading) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      panel.appendChild(
        el(
          'div',
          { class: 'changes-head' },
          el('span', { class: 'changes-title', text: 'Changes' }),
          el('span', { class: 'spin' })
        )
      );
      return;
    }
    panel.hidden = false;
    panel.appendChild(
      el(
        'div',
        { class: 'changes-head' },
        el('span', { class: 'changes-title', text: 'Changes' }),
        el('span', {
          class: 'changes-count',
          text:
            S.changes.items.length +
            ' turn' +
            (S.changes.items.length === 1 ? '' : 's')
        })
      )
    );
    var list = el('div', { class: 'changes-list' });
    S.changes.items.forEach(function (item) {
      list.appendChild(renderChangeCard(item));
    });
    panel.appendChild(list);
  }

  function renderChangeCard(item) {
    var card = el('div', {
      class:
        'change-card' + (item.available === false ? ' is-unavailable' : '')
    });
    var turn = item.turn == null ? '?' : String(item.turn);
    if (item.available === false) {
      card.appendChild(
        el(
          'div',
          { class: 'change-card-head' },
          el('span', { class: 'change-turn', text: 'Turn ' + turn }),
          el('span', {
            class: 'change-note',
            text: 'diff unavailable (session not live)'
          })
        )
      );
      return card;
    }
    var allFiles = Array.isArray(item.files) ? item.files : [];
    var files = allFiles.slice(0, 20);
    var total = Number(item.total);
    if (!isFinite(total) || total < files.length) total = allFiles.length;
    card.appendChild(
      el(
        'div',
        { class: 'change-card-head' },
        el('span', { class: 'change-turn', text: 'Turn ' + turn }),
        el('span', {
          class: 'change-counts',
          text: total + ' file' + (total === 1 ? '' : 's')
        }),
        el('span', {
          class: 'change-added',
          text: '+' + (Number(item.added) || 0)
        }),
        el('span', {
          class: 'change-deleted',
          text: '−' + (Number(item.deleted) || 0)
        })
      )
    );
    files.forEach(function (file) {
      card.appendChild(renderChangeFile(item, file));
    });
    if (allFiles.length > files.length) {
      card.appendChild(
        el('p', {
          class: 'change-note',
          text: '+' + (allFiles.length - files.length) + ' more files'
        })
      );
    }
    return card;
  }

  function renderChangeFile(item, file) {
    var button = el('button', {
      class: 'change-file',
      attrs: { type: 'button' }
    });
    button.appendChild(icon('file', 'change-file-icon'));
    var main = el('span', { class: 'change-file-main' });
    main.appendChild(
      el('span', {
        class: 'change-file-path',
        text: file.display || file.path || 'file'
      })
    );
    var meta = [];
    if (file.binary) meta.push('binary');
    else {
      if (file.added) meta.push('+' + file.added);
      if (file.deleted) meta.push('−' + file.deleted);
      if (file.oversized) meta.push('large');
    }
    main.appendChild(
      el('span', { class: 'change-file-meta', text: meta.join(' · ') })
    );
    button.appendChild(main);
    button.addEventListener('click', function () {
      openDiffSheet(item.seq, file);
    });
    return button;
  }

  function openDiffSheet(seq, file) {
    if (!S.session) return;
    var index = Number(file && file.index);
    S.pendingDiff = {
      sessionId: S.session.id,
      seq: seq,
      index: index,
      path: (file && (file.display || file.path)) || ''
    };
    openSheet('diff');
    if (
      !sendFrame({
        type: 'changes.diff',
        sessionId: S.session.id,
        seq: seq,
        index: index
      })
    ) {
      renderDiffSheet({
        unavailable: true,
        seq: seq,
        index: index,
        path: S.pendingDiff.path
      });
    }
  }

  function buildDiffSheet() {
    var pending = S.pendingDiff;
    setSheetHead(
      pending && pending.path ? pending.path : 'Changed file',
      'Diff'
    );
    refs.sheetBody.appendChild(
      el(
        'div',
        { class: 'sheet-loading' },
        el('span', { class: 'spin' }),
        el('span', { text: 'Loading diff…' })
      )
    );
  }

  function diffNotice(text) {
    return el('p', { class: 'diff-notice', text: text });
  }

  function renderDiffSheet(frame) {
    if (S.sheet !== 'diff') return;
    var pending = S.pendingDiff;
    var path =
      (frame && frame.path) || (pending && pending.path) || 'Changed file';
    setSheetHead(path, frame && frame.coarse ? 'Whole-file hunk' : 'Diff');
    var body = refs.sheetBody;
    body.replaceChildren();
    S.pendingDiff = null;
    if (!frame || frame.unavailable) {
      body.appendChild(diffNotice('Diff unavailable (session not live).'));
      return;
    }
    if (frame.kind === 'binary') {
      body.appendChild(diffNotice('Binary file — no text diff available.'));
      return;
    }
    if (frame.kind === 'oversized') {
      body.appendChild(diffNotice('Diff is too large to display.'));
      return;
    }
    if (frame.kind && frame.kind !== 'text') {
      body.appendChild(diffNotice('No diff available for this file.'));
      return;
    }
    if (frame.coarse) {
      body.appendChild(
        el('p', {
          class: 'diff-note',
          text: 'Large file — showing a whole-file hunk.'
        })
      );
    }
    var hunks = Array.isArray(frame.hunks) ? frame.hunks : [];
    if (!hunks.length) {
      body.appendChild(diffNotice('No textual changes.'));
      return;
    }
    var limit = 1200;
    var shown = 0;
    var view = el('div', { class: 'diff-view' });
    for (var h = 0; h < hunks.length && shown < limit; h += 1) {
      var lines = Array.isArray(hunks[h].lines) ? hunks[h].lines : [];
      for (var i = 0; i < lines.length && shown < limit; i += 1) {
        var line = String(lines[i] == null ? '' : lines[i]);
        var prefix = line.charAt(0) || ' ';
        var cls =
          prefix === '+' ? 'is-add' : prefix === '-' ? 'is-del' : 'is-ctx';
        view.appendChild(
          el(
            'div',
            { class: 'diff-line ' + cls },
            el('span', { class: 'diff-prefix', text: prefix }),
            el('span', { class: 'diff-text', text: line.slice(1) })
          )
        );
        shown += 1;
      }
    }
    body.appendChild(view);
    if (shown >= limit) {
      body.appendChild(
        el('p', {
          class: 'diff-note',
          text: 'Diff truncated — showing the first ' + limit + ' lines.'
        })
      );
    }
  }

  function openCommands() {
    if (!S.session) {
      toast('Open a session first.');
      return;
    }
    S.commands = {
      sessionId: S.session.id,
      available: false,
      items: [],
      reason: '',
      loading: true
    };
    S.commandConfirmName = '';
    openSheet('commands');
    if (!sendFrame({ type: 'commands.list', sessionId: S.session.id })) {
      S.commands.loading = false;
      S.commands.reason = 'unavailable';
      if (S.sheet === 'commands') buildSheet();
      return;
    }
    /* A dropped or refused list must not leave the spinner up forever. */
    clearTimeout(S.commandsLoadTimer);
    S.commandsLoadTimer = setTimeout(function () {
      S.commandsLoadTimer = null;
      if (!S.commands.loading || S.sheet !== 'commands') return;
      S.commands.loading = false;
      S.commands.reason = 'timeout';
      buildSheet();
    }, 10000);
  }

  function buildCommandsSheet() {
    var data = S.commands;
    setSheetHead('Commands', 'Run a Harness command in this session');
    var body = refs.sheetBody;
    if (data.loading) {
      body.appendChild(
        el(
          'div',
          { class: 'sheet-loading' },
          el('span', { class: 'spin' }),
          el('span', { text: 'Loading commands…' })
        )
      );
      return;
    }
    if (!data.available) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text:
            data.reason === 'not-live'
              ? 'Commands need a live agent — send a message first, then try again.'
              : data.reason === 'timeout'
                ? 'The Harness did not answer in time — try again.'
                : 'Commands are not available here.'
        })
      );
      return;
    }
    if (!data.items.length) {
      body.appendChild(
        el('p', {
          class: 'sheet-note',
          text: 'No commands are available for this session.'
        })
      );
      return;
    }
    data.items.forEach(function (item) {
      var name = String(item.name || '');
      if (!name) return;
      var hint = item.hint ? String(item.hint).trim() : '';
      var confirming = S.commandConfirmName === name;
      var description = item.description || 'Run this Host command';
      var node = row({
        icon: 'terminal',
        title: '/' + name,
        sub: confirming ? 'Tap again to run this command' : description,
        danger: confirming,
        onClick: function () {
          runCommand(item);
        }
      });
      node.classList.add('command-row');
      if (!confirming && hint) {
        var main = node.querySelector('.row-main');
        if (main) main.appendChild(el('span', { class: 'row-hint', text: hint }));
      }
      body.appendChild(node);
    });
    setSheetFoot(
      el('span', {
        text: 'Commands run on the desktop agent and are logged to the transcript.'
      })
    );
  }

  function buildCommandInputSheet() {
    var item = S.commandInputItem;
    if (!item) {
      closeSheet();
      return;
    }
    var name = String(item.name || '');
    setSheetHead(
      '/' + name,
      item.description ? String(item.description) : 'Run a Harness command'
    );
    var body = refs.sheetBody;
    var input = el('input', {
      class: 'sheet-search',
      attrs: {
        type: 'text',
        placeholder: item.hint ? String(item.hint) : 'Arguments',
        'aria-label': 'Arguments for /' + name,
        autocomplete: 'off',
        spellcheck: 'false'
      }
    });
    input.value = S.commandDraft || '';
    input.addEventListener('input', function () {
      S.commandDraft = input.value;
    });
    body.appendChild(input);
    if (item.hint) {
      body.appendChild(
        el('p', { class: 'sheet-note', text: 'Hint: ' + String(item.hint) })
      );
    }
    var run = row({
      icon: 'terminal',
      accent: true,
      title: 'Run command',
      sub: 'Send /' + name + ' with these arguments',
      onClick: function () {
        var value = input.value.trim();
        executeCommandLine(name, '/' + name + (value ? ' ' + value : ''));
      }
    });
    body.appendChild(run);
    window.requestAnimationFrame(function () {
      try {
        input.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    });
  }

  function executeCommandLine(name, line) {
    if (!S.session || !name) return;
    S.commandPending = name;
    if (
      !sendFrame({
        type: 'commands.execute',
        sessionId: S.session.id,
        line: line
      })
    ) {
      S.commandPending = '';
      toast('Not connected — try again in a moment.');
      return;
    }
    closeSheet();
    toast('Running /' + name + '…');
    setTimeout(function () {
      if (S.commandPending === name) S.commandPending = '';
    }, 20000);
  }

  function runCommand(item) {
    if (!S.session || !item || !item.name) return;
    var name = String(item.name);
    var hint = item.hint ? String(item.hint).trim() : '';
    if (hint) {
      S.commandInputItem = item;
      S.commandDraft = '';
      openSheet('command-input');
      return;
    }
    if (S.commandConfirmName !== name) {
      S.commandConfirmName = name;
      buildSheet();
      return;
    }
    S.commandConfirmName = '';
    executeCommandLine(name, '/' + name);
  }

  /* ---------- Batch E2: app lock (client-side WebAuthn gate) ------------- */

  function appLockSupported() {
    try {
      return (
        typeof window.PublicKeyCredential === 'function' &&
        window.isSecureContext === true
      );
    } catch (err) {
      return false;
    }
  }

  function lockRandomBytes(length) {
    var bytes = new Uint8Array(length);
    try {
      window.crypto.getRandomValues(bytes);
    } catch (err) {
      for (var i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return bytes;
  }

  function base64UrlEncode(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlDecode(value) {
    var text = String(value).replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4 !== 0) text += '=';
    var raw = atob(text);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function readAppLockState() {
    try {
      var raw = store.get(LS_APP_LOCK);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.credentialId !== 'string' || !parsed.credentialId) {
        return null;
      }
      var storedDevice = parsed.deviceId ? String(parsed.deviceId) : '';
      var currentDevice = S.device && S.device.id ? String(S.device.id) : '';
      if (storedDevice && currentDevice && storedDevice !== currentDevice) {
        return null;
      }
      return {
        credentialId: parsed.credentialId,
        deviceId: storedDevice || currentDevice,
        enabledAt: Number(parsed.enabledAt) || 0,
        unlockedAt: Number(parsed.unlockedAt) || 0
      };
    } catch (err) {
      /* Unreadable lock state fails open (client-side deterrent only). */
      return null;
    }
  }

  function loadAppLockState() {
    var stored = readAppLockState();
    if (!stored) {
      appLock.enabled = false;
      appLock.credentialId = '';
      appLock.deviceId = '';
      appLock.enabledAt = 0;
      appLock.unlockedAt = 0;
      appLock.locked = false;
      appLock.sessionVerified = false;
      return;
    }
    appLock.enabled = true;
    appLock.credentialId = stored.credentialId;
    appLock.deviceId = stored.deviceId;
    appLock.enabledAt = stored.enabledAt;
    appLock.unlockedAt = stored.unlockedAt;
    appLock.locked = false;
    appLock.sessionVerified = false;
    appLock.coldStartChecked = false;
  }

  function persistAppLock() {
    if (!appLock.enabled) {
      store.del(LS_APP_LOCK);
      return;
    }
    store.set(
      LS_APP_LOCK,
      JSON.stringify({
        credentialId: appLock.credentialId,
        deviceId: appLock.deviceId,
        enabledAt: appLock.enabledAt,
        unlockedAt: appLock.unlockedAt
      })
    );
  }

  /* Pure decision used by the resume/cold-start paths and the test harness:
     cold start always locks; after verification, 5 minutes of grace; being
     away for 30+ seconds always locks. */
  function appLockShouldLock(state, now, hiddenForMs) {
    if (!state || !state.enabled || !state.credentialId) return false;
    if (!state.sessionVerified) return true;
    if (hiddenForMs >= LOCK_HIDDEN_MS) return true;
    if (!state.unlockedAt || now - state.unlockedAt > LOCK_GRACE_MS) return true;
    return false;
  }

  function showLockOverlay() {
    var overlay = refs.appLock;
    if (!overlay) return;
    overlay.hidden = false;
    window.requestAnimationFrame(function () {
      overlay.classList.add('is-open');
    });
    if (refs.app) {
      refs.app.setAttribute('inert', '');
      refs.app.setAttribute('aria-hidden', 'true');
      refs.app.classList.add('is-locked');
    }
    if (refs.appLockError) {
      refs.appLockError.hidden = true;
      refs.appLockError.textContent = '';
    }
    if (refs.appLockUnlock) {
      refs.appLockUnlock.disabled = false;
      refs.appLockUnlock.textContent = 'Unlock';
      try {
        refs.appLockUnlock.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    }
  }

  function hideLockOverlay(quiet) {
    var overlay = refs.appLock;
    if (overlay) {
      overlay.classList.remove('is-open');
      overlay.hidden = true;
    }
    if (refs.app) {
      refs.app.removeAttribute('inert');
      refs.app.removeAttribute('aria-hidden');
      refs.app.classList.remove('is-locked');
    }
    appLock.locked = false;
    if (!quiet) {
      appLock.sessionVerified = true;
      appLock.unlockedAt = Date.now();
      persistAppLock();
    }
  }

  function lockAppNow() {
    if (!appLock.enabled || appLock.locked) return;
    closeSheet();
    appLock.locked = true;
    appLock.sessionVerified = false;
    showLockOverlay();
  }

  function maybeLockOnColdStart() {
    if (appLock.coldStartChecked) return;
    appLock.coldStartChecked = true;
    if (
      appLockShouldLock(
        {
          enabled: appLock.enabled,
          credentialId: appLock.credentialId,
          sessionVerified: false,
          unlockedAt: appLock.unlockedAt
        },
        Date.now(),
        0
      )
    ) {
      lockAppNow();
    }
  }

  function syncAppLockOnResume() {
    if (!appLock.enabled || S.phase !== 'app') return;
    var hiddenFor = appLock.hiddenAt ? Date.now() - appLock.hiddenAt : 0;
    appLock.hiddenAt = 0;
    if (appLock.locked) return;
    if (
      appLockShouldLock(
        {
          enabled: appLock.enabled,
          credentialId: appLock.credentialId,
          sessionVerified: appLock.sessionVerified,
          unlockedAt: appLock.unlockedAt
        },
        Date.now(),
        hiddenFor
      )
    ) {
      lockAppNow();
    }
  }

  function requestAppLockAssertion() {
    return new Promise(function (resolve) {
      if (
        !appLockSupported() ||
        !navigator.credentials ||
        !appLock.credentialId
      ) {
        resolve(false);
        return;
      }
      var publicKey = {
        challenge: lockRandomBytes(32),
        allowCredentials: [
          {
            id: base64UrlDecode(appLock.credentialId),
            type: 'public-key',
            transports: ['internal']
          }
        ],
        userVerification: 'required',
        timeout: 60000
      };
      var promise;
      try {
        promise = navigator.credentials.get({ publicKey: publicKey });
      } catch (err) {
        resolve(false);
        return;
      }
      if (!promise || typeof promise.then !== 'function') {
        resolve(false);
        return;
      }
      promise.then(
        function (assertion) {
          resolve(!!assertion && !!assertion.id);
        },
        function () {
          resolve(false);
        }
      );
    });
  }

  function onUnlockClick() {
    if (!appLock.locked || appLock.busy) return;
    appLock.busy = true;
    if (refs.appLockUnlock) {
      refs.appLockUnlock.disabled = true;
      refs.appLockUnlock.textContent = 'Verifying…';
    }
    if (refs.appLockError) refs.appLockError.hidden = true;
    requestAppLockAssertion().then(function (ok) {
      appLock.busy = false;
      if (ok) {
        hideLockOverlay(false);
        return;
      }
      if (refs.appLockUnlock) {
        refs.appLockUnlock.disabled = false;
        refs.appLockUnlock.textContent = 'Try again';
      }
      if (refs.appLockError) {
        refs.appLockError.textContent = 'Could not verify — try again.';
        refs.appLockError.hidden = false;
      }
    });
  }

  function toggleAppLock() {
    if (!appLockSupported() || appLock.busy) return;
    if (appLock.enabled) {
      /* Disabling also requires a successful assertion. */
      appLock.busy = true;
      requestAppLockAssertion().then(function (ok) {
        appLock.busy = false;
        if (!ok) {
          toast('Verification failed — app lock stays on.');
          return;
        }
        appLock.enabled = false;
        appLock.credentialId = '';
        appLock.deviceId = '';
        appLock.enabledAt = 0;
        appLock.unlockedAt = 0;
        appLock.sessionVerified = false;
        appLock.locked = false;
        appLock.coldStartChecked = true;
        persistAppLock();
        hideLockOverlay(true);
        if (S.sheet === 'menu') buildSheet();
        toast('App lock off');
      });
      return;
    }

    appLock.busy = true;
    var deviceId = (S.device && S.device.id) || '';
    var publicKey = {
      challenge: lockRandomBytes(32),
      rp: { name: 'DSH Remote', id: window.location.hostname },
      user: {
        id: lockRandomBytes(16),
        name: 'dsh-remote-' + deviceId,
        displayName: 'DSH Remote'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 }
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      },
      timeout: 60000,
      attestation: 'none'
    };
    var promise;
    try {
      promise = navigator.credentials.create({ publicKey: publicKey });
    } catch (err) {
      appLock.busy = false;
      toast("App lock wasn't enabled.");
      return;
    }
    Promise.resolve(promise).then(
      function (credential) {
        appLock.busy = false;
        if (!credential || !credential.rawId) {
          toast("App lock wasn't enabled.");
          return;
        }
        appLock.enabled = true;
        appLock.credentialId = base64UrlEncode(credential.rawId);
        appLock.deviceId = deviceId;
        appLock.enabledAt = Date.now();
        appLock.unlockedAt = Date.now();
        appLock.sessionVerified = true;
        appLock.locked = false;
        appLock.coldStartChecked = true;
        persistAppLock();
        if (S.sheet === 'menu') buildSheet();
        toast('App lock on');
      },
      function () {
        appLock.busy = false;
        toast("App lock wasn't enabled.");
      }
    );
  }

  /* ======================================================================
     Safe markdown renderer
     Subset: headings, bold, italic, inline code, fenced code, lists,
     blockquotes, links, horizontal rules. Everything else is plain text.
     ====================================================================== */

  var INLINE_PATTERN =
    '(`[^`\\n]+`)' + // inline code
    '|(\\[[^\\]\\n]*\\]\\([^)\\s]+\\))' + // link
    '|(\\*\\*\\*[^*\\n]+?\\*\\*\\*)' + // bold italic
    '|(\\*\\*[^*\\n]+?\\*\\*)' + // bold
    '|(__[^_\\n]+?__)' + // bold underscore
    '|(\\*[^*\\n]+?\\*)' + // italic
    '|(_[^_\\n]+?_)'; // italic underscore

  function renderMarkdown(source, options) {
    var opts = options || {};
    var frag = document.createDocumentFragment();
    var text = String(source === null || source === undefined ? '' : source)
      .replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var i = 0;
    var cursorHost = null;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) {
        i++;
        continue;
      }

      var fence = line.match(/^\s*(```+|~~~+)\s*([\w#+.-]*)\s*$/);
      if (fence) {
        var marker = fence[1].charAt(0);
        var lang = (fence[2] || '').toLowerCase();
        var codeLines = [];
        i++;
        while (i < lines.length) {
          var closeFence = lines[i].match(/^\s*(```+|~~~+)\s*$/);
          if (closeFence && closeFence[1].charAt(0) === marker) {
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        frag.appendChild(renderCodeBlock(codeLines.join('\n'), lang));
        cursorHost = null;
        continue;
      }

      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        var level = Math.min(6, heading[1].length);
        var h = el('h' + level, {
          class: 'md-h md-h' + level
        });
        h.appendChild(parseInline(heading[2]));
        frag.appendChild(h);
        cursorHost = null;
        i++;
        continue;
      }

      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        frag.appendChild(el('hr', { class: 'md-hr' }));
        cursorHost = null;
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        var quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        var quote = el('blockquote', { class: 'md-quote' });
        quote.appendChild(renderMarkdown(quoteLines.join('\n')));
        frag.appendChild(quote);
        cursorHost = null;
        continue;
      }

      if (
        line.indexOf('|') !== -1 &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        var table = renderTable(lines, i);
        if (table) {
          frag.appendChild(table.node);
          i = table.next;
          cursorHost = null;
          continue;
        }
      }

      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var listResult = renderList(lines, i);
        frag.appendChild(listResult.node);
        i = listResult.next;
        cursorHost = null;
        continue;
      }

      var paragraphLines = [line];
      i++;
      while (i < lines.length) {
        var next = lines[i];
        if (!next.trim()) break;
        if (/^\s*(```+|~~~+|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(next)) break;
        if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(next)) break;
        paragraphLines.push(next);
        i++;
      }
      var paragraph = el('p', { class: 'md-p' });
      paragraphLines.forEach(function (pl, idx) {
        if (idx > 0) paragraph.appendChild(document.createTextNode(' '));
        paragraph.appendChild(parseInline(pl));
      });
      frag.appendChild(paragraph);
      cursorHost = paragraph;
    }

    if (opts.cursor) {
      if (cursorHost) {
        cursorHost.appendChild(cursorNode());
      } else {
        frag.appendChild(el('p', { class: 'md-p' }, cursorNode()));
      }
    }

    return frag;
  }

  function parseInline(text, depth) {
    depth = depth || 0;
    var frag = document.createDocumentFragment();
    var src = String(text === null || text === undefined ? '' : text);
    if (depth > 5) {
      frag.appendChild(document.createTextNode(src));
      return frag;
    }

    var re = new RegExp(INLINE_PATTERN, 'g');
    var lastIndex = 0;
    var match;

    while ((match = re.exec(src))) {
      var token = match[0];

      /* Avoid turning snake_case_names into italics. */
      if (token.charAt(0) === '_' && token.indexOf('__') !== 0) {
        var before = match.index > 0 ? src.charAt(match.index - 1) : '';
        var after = src.charAt(match.index + token.length);
        if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) {
          re.lastIndex = match.index + 1;
          continue;
        }
      }

      if (match.index > lastIndex) {
        frag.appendChild(
          document.createTextNode(src.slice(lastIndex, match.index))
        );
      }
      frag.appendChild(buildInlineToken(token, depth));
      lastIndex = match.index + token.length;
    }

    if (lastIndex < src.length) {
      frag.appendChild(document.createTextNode(src.slice(lastIndex)));
    }
    return frag;
  }

  function buildInlineToken(token, depth) {
    if (token.charAt(0) === '`') {
      return el('code', { class: 'md-code', text: token.slice(1, -1) });
    }
    if (token.charAt(0) === '[') {
      var linkMatch = token.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
      if (!linkMatch) return document.createTextNode(token);
      var href = safeUrl(linkMatch[2]);
      if (!href) {
        return el('span', { class: 'md-link-plain', text: token });
      }
      var anchor = el('a', {
        class: 'md-link',
        attrs: {
          href: href,
          target: '_blank',
          rel: 'noopener noreferrer nofollow'
        }
      });
      anchor.appendChild(parseInline(linkMatch[1], depth + 1));
      return anchor;
    }
    if (token.indexOf('***') === 0) {
      return el(
        'strong',
        null,
        el('em', null, parseInline(token.slice(3, -3), depth + 1))
      );
    }
    if (token.indexOf('**') === 0) {
      return el('strong', null, parseInline(token.slice(2, -2), depth + 1));
    }
    if (token.indexOf('__') === 0) {
      return el('strong', null, parseInline(token.slice(2, -2), depth + 1));
    }
    if (token.charAt(0) === '*') {
      return el('em', null, parseInline(token.slice(1, -1), depth + 1));
    }
    if (token.charAt(0) === '_') {
      return el('em', null, parseInline(token.slice(1, -1), depth + 1));
    }
    return document.createTextNode(token);
  }

  function safeUrl(raw) {
    var url = String(raw || '').trim();
    if (!url) return null;
    if (/^(https?:|mailto:)/i.test(url)) return url;
    if (url.charAt(0) === '/') {
      try {
        return new URL(url, window.location.origin).href;
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  function renderList(lines, start) {
    var first = lines[start].match(/^(\s*)([-*+]|(\d+)[.)])\s+/);
    var ordered = !!(first && first[3]);
    var baseIndent = first ? first[1].length : 0;
    var list = el(ordered ? 'ol' : 'ul', { class: 'md-list' });
    var i = start;
    var lastItem = null;

    while (i < lines.length) {
      var line = lines[i];
      var itemMatch = line.match(/^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/);

      if (itemMatch && itemMatch[1].length === baseIndent) {
        lastItem = el('li', { class: 'md-li' });
        lastItem.appendChild(parseInline(itemMatch[4]));
        list.appendChild(lastItem);
        i++;
        continue;
      }

      if (itemMatch && itemMatch[1].length > baseIndent && lastItem) {
        var nested = renderList(lines, i);
        lastItem.appendChild(nested.node);
        i = nested.next;
        continue;
      }

      if (
        lastItem &&
        line.trim() &&
        !/^\s*([-*+]|\d+[.)])\s+/.test(line) &&
        !/^\s*(```+|~~~+)/.test(line)
      ) {
        lastItem.appendChild(document.createTextNode(' '));
        lastItem.appendChild(parseInline(line.trim()));
        i++;
        continue;
      }
      break;
    }

    return { node: list, next: i };
  }

  function splitTableRow(line) {
    var text = String(line || '').trim();
    if (text.charAt(0) === '|') text = text.slice(1);
    if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1);
    return text.split('|').map(function (cell) {
      return cell.trim();
    });
  }

  function renderTable(lines, start) {
    var header = splitTableRow(lines[start]);
    if (!header.length) return null;
    var aligns = splitTableRow(lines[start + 1]).map(function (cell) {
      var left = cell.charAt(0) === ':';
      var right = cell.charAt(cell.length - 1) === ':';
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
    var rows = [];
    var i = start + 2;
    while (
      i < lines.length &&
      lines[i].trim() &&
      lines[i].indexOf('|') !== -1
    ) {
      rows.push(splitTableRow(lines[i]));
      i++;
    }

    var wrap = el('div', { class: 'md-table-wrap' });
    var table = el('table', { class: 'md-table' });
    var thead = el('thead');
    var headRow = el('tr');
    header.forEach(function (cell, index) {
      var th = el('th');
      if (aligns[index]) th.style.textAlign = aligns[index];
      th.appendChild(parseInline(cell));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (cells) {
      var tr = el('tr');
      for (var c = 0; c < header.length; c++) {
        var td = el('td');
        if (aligns[c]) td.style.textAlign = aligns[c];
        td.appendChild(parseInline(cells[c] || ''));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return { node: wrap, next: i };
  }

  function renderCodeBlock(code, lang) {
    var wrap = el('div', { class: 'md-pre' });
    var head = el('div', { class: 'md-pre-head' });
    var label = el('span', {
      class: 'md-pre-lang',
      text: lang || 'text'
    });
    var copy = el('button', {
      class: 'md-copy',
      attrs: { type: 'button', 'aria-label': 'Copy code' }
    });
    copy.appendChild(icon('copy'));
    copy.appendChild(el('span', { text: 'Copy' }));
    copy.addEventListener('click', function () {
      copyText(code, copy, 'Copy');
    });
    head.append(label, copy);

    var pre = el('pre', { class: 'md-codeblock' });
    var codeNode = el('code');
    appendHighlighted(codeNode, code, lang);
    pre.appendChild(codeNode);
    wrap.append(head, pre);
    return wrap;
  }

  function copyToClipboard(text, onDone) {
    function done() {
      if (typeof onDone === 'function') onDone();
    }
    function fallback() {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        done();
      } catch (err) {
        toast('Could not copy to the clipboard.');
      }
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function copyText(text, button, idleLabel) {
    function done() {
      var label = button.querySelector('span');
      if (!label) label = button;
      var previous = label.textContent;
      label.textContent = 'Copied';
      button.classList.add('is-copied');
      setTimeout(function () {
        label.textContent = idleLabel || previous;
        button.classList.remove('is-copied');
      }, 1400);
    }
    function fallback() {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        done();
      } catch (err) {
        toast('Could not copy to the clipboard.');
      }
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  /* ======================================================================
     Lightweight syntax highlighter
     Tokenises the *escaped* text into DOM spans; unknown languages get a
     single plain code node.
     ====================================================================== */

  var LANG_ALIASES = {
    js: 'js',
    javascript: 'js',
    jsx: 'js',
    mjs: 'js',
    cjs: 'js',
    ts: 'js',
    typescript: 'js',
    tsx: 'js',
    json: 'json',
    jsonc: 'json',
    sql: 'sql',
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    python: 'python',
    py: 'python',
    rust: 'rust',
    rs: 'rust',
    html: 'html',
    htm: 'html',
    css: 'css'
  };

  var LANG_RULES = {
    js: [
      { cls: 'com', re: /(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/y },
      {
        cls: 'str',
        re: /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/y
      },
      {
        cls: 'kw',
        re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|import|export|from|as|default|async|await|yield|try|catch|finally|throw|delete|void|null|undefined|true|false|interface|type|enum|implements|namespace|declare|public|private|protected|readonly|static|get|set|satisfies|keyof)\b/y
      },
      { cls: 'num', re: /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y },
      { cls: 'fn', re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y }
    ],
    json: [
      { cls: 'prop', re: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
      { cls: 'str', re: /"(?:\\.|[^"\\])*"/y },
      { cls: 'num', re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
      { cls: 'kw', re: /\b(?:true|false|null)\b/y }
    ],
    sql: [
      { cls: 'com', re: /--[^\n]*|\/\*[\s\S]*?\*\//y },
      { cls: 'str', re: /'(?:''|\\.|[^'\\])*'/y },
      {
        cls: 'kw',
        re: /\b(?:select|from|where|and|or|not|null|is|in|join|left|right|inner|outer|on|group|by|order|having|limit|offset|insert|into|values|update|set|delete|create|alter|drop|table|index|view|as|distinct|case|when|then|else|end|union|all|exists|between|like|asc|desc|primary|key|foreign|references|default|returning|with)\b/iy
      },
      { cls: 'num', re: /\b\d+(?:\.\d+)?\b/y }
    ],
    bash: [
      { cls: 'com', re: /#[^\n]*/y },
      { cls: 'str', re: /"(?:\\.|[^"\\])*"|'[^']*'/y },
      { cls: 'var', re: /\$(?:\{[^}]*\}|[A-Za-z_]\w*)/y },
      {
        cls: 'kw',
        re: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|select|until|return|exit|local|export|readonly|declare|echo|cd|set|unset|source|eval|exec|trap|shift|test)\b/y
      },
      { cls: 'num', re: /\b\d+\b/y }
    ],
    python: [
      { cls: 'com', re: /#[^\n]*/y },
      {
        cls: 'str',
        re: /[rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/y
      },
      { cls: 'fn', re: /@[A-Za-z_][\w.]*/y },
      {
        cls: 'kw',
        re: /\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|with|try|except|finally|raise|lambda|yield|async|await|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|self)\b/y
      },
      { cls: 'num', re: /\b\d+(?:\.\d+)?\b/y }
    ],
    rust: [
      { cls: 'com', re: /(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/y },
      {
        cls: 'str',
        re: /(?:b?"(?:\\.|[^"\\])*"|b?'(?:\\.|[^'\\])*'|r#*"[\s\S]*?"#*)/y
      },
      { cls: 'attr', re: /#!?\[[^\]]*\]/y },
      {
        cls: 'kw',
        re: /\b(?:fn|let|mut|const|static|struct|enum|trait|impl|for|while|loop|if|else|match|return|use|mod|pub|crate|self|Self|super|as|in|ref|move|async|await|dyn|where|type|unsafe|extern|true|false|Some|None|Ok|Err)\b/y
      },
      { cls: 'num', re: /\b\d+(?:\.\d+)?(?:[a-z]\w*)?\b/y }
    ],
    html: [
      { cls: 'com', re: /<!--[\s\S]*?-->/y },
      { cls: 'com', re: /<!DOCTYPE[^>]*>/iy },
      { cls: 'tag', re: /<\/?[A-Za-z][\w:-]*/y },
      { cls: 'str', re: /"[^"]*"|'[^']*'/y },
      { cls: 'attr', re: /\b[A-Za-z_:][\w:.-]*(?==)/y }
    ],
    css: [
      { cls: 'com', re: /\/\*[\s\S]*?\*\//y },
      { cls: 'str', re: /"[^"]*"|'[^']*'/y },
      { cls: 'kw', re: /@[A-Za-z-]+/y },
      { cls: 'prop', re: /[A-Za-z-]+(?=\s*:)/y },
      {
        cls: 'num',
        re: /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg|fr)?\b/y
      }
    ]
  };

  function normalizeLang(lang) {
    var key = String(lang || '').trim().toLowerCase();
    return LANG_ALIASES[key] || null;
  }

  function appendHighlighted(parent, code, lang) {
    var key = normalizeLang(lang);
    if (!key || code.length > 30000) {
      parent.appendChild(document.createTextNode(code));
      return;
    }
    var rules = LANG_RULES[key];
    if (!rules) {
      parent.appendChild(document.createTextNode(code));
      return;
    }
    var segments = tokenizeCode(code, rules);
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (!segment.cls) {
        parent.appendChild(document.createTextNode(segment.text));
      } else {
        var span = document.createElement('span');
        span.className = 'tok-' + segment.cls;
        span.textContent = segment.text;
        parent.appendChild(span);
      }
    }
  }

  function tokenizeCode(code, rules) {
    var out = [];
    var pos = 0;
    var plainStart = 0;
    var length = code.length;

    while (pos < length) {
      var found = null;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        var re = rule.re;
        re.lastIndex = pos;
        var match = re.exec(code);
        if (match && match.index === pos && match[0].length > 0) {
          found = { text: match[0], cls: rule.cls };
          break;
        }
      }
      if (found) {
        if (plainStart < pos) {
          out.push({ text: code.slice(plainStart, pos), cls: null });
        }
        out.push(found);
        pos += found.text.length;
        plainStart = pos;
      } else {
        pos++;
      }
    }
    if (plainStart < length) {
      out.push({ text: code.slice(plainStart), cls: null });
    }
    return out;
  }

  /* ---------- Toast ------------------------------------------------------- */

  var toastTimer = null;

  function toast(message) {
    if (!message) return;
    refs.toast.textContent = String(message);
    refs.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      refs.toast.classList.remove('is-visible');
    }, 2800);
  }

  /* ---------- Go ---------------------------------------------------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

