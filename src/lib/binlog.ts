/**
 * Client-side helpers for ArduPilot DataFlash `.bin` files:
 *  - sha256Hex: checksum for dedupe (flight_logs.checksum UNIQUE)
 *  - extractLogStartTime: best-effort flight start from the log's own GPS
 *    time (FMT self-describing format → first GPS message with GWk > 0).
 *    Falls back to the file's mtime, labelled so the UI can say which one
 *    it used. The parser refines everything server-side later.
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

/**
 * Walk the head of the log: collect FMT definitions, then decode GPS
 * messages until one carries a valid GPS week. Unknown message types force
 * a resync scan for the next 0xA3 0x95 header.
 */
export async function extractLogStartTime(file: File): Promise<LogStartTime> {
  const fallback: LogStartTime = {
    time: new Date(file.lastModified),
    source: 'mtime',
  };
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
        const t = decodeGpsTime(view, head, i + 3, fmt);
        if (t) return { time: t, source: 'gps' };
      }
      i += fmt.length;
    }
  } catch {
    // unreadable head → fall through to mtime
  }
  return fallback;
}

function decodeGpsTime(
  view: DataView,
  bytes: Uint8Array,
  payloadStart: number,
  fmt: MsgFormat,
): Date | null {
  let gwk: number | null = null;
  let gms: number | null = null;
  let off = payloadStart;
  for (let f = 0; f < fmt.format.length && f < fmt.columns.length; f++) {
    const ch = fmt.format[f];
    const size = TYPE_SIZES[ch];
    if (!size) return null; // unknown field char — bail out safely
    if (off + size > bytes.length) return null;
    const col = fmt.columns[f];
    if (col === 'GWk' && ch === 'H') gwk = view.getUint16(off, true);
    if (col === 'GMS' && ch === 'I') gms = view.getUint32(off, true);
    off += size;
  }
  if (gwk == null || gms == null || gwk === 0) return null;
  const unixS = GPS_EPOCH_S + gwk * 604800 + gms / 1000 - GPS_LEAP_S;
  const d = new Date(unixS * 1000);
  // sanity: between 2010 and now+2d
  if (d.getTime() < Date.UTC(2010, 0, 1) || d.getTime() > Date.now() + 2 * 864e5) {
    return null;
  }
  return d;
}
