"""Sanitize an ArduPilot DataFlash .bin log: strip ALL location-bearing data.

Strategy (per RUN-CONTEXT "Parser" + V2-PLAN "GPS privacy"):

1. DROP entire messages whose sole/primary purpose is position:
   GPS / GPS2 / GPSB / GPA / GPA2 / GPAB (fix, lat/lng, accuracy), POS (fused
   position), ORGN (EKF origin), HOME, TERR (terrain lat/lng), RALY (rally
   points), GRAW/GRXH/GRXS (raw GNSS observables).
2. For every message that is KEPT, zero any field whose name matches a
   latitude/longitude pattern (Lat, Lng, Lon, TLat, DLng, ...). This covers
   fused/derived messages present in any firmware (AHR2, SIM, CMD waypoints,
   CAMERA/TRIG, precision-landing, etc.) without needing a per-type list.

The walker operates on raw bytes using the FMT self-description in the log,
so the output is a byte-exact valid DataFlash file that pymavlink re-parses
cleanly. FMT/FMTU definitions are kept even for dropped types (harmless, and
keeps unit/format tables consistent).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

HEAD1 = 0xA3
HEAD2 = 0x95
FMT_ID = 0x80
FMT_LEN = 89  # 3 header + BBnNZ payload (1+1+4+16+64)

# Size in bytes of each DataFlash format char (mirrors pymavlink DFReader).
FORMAT_SIZES = {
    "a": 64, "b": 1, "B": 1, "h": 2, "H": 2, "i": 4, "I": 4,
    "f": 4, "d": 8, "n": 4, "N": 16, "Z": 64, "c": 2, "C": 2,
    "e": 4, "E": 4, "L": 4, "M": 1, "q": 8, "Q": 8, "g": 8,
}

# Messages dropped wholesale.
DROP_TYPES = {
    "GPS", "GPS2", "GPSB", "GPA", "GPA2", "GPAB",
    "POS", "ORGN", "HOME", "TERR", "RALY",
    "GRAW", "GRXH", "GRXS",
}

# Field-name pattern for lat/lng in kept messages: optional single prefix
# letter + Lat/Lng + optional digit (Lat, Lng, TLat, DLng, Lat0, GLat...).
# Bare Lon/Long allowed only WITHOUT a prefix letter: PM.NLon is a loop
# counter, not a longitude (real-log false positive, r1).
_LOC_FIELD_RE = re.compile(r"^([A-Za-z]?(lat|lng)[0-9]?|long?[0-9]?)$",
                           re.IGNORECASE)


@dataclass
class MsgDef:
    msg_id: int
    length: int          # total on-wire length incl. 3 header bytes
    name: str
    fmt: str
    columns: list[str]
    # byte ranges (start, size) within the payload to zero, or None
    zero_ranges: list[tuple[int, int]] | None = None


def _parse_fmt_payload(payload: bytes) -> MsgDef:
    msg_id = payload[0]
    length = payload[1]
    name = payload[2:6].split(b"\x00")[0].decode("ascii", "replace")
    fmt = payload[6:22].split(b"\x00")[0].decode("ascii", "replace")
    columns = payload[22:86].split(b"\x00")[0].decode("ascii", "replace")
    cols = [c for c in columns.split(",") if c] if columns else []
    d = MsgDef(msg_id=msg_id, length=length, name=name, fmt=fmt, columns=cols)
    # Pre-compute zero ranges for location-named fields.
    ranges: list[tuple[int, int]] = []
    off = 0
    for i, ch in enumerate(fmt):
        size = FORMAT_SIZES.get(ch)
        if size is None:  # unknown format char; cannot compute offsets safely
            ranges = []
            break
        if i < len(cols) and _LOC_FIELD_RE.match(cols[i]):
            ranges.append((off, size))
        off += size
    d.zero_ranges = ranges or None
    return d


class SanitizeStats:
    def __init__(self) -> None:
        self.messages_in = 0
        self.messages_out = 0
        self.dropped: dict[str, int] = {}
        self.zeroed_fields: dict[str, int] = {}
        self.resync_bytes = 0

    def as_dict(self) -> dict:
        return {
            "messages_in": self.messages_in,
            "messages_out": self.messages_out,
            "dropped": self.dropped,
            "zeroed_fields": self.zeroed_fields,
            "resync_bytes": self.resync_bytes,
        }


def sanitize_bytes(data: bytes) -> tuple[bytes, SanitizeStats]:
    """Return (sanitized_bytes, stats) for a DataFlash .bin blob."""
    defs: dict[int, MsgDef] = {
        FMT_ID: MsgDef(FMT_ID, FMT_LEN, "FMT", "BBnNZ",
                       ["Type", "Length", "Name", "Format", "Columns"])
    }
    out = bytearray()
    stats = SanitizeStats()
    n = len(data)
    i = 0
    while i < n - 3:
        if data[i] != HEAD1 or data[i + 1] != HEAD2:
            i += 1
            stats.resync_bytes += 1
            continue
        msg_id = data[i + 2]
        mdef = defs.get(msg_id)
        if mdef is None:
            # Unknown id before its FMT — corruption; resync.
            i += 1
            stats.resync_bytes += 1
            continue
        end = i + mdef.length
        if end > n:
            break  # truncated tail
        stats.messages_in += 1
        if msg_id == FMT_ID:
            new = _parse_fmt_payload(data[i + 3:end])
            if 0 < new.length <= 256:
                defs[new.msg_id] = new
            out += data[i:end]
            stats.messages_out += 1
        elif mdef.name in DROP_TYPES:
            stats.dropped[mdef.name] = stats.dropped.get(mdef.name, 0) + 1
        elif mdef.zero_ranges:
            buf = bytearray(data[i:end])
            for (off, size) in mdef.zero_ranges:
                start = 3 + off
                buf[start:start + size] = b"\x00" * size
            out += buf
            stats.messages_out += 1
            stats.zeroed_fields[mdef.name] = (
                stats.zeroed_fields.get(mdef.name, 0) + 1)
        else:
            out += data[i:end]
            stats.messages_out += 1
        i = end
    return bytes(out), stats


def sanitize_file(src_path: str, dst_path: str) -> SanitizeStats:
    with open(src_path, "rb") as f:
        data = f.read()
    sanitized, stats = sanitize_bytes(data)
    with open(dst_path, "wb") as f:
        f.write(sanitized)
    return stats
