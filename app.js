"use strict";

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
  return { creationDate, timescale, duration, durationSeconds: duration / timescale };
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

const gpxInput = document.getElementById("gpxInput");
const gpxFileName = document.getElementById("gpxFileName");
const gpxStatus = document.getElementById("gpxStatus");

const mapSection = document.getElementById("step-map");

const cropBtn = document.getElementById("cropBtn");
const cropStatus = document.getElementById("cropStatus");
const downloadBtn = document.getElementById("downloadBtn");
const timelineEl = document.getElementById("timeline");
const timelineWindowEl = document.getElementById("timelineWindow");
const timelineFullStart = document.getElementById("timelineFullStart");
const timelineFullEnd = document.getElementById("timelineFullEnd");

let gpxDocText = null; // raw text, re-parsed fresh on each crop so repeated crops don't compound mutations
let gpxPointsRange = null; // {first: Date, last: Date}
let gpxAllPoints = null; // sorted [{time, lat, lon, ...}] across the whole GPX, used by the map
let currentVideoFile = null;
let currentVideoObjectUrl = null;

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function updateCropButtonState() {
  cropBtn.disabled = !(gpxDocText && startInput.value.trim() && durationInput.value.trim());
}

/** Reads start/duration/offset from the form; returns {start, end} Dates, or null if incomplete/invalid. */
function getWindowFromInputs() {
  const startTime = new Date(startInput.value.trim());
  if (Number.isNaN(startTime.getTime())) return null;
  const durationSeconds = parseDurationSeconds(durationInput.value);
  if (Number.isNaN(durationSeconds) || durationSeconds <= 0) return null;
  const offsetSeconds = parseFloat(offsetInput.value) || 0;
  const start = new Date(startTime.getTime() + offsetSeconds * 1000);
  const end = new Date(start.getTime() + durationSeconds * 1000);
  return { start, end };
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
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
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
  if (!mapAvailable) return;
  ensureMap();
  mapSection.hidden = false;
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

videoInput.addEventListener("change", async () => {
  const file = videoInput.files[0];
  if (!file) return;
  currentVideoFile = file;
  videoFileName.textContent = file.name;
  setStatus(videoStatus, "Lettura dei metadati MP4 in corso…");
  filenameCandidateEl.textContent = "";
  downloadBtn.hidden = true;
  timelineEl.hidden = true;

  if (currentVideoObjectUrl) URL.revokeObjectURL(currentVideoObjectUrl);
  currentVideoObjectUrl = URL.createObjectURL(file);
  videoPreview.src = currentVideoObjectUrl;
  videoPreview.hidden = false;

  try {
    const result = await analyzeVideo(file);
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
          updateWindowHighlight();
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
  updateWindowHighlight();
  syncLiveMarkerFromVideo();
});

gpxInput.addEventListener("change", async () => {
  const file = gpxInput.files[0];
  if (!file) return;
  gpxFileName.textContent = file.name;
  setStatus(gpxStatus, "Lettura del GPX in corso…");
  downloadBtn.hidden = true;
  timelineEl.hidden = true;

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
    syncLiveMarkerFromVideo();
  } catch (e) {
    gpxDocText = null;
    gpxAllPoints = null;
    gpxPointsRange = null;
    setStatus(gpxStatus, "Errore: " + e.message, "error");
  }
  updateCropButtonState();
});

[startInput, durationInput, offsetInput].forEach((el) => el.addEventListener("input", () => {
  updateCropButtonState();
  updateWindowHighlight();
  syncLiveMarkerFromVideo();
}));

cropBtn.addEventListener("click", () => {
  downloadBtn.hidden = true;
  timelineEl.hidden = true;

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

    if (gpxPointsRange) {
      const fullSpan = gpxPointsRange.last - gpxPointsRange.first;
      const winStartPct = Math.max(0, Math.min(100, ((windowStart - gpxPointsRange.first) / fullSpan) * 100));
      const winEndPct = Math.max(0, Math.min(100, ((windowEnd - gpxPointsRange.first) / fullSpan) * 100));
      timelineWindowEl.style.left = winStartPct + "%";
      timelineWindowEl.style.width = Math.max(0.5, winEndPct - winStartPct) + "%";
      timelineFullStart.textContent = formatIso(gpxPointsRange.first);
      timelineFullEnd.textContent = formatIso(gpxPointsRange.last);
      timelineEl.hidden = false;
    }
  } catch (e) {
    setStatus(cropStatus, "Errore durante il ritaglio: " + e.message, "error");
  }
});
