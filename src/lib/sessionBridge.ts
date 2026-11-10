/**
 * Sign in once across Arrow apps. This app keeps its sign-in in
 * app.arrowair.com's storage, reached through a hidden frame
 * (app.arrowair.com/session-bridge.html, which answers only this app), so
 * signing in or out here or there does both. Nothing is shared with the rest
 * of arrowair.com: the forum and the website are hosted elsewhere.
 *
 * This app keeps its own sign-in, as before the bridge, when the frame can't
 * see app.arrowair.com's storage (Safari and every iPhone browser give a frame
 * under another address storage of its own; a browser that never opened
 * app.arrowair.com has nothing to share yet), and while app.arrowair.com holds
 * another account. It keeps a copy of the shared sign-in too, used while the
 * bridge doesn't answer (app.arrowair.com down or slow).
 */

/** The stored sign-in, wherever it lives. */
export interface Hub {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface LocalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The account a stored session belongs to, if it is one. */
export function accountOf(value: string | null): string | null {
  if (value === null) return null;
  try {
    const s = JSON.parse(value);
    if (typeof s?.user?.id === 'string') return s.user.id;
    const claims = JSON.parse(atob(s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

function expiresAt(value: string): number {
  try {
    const n = JSON.parse(value)?.expires_at;
    return typeof n === 'number' ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Storage for supabase-js: the hub when it answers, this app's own storage
 * when it doesn't. Beside each key this app keeps a copy, marked when it
 * mirrors the hub. An unmarked copy is this app's own sign-in (from before the
 * bridge, or written while the hub didn't answer): on first contact it goes to
 * the hub if the hub has none or an older one of the same account. If the hub
 * holds another account, this app keeps its own until it signs out.
 */
export function bridgeStorage(hub: () => Promise<Hub | null>, local: LocalStore) {
  const mark = (key: string) => `${key}-shared`;
  const settled = new Set<string>();
  const apart = new Set<string>();

  function keep(key: string, value: string | null, shared: boolean) {
    if (value === null) local.removeItem(key);
    else local.setItem(key, value);
    if (shared && value !== null) local.setItem(mark(key), '1');
    else local.removeItem(mark(key));
  }

  async function reach(key: string): Promise<Hub | null> {
    if (apart.has(key)) return null;
    const h = await hub().catch(() => null);
    if (!h || settled.has(key)) return h;
    const mine = local.getItem(key);
    if (mine !== null && local.getItem(mark(key)) === null) {
      const theirs = await h.get(key);
      if (theirs !== null && accountOf(theirs) !== accountOf(mine)) {
        apart.add(key);
        return null;
      }
      if (theirs === null || expiresAt(mine) > expiresAt(theirs)) await h.set(key, mine);
      local.setItem(mark(key), '1');
    }
    // Only once it went through: a hub that failed halfway tries again next time.
    settled.add(key);
    return h;
  }

  return {
    async getItem(key: string): Promise<string | null> {
      try {
        const h = await reach(key);
        if (h) {
          const v = await h.get(key);
          keep(key, v, true);
          return v;
        }
      } catch {
        /* the hub stopped answering: the copy here */
      }
      return local.getItem(key);
    },
    async setItem(key: string, value: string): Promise<void> {
      try {
        const h = await reach(key);
        if (h) {
          await h.set(key, value);
          keep(key, value, true);
          return;
        }
      } catch {
        /* as above */
      }
      keep(key, value, false);
    },
    async removeItem(key: string): Promise<void> {
      try {
        const h = await reach(key);
        if (h) {
          await h.remove(key);
          keep(key, null, true);
          return;
        }
      } catch {
        /* as above */
      }
      keep(key, null, false);
    },
  };
}

interface Reply {
  arrowSession: 1;
  id?: string;
  ok?: boolean;
  shared?: boolean;
  value?: string | null;
  error?: string;
  changed?: string;
}

/**
 * The hub as a hidden frame of `origin`/session-bridge.html, opened on first
 * use. A frame that doesn't answer within `timeoutMs` is dropped and tried
 * again after `retryMs`; one that answers but can't see app.arrowair.com's
 * storage isn't used again on this page. `onChange` runs when the sign-in
 * changes in another app's tab.
 */
export function frameHub(origin: string, timeoutMs = 4000, retryMs = 30000) {
  const listeners = new Set<() => void>();
  const waiting = new Map<string, (m: Reply) => void>();
  let seq = 0;
  let frame: HTMLIFrameElement | null = null;
  let current: Promise<Hub | null> | null = null;
  let failedAt = -Infinity;
  let unshared = false;

  window.addEventListener('message', (e: MessageEvent) => {
    if (!frame || e.origin !== origin || e.source !== frame.contentWindow) return;
    const m = e.data as Reply;
    if (!m || m.arrowSession !== 1) return;
    if (m.changed) {
      listeners.forEach((fn) => fn());
      return;
    }
    const done = m.id ? waiting.get(m.id) : undefined;
    if (done) {
      waiting.delete(m.id!);
      done(m);
    }
  });

  function drop(f: HTMLIFrameElement) {
    f.remove();
    if (frame !== f) return;
    frame = null;
    current = null;
    failedAt = Date.now();
  }

  function call(op: string, key?: string, value?: string): Promise<Reply> {
    const f = frame;
    return new Promise<Reply>((ok, fail) => {
      if (!f) return fail(new Error('The sign-in bridge is closed.'));
      const id = String(++seq);
      const timer = setTimeout(() => {
        waiting.delete(id);
        drop(f);
        fail(new Error('The sign-in bridge did not answer.'));
      }, timeoutMs);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) fail(new Error(m.error));
        else ok(m);
      });
      f.contentWindow?.postMessage({ arrowSession: 1, id, op, key, value }, origin);
    });
  }

  const hub: Hub = {
    get: async (key) => {
      const v = (await call('get', key)).value;
      return typeof v === 'string' ? v : null;
    },
    set: async (key, value) => {
      await call('set', key, value);
    },
    remove: async (key) => {
      await call('remove', key);
    },
  };

  function open(): Promise<Hub | null> {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      frame = f;
      const giveUp = setTimeout(() => {
        drop(f);
        resolve(null);
      }, timeoutMs);
      f.addEventListener(
        'load',
        () => {
          call('hello').then(
            (m) => {
              clearTimeout(giveUp);
              if (m.shared === true) return resolve(hub);
              unshared = true;
              drop(f);
              resolve(null);
            },
            () => {
              clearTimeout(giveUp);
              resolve(null);
            },
          );
        },
        { once: true },
      );
      f.title = 'Arrow sign-in';
      f.hidden = true;
      f.tabIndex = -1;
      f.setAttribute('aria-hidden', 'true');
      f.src = `${origin}/session-bridge.html`;
      (document.body ?? document.documentElement).appendChild(f);
    });
  }

  return {
    hub(): Promise<Hub | null> {
      if (unshared) return Promise.resolve(null);
      if (current) return current;
      if (Date.now() - failedAt < retryMs) return Promise.resolve(null);
      const p = open();
      current = p;
      return p;
    },
    onChange: (fn: () => void) => {
      listeners.add(fn);
    },
  };
}

/**
 * Where the shared sign-in lives: app.arrowair.com in production, or
 * VITE_SESSION_HUB (an origin; empty turns the bridge off). Elsewhere (local
 * dev) each app keeps its own.
 */
export function hubOrigin(
  configured: string | undefined,
  hostname: string,
): string | null {
  if (configured !== undefined) return configured.replace(/\/+$/, '') || null;
  return hostname === 'flights.arrowair.com' ? 'https://app.arrowair.com' : null;
}
