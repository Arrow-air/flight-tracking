/**
 * Client-side helpers for ArduPilot DataFlash `.bin` files:
 *  - sha256Hex: checksum for dedupe (flight_logs.checksum UNIQUE)
 *  - extractLogInfo: best-effort flight start from the log's own GPS
 *    time (FMT self-describing format → first GPS message with GWk > 0),
 *    plus a COARSE (2 dp) first-fix coordinate for weather auto-fill (D1).
 *    Falls back to the file's mtime, labelled so the UI can say which one
 *    it used. The parser refines everything server-side later.
 *  - extractLogStartTime: back-compat wrapper (time only).
 */

const HEAD1 = 0xa3;
const HEAD2 = 0x95;
const FMT_TYPE = 0x80; // 128
const FMT_LEN = 89; // 3 header + 86 payload
const GPS_EPOCH_S = 315964800; // 1980-01-06 UTC
const GPS_LEAP_S = 18;
/** Only scan the head of the file — FMT block + early GPS msgs live there. */
const SCAN_BYTES = 8 * 1024 * 1024;

/** DataFlash format char → byte size (subset; enough to walk field offsets). */
const TYPE_SIZES: Record<string, number> = {
  a: 64,
  b: 1,
  B: 1,
  h: 2,
  H: 2,
  i: 4,
  I: 4,
  f: 4,
  d: 8,
  n: 4,
  N: 16,
  Z: 64,
  c: 2,
  C: 2,
  e: 4,
  E: 4,
  L: 4,
  M: 1,
  q: 8,
  Q: 8,
};

export async function sha256Hex(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function readCString(bytes: Uint8Array, start: number, len: number): string {
  let out = '';
  for (let i = start; i < start + len; i++) {
    const c = bytes[i];
    if (!c) break;
    out += String.fromCharCode(c);
  }
  return out;
}

interface MsgFormat {
  length: number;
  name: string;
  format: string;
  columns: string[];
}

export interface LogStartTime {
  time: Date;
  source: 'gps' | 'mtime';
}

export interface LogHeadInfo extends LogStartTime {
  /** COARSE first-fix coordinate (rounded to 2 dp ≈ 1.1 km, matching the
   *  parser's D1 privacy coarsening) — for weather auto-fill only; the
   *  precise values never leave this function. Null when no valid fix is
   *  found in the scanned head. */
  lat: number | null;
  lon: number | null;
}

/** Back-compat wrapper: start time only. */
export async function extractLogStartTime(file: File): Promise<LogStartTime> {
  const { time, source } = await extractLogInfo(file);
  return { time, source };
}

/**
 * Walk the head of the log: collect FMT definitions, then decode GPS
 * messages until one carries a valid GPS week (start time) — the same
 * message's Lat/Lng, when plausible, yields the coarse takeoff coordinate.
 * Unknown message types force a resync scan for the next 0xA3 0x95 header.
 */
export async function extractLogInfo(file: File): Promise<LogHeadInfo> {
  const fallback: LogHeadInfo = {
    time: new Date(file.lastModified),
    source: 'mtime',
    lat: null,
    lon: null,
  };
  let result: LogHeadInfo | null = null;
  try {
    const head = new Uint8Array(
      await file.slice(0, Math.min(SCAN_BYTES, file.size)).arrayBuffer(),
    );
    const view = new DataView(head.buffer);
    const formats = new Map<number, MsgFormat>();
    let i = 0;
    while (i + 3 <= head.length) {
      if (head[i] !== HEAD1 || head[i + 1] !== HEAD2) {
        i++;
        continue;
      }
      const msgType = head[i + 2];
      if (msgType === FMT_TYPE) {
        if (i + FMT_LEN > head.length) break;
        const p = i + 3;
        const defType = head[p];
        const defLen = head[p + 1];
        const name = readCString(head, p + 2, 4);
        const format = readCString(head, p + 6, 16);
        const columns = readCString(head, p + 22, 64)
          .split(',')
          .filter(Boolean);
        formats.set(defType, { length: defLen, name, format, columns });
        i += FMT_LEN;
        continue;
      }
      const fmt = formats.get(msgType);
      if (!fmt || fmt.length < 3) {
        i += 3; // unknown type: resync on next header
        continue;
      }
      if (fmt.name === 'GPS' && i + fmt.length <= head.length) {
        const g = decodeGpsMsg(view, head, i + 3, fmt);
        if (g) {
          if (!result) {
            result = { time: g.time, source: 'gps', lat: null, lon: null };
          }
          if (g.lat != null && g.lon != null) {
            // D1 PRIVACY: coarsen to 2 dp before the value leaves here.
            result.lat = Math.round(g.lat * 100) / 100;
            result.lon = Math.round(g.lon * 100) / 100;
            return result;
          }
          // time acquired but no position lock yet — keep scanning the
          // head for the first plausible fix.
        }
      }
      i += fmt.length;
    }
  } catch {
    // unreadable head → fall through to mtime
  }
  return result ?? fallback;
}

function decodeGpsMsg(
  view: DataView,
  bytes: Uint8Array,
  payloadStart: number,
  fmt: MsgFormat,
): { time: Date; lat: number | null; lon: number | null } | null {
  let gwk: number | null = null;
  let gms: number | null = null;
  let lat: number | null = null;
  let lon: number | null = null;
  let off = payloadStart;
  for (let f = 0; f < fmt.format.length && f < fmt.columns.length; f++) {
    const ch = fmt.format[f];
    const size = TYPE_SIZES[ch];
    if (!size) return null; // unknown field char — bail out safely
    if (off + size > bytes.length) return null;
    const col = fmt.columns[f];
    if (col === 'GWk' && ch === 'H') gwk = view.getUint16(off, true);
    if (col === 'GMS' && ch === 'I') gms = view.getUint32(off, true);
    // Lat/Lng: 'L' = int32 degrees * 1e7 (ArduPilot DataFlash convention)
    if (col === 'Lat' && ch === 'L') lat = view.getInt32(off, true) / 1e7;
    if (col === 'Lng' && ch === 'L') lon = view.getInt32(off, true) / 1e7;
    off += size;
  }
  if (gwk == null || gms == null || gwk === 0) return null;
  const unixS = GPS_EPOCH_S + gwk * 604800 + gms / 1000 - GPS_LEAP_S;
  const d = new Date(unixS * 1000);
  // sanity: between 2010 and now+2d
  if (d.getTime() < Date.UTC(2010, 0, 1) || d.getTime() > Date.now() + 2 * 864e5) {
    return null;
  }
  // plausibility: reject out-of-range and the (0,0) no-fix placeholder
  const validFix =
    lat != null &&
    lon != null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0);
  return { time: d, lat: validFix ? lat : null, lon: validFix ? lon : null };
}
