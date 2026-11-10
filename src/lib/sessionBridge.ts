/**
 * Sign in once across Arrow apps. This app keeps its sign-in in
 * app.arrowair.com's storage, reached through a hidden frame
 * (app.arrowair.com/session-bridge.html, which answers only this app), so
 * signing in or out here or there does both. Nothing is shared with the rest
 * of arrowair.com: the forum and the website are hosted elsewhere.
 *
 * If the bridge doesn't answer (app.arrowair.com down, storage blocked), this
 * app keeps its own sign-in, as before.
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

/**
 * Storage for supabase-js: the hub when it answers, this app's own storage
 * when it doesn't. A sign-in this app kept itself before the bridge moves to
 * the hub, unless the hub already has one (then the hub's wins).
 */
export function bridgeStorage(hub: () => Promise<Hub | null>, local: LocalStore) {
  const adopted = new Set<string>();
  async function reach(key: string): Promise<Hub | null> {
    const h = await hub().catch(() => null);
    if (!h || adopted.has(key)) return h;
    adopted.add(key);
    const mine = local.getItem(key);
    if (mine !== null) {
      if ((await h.get(key)) === null) await h.set(key, mine);
      local.removeItem(key);
    }
    return h;
  }
  return {
    async getItem(key: string): Promise<string | null> {
      try {
        const h = await reach(key);
        if (h) return await h.get(key);
      } catch {
        /* the hub stopped answering: this app's own storage */
      }
      return local.getItem(key);
    },
    async setItem(key: string, value: string): Promise<void> {
      try {
        const h = await reach(key);
        if (h) return await h.set(key, value);
      } catch {
        /* as above */
      }
      local.setItem(key, value);
    },
    async removeItem(key: string): Promise<void> {
      local.removeItem(key);
      try {
        const h = await reach(key);
        if (h) await h.remove(key);
      } catch {
        /* as above */
      }
    },
  };
}

interface Reply {
  arrowSession: 1;
  id?: string;
  ok?: boolean;
  value?: string | null;
  error?: string;
  changed?: string;
}

/**
 * The hub as a hidden frame of `origin`/session-bridge.html, opened on first
 * use. `onChange` runs when the sign-in changes in another app's tab.
 */
export function frameHub(origin: string, timeoutMs = 4000) {
  let opened: Promise<Hub | null> | null = null;
  const listeners = new Set<() => void>();

  function open(): Promise<Hub | null> {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      const waiting = new Map<string, (m: Reply) => void>();
      let seq = 0;
      window.addEventListener('message', (e: MessageEvent) => {
        if (e.origin !== origin || e.source !== frame.contentWindow) return;
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
      const call = (op: string, key?: string, value?: string) =>
        new Promise<Reply>((ok, fail) => {
          const id = String(++seq);
          const timer = setTimeout(() => {
            waiting.delete(id);
            fail(new Error('The sign-in bridge did not answer.'));
          }, timeoutMs);
          waiting.set(id, (m) => {
            clearTimeout(timer);
            if (m.error) fail(new Error(m.error));
            else ok(m);
          });
          frame.contentWindow?.postMessage({ arrowSession: 1, id, op, key, value }, origin);
        });
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
      const giveUp = setTimeout(() => resolve(null), timeoutMs);
      frame.addEventListener(
        'load',
        () => {
          call('hello').then(
            () => {
              clearTimeout(giveUp);
              resolve(hub);
            },
            () => {
              clearTimeout(giveUp);
              resolve(null);
            },
          );
        },
        { once: true },
      );
      frame.title = 'Arrow sign-in';
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.src = `${origin}/session-bridge.html`;
      (document.body ?? document.documentElement).appendChild(frame);
    });
  }

  return {
    hub: () => (opened ??= open()),
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
