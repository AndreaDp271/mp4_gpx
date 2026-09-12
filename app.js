"use strict";

/* ---------------------------------------------------------------------- */
/* Theme toggle (persisted override on top of the OS light/dark setting)  */
/* ---------------------------------------------------------------------- */

(function initThemeToggle() {
  const THEME_KEY = "gpxVideoSyncTheme";
  const toggle = document.getElementById("themeToggle");
  const iconUse = document.getElementById("themeToggleIconUse");

  function getStored() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function setStored(value) {
    try {
      if (value) localStorage.setItem(THEME_KEY, value);
      else localStorage.removeItem(THEME_KEY);
    } catch (e) { /* private browsing / storage disabled — theme just won't persist */ }
  }
  function isDarkNow() {
    const stored = getStored();
    if (stored === "dark") return true;
    if (stored === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function apply() {
    const stored = getStored();
    if (stored === "dark" || stored === "light") {
      document.documentElement.setAttribute("data-theme", stored);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    // Icon shows the mode a click would switch TO, not the current one.
    iconUse.setAttribute("href", isDarkNow() ? "#icon-sun" : "#icon-moon");
  }

  toggle.addEventListener("click", () => {
    setStored(isDarkNow() ? "light" : "dark");
    apply();
  });

  apply();
})();

/* ---------------------------------------------------------------------- */
/* MP4 box parsing (client-side, no upload — reads only small slices)     */
/* ---------------------------------------------------------------------- */

const CONTAINER_TYPES = new Set([
  "moov", "trak", "mdia", "udta", "edts", "minf", "stbl", "meta", "moof", "traf", "mvex",
]);

const MP4_EPOCH_OFFSET_SECONDS = Date.UTC(1904, 0, 1) / 1000;

async function readSlice(file, start, length) {
  const blob = file.slice(start, start + length);
  return blob.arrayBuffer();
}

function readBoxHeader(dv, offset, limit) {
  if (offset + 8 > limit) return null;
  let size = dv.getUint32(offset);
  const type = String.fromCharCode(
    dv.getUint8(offset + 4), dv.getUint8(offset + 5),
    dv.getUint8(offset + 6), dv.getUint8(offset + 7)
  );
  let headerLen = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const hi = dv.getUint32(offset + 8);
    const lo = dv.getUint32(offset + 12);
    size = hi * 4294967296 + lo;
    headerLen = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerLen) return null;
  return { type, offset, size, headerLen };
}

/** Scan top-level boxes of the file until `targetType` is found. Only reads box headers. */
async function findTopLevelBox(file, targetType) {
  let offset = 0;
  const fileSize = file.size;
  while (offset < fileSize) {
    const buf = await readSlice(file, offset, 16);
    const dv = new DataView(buf);
    const box = readBoxHeader(dv, 0, buf.byteLength);
    if (!box) break;
    if (box.type === targetType) {
      return { offset: offset + box.headerLen, size: box.size - box.headerLen, boxOffset: offset };
    }
    if (box.size <= 0) break;
    offset += box.size;
  }
  return null;
}

function parseMvhd(dv, pos, headerLen) {
  let p = pos + headerLen;
  const version = dv.getUint8(p);
  p += 4; // version (1 byte) + flags (3 bytes)
  const creationTimeOffset = p; // relative to the moov buffer — kept so creation_time can be patched in place later
  const creationTimeSize = version === 1 ? 8 : 4;
  let creationTime, timescale, duration;
  if (version === 1) {
    creationTime = Number(dv.getBigUint64(p)); p += 8;
    p += 8; // modification_time
    timescale = dv.getUint32(p); p += 4;
    duration = Number(dv.getBigUint64(p)); p += 8;
  } else {
    creationTime = dv.getUint32(p); p += 4;
    p += 4; // modification_time
    timescale = dv.getUint32(p); p += 4;
    duration = dv.getUint32(p); p += 4;
  }
  const creationDate = new Date((MP4_EPOCH_OFFSET_SECONDS + creationTime) * 1000);
  return { creationDate, timescale, duration, durationSeconds: duration / timescale, creationTimeOffset, creationTimeSize };
}

function parseElstFirstOffset(dv, pos, headerLen) {
  let p = pos + headerLen;
  const version = dv.getUint8(p);
  p += 4;
  const count = dv.getUint32(p); p += 4;
  if (count === 0) return 0;
  let mediaTime;
  if (version === 1) {
    p += 8;
    mediaTime = Number(dv.getBigInt64(p));
  } else {
    p += 4;
    mediaTime = dv.getInt32(p);
  }
  return mediaTime;
}

function walkBoxes(dv, start, end, onBox) {
  let offset = start;
  while (offset < end) {
    const box = readBoxHeader(dv, offset, end);
    if (!box) break;
    onBox(box);
    offset += box.size;
  }
}

/** Parses an in-memory `moov` buffer and extracts mvhd + any non-zero edit-list offsets. */
function parseMoovBuffer(buf) {
  const dv = new DataView(buf);
  let mvhd = null;
  const editOffsets = [];

  function walkRecursive(start, end) {
    walkBoxes(dv, start, end, (box) => {
      if (box.type === "mvhd") {
        mvhd = parseMvhd(dv, box.offset, box.headerLen);
      } else if (box.type === "elst") {
        try {
          const off = parseElstFirstOffset(dv, box.offset, box.headerLen);
          if (off !== 0) editOffsets.push(off);
        } catch (e) { /* ignore malformed elst */ }
      }
      if (CONTAINER_TYPES.has(box.type)) {
        walkRecursive(box.offset + box.headerLen, box.offset + box.size);
      }
    });
  }

  walkRecursive(0, buf.byteLength);
  return { mvhd, editOffsets };
}

/** Tries to pull a YYYYMMDDHHMMSS timestamp out of a camera filename (DJI/GoPro style). */
function filenameCandidate(name) {
  const m = name.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return { year: y, month: mo, day: d, hour: h, minute: mi, second: s };
}

async function analyzeVideo(file) {
  const moovBox = await findTopLevelBox(file, "moov");
  if (!moovBox) {
    throw new Error("Box 'moov' non trovato: il file potrebbe non essere un MP4 valido o è ancora in fase di scrittura.");
  }
  const moovBuf = await readSlice(file, moovBox.offset, moovBox.size);
  const { mvhd, editOffsets } = parseMoovBuffer(moovBuf);
  if (mvhd) {
    // Absolute offset in the original file where creation_time lives, for in-place patching.
    mvhd.creationTimeFileOffset = moovBox.offset + mvhd.creationTimeOffset;
  }
  return { mvhd, editOffsets, filenameCandidate: filenameCandidate(file.name) };
}

/* ---------------------------------------------------------------------- */
/* GPX parsing / cropping                                                 */
/* ---------------------------------------------------------------------- */

const GPX_NS = "http://www.topografix.com/GPX/1/1";

function parseGpxText(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const errNode = doc.querySelector("parsererror");
  if (errNode) throw new Error("GPX non valido: " + errNode.textContent.slice(0, 200));
  return doc;
}

function getChildNS(el, ns, localName) {
  for (const child of el.children) {
    if (child.namespaceURI === ns && child.localName === localName) return child;
  }
  return null;
}

/** Collects numeric leaf fields under <extensions>, keyed by "namespaceURI|localName". */
function getLeafNumericFields(extEl) {
  const map = {};
  if (!extEl) return map;
  const walk = (el) => {
    if (el.children.length === 0) {
      const v = parseFloat(el.textContent);
      if (!Number.isNaN(v)) {
        map[`${el.namespaceURI || ""}|${el.localName}`] = v;
      }
    } else {
      for (const child of el.children) walk(child);
    }
  };
  for (const child of extEl.children) walk(child);
  return map;
}

function parseTrkpt(trkptEl) {
  const lat = parseFloat(trkptEl.getAttribute("lat"));
  const lon = parseFloat(trkptEl.getAttribute("lon"));
  const timeEl = getChildNS(trkptEl, GPX_NS, "time");
  if (!timeEl) return null;
  const time = new Date(timeEl.textContent.trim());
  if (Number.isNaN(time.getTime())) return null;
  const eleEl = getChildNS(trkptEl, GPX_NS, "ele");
  const ele = eleEl ? parseFloat(eleEl.textContent) : null;
  const extEl = getChildNS(trkptEl, GPX_NS, "extensions");
  const ext = getLeafNumericFields(extEl);
  return { el: trkptEl, lat, lon, time, ele, ext };
}

function formatIso(date) {
  return date.toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

function formatNumber(key, value) {
  const localName = key.split("|")[1];
  if (localName === "hr" || localName === "cad") {
    return String(Math.round(value));
  }
  return String(Math.round(value * 1e6) / 1e6);
}

/** Builds an interpolated <trkpt> at time `t`, cloning the extension structure of the nearer point. */
function interpolatePoint(doc, a, b, t) {
  const totalMs = b.time - a.time;
  const frac = totalMs === 0 ? 0 : (t - a.time) / totalMs;
  const lerp = (x, y) => x + (y - x) * frac;

  const trkpt = doc.createElementNS(GPX_NS, "trkpt");
  trkpt.setAttribute("lat", String(lerp(a.lat, b.lat)));
  trkpt.setAttribute("lon", String(lerp(a.lon, b.lon)));

  if (a.ele !== null && b.ele !== null) {
    const eleEl = doc.createElementNS(GPX_NS, "ele");
    eleEl.textContent = String(Math.round(lerp(a.ele, b.ele) * 100) / 100);
    trkpt.appendChild(eleEl);
  }

  const timeEl = doc.createElementNS(GPX_NS, "time");
  timeEl.textContent = formatIso(t);
  trkpt.appendChild(timeEl);

  const template = Math.abs(t - a.time) <= Math.abs(b.time - t) ? a : b;
  const templateExtEl = getChildNS(template.el, GPX_NS, "extensions");
  if (templateExtEl) {
    const clone = templateExtEl.cloneNode(true);
    const walk = (el) => {
      if (el.children.length === 0) {
        const key = `${el.namespaceURI || ""}|${el.localName}`;
        if (key in a.ext && key in b.ext) {
          el.textContent = formatNumber(key, lerp(a.ext[key], b.ext[key]));
        }
      } else {
        for (const child of el.children) walk(child);
      }
    };
    for (const child of clone.children) walk(child);
    trkpt.appendChild(clone);
  }

  return trkpt;
}

/**
 * Crops every <trkseg> in the document to [startTime, endTime], inserting an
 * interpolated boundary point wherever the window cuts through a segment's
 * own time range. Segments/tracks left empty are removed.
 */
function cropGpxDoc(doc, startTime, endTime) {
  const stats = { originalPoints: 0, croppedPoints: 0, interpolatedPoints: 0 };

  const trksegs = Array.from(doc.getElementsByTagNameNS(GPX_NS, "trkseg"));
  let firstTime = null;
  let lastTime = null;

  for (const trkseg of trksegs) {
    const trkptEls = Array.from(trkseg.getElementsByTagNameNS(GPX_NS, "trkpt"));
    const points = trkptEls.map(parseTrkpt).filter(Boolean);
    points.sort((p, q) => p.time - q.time);
    stats.originalPoints += points.length;

    if (points.length === 0 || points[points.length - 1].time < startTime || points[0].time > endTime) {
      trkseg.remove();
      continue;
    }

    const newPoints = [];

    const findBracket = (t) => {
      for (let i = 0; i < points.length - 1; i++) {
        if (points[i].time <= t && t <= points[i + 1].time) return [points[i], points[i + 1]];
      }
      return null;
    };

    if (startTime > points[0].time) {
      const bracket = findBracket(startTime);
      if (bracket) {
        newPoints.push({ node: interpolatePoint(doc, bracket[0], bracket[1], startTime), time: startTime });
        stats.interpolatedPoints++;
      }
    }

    for (const p of points) {
      if (p.time > startTime && p.time < endTime) {
        newPoints.push({ node: p.el, time: p.time });
      }
    }

    if (endTime < points[points.length - 1].time) {
      const bracket = findBracket(endTime);
      if (bracket) {
        newPoints.push({ node: interpolatePoint(doc, bracket[0], bracket[1], endTime), time: endTime });
        stats.interpolatedPoints++;
      }
    } else if (points[points.length - 1].time <= endTime && points[points.length - 1].time >= startTime) {
      // last real point already within [start, end] and equals segment end — nothing to append
    }

    if (newPoints.length === 0) {
      trkseg.remove();
      continue;
    }

    while (trkseg.firstChild) trkseg.removeChild(trkseg.firstChild);
    for (const np of newPoints) trkseg.appendChild(np.node);

    stats.croppedPoints += newPoints.length;
    const segFirst = newPoints[0].time;
    const segLast = newPoints[newPoints.length - 1].time;
    if (firstTime === null || segFirst < firstTime) firstTime = segFirst;
    if (lastTime === null || segLast > lastTime) lastTime = segLast;
  }

  // Drop now-empty <trk> elements
  for (const trk of Array.from(doc.getElementsByTagNameNS(GPX_NS, "trk"))) {
    if (trk.getElementsByTagNameNS(GPX_NS, "trkpt").length === 0) trk.remove();
  }

  const metaTime = doc.querySelector("metadata > time") ||
    (() => {
      const meta = Array.from(doc.getElementsByTagNameNS(GPX_NS, "metadata"))[0];
      return meta ? getChildNS(meta, GPX_NS, "time") : null;
    })();
  if (metaTime && firstTime) metaTime.textContent = formatIso(firstTime);

  return { stats, firstTime, lastTime };
}

function serializeGpx(doc) {
  const xml = new XMLSerializer().serializeToString(doc);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
}

/* ---------------------------------------------------------------------- */
/* CAMM track embedding (Camera Motion Metadata — same open format Google */
/* defined for Street View, natively read by Mapillary/Insta360/etc.)     */
/* Adds a GPS-only ('MIN_GPS') camm track built from the full GPX, without */
/* re-encoding or touching any existing track. Only supported when 'moov' */
/* is the last top-level box (true for typical GoPro/DJI/action-cam MP4s), */
/* since then the new mdat+moov can simply replace it at the file's tail   */
/* without shifting — and invalidating — any existing sample offset.       */
/* ---------------------------------------------------------------------- */

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : new Uint8Array(p), offset);
    offset += p.byteLength;
  }
  return out;
}

