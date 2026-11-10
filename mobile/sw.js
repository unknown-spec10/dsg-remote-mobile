/* DSH Remote — service worker (v20)
 *
 * Zero dependencies. Caches only the app shell:
 *   - navigations: network first, cached "/" fallback when offline
 *   - versioned same-origin assets: cache first + stale-while-revalidate
 *   - never touches /api/*, /ws, /remote-mobile/*, /share-target, or anything
 *     cross-origin / opaque
 *
 * Bump CACHE when the shell changes; registration in app.js uses
 * updateViaCache: 'none'. The page reloads at most once on controllerchange.
 */
'use strict';

var CACHE = 'dsh-remote-v20';
var PRECACHE = [
  '/',
  '/app.js?v=20',
  '/styles.css?v=20',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

/* Bounded diagnostics for the Host debug log: only event names, the cache
 * version and (optionally) an error name. Never sends a subscription endpoint,
 * key material or notification content. */
function reportPush(kind, detail) {
  try {
    fetch('/api/push/report', {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: String(kind || 'event').slice(0, 40),
        detail: String(detail || '').slice(0, 180),
        scope: self.registration ? String(self.registration.scope || '') : ''
      })
    }).catch(function () {});
  } catch (err) {
    /* diagnostics must never break the push path */
  }
}

var SHELL_PATHS = {  '/': true,
  '/index.html': true,
  '/app.js': true,
  '/styles.css': true,
  '/manifest.webmanifest': true,
  '/favicon.svg': true,
  '/icons/icon-192.png': true,
  '/icons/icon-512.png': true,
  '/icons/icon-maskable-512.png': true,
  '/icons/apple-touch-icon.png': true
};

var NEVER_PREFIXES = ['/api/', '/remote-mobile/'];
var NEVER_PATHS = { '/ws': true, '/share-target': true, '/sw.js': true };

function isNever(url) {
  if (NEVER_PATHS[url.pathname]) return true;
  for (var i = 0; i < NEVER_PREFIXES.length; i += 1) {
    if (url.pathname.indexOf(NEVER_PREFIXES[i]) === 0) return true;
  }
  return false;
}

function isShellAsset(url) {
  if (SHELL_PATHS[url.pathname]) return true;
  /* A cache-busting version query always identifies a shell asset. */
  return url.searchParams.has('v');
}

function stash(request, response) {
  if (!response || !response.ok || response.type !== 'basic') return;
  caches.open(CACHE).then(function (cache) {
    return cache.put(request, response.clone());
  }).catch(function () {
    /* best effort: a failed write must never break a response */
  });
}

function navigationResponse(request) {
  return fetch(request).then(function (response) {
    if (
      response &&
      response.ok &&
      response.type === 'basic' &&
      new URL(request.url).pathname === '/'
    ) {
      stash(new Request('/'), response);
    }
    return response;
  }).catch(function () {
    return caches.open(CACHE).then(function (cache) {
      return cache.match('/').then(function (cached) {
        return cached || cache.match('/index.html');
      });
    }).then(function (cached) {
      return cached || Response.error();
    });
  });
}

function staticAsset(event, request) {
  var cachePromise = caches.open(CACHE);
  var networkPromise = fetch(request).then(function (response) {
    if (response && response.ok && response.type === 'basic') {
      return cachePromise.then(function (cache) {
        return cache.put(request, response.clone());
      }).then(function () {
        return response;
      }).catch(function () {
        return response;
      });
    }
    return response;
  }).catch(function () {
    return null;
  });

  /* Start the revalidation without waiting for the response body. */
  event.waitUntil(networkPromise.then(function () {}).catch(function () {}));

  return cachePromise.then(function (cache) {
    return cache.match(request);
  }).then(function (cached) {
    if (cached) return cached;
    return networkPromise.then(function (response) {
      if (response) return response;
      return caches.open(CACHE).then(function (cache) {
        return cache.match(request, { ignoreSearch: true });
      }).then(function (fallback) {
        return fallback || Response.error();
      });
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf('dsh-remote-') === 0 && key !== CACHE) {
          return caches.delete(key);
        }
        return Promise.resolve(false);
      }));
    }).then(function () {
      return self.clients.claim();
    }).then(function () {
      reportPush('sw-activated', 'cache=' + CACHE);
    })
  );
});

/* ---------- Web Push ------------------------------------------------------ */
/* The page registers for push and reports `client.visibility` over the socket;
 * this worker only renders the payload the Host sent and routes a tap back
 * into the app. Payload parsing is defensive: a malformed or empty message
 * still produces a notification, because a push event that ends without
 * showNotification can make the browser revoke the subscription. */

var PUSH_ICON = '/icons/icon-192.png';
var PUSH_FALLBACK_TITLE = 'DSH Remote';
var PUSH_FALLBACK_BODY = 'Something needs your attention.';

