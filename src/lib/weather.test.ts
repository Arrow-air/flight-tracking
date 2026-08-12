/**
 * P2 (v2.2): fetchWeatherAt must refuse unusable coordinates — above all
 * the null island (0,0) that GPS-stripped logs produce — BEFORE any
 * network request. The stubbed fetch fails the test if it is ever called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWeatherAt } from './weather';

describe('fetchWeatherAt coordinate guard (P2 v2.2)', () => {
  const fetchSpy = vi.fn(() => {
    throw new Error('fetch must not be called for unusable coordinates');
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on the null island (0,0) without fetching', async () => {
    await expect(fetchWeatherAt(0, 0, new Date())).rejects.toThrow(
      /unusable coordinates/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on near-zero residue that rounds to the 2-dp null island', async () => {
    await expect(fetchWeatherAt(0.004, -0.004, new Date())).rejects.toThrow(
      /unusable coordinates/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on non-finite and out-of-range coordinates', async () => {
    await expect(fetchWeatherAt(NaN, 10, new Date())).rejects.toThrow(
      /unusable coordinates/,
    );
    await expect(fetchWeatherAt(95, 10, new Date())).rejects.toThrow(
      /unusable coordinates/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes the guard for real coordinates (fetch is then attempted)', async () => {
    // The stub throws, proving the guard let a REAL coordinate through to
    // the network layer; fetchJson has no try/catch so the stub's error
    // propagates.
    await expect(
      fetchWeatherAt(30.04, -103.49, new Date()),
    ).rejects.toThrow(/fetch must not be called/);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