function beU16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, false); return b; }
function beU32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; }
function beU64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(Math.round(n)), false); return b; }
function leU16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function leF64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, true); return b; }
function fourcc(type) { const b = new Uint8Array(4); for (let i = 0; i < 4; i++) b[i] = type.charCodeAt(i); return b; }

/** Builds a standard 32-bit-size ISO BMFF box; big enough for everything this app writes. */
function mkBox(type, contentParts) {
  const content = concatBytes(contentParts);
  return concatBytes([beU32(8 + content.length), fourcc(type), content]);
}

/** One CAMM sample, type 5 "MIN_GPS": reserved(2) + type(2) + lat/lon/alt as little-endian float64. */
function buildCammMinGpsSample(lat, lon, ele) {
  return concatBytes([new Uint8Array(2), leU16(5), leF64(lat), leF64(lon), leF64(ele == null ? -1 : ele)]);
}

function buildCammStsd() {
  const sampleEntry = mkBox("camm", [new Uint8Array(6), beU16(1)]); // reserved(6) + data_reference_index(1)
  return mkBox("stsd", [beU32(0), beU32(1), sampleEntry]);
}

/** Run-length-compresses consecutive equal deltas, as stts requires. */
function buildCammStts(deltas) {
  const entries = [];
  for (const d of deltas) {
    if (entries.length && entries[entries.length - 1].delta === d) entries[entries.length - 1].count++;
    else entries.push({ count: 1, delta: d });
  }
  const parts = [beU32(0), beU32(entries.length)];
  for (const e of entries) parts.push(beU32(e.count), beU32(e.delta));
  return mkBox("stts", parts);
}

