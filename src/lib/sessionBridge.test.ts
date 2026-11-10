import { describe, expect, it } from 'vitest';
import { accountOf, bridgeStorage, hubOrigin, type Hub } from './sessionBridge';

const KEY = 'sb-supabase-auth-token';
const MARK = `${KEY}-shared`;

/** A stored session for `user`, expiring at `exp`. */
const session = (user: string, exp: number) => JSON.stringify({ access_token: 'x.y.z', expires_at: exp, user: { id: user } });

function memoryHub(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const hub: Hub = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
    remove: async (k) => {
      data.delete(k);
    },
  };
  return { hub, data };
}

function memoryLocal(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const failing = (): Hub => {
  const no = async (): Promise<never> => {
    throw new Error('The sign-in bridge did not answer.');
  };
  return { get: no, set: no, remove: no };
};

describe('bridgeStorage (sign in once across Arrow apps)', () => {
  it('reads and writes the session in the hub, keeping a marked copy here', async () => {
    const { hub, data } = memoryHub({ [KEY]: 'from-app' });
    const local = memoryLocal();
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe('from-app');
    expect(local.data.get(KEY)).toBe('from-app');
    expect(local.data.get(MARK)).toBe('1');
    await s.setItem(KEY, 'refreshed');
    expect(data.get(KEY)).toBe('refreshed');
    expect(local.data.get(KEY)).toBe('refreshed');
    await s.removeItem(KEY);
    expect(data.has(KEY)).toBe(false);
    expect(local.data.size).toBe(0);
  });

  it("moves this app's own earlier sign-in to the hub when the hub has none", async () => {
    const { hub, data } = memoryHub();
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe('flights-only');
    expect(data.get(KEY)).toBe('flights-only');
    expect(local.data.get(MARK)).toBe('1');
  });

  it("keeps the hub's sign-in when it holds a newer one of the same account", async () => {
    const { hub, data } = memoryHub({ [KEY]: session('u1', 200) });
    const local = memoryLocal({ [KEY]: session('u1', 100) });
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe(session('u1', 200));
    expect(data.get(KEY)).toBe(session('u1', 200));
    expect(local.data.get(KEY)).toBe(session('u1', 200));
  });

  it("sends this app's sign-in when it is the newer one of the same account (refreshed while the hub was away)", async () => {
    const { hub, data } = memoryHub({ [KEY]: session('u1', 100) });
    const local = memoryLocal({ [KEY]: session('u1', 200) });
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe(session('u1', 200));
    expect(data.get(KEY)).toBe(session('u1', 200));
  });

  it('another account on the hub: this app keeps its own, untouched, until it signs out', async () => {
    const { hub, data } = memoryHub({ [KEY]: session('app-user', 100) });
    const local = memoryLocal({ [KEY]: session('flights-user', 100) });
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe(session('flights-user', 100));
    await s.setItem(KEY, session('flights-user', 200));
    expect(data.get(KEY)).toBe(session('app-user', 100));
    expect(local.data.get(KEY)).toBe(session('flights-user', 200));
    expect(local.data.has(MARK)).toBe(false);
    await s.removeItem(KEY);
    expect(data.get(KEY)).toBe(session('app-user', 100));
    // Signed out here: the next page shares app.arrowair.com's sign-in.
    const next = bridgeStorage(async () => hub, local);
    expect(await next.getItem(KEY)).toBe(session('app-user', 100));
  });

  it('signed out on app.arrowair.com: the copy here goes too', async () => {
    const { hub } = memoryHub();
    const local = memoryLocal({ [KEY]: session('u1', 100), [MARK]: '1' });
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBeNull();
    expect(local.data.size).toBe(0);
  });

  it('settles once per key: a value written here behind its back is not pushed', async () => {
    const { hub, data } = memoryHub();
    const local = memoryLocal();
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBeNull();
    local.setItem(KEY, 'written-behind-our-back');
    expect(await s.getItem(KEY)).toBeNull();
    expect(data.has(KEY)).toBe(false);
  });

  it("uses this app's own storage when there is no hub (Safari, or app.arrowair.com never opened)", async () => {
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(async () => null, local);
    expect(await s.getItem(KEY)).toBe('flights-only');
    await s.setItem(KEY, 'new');
    expect(local.data.get(KEY)).toBe('new');
    expect(local.data.has(MARK)).toBe(false);
    await s.removeItem(KEY);
    expect(local.data.has(KEY)).toBe(false);
  });

  it('keeps a slow or failed hub from signing anyone out: the copy here answers', async () => {
    const { hub } = memoryHub({ [KEY]: session('u1', 100) });
    let up = true;
    const local = memoryLocal();
    const s = bridgeStorage(async () => (up ? hub : failing()), local);
    expect(await s.getItem(KEY)).toBe(session('u1', 100));
    up = false;
    expect(await s.getItem(KEY)).toBe(session('u1', 100));
    await s.setItem(KEY, session('u1', 200));
    expect(local.data.get(KEY)).toBe(session('u1', 200));
  });

  it('a sign-in made while the hub was away reaches it when it is back', async () => {
    const { hub, data } = memoryHub();
    const local = memoryLocal();
    const away = bridgeStorage(async () => null, local);
    await away.setItem(KEY, session('u1', 100));
    const back = bridgeStorage(async () => hub, local);
    expect(await back.getItem(KEY)).toBe(session('u1', 100));
    expect(data.get(KEY)).toBe(session('u1', 100));
  });

  it('falls back when the hub fails mid-call, and a sign-out still clears it here', async () => {
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(async () => failing(), local);
    expect(await s.getItem(KEY)).toBe('flights-only');
    await s.setItem(KEY, 'kept-here');
    expect(local.data.get(KEY)).toBe('kept-here');
    await s.removeItem(KEY);
    expect(local.data.has(KEY)).toBe(false);
  });

  it('a hub that fails while taking over the earlier sign-in gets it next time', async () => {
    const { hub, data } = memoryHub();
    let flaky = true;
    const shaky: Hub = {
      ...hub,
      get: async (k) => {
        if (flaky) throw new Error('The sign-in bridge did not answer.');
        return hub.get(k);
      },
    };
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(async () => shaky, local);
    expect(await s.getItem(KEY)).toBe('flights-only');
    flaky = false;
    expect(await s.getItem(KEY)).toBe('flights-only');
    expect(data.get(KEY)).toBe('flights-only');
    expect(local.data.get(MARK)).toBe('1');
  });

  it('a hub that rejects while opening counts as no hub', async () => {
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(() => Promise.reject(new Error('blocked')), local);
    expect(await s.getItem(KEY)).toBe('flights-only');
  });
});

describe('accountOf', () => {
  it("reads the account from the stored user, or else from the token's subject", () => {
    expect(accountOf(session('u1', 1))).toBe('u1');
    const claims = btoa(JSON.stringify({ sub: 'u2' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(accountOf(JSON.stringify({ access_token: `h.${claims}.s` }))).toBe('u2');
    expect(accountOf('not json')).toBeNull();
    expect(accountOf(null)).toBeNull();
  });
});

describe('hubOrigin', () => {
  it('uses app.arrowair.com on flights.arrowair.com', () => {
    expect(hubOrigin(undefined, 'flights.arrowair.com')).toBe('https://app.arrowair.com');
  });
  it('keeps its own sign-in elsewhere (local dev, previews)', () => {
    expect(hubOrigin(undefined, 'localhost')).toBeNull();
    expect(hubOrigin(undefined, 'flights-preview.example.com')).toBeNull();
  });
  it('VITE_SESSION_HUB picks the hub, or turns the bridge off when empty', () => {
    expect(hubOrigin('http://localhost:5174/', 'localhost')).toBe('http://localhost:5174');
    expect(hubOrigin('', 'flights.arrowair.com')).toBeNull();
  });
});