function readPushPayload(event) {
  var payload = null;
  try {
    payload = event && event.data ? event.data.json() : null;
  } catch (err) {
    payload = null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  return payload;
}

function pushString(value, fallback, limit) {
  if (typeof value !== 'string') return fallback;
  var text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!text) return fallback;
  return limit && text.length > limit ? text.slice(0, limit) : text;
}

function pushNotificationOptions(payload) {
  var options = {
    body: pushString(payload.body, PUSH_FALLBACK_BODY, 240),
    icon: PUSH_ICON,
    badge: PUSH_ICON,
    data: {
      url: pushString(payload.url, '/', 700),
      sessionId: typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId.slice(0, 200) : null,
      kind: pushString(payload.kind, 'reply', 24)
    }
  };
  var tag = pushString(payload.tag, '', 200);
  if (tag) options.tag = tag;
  return options;
}

self.addEventListener('push', function (event) {
  var payload = readPushPayload(event);
  var title = pushString(payload.title, PUSH_FALLBACK_TITLE, 120);
  var shown;
  try {
    var registration = self.registration;
    if (registration && typeof registration.showNotification === 'function') {
      shown = registration.showNotification(title, pushNotificationOptions(payload));
    }
  } catch (err) {
    shown = null;
  }
  var outcome = 'kind=' + pushString(payload.kind, 'unknown', 24) + ' tag=' + pushString(payload.tag, '-', 60);
  if (!shown || typeof shown.then !== 'function') shown = Promise.resolve();
  event.waitUntil(shown.then(function () {
    reportPush('push-shown', outcome);
  }, function (err) {
    reportPush('push-error', outcome + ' error=' + (err && err.name ? String(err.name) : 'unknown'));
  }));
});

function sameOriginUrl(value, origin) {
  try {
    return new URL(value, origin);
  } catch (err) {
    try {
      return new URL('/', origin);
    } catch (nextErr) {
      return null;
    }
  }
}

function clientOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (err) {
    return '';
  }
}

self.addEventListener('notificationclick', function (event) {
  try {
    event.notification.close();
  } catch (err) {
    /* ignore */
  }
  var data = event.notification && event.notification.data && typeof event.notification.data === 'object'
    ? event.notification.data
    : {};
  var origin = self.location ? self.location.origin : '';
  var target = sameOriginUrl(typeof data.url === 'string' && data.url ? data.url : '/', origin);
  /* A notification must never navigate the phone to a third-party page, even
     if a malformed/future payload carries an absolute URL. */
  if (!target || target.origin !== origin) target = sameOriginUrl('/', origin);
  var sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;

  var work = Promise.resolve().then(function () {
    var matching = [];
    try {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    } catch (err) {
      return matching;
    }
  }).then(function (list) {
    var clients = Array.isArray(list) ? list : [];
    var wantedOrigin = target ? target.origin : origin;
    for (var i = 0; i < clients.length; i += 1) {
      var client = clients[i];
      if (!client || clientOrigin(client.url) !== wantedOrigin) continue;
      var focused = null;
      try {
        focused = client.focus();
      } catch (err) {
        focused = null;
      }
      return Promise.resolve(focused).catch(function () {}).then(function () {
        try {
          client.postMessage({ type: 'open-session', sessionId: sessionId });
        } catch (err) {
          /* ignore */
        }
      });
    }
    if (!target || !self.clients || typeof self.clients.openWindow !== 'function') return undefined;
    return self.clients.openWindow(target.href).catch(function () {});
  });
  event.waitUntil(work.then(function () {
    reportPush('notification-click', 'session=' + (sessionId || '-'));
  }, function (err) {
    reportPush('notification-click-error', err && err.name ? String(err.name) : 'unknown');
  }));
});

function decodeBase64Url(value) {
  var text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4 !== 0) text += '=';
  var binary = atob(text);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* Rebuild a lost/rotated push subscription from the Host's VAPID key. Best
 * effort: failure is retried on the next app start by app.js. */
function renewPushSubscription(event) {
  var registration = null;
  try {
    registration = self.registration;
  } catch (err) {
    registration = null;
  }
  if (!registration || !registration.pushManager || typeof registration.pushManager.subscribe !== 'function') {
    return Promise.resolve();
  }
  return fetch('/api/push/key', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (response) {
      if (!response || !response.ok) return null;
      return response.json();
    })
    .then(function (data) {
      if (!data || data.enabled !== true || typeof data.publicKey !== 'string') return null;
      var existing = event && event.newSubscription ? event.newSubscription : null;
      if (existing) return existing;
      return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(data.publicKey)
      });
    })
    .then(function (subscription) {
      if (!subscription) return undefined;
      var json = null;
      try {
        json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
      } catch (err) {
        json = null;
      }
      if (!json || typeof json !== 'object') return undefined;
      return fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: json })
      }).catch(function () {});
    })
    .catch(function () {});
}

self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(renewPushSubscription(event).catch(function () {}));
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (!request || request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /* Never proxy or cache cross-origin traffic. */
  if (url.origin !== self.location.origin) return;
  if (isNever(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(staticAsset(event, request));
  }
});