/** All samples are written contiguously as a single chunk. */
function buildCammStsc(sampleCount) {
  return mkBox("stsc", [beU32(0), beU32(1), beU32(1), beU32(sampleCount), beU32(1)]);
}

function buildCammStsz(sampleSize, sampleCount) {
  return mkBox("stsz", [beU32(0), beU32(sampleSize), beU32(sampleCount)]);
}

function buildCammCo64(chunkOffset) {
  return mkBox("co64", [beU32(0), beU32(1), beU64(chunkOffset)]);
}

function buildCammStbl(sampleCount, sampleSize, chunkOffset, deltas) {
  return mkBox("stbl", [
    buildCammStsd(),
    buildCammStts(deltas),
    buildCammStsc(sampleCount),
    buildCammStsz(sampleSize, sampleCount),
    buildCammCo64(chunkOffset),
  ]);
}

function buildCammDinf() {
  const urlBox = mkBox("url ", [beU32(1)]); // version 0, flags=1 ("self-contained": data is in this file)
  return mkBox("dinf", [mkBox("dref", [beU32(0), beU32(1), urlBox])]);
}

function buildCammHdlr() {
  const name = new TextEncoder().encode("CameraMetadataMotionHandler\0");
  return mkBox("hdlr", [beU32(0), beU32(0), fourcc("camm"), new Uint8Array(12), name]);
}

/** Version-1 (64-bit) mdhd; language 21956 is the packed ISO-639-2 code for "und" (undetermined). */
function buildCammMdhd(timescale, duration, creationTime, modificationTime) {
  return mkBox("mdhd", [
    beU32(0x01000000),
    beU64(creationTime), beU64(modificationTime),
    beU32(timescale), beU64(duration),
    beU16(21956), beU16(0),
  ]);
}

