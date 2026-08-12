import { describe, expect, it } from 'vitest';
import { extractLogInfo, extractLogStartTime } from './binlog';

/**
 * Synthetic ArduPilot DataFlash builder — just enough of the format to
 * exercise extractLogInfo: an FMT self-description for a GPS message,
 * followed by GPS messages with configurable week/ms/lat/lng.
 */
const GPS_TYPE = 130;
const GPS_FORMAT = 'QBIHBcLLefffB';
const GPS_COLUMNS = 'TimeUS,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,U';
// Q8 B1 I4 H2 B1 c2 L4 L4 e4 f4 f4 f4 B1 = 43 payload + 3 header
const GPS_LEN = 46;

function cstr(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i);
  return out;
}

function fmtMsg(): Uint8Array {
  const out = new Uint8Array(89);
  out.set([0xa3, 0x95, 0x80]);
  out[3] = GPS_TYPE;
  out[4] = GPS_LEN;
  out.set(cstr('GPS', 4), 5);
  out.set(cstr(GPS_FORMAT, 16), 9);
  out.set(cstr(GPS_COLUMNS, 64), 25);
  return out;
}

function gpsMsg(opts: {
  gwk: number;
  gms: number;
  lat?: number;
  lng?: number;
}): Uint8Array {
  const out = new Uint8Array(GPS_LEN);
  const view = new DataView(out.buffer);
  out.set([0xa3, 0x95, GPS_TYPE]);
  let off = 3;
  view.setBigUint64(off, 123456789n, true); // TimeUS (Q)
  off += 8;
  view.setUint8(off, 3); // Status (B)
  off += 1;
  view.setUint32(off, opts.gms, true); // GMS (I)
  off += 4;
  view.setUint16(off, opts.gwk, true); // GWk (H)
  off += 2;
  view.setUint8(off, 12); // NSats (B)
  off += 1;
  view.setInt16(off, 120, true); // HDop (c)
  off += 2;
  view.setInt32(off, Math.round((opts.lat ?? 0) * 1e7), true); // Lat (L)
  off += 4;
  view.setInt32(off, Math.round((opts.lng ?? 0) * 1e7), true); // Lng (L)
  off += 4;
  // Alt(e) Spd(f) GCrs(f) VZ(f) U(B) left zeroed
  return out;
}

function makeFile(parts: Uint8Array[], lastModified = 1_700_000_000_000): File {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return new File([buf], 'test.bin', { lastModified });
}

// GWk 2400 + GMS 100000000 → 2026-01-05T02:26:22Z (before today + 2d)
const GWK = 2400;
const GMS = 100_000_000;
const EXPECTED_UNIX_S = 315964800 + GWK * 604800 + GMS / 1000 - 18;

describe('extractLogInfo (D1: coarse takeoff coords)', () => {
  it('reads GPS time and the coarse (2 dp) first fix', async () => {
    const file = makeFile([
      fmtMsg(),
      gpsMsg({ gwk: GWK, gms: GMS, lat: 37.123456, lng: -122.654321 }),
    ]);
    const info = await extractLogInfo(file);
    expect(info.source).toBe('gps');
    expect(info.time.getTime()).toBe(EXPECTED_UNIX_S * 1000);
    // privacy: exactly 2 decimal places, never the raw 6-dp values
    expect(info.lat).toBe(37.12);
    expect(info.lon).toBe(-122.65);
  });

  it('skips GWk=0 (no lock) messages and uses the first valid one', async () => {
    const file = makeFile([
      fmtMsg(),
      gpsMsg({ gwk: 0, gms: 0, lat: 1.5, lng: 1.5 }),
      gpsMsg({ gwk: GWK, gms: GMS, lat: 51.5074, lng: -0.1278 }),
    ]);
    const info = await extractLogInfo(file);
    expect(info.source).toBe('gps');
    expect(info.lat).toBe(51.51);
    expect(info.lon).toBe(-0.13);
  });

  it('keeps the first timed message but scans on for the first real fix', async () => {
    const file = makeFile([
      fmtMsg(),
      gpsMsg({ gwk: GWK, gms: GMS, lat: 0, lng: 0 }), // time, (0,0) placeholder
      gpsMsg({ gwk: GWK, gms: GMS + 5000, lat: 40.0, lng: -105.0 }),
    ]);
    const info = await extractLogInfo(file);
    expect(info.source).toBe('gps');
    expect(info.time.getTime()).toBe(EXPECTED_UNIX_S * 1000); // first msg's clock
    expect(info.lat).toBe(40);
    expect(info.lon).toBe(-105);
  });

  it('returns time without coords when no plausible fix appears', async () => {
    const file = makeFile([fmtMsg(), gpsMsg({ gwk: GWK, gms: GMS, lat: 0, lng: 0 })]);
    const info = await extractLogInfo(file);
    expect(info.source).toBe('gps');
    expect(info.lat).toBeNull();
    expect(info.lon).toBeNull();
  });

  it('falls back to file mtime when the log has no GPS messages', async () => {
    const mtime = 1_690_000_000_000;
    const file = makeFile([fmtMsg()], mtime);
    const info = await extractLogInfo(file);
    expect(info.source).toBe('mtime');
    expect(info.time.getTime()).toBe(mtime);
    expect(info.lat).toBeNull();
    expect(info.lon).toBeNull();
  });

  it('extractLogStartTime wrapper keeps its original shape', async () => {
    const file = makeFile([fmtMsg(), gpsMsg({ gwk: GWK, gms: GMS, lat: 1, lng: 2 })]);
    const st = await extractLogStartTime(file);
    expect(st).toEqual({ time: new Date(EXPECTED_UNIX_S * 1000), source: 'gps' });
  });
});
