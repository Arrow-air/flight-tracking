import { describe, expect, it } from 'vitest';
import { bridgeStorage, hubOrigin, type Hub } from './sessionBridge';

const KEY = 'sb-supabase-auth-token';

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

describe('bridgeStorage (sign in once across Arrow apps)', () => {
  it('reads and writes the session in the hub, not locally', async () => {
    const { hub, data } = memoryHub({ [KEY]: 'from-app' });
    const local = memoryLocal();
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe('from-app');
    await s.setItem(KEY, 'refreshed');
    expect(data.get(KEY)).toBe('refreshed');
    expect(local.data.size).toBe(0);
    await s.removeItem(KEY);
    expect(data.has(KEY)).toBe(false);
  });

  it("moves this app's own earlier sign-in to the hub when the hub has none", async () => {
    const { hub, data } = memoryHub();
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe('flights-only');
    expect(data.get(KEY)).toBe('flights-only');
    expect(local.data.has(KEY)).toBe(false);
  });

  it("keeps the hub's sign-in when both have one, and drops this app's", async () => {
    const { hub, data } = memoryHub({ [KEY]: 'from-app' });
    const local = memoryLocal({ [KEY]: 'stale-flights' });
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBe('from-app');
    expect(data.get(KEY)).toBe('from-app');
    expect(local.data.has(KEY)).toBe(false);
  });

  it('adopts once per key: a later local value is not pushed again', async () => {
    const { hub, data } = memoryHub();
    const local = memoryLocal();
    const s = bridgeStorage(async () => hub, local);
    expect(await s.getItem(KEY)).toBeNull();
    local.setItem(KEY, 'written-behind-our-back');
    expect(await s.getItem(KEY)).toBeNull();
    expect(data.has(KEY)).toBe(false);
  });

  it("falls back to this app's own storage when the hub doesn't answer", async () => {
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(async () => null, local);
    expect(await s.getItem(KEY)).toBe('flights-only');
    await s.setItem(KEY, 'new');
    expect(local.data.get(KEY)).toBe('new');
    await s.removeItem(KEY);
    expect(local.data.has(KEY)).toBe(false);
  });

  it('falls back when the hub fails mid-call, and a sign-out still clears both', async () => {
    const broken: Hub = {
      get: async () => {
        throw new Error('The sign-in bridge did not answer.');
      },
      set: async () => {
        throw new Error('The sign-in bridge did not answer.');
      },
      remove: async () => {
        throw new Error('The sign-in bridge did not answer.');
      },
    };
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(async () => broken, local);
    expect(await s.getItem(KEY)).toBe('flights-only');
    await s.setItem(KEY, 'kept-here');
    expect(local.data.get(KEY)).toBe('kept-here');
    await s.removeItem(KEY);
    expect(local.data.has(KEY)).toBe(false);
  });

  it('a hub that rejects while opening counts as no hub', async () => {
    const local = memoryLocal({ [KEY]: 'flights-only' });
    const s = bridgeStorage(() => Promise.reject(new Error('blocked')), local);
    expect(await s.getItem(KEY)).toBe('flights-only');
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