/** Version-0 tkhd with an identity matrix and zero width/height, matching a non-visual track. */
function buildCammTkhd(trackId, creationTime, modificationTime) {
  const parts = [
    beU32(0),
    beU32(creationTime), beU32(modificationTime),
    beU32(trackId), beU32(0),
    beU32(0xFFFFFFFF), // duration unknown/indeterminate, as recommended by the spec
    beU32(0), beU32(0),
    beU16(0), beU16(0), beU16(0), beU16(0),
  ];
  for (const v of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) parts.push(beU32(v));
  parts.push(beU32(0), beU32(0)); // width, height
  return mkBox("tkhd", parts);
}

function buildCammTrak({ trackId, mediaTimescale, sampleCount, sampleSize, chunkOffset, deltas, creationTime, modificationTime }) {
  const mediaDuration = deltas.reduce((a, b) => a + b, 0);
  const tkhd = buildCammTkhd(trackId, creationTime, modificationTime);
  const mdhd = buildCammMdhd(mediaTimescale, mediaDuration, creationTime, modificationTime);
  const hdlr = buildCammHdlr();
  const minf = mkBox("minf", [buildCammDinf(), buildCammStbl(sampleCount, sampleSize, chunkOffset, deltas)]);
  return mkBox("trak", [tkhd, mkBox("mdia", [mdhd, hdlr, minf])]);
}

/** Scans a moov buffer for the highest existing track_ID, so the new camm track gets an unused one. */
function findMaxTrackId(moovBuf) {
  const dv = new DataView(moovBuf);
  let maxId = 0;
  function walk(start, end) {
    walkBoxes(dv, start, end, (box) => {
      if (box.type === "tkhd") {
        let p = box.offset + box.headerLen;
        const version = dv.getUint8(p);
        p += 4 + (version === 1 ? 16 : 8);
        maxId = Math.max(maxId, dv.getUint32(p));
      }
      if (CONTAINER_TYPES.has(box.type)) walk(box.offset + box.headerLen, box.offset + box.size);
    });
  }
  walk(0, moovBuf.byteLength);
  return maxId;
}

/**
 * Builds {t (seconds from windowStart), lat, lon, ele} samples covering [windowStart, windowEnd],
 * boundary-interpolated exactly like cropGpxDoc — so the embedded track and a cropped-GPX export
 * always agree on what the video's "position at time t" is.
 */
function buildCammSamplesFromGpx(points, windowStart, windowEnd) {
  if (points.length === 0) return [];

  const findBracket = (t) => {
    for (let i = 0; i < points.length - 1; i++) {
      if (points[i].time <= t && t <= points[i + 1].time) return [points[i], points[i + 1]];
    }
    return null;
  };
  const lerp = (a, b, t) => {
    const totalMs = b.time - a.time;
    const frac = totalMs === 0 ? 0 : (t - a.time) / totalMs;
    return {
      time: t,
      lat: a.lat + (b.lat - a.lat) * frac,
      lon: a.lon + (b.lon - a.lon) * frac,
      ele: a.ele != null && b.ele != null ? a.ele + (b.ele - a.ele) * frac : null,
    };
  };

  const raw = [];
  if (windowStart <= points[0].time) {
    raw.push(points[0]);
  } else {
    const bracket = findBracket(windowStart);
    if (bracket) raw.push(lerp(bracket[0], bracket[1], windowStart));
  }
  for (const p of points) {
    if (p.time > windowStart && p.time < windowEnd) raw.push(p);
  }
  if (windowEnd >= points[points.length - 1].time) {
    raw.push(points[points.length - 1]);
  } else {
    const bracket = findBracket(windowEnd);
    if (bracket) raw.push(lerp(bracket[0], bracket[1], windowEnd));
  }

  const startMs = windowStart.getTime();
  const samples = [];
  for (const p of raw) {
    const t = (p.time.getTime() - startMs) / 1000;
    if (samples.length && t <= samples[samples.length - 1].t) continue; // dedupe/monotonic guard
    samples.push({ t, lat: p.lat, lon: p.lon, ele: p.ele });
  }
  return samples;
}

/** Assembles the final MP4 Blob: original bytes up to 'moov' unchanged, then the new camm mdat, then the enlarged moov. */
function buildCammEmbedBlob(file, moovBox, moovBufOriginal, movieTimescale, maxTrackId, samples) {
  if (moovBox.offset + moovBox.size !== file.size) {
    throw new Error(
      "Il box 'moov' (l'indice del file: tracce e posizione di ogni campione audio/video) non è l'ultimo blocco del file, " +
      "ma precede i dati audio/video veri e propri (layout 'faststart'/web-optimized, tipico di video passati per un editor " +
      "o esportati per lo streaming). Per aggiungere la traccia GPS senza ricodificare, questo strumento può solo accodare " +
      "dati in fondo al file — operazione sicura solo se 'moov' è già l'ultimo blocco, perché altrimenti farlo crescere " +
      "sposterebbe i dati audio/video esistenti invalidandone gli offset e corromperebbe il video. " +
      "Puoi: 1) ri-muxare il file per spostare 'moov' in fondo, es. con `ffmpeg -i input.mp4 -c copy output.mp4` " +
      "(senza -movflags faststart) e ritentare su quel file; oppure 2) usare 'Correggi orario video' + GPX intero, " +
      "che non richiede questo layout."
    );
  }

  const mediaTimescale = Math.max(1000, movieTimescale);
  const deltas = samples.map((s, i) =>
    i + 1 < samples.length ? Math.round((samples[i + 1].t - s.t) * mediaTimescale) : 0
  );
  const sampleBytesList = samples.map((s) => buildCammMinGpsSample(s.lat, s.lon, s.ele));
  const sampleSize = sampleBytesList[0].length; // always 28 bytes (fixed-size MIN_GPS payload)
  const mdatContent = concatBytes(sampleBytesList);

  const camMdatStart = moovBox.boxOffset; // replaces the original moov box, which starts right after the unchanged prefix
  const camMdatDataStart = camMdatStart + 8;

  const trak = buildCammTrak({
    trackId: maxTrackId + 1,
    mediaTimescale,
    sampleCount: samples.length,
    sampleSize,
    chunkOffset: camMdatDataStart,
    deltas,
    creationTime: 0,
    modificationTime: 0,
  });

  const newMdatBox = mkBox("mdat", [mdatContent]);
  const newMoovBox = mkBox("moov", [moovBufOriginal, trak]);
  const prefix = file.slice(0, moovBox.boxOffset);

  return new Blob([prefix, newMdatBox, newMoovBox], { type: file.type || "video/mp4" });
}

/* ---------------------------------------------------------------------- */
/* Position lookup (used by the map's live marker while the video plays)  */
/* ---------------------------------------------------------------------- */

/** Index i such that points[i].time <= t <= points[i+1].time, clamped to the array's range. */
function findBracketIndex(points, t) {
  if (t <= points[0].time) return 0;
  if (t >= points[points.length - 1].time) return points.length - 2;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= t) lo = mid; else hi = mid;
  }
  return lo;
}

/** Linearly interpolated {lat, lon} at time `t`, clamped to the track's own time range. */
function positionAtTime(points, t) {
  if (!points || points.length === 0) return null;
  if (points.length === 1) return { lat: points[0].lat, lon: points[0].lon };
  const i = findBracketIndex(points, t);
  const a = points[i], b = points[i + 1];
  const totalMs = b.time - a.time;
  const frac = totalMs === 0 ? 0 : Math.max(0, Math.min(1, (t - a.time) / totalMs));
  return { lat: a.lat + (b.lat - a.lat) * frac, lon: a.lon + (b.lon - a.lon) * frac };
}

/* ---------------------------------------------------------------------- */
/* Duration parsing (accepts seconds, mm:ss, hh:mm:ss)                    */
/* ---------------------------------------------------------------------- */

function parseDurationSeconds(str) {
  str = str.trim();
  if (!str) return NaN;
  if (!str.includes(":")) return parseFloat(str);
  const parts = str.split(":").map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

/* ---------------------------------------------------------------------- */
/* UI wiring                                                              */
/* ---------------------------------------------------------------------- */

const videoInput = document.getElementById("videoInput");
const videoFileName = document.getElementById("videoFileName");
const videoStatus = document.getElementById("videoStatus");
const videoPreview = document.getElementById("videoPreview");
const startInput = document.getElementById("startInput");
const durationInput = document.getElementById("durationInput");
const offsetInput = document.getElementById("offsetInput");
const filenameCandidateEl = document.getElementById("filenameCandidate");
const offsetHintEl = document.getElementById("offsetHint");
const playbackRateSelect = document.getElementById("playbackRateSelect");

const gpxInput = document.getElementById("gpxInput");
const gpxFileName = document.getElementById("gpxFileName");
const gpxStatus = document.getElementById("gpxStatus");

const previewSection = document.getElementById("step-preview");

const cropBtn = document.getElementById("cropBtn");
const cropStatus = document.getElementById("cropStatus");
const downloadBtn = document.getElementById("downloadBtn");
const fixVideoBtn = document.getElementById("fixVideoBtn");
const fixVideoStatus = document.getElementById("fixVideoStatus");
const fixVideoDownloadBtn = document.getElementById("fixVideoDownloadBtn");
const embedBtn = document.getElementById("embedBtn");
const embedStatus = document.getElementById("embedStatus");
const embedDownloadBtn = document.getElementById("embedDownloadBtn");
const timelineEl = document.getElementById("timeline");
const timelineWindowEl = document.getElementById("timelineWindow");
const timelineFullStart = document.getElementById("timelineFullStart");
const timelineFullEnd = document.getElementById("timelineFullEnd");

let gpxDocText = null; // raw text, re-parsed fresh on each crop so repeated crops don't compound mutations
let gpxPointsRange = null; // {first: Date, last: Date}
let gpxAllPoints = null; // sorted [{time, lat, lon, ...}] across the whole GPX, used by the map
let currentVideoFile = null;
let currentVideoObjectUrl = null;
let currentVideoMvhd = null; // {creationDate, timescale, duration, durationSeconds, creationTimeFileOffset, creationTimeSize}, or null if unreadable

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function updateCropButtonState() {
  cropBtn.disabled = !(gpxDocText && startInput.value.trim() && durationInput.value.trim());
}

function updateFixVideoButtonState() {
  fixVideoBtn.disabled = !(
    currentVideoFile &&
    currentVideoMvhd &&
    currentVideoMvhd.creationTimeFileOffset != null &&
    getCorrectedVideoStart()
  );
}

function updateEmbedButtonState() {
  embedBtn.disabled = !(
    currentVideoFile &&
    currentVideoMvhd &&
    currentVideoMvhd.creationTimeFileOffset != null &&
    gpxAllPoints &&
    getWindowFromInputs()
  );
}

/** Formats a signed duration in seconds as e.g. "-2 min 15.0 s" or "1 h 3 min 2.5 s". */
function formatDurationHuman(totalSeconds) {
  const sign = totalSeconds < 0 ? "-" : "";
  let s = Math.abs(totalSeconds);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (h) parts.push(`${h} h`);
  if (h || m) parts.push(`${m} min`);
  parts.push(`${s.toFixed(1)} s`);
  return sign + parts.join(" ");
}

/** Live readout of the offset field: how big the video/GPX misalignment is, and the resulting corrected video start. */
function updateOffsetHint() {
  const offsetSeconds = parseFloat(offsetInput.value) || 0;
  let text = `Disallineamento video/GPX: ${formatDurationHuman(offsetSeconds)}`;
  const correctedStart = getCorrectedVideoStart();
  if (correctedStart) {
    text += ` — inizio video corretto: ${formatIso(correctedStart)}`;
  }
  offsetHintEl.textContent = text;
}

/** Reads start+offset from the form; returns the offset-corrected start Date, or null if incomplete/invalid. */
function getCorrectedVideoStart() {
  const startTime = new Date(startInput.value.trim());
  if (Number.isNaN(startTime.getTime())) return null;
  const offsetSeconds = parseFloat(offsetInput.value) || 0;
  return new Date(startTime.getTime() + offsetSeconds * 1000);
}

/** Reads start/duration/offset from the form; returns {start, end} Dates, or null if incomplete/invalid. */
function getWindowFromInputs() {
  const start = getCorrectedVideoStart();
  if (!start) return null;
  const durationSeconds = parseDurationSeconds(durationInput.value);
  if (Number.isNaN(durationSeconds) || durationSeconds <= 0) return null;
  const end = new Date(start.getTime() + durationSeconds * 1000);
  return { start, end };
}

/** Redraws the full-span/current-window bar right below the preview, live as inputs change. */
function updateTimelineBar() {
  if (!gpxPointsRange) { timelineEl.hidden = true; return; }
  const win = getWindowFromInputs();
  if (!win) { timelineEl.hidden = true; return; }

  const fullSpan = gpxPointsRange.last - gpxPointsRange.first;
  const winStartPct = Math.max(0, Math.min(100, ((win.start - gpxPointsRange.first) / fullSpan) * 100));
  const winEndPct = Math.max(0, Math.min(100, ((win.end - gpxPointsRange.first) / fullSpan) * 100));
  timelineWindowEl.style.left = winStartPct + "%";
  timelineWindowEl.style.width = Math.max(0.5, winEndPct - winStartPct) + "%";
  timelineFullStart.textContent = formatIso(gpxPointsRange.first);
  timelineFullEnd.textContent = formatIso(gpxPointsRange.last);
  timelineEl.hidden = false;
}

/* ---- Map (Leaflet + OpenStreetMap tiles; degrades quietly if unavailable) ---- */

const mapAvailable = typeof L !== "undefined";
let map = null;
let fullPolyline = null;
let windowPolyline = null;
let startMarker = null;
let endMarker = null;
let liveMarker = null;

function ensureMap() {
  if (!mapAvailable || map) return;
  map = L.map("map");

  const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS user community",
    }
  );

  // Dedicated pane between the base tiles (z 200) and our track/marker overlay (z 400),
  // so place-name labels sit on top of the imagery but under the GPX track and markers.
  map.createPane("satelliteLabelsPane");
  map.getPane("satelliteLabelsPane").style.zIndex = 350;
  map.getPane("satelliteLabelsPane").style.pointerEvents = "none";

  const satelliteLabels = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, pane: "satelliteLabelsPane" }
  );
  const satelliteWithLabels = L.layerGroup([satelliteLayer, satelliteLabels]);

  L.control.layers(
    { "Mappa": streetLayer, "Satellite": satelliteWithLabels },
    {},
    { position: "topright" }
  ).addTo(map);
}

function downsample(points, maxCount) {
  if (points.length <= maxCount) return points;
  const step = points.length / maxCount;
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[Math.floor(i)]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function renderFullTrack(points) {
  previewSection.hidden = false; // shared with the video player, so show it even if the map itself can't load
  if (!mapAvailable) return;
  ensureMap();
  setTimeout(() => map.invalidateSize(), 0); // container was `hidden`, Leaflet needs a visible box to size itself

  const latlngs = downsample(points, 3000).map((p) => [p.lat, p.lon]);
  if (fullPolyline) map.removeLayer(fullPolyline);
  fullPolyline = L.polyline(latlngs, { color: "#9a9aa2", weight: 3, opacity: 0.8 }).addTo(map);
  map.fitBounds(fullPolyline.getBounds(), { padding: [20, 20] });
}

/** Redraws the accent-colored sub-track for the current start/duration/offset window. */
function updateWindowHighlight() {
  if (!mapAvailable || !map || !gpxAllPoints) return;

  if (windowPolyline) { map.removeLayer(windowPolyline); windowPolyline = null; }
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }

  const win = getWindowFromInputs();
  if (!win) return;

  const within = gpxAllPoints.filter((p) => p.time >= win.start && p.time <= win.end);
  const startPos = positionAtTime(gpxAllPoints, win.start);
  const endPos = positionAtTime(gpxAllPoints, win.end);

  const latlngs = [];
  if (startPos) latlngs.push([startPos.lat, startPos.lon]);
  for (const p of within) latlngs.push([p.lat, p.lon]);
  if (endPos) latlngs.push([endPos.lat, endPos.lon]);
  if (latlngs.length < 2) return;

  windowPolyline = L.polyline(latlngs, { color: "#2563eb", weight: 4 }).addTo(map);
  if (startPos) {
    startMarker = L.circleMarker([startPos.lat, startPos.lon], {
      radius: 6, color: "#15803d", fillColor: "#15803d", fillOpacity: 1,
    }).addTo(map).bindTooltip("Inizio");
  }
  if (endPos) {
    endMarker = L.circleMarker([endPos.lat, endPos.lon], {
      radius: 6, color: "#b91c1c", fillColor: "#b91c1c", fillOpacity: 1,
    }).addTo(map).bindTooltip("Fine");
  }
}

function updateLiveMarker(pos) {
  if (!mapAvailable || !map || !pos) return;
  if (!liveMarker) {
    liveMarker = L.marker([pos.lat, pos.lon], {
      icon: L.divIcon({ className: "map-marker", iconSize: [14, 14] }),
    }).addTo(map);
  } else {
    liveMarker.setLatLng([pos.lat, pos.lon]);
  }
}

/** Recomputes the live marker from the video's current playback position (even while paused) — used both by 'timeupdate' and whenever start/duration/offset change, so nudging the offset while paused on a frame moves the marker immediately. */
function syncLiveMarkerFromVideo() {
  if (!gpxAllPoints || videoPreview.hidden) return;
  const win = getWindowFromInputs();
  if (!win) return;
  const t = new Date(win.start.getTime() + videoPreview.currentTime * 1000);
  updateLiveMarker(positionAtTime(gpxAllPoints, t));
}

videoPreview.addEventListener("timeupdate", syncLiveMarkerFromVideo);

playbackRateSelect.addEventListener("change", () => {
  videoPreview.playbackRate = parseFloat(playbackRateSelect.value) || 1;
});

videoInput.addEventListener("change", async () => {
  const file = videoInput.files[0];
  if (!file) return;
  currentVideoFile = file;
  currentVideoMvhd = null;
  videoFileName.textContent = file.name;
  setStatus(videoStatus, "Lettura dei metadati MP4 in corso…");
  filenameCandidateEl.textContent = "";
  downloadBtn.hidden = true;
  fixVideoDownloadBtn.hidden = true;
  setStatus(fixVideoStatus, "", "");
  embedDownloadBtn.hidden = true;
  setStatus(embedStatus, "", "");

  if (currentVideoObjectUrl) URL.revokeObjectURL(currentVideoObjectUrl);
  currentVideoObjectUrl = URL.createObjectURL(file);
  videoPreview.src = currentVideoObjectUrl;
  videoPreview.playbackRate = parseFloat(playbackRateSelect.value) || 1;
  videoPreview.hidden = false;
  previewSection.hidden = false;

  try {
    const result = await analyzeVideo(file);
    currentVideoMvhd = result.mvhd;
    let msg = "";
    if (result.mvhd) {
      startInput.value = formatIso(result.mvhd.creationDate);
      durationInput.value = result.mvhd.durationSeconds.toFixed(3);
      msg = `Rilevato dal container MP4: inizio ${formatIso(result.mvhd.creationDate)}, durata ${result.mvhd.durationSeconds.toFixed(3)} s.`;
      if (result.editOffsets.length) {
        msg += `\nAttenzione: trovate edit-list con offset non nullo (${result.editOffsets.join(", ")} unità) — l'inizio effettivo potrebbe differire leggermente.`;
      }
      setStatus(videoStatus, msg, "ok");
    } else {
      // Fall back to the browser's own decoder for the duration, since our mvhd parser found nothing.
      videoPreview.addEventListener("loadedmetadata", () => {
        if (!durationInput.value.trim() && Number.isFinite(videoPreview.duration)) {
          durationInput.value = videoPreview.duration.toFixed(3);
          setStatus(videoStatus, `mvhd non leggibile: durata (${videoPreview.duration.toFixed(3)} s) presa dal player. Inserisci l'inizio manualmente.`, "warn");
          updateCropButtonState();
          updateEmbedButtonState();
          updateWindowHighlight();
          updateTimelineBar();
        }
      }, { once: true });
      setStatus(videoStatus, "Impossibile leggere mvhd. Inserisci inizio e durata manualmente.", "warn");
    }

    if (result.filenameCandidate) {
      const c = result.filenameCandidate;
      const pad = (n) => String(n).padStart(2, "0");
      const localStr = `${c.year}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}`;
      filenameCandidateEl.innerHTML = `Nome file suggerisce (ora locale della camera): <strong>${localStr}</strong> — ` +
        `se il fuso non è UTC, converti manualmente e correggi il campo "Inizio video" sopra.`;
    }
  } catch (e) {
    setStatus(videoStatus, "Errore: " + e.message, "error");
  }
  updateCropButtonState();
  updateFixVideoButtonState();
  updateEmbedButtonState();
  updateWindowHighlight();
  updateTimelineBar();
  updateOffsetHint();
  syncLiveMarkerFromVideo();
});

gpxInput.addEventListener("change", async () => {
  const file = gpxInput.files[0];
  if (!file) return;
  gpxFileName.textContent = file.name;
  setStatus(gpxStatus, "Lettura del GPX in corso…");
  downloadBtn.hidden = true;
  embedDownloadBtn.hidden = true;
  setStatus(embedStatus, "", "");

  try {
    const text = await file.text();
    const doc = parseGpxText(text);
    const points = Array.from(doc.getElementsByTagNameNS(GPX_NS, "trkpt"))
      .map(parseTrkpt)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    if (points.length === 0) throw new Error("Nessun trackpoint con timestamp trovato nel file.");

    gpxDocText = text;
    gpxAllPoints = points;
    gpxPointsRange = { first: points[0].time, last: points[points.length - 1].time };

    setStatus(
      gpxStatus,
      `${points.length} trackpoint, dal ${formatIso(gpxPointsRange.first)} al ${formatIso(gpxPointsRange.last)}.`,
      "ok"
    );

    renderFullTrack(gpxAllPoints);
    updateWindowHighlight();
    updateTimelineBar();
    syncLiveMarkerFromVideo();
  } catch (e) {
    gpxDocText = null;
    gpxAllPoints = null;
    gpxPointsRange = null;
    timelineEl.hidden = true;
    setStatus(gpxStatus, "Errore: " + e.message, "error");
  }
  updateCropButtonState();
  updateEmbedButtonState();
});

[startInput, durationInput, offsetInput].forEach((el) => el.addEventListener("input", () => {
  updateCropButtonState();
  updateFixVideoButtonState();
  updateEmbedButtonState();
  updateWindowHighlight();
  updateTimelineBar();
  updateOffsetHint();
  syncLiveMarkerFromVideo();
}));

updateOffsetHint();

cropBtn.addEventListener("click", () => {
  downloadBtn.hidden = true;

  const win = getWindowFromInputs();
  if (!win) {
    setStatus(cropStatus, "Inizio video e/o durata non validi: inizio in formato ISO 8601 (es. 2026-09-05T10:30:14.000Z), durata in secondi.", "error");
    return;
  }
  const { start: windowStart, end: windowEnd } = win;

  if (gpxPointsRange && (windowStart < gpxPointsRange.first || windowEnd > gpxPointsRange.last)) {
    setStatus(
      cropStatus,
      `Attenzione: la finestra video (${formatIso(windowStart)} → ${formatIso(windowEnd)}) esce dall'intervallo coperto dal GPX ` +
      `(${formatIso(gpxPointsRange.first)} → ${formatIso(gpxPointsRange.last)}). Procedo comunque, ma il ritaglio potrebbe risultare incompleto.`,
      "warn"
    );
  }

  try {
    const doc = parseGpxText(gpxDocText);
    const { stats, firstTime, lastTime } = cropGpxDoc(doc, windowStart, windowEnd);

    if (stats.croppedPoints === 0) {
      setStatus(cropStatus, "Nessun punto trovato nella finestra indicata: controlla inizio/durata/offset.", "error");
      return;
    }

    const xmlText = serializeGpx(doc);
    const blob = new Blob([xmlText], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);

    const baseName = currentVideoFile ? currentVideoFile.name.replace(/\.[^.]+$/, "") : "video";
    downloadBtn.href = url;
    downloadBtn.download = `${baseName}_track.gpx`;
    downloadBtn.hidden = false;

    const actualDuration = (lastTime - firstTime) / 1000;
    setStatus(
      cropStatus,
      `${stats.croppedPoints} punti nel ritaglio (di cui ${stats.interpolatedPoints} interpolati ai bordi), ` +
      `da ${formatIso(firstTime)} a ${formatIso(lastTime)} — durata ${actualDuration.toFixed(3)} s.`,
      "ok"
    );
  } catch (e) {
    setStatus(cropStatus, "Errore durante il ritaglio: " + e.message, "error");
  }
});

/**
 * Patches the video's own MP4 `creation_time` (in the mvhd box) to the offset-corrected
 * start time, in place, without re-encoding or touching the GPX. Since the field's byte
 * width doesn't change, every other offset in the file (stco/co64 sample tables included)
 * stays valid.
 */
fixVideoBtn.addEventListener("click", () => {
  fixVideoDownloadBtn.hidden = true;

  const correctedStart = getCorrectedVideoStart();
  if (!correctedStart) {
    setStatus(fixVideoStatus, "Inizio video non valido: usa formato ISO 8601 (es. 2026-09-05T10:30:14.000Z).", "error");
    return;
  }
  if (!currentVideoFile || !currentVideoMvhd || currentVideoMvhd.creationTimeFileOffset == null) {
    setStatus(fixVideoStatus, "Metadati mvhd non disponibili per questo video: impossibile correggere l'orario senza ricodificarlo.", "error");
    return;
  }

  const { creationTimeFileOffset: offset, creationTimeSize: size } = currentVideoMvhd;
  const rawValue = Math.round(correctedStart.getTime() / 1000 - MP4_EPOCH_OFFSET_SECONDS);

  if (rawValue < 0 || (size === 4 && rawValue > 0xFFFFFFFF)) {
    setStatus(fixVideoStatus, "Data fuori dall'intervallo rappresentabile nei metadati MP4 di questo file.", "error");
    return;
  }

  const patchBuf = new ArrayBuffer(size);
  const patchDv = new DataView(patchBuf);
  if (size === 8) {
    patchDv.setBigUint64(0, BigInt(rawValue), false);
  } else {
    patchDv.setUint32(0, rawValue, false);
  }

  const file = currentVideoFile;
  const patchedBlob = new Blob(
    [file.slice(0, offset), patchBuf, file.slice(offset + size, file.size)],
    { type: file.type || "video/mp4" }
  );

  const url = URL.createObjectURL(patchedBlob);
  const baseName = file.name.replace(/\.[^.]+$/, "");
  fixVideoDownloadBtn.href = url;
  fixVideoDownloadBtn.download = `${baseName}_synced.mp4`;
  fixVideoDownloadBtn.hidden = false;

  setStatus(
    fixVideoStatus,
    `Creation time del video corretto a ${formatIso(correctedStart)} (arrotondato al secondo, come richiesto dal formato MP4). ` +
    `Il file GPX resta intero e non modificato.`,
    "ok"
  );
});

/**
 * Adds a CAMM ('camm') GPS track to the video, built from the full GPX over the current
 * start/duration/offset window, without re-encoding video/audio and without touching the
 * GPX. Only works when 'moov' is the file's last top-level box (see buildCammEmbedBlob).
 */
embedBtn.addEventListener("click", async () => {
  embedDownloadBtn.hidden = true;

  const win = getWindowFromInputs();
  if (!win) {
    setStatus(embedStatus, "Inizio video e/o durata non validi: inizio in formato ISO 8601 (es. 2026-09-05T10:30:14.000Z), durata in secondi.", "error");
    return;
  }
  if (!currentVideoFile || !currentVideoMvhd || currentVideoMvhd.creationTimeFileOffset == null) {
    setStatus(embedStatus, "Metadati mvhd non disponibili per questo video: impossibile incorporare la traccia GPS.", "error");
    return;
  }
  if (!gpxAllPoints) {
    setStatus(embedStatus, "Carica prima un file GPX.", "error");
    return;
  }

  setStatus(embedStatus, "Costruzione della traccia CAMM in corso…");

  try {
    const samples = buildCammSamplesFromGpx(gpxAllPoints, win.start, win.end);
    if (samples.length < 2) {
      setStatus(embedStatus, "Nessun punto GPX trovato nella finestra del video: controlla inizio/durata/offset.", "error");
      return;
    }

    const file = currentVideoFile;
    const moovBox = await findTopLevelBox(file, "moov");
    if (!moovBox) throw new Error("Box 'moov' non trovato.");
    const moovBufOriginal = await readSlice(file, moovBox.offset, moovBox.size);
    const maxTrackId = findMaxTrackId(moovBufOriginal);

    const blob = buildCammEmbedBlob(file, moovBox, moovBufOriginal, currentVideoMvhd.timescale, maxTrackId, samples);

    const url = URL.createObjectURL(blob);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    embedDownloadBtn.href = url;
    embedDownloadBtn.download = `${baseName}_camm.mp4`;
    embedDownloadBtn.hidden = false;

    setStatus(
      embedStatus,
      `Traccia CAMM aggiunta con ${samples.length} punti GPS (da ${formatIso(win.start)} a ${formatIso(win.end)}). ` +
      `Video e audio originali non sono stati ricodificati, e il file GPX resta intero e non modificato.`,
      "ok"
    );
  } catch (e) {
    setStatus(embedStatus, "Errore: " + e.message, "error");
  }
});
