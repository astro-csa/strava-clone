/* ═══════════════════════════════════════
   TRAILRUN PWA — app.js
   Stack: Vanilla JS + Leaflet + IndexedDB
═══════════════════════════════════════ */

'use strict';

// ─── ESTADO GLOBAL ───────────────────────────────────────────────────────────
const State = {
  // Sesión activa
  session: {
    active: false,
    paused: false,
    points: [],          // [{lat, lon, alt, ts, acc}]
    startTime: null,
    pausedMs: 0,         // ms acumulados en pausa
    pauseStart: null,
    watchId: null,
    timerInterval: null,
    distance: 0,         // km
    elevGain: 0,         // m
    elevLoss: 0,         // m
    lastAlt: null,
  },
  // Datos de la ruta actual (post-sesión, pre-guardado)
  currentRun: null,
  // Ruta abierta en el modal
  modalRun: null,
  // Ruta cargada en vista 3D
  activeRun3D: null,
};

// ─── BASE DE DATOS (IndexedDB) ────────────────────────────────────────────────
const DB = (() => {
  const DB_NAME    = 'TrailRunDB';
  const DB_VERSION = 1;
  const STORE      = 'runs';
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const s = d.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('date', 'date', { unique: false });
        }
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function save(run) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(run).onsuccess = () => resolve(run);
      tx.onerror = e => reject(e.target.error);
    });
  }

  function getAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).index('date').getAll();
      req.onsuccess = e => resolve(e.target.result.reverse());
      req.onerror   = e => reject(e.target.error);
    });
  }

  function get(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function del(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id).onsuccess = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  return { open, save, getAll, get, del };
})();

// ─── CÁLCULOS GEOGRÁFICOS ─────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function formatPace(kmPerH) {
  if (!kmPerH || kmPerH <= 0) return '--:--';
  const minPerKm = 60 / kmPerH;
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long'
  });
}

function formatDateShort(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('es-ES', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function computeStats(points) {
  let distance = 0, elevGain = 0, elevLoss = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversine(
      points[i-1].lat, points[i-1].lon,
      points[i].lat,   points[i].lon
    );
    if (points[i].alt != null && points[i-1].alt != null) {
      const diff = points[i].alt - points[i-1].alt;
      if (diff > 0) elevGain += diff;
      else          elevLoss += Math.abs(diff);
    }
  }
  return { distance, elevGain: Math.round(elevGain), elevLoss: Math.round(elevLoss) };
}

// ─── EXPORTACIÓN GPX ─────────────────────────────────────────────────────────
function buildGPX(run) {
  const pts = run.points.map(p => {
    const ts = new Date(p.ts).toISOString();
    const alt = p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : '';
    return `    <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${alt}<time>${ts}</time></trkpt>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailRun PWA"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${formatDate(run.date)}</name>
    <time>${new Date(run.date).toISOString()}</time>
  </metadata>
  <trk>
    <name>${formatDate(run.date)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}

function downloadGPX(run) {
  const gpx  = buildGPX(run);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const name = `trailrun_${new Date(run.date).toISOString().split('T')[0]}.gpx`;
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  showToast('GPX exportado ✓');
}

// ─── IMPORTACIÓN GPX ─────────────────────────────────────────────────────────
// Permite cargar un .gpx grabado en otro dispositivo (ej. móvil) para
// probarlo en desktop, sin depender del GPS del navegador local.
function parseGPX(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');

  const parseError = xml.querySelector('parsererror');
  if (parseError) throw new Error('El archivo GPX no es XML válido');

  const trkpts = Array.from(xml.querySelectorAll('trkpt'));
  if (trkpts.length === 0) throw new Error('El GPX no contiene puntos de track (<trkpt>)');

  const points = trkpts.map(pt => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const eleEl = pt.querySelector('ele');
    const timeEl = pt.querySelector('time');
    const alt = eleEl ? parseFloat(eleEl.textContent) : null;
    const ts  = timeEl ? new Date(timeEl.textContent).getTime() : Date.now();
    return { lat, lon, alt, ts, acc: 0 };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (points.length < 2) {
    throw new Error(`Solo ${points.length} punto(s) válido(s) tras parsear — insuficiente`);
  }

  const nameEl = xml.querySelector('metadata > name, trk > name');
  const { distance, elevGain, elevLoss } = computeStats(points);
  const durationMs = points[points.length - 1].ts - points[0].ts;
  const speed = distance / (durationMs / 3600000 || 1);

  return {
    id:        `run_imported_${Date.now()}`,
    date:      points[0].ts,
    points,
    durationMs,
    distance,
    elevGain,
    elevLoss,
    avgPace:   formatPace(speed),
    speed,
    sourceName: nameEl?.textContent || 'Ruta importada',
  };
}

async function handleGPXImport(file) {
  try {
    const text = await file.text();
    const run  = parseGPX(text);
    await DB.save(run);
    showToast(`GPX importado ✓ (${run.points.length} puntos)`);
    await loadHistory();
  } catch (e) {
    console.error('[GPX import]', e);
    showToast(`Error al importar: ${e.message}`, 4000);
  }
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('show'));
  });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, duration);
}

// ─── ROUTER DE PANTALLAS ─────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── MAPA DE TRACKING ────────────────────────────────────────────────────────
let trackMap    = null;
let trackLine   = null;
let posMarker   = null;
let summaryMap  = null;
let modalMapObj = null;

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

function initTrackMap() {
  if (trackMap) return;
  trackMap = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
  }).setView([40.4168, -3.7038], 15);

  L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(trackMap);
  L.control.zoom({ position: 'topright' }).addTo(trackMap);

  trackLine = L.polyline([], {
    color: '#BFFF00',
    weight: 4,
    opacity: 0.9,
    lineJoin: 'round',
  }).addTo(trackMap);

  // Marcador de posición personalizado
  const icon = L.divIcon({
    className: '',
    html: `<div style="
      width:16px;height:16px;
      background:#BFFF00;
      border:2.5px solid #000;
      border-radius:50%;
      box-shadow:0 0 0 3px rgba(191,255,0,.3);
    "></div>`,
    iconSize: [16,16],
    iconAnchor: [8,8],
  });

  posMarker = L.marker([0,0], { icon, zIndexOffset: 1000 });
}

function updateTrackMap(lat, lon) {
  if (!trackMap) return;
  const latlng = [lat, lon];

  // Añadir punto a la polilínea
  trackLine.addLatLng(latlng);

  // Mover marcador
  if (!posMarker._map) posMarker.addTo(trackMap);
  posMarker.setLatLng(latlng);

  // Centrar si el usuario no ha movido el mapa
  if (!trackMap._userInteracted) {
    trackMap.setView(latlng, trackMap.getZoom() || 16);
  }
}

function resetTrackMap() {
  if (!trackMap) return;
  trackLine.setLatLngs([]);
  if (posMarker._map) posMarker.remove();
  trackMap._userInteracted = false;
}

// Detectar interacción manual del usuario con el mapa
function setupMapInteraction() {
  if (!trackMap) return;
  trackMap.on('dragstart', () => { trackMap._userInteracted = true; });
}

function renderSummaryMap(containerId, points) {
  const el = document.getElementById(containerId);
  if (!el) return null;

  // Destruir mapa previo si existe
  if (containerId === 'summary-map' && summaryMap) {
    summaryMap.remove(); summaryMap = null;
  }
  if (containerId === 'modal-map' && modalMapObj) {
    modalMapObj.remove(); modalMapObj = null;
  }

  const map = L.map(containerId, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
  });

  L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map);

  const latlngs = points.map(p => [p.lat, p.lon]);

  L.polyline(latlngs, {
    color: '#BFFF00',
    weight: 3,
    opacity: 0.9,
  }).addTo(map);

  // Marcador inicio / fin
  if (latlngs.length > 0) {
    const iconStart = L.divIcon({
      className: '',
      html: `<div style="width:10px;height:10px;background:#fff;border:2px solid #000;border-radius:50%;"></div>`,
      iconSize:[10,10], iconAnchor:[5,5],
    });
    const iconEnd = L.divIcon({
      className: '',
      html: `<div style="width:10px;height:10px;background:#BFFF00;border:2px solid #000;border-radius:50%;"></div>`,
      iconSize:[10,10], iconAnchor:[5,5],
    });
    L.marker(latlngs[0], { icon: iconStart }).addTo(map);
    L.marker(latlngs[latlngs.length-1], { icon: iconEnd }).addTo(map);
    map.fitBounds(L.polyline(latlngs).getBounds(), { padding: [20,20] });
  }

  if (containerId === 'summary-map') summaryMap = map;
  else modalMapObj = map;

  return map;
}

// ─── GRÁFICO DE ELEVACIÓN ────────────────────────────────────────────────────
function drawElevationChart(canvasId, points) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || points.length < 2) return;

  const alts = points.map(p => p.alt).filter(a => a != null);
  if (alts.length < 2) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    return;
  }

  const W = canvas.offsetWidth || 320;
  const H = canvas.height;
  canvas.width = W;

  const ctx   = canvas.getContext('2d');
  const min   = Math.min(...alts);
  const max   = Math.max(...alts);
  const range = max - min || 1;

  ctx.clearRect(0,0,W,H);

  // Área bajo la curva
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0, 'rgba(191,255,0,.35)');
  grad.addColorStop(1, 'rgba(191,255,0,0)');

  ctx.beginPath();
  alts.forEach((a,i) => {
    const x = (i / (alts.length-1)) * W;
    const y = H - ((a-min)/range) * (H*0.8) - H*0.1;
    i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Línea
  ctx.beginPath();
  alts.forEach((a,i) => {
    const x = (i / (alts.length-1)) * W;
    const y = H - ((a-min)/range) * (H*0.8) - H*0.1;
    i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.strokeStyle = '#BFFF00';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Etiquetas min/max
  ctx.fillStyle = 'rgba(136,136,136,.9)';
  ctx.font      = '10px JetBrains Mono, monospace';
  ctx.fillText(`${Math.round(max)}m`, 4, 12);
  ctx.fillText(`${Math.round(min)}m`, 4, H - 4);
}

// ─── LOG TERMINAL ─────────────────────────────────────────────────────────────
function addLogLine(text, cls = 'log-point') {
  const log = document.getElementById('terminal-log');
  if (!log) return;
  const p = document.createElement('p');
  p.className = `log-line ${cls}`;
  p.textContent = text;
  log.prepend(p);
  // Limitar a 30 líneas
  while (log.children.length > 30) log.removeChild(log.lastChild);
}

// ─── GPS ──────────────────────────────────────────────────────────────────────
function checkGPS() {
  const dot  = document.getElementById('gps-dot');
  const text = document.getElementById('gps-status-text');
  const hint = document.getElementById('gps-hint');
  const btn  = document.getElementById('btn-start-run');

  if (!navigator.geolocation) {
    dot.className  = 'gps-dot error';
    text.textContent = 'GPS no disponible en este dispositivo';
    btn.disabled   = true;
    return;
  }

  dot.className  = 'gps-dot warn';
  text.textContent = 'Obteniendo posición…';

  navigator.geolocation.getCurrentPosition(
    pos => {
      const acc = Math.round(pos.coords.accuracy);
      dot.className  = acc < 30 ? 'gps-dot good' : 'gps-dot warn';
      text.textContent = `GPS listo · precisión ±${acc}m`;
      hint.textContent = acc > 30
        ? 'La señal mejorará al aire libre'
        : 'Señal óptima para iniciar';
      btn.disabled = false;
    },
    err => {
      dot.className  = 'gps-dot error';
      btn.disabled   = true;
      switch (err.code) {
        case 1: text.textContent = 'Permiso de ubicación denegado'; hint.textContent = 'Actívalo en Ajustes > Privacidad'; break;
        case 2: text.textContent = 'Señal GPS no disponible'; hint.textContent = 'Sal al exterior e inténtalo de nuevo'; break;
        case 3: text.textContent = 'Tiempo de espera agotado'; hint.textContent = 'Pulsa "Iniciar carrera" para reintentar'; btn.disabled = false; break;
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ─── TRACKING ────────────────────────────────────────────────────────────────
function startSession() {
  const s = State.session;
  s.active    = true;
  s.paused    = false;
  s.points    = [];
  s.startTime = Date.now();
  s.pausedMs  = 0;
  s.pauseStart= null;
  s.distance  = 0;
  s.elevGain  = 0;
  s.elevLoss  = 0;
  s.lastAlt   = null;

  resetTrackMap();
  updateTrackingUI();
  showScreen('screen-tracking');
  setTimeout(() => { if (trackMap) trackMap.invalidateSize(); }, 300);
  setupMapInteraction();

  // Iniciar watchPosition
  s.watchId = navigator.geolocation.watchPosition(
    onGPSPoint,
    onGPSError,
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 2000 }
  );

  // Timer
  s.timerInterval = setInterval(updateTimer, 1000);

  // Log
  addLogLine('▶ Sesión iniciada. Esperando señal GPS…', 'log-system');
}

function onGPSPoint(pos) {
  const s = State.session;
  if (!s.active || s.paused) return;

  const { latitude: lat, longitude: lon, altitude: alt, accuracy: acc } = pos.coords;
  const ts = pos.timestamp;

  // Filtrar puntos con muy mala precisión
  if (acc > 80) {
    addLogLine(`⚠ precisión baja (±${Math.round(acc)}m) — punto descartado`);
    return;
  }

  const point = { lat, lon, alt, ts, acc: Math.round(acc) };
  s.points.push(point);

  // Calcular distancia incremental
  if (s.points.length > 1) {
    const prev = s.points[s.points.length - 2];
    const d = haversine(prev.lat, prev.lon, lat, lon);
    s.distance += d;

    // Desnivel
    if (alt != null && s.lastAlt != null) {
      const diff = alt - s.lastAlt;
      if (Math.abs(diff) > 0.5) { // filtrar ruido del altímetro
        if (diff > 0) s.elevGain += diff;
        else          s.elevLoss += Math.abs(diff);
      }
    }
  }

  if (alt != null) s.lastAlt = alt;

  // Actualizar mapa
  updateTrackMap(lat, lon);

  // Actualizar HUD
  updateMetricsUI();

  // Log
  const n     = s.points.length;
  const altTx = alt != null ? ` alt:${Math.round(alt)}m` : '';
  if (n === 1 || n % 5 === 0) {
    addLogLine(`[${String(n).padStart(4,'0')}] ${lat.toFixed(5)},${lon.toFixed(5)}${altTx} ±${Math.round(acc)}m`);
  }
}

function onGPSError(err) {
  addLogLine(`✗ Error GPS: ${err.message}`, 'log-system');
}

function pauseSession() {
  const s = State.session;
  if (!s.active) return;
  s.paused = !s.paused;

  const btn = document.getElementById('btn-pause');

  if (s.paused) {
    s.pauseStart = Date.now();
    btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    addLogLine('⏸ En pausa', 'log-system');
  } else {
    s.pausedMs += Date.now() - s.pauseStart;
    s.pauseStart = null;
    btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
    addLogLine('▶ Reanudado', 'log-system');
  }
}

function stopSession() {
  const s = State.session;
  if (!s.active) return;

  // Detener GPS y timer
  if (s.watchId != null) navigator.geolocation.clearWatch(s.watchId);
  if (s.timerInterval)   clearInterval(s.timerInterval);

  const elapsedMs = (Date.now() - s.startTime) - s.pausedMs -
    (s.paused && s.pauseStart ? Date.now() - s.pauseStart : 0);

  const { distance, elevGain, elevLoss } = computeStats(s.points);

  const speed    = distance / (elapsedMs / 3600000); // km/h
  const avgPace  = formatPace(speed);

  State.currentRun = {
    id:        `run_${Date.now()}`,
    date:      s.startTime,
    points:    [...s.points],
    durationMs:elapsedMs,
    distance,
    elevGain,
    elevLoss,
    avgPace,
    speed,
  };

  s.active = false;

  showSummaryScreen(State.currentRun);
}

function updateTimer() {
  const s = State.session;
  if (!s.active || s.paused) return;
  const elapsed = (Date.now() - s.startTime) - s.pausedMs;
  document.getElementById('hud-timer').textContent = formatDuration(elapsed);
}

function updateMetricsUI() {
  const s = State.session;
  const elapsed = s.active && !s.paused
    ? (Date.now() - s.startTime) - s.pausedMs
    : 0;

  document.getElementById('t-distance').textContent = s.distance.toFixed(2);

  // Pace instantáneo: últimos 3 puntos
  if (s.points.length >= 3) {
    const recent = s.points.slice(-3);
    let d = 0, dt = 0;
    for (let i = 1; i < recent.length; i++) {
      d  += haversine(recent[i-1].lat, recent[i-1].lon, recent[i].lat, recent[i].lon);
      dt += recent[i].ts - recent[i-1].ts;
    }
    const spd = d / (dt / 3600000);
    document.getElementById('t-pace').textContent = formatPace(spd);
  }

  const lastPoint = s.points[s.points.length-1];
  if (lastPoint?.alt != null) {
    document.getElementById('t-elevation').textContent = Math.round(lastPoint.alt);
  }

  document.getElementById('t-gain').textContent = `+${Math.round(s.elevGain)}`;
}

function updateTrackingUI() {
  document.getElementById('hud-timer').textContent = '00:00:00';
  document.getElementById('t-distance').textContent = '0.00';
  document.getElementById('t-pace').textContent     = '--:--';
  document.getElementById('t-elevation').textContent= '0';
  document.getElementById('t-gain').textContent     = '+0';
  document.getElementById('terminal-log').innerHTML =
    '<p class="log-line log-system">▶ Sesión iniciada. Esperando señal GPS…</p>';
}

// ─── PANTALLA RESUMEN ─────────────────────────────────────────────────────────
function showSummaryScreen(run) {
  showScreen('screen-summary');

  document.getElementById('sum-distance').textContent = run.distance.toFixed(2);
  document.getElementById('sum-time').textContent     = formatDuration(run.durationMs);
  document.getElementById('sum-pace').textContent     = run.avgPace;
  document.getElementById('sum-gain').textContent     = `+${run.elevGain} m`;
  document.getElementById('sum-loss').textContent     = `−${run.elevLoss} m`;
  document.getElementById('sum-points').textContent   = run.points.length;

  // Mapa resumen (necesita pequeño delay para que el screen sea visible)
  setTimeout(() => {
    renderSummaryMap('summary-map', run.points);
    drawElevationChart('elevation-chart', run.points);
  }, 300);
}

// ─── PANTALLA HISTORIAL ───────────────────────────────────────────────────────
async function loadHistory() {
  const runs = await DB.getAll();
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  list.innerHTML = '';

  if (runs.length === 0) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');

  runs.forEach(run => {
    const card = document.createElement('div');
    card.className = 'run-card';
    card.innerHTML = `
      <div>
        <div class="run-card-date">${formatDateShort(run.date)}</div>
        <div class="run-card-main">${run.distance.toFixed(2)} km</div>
        <div class="run-card-meta">${formatDuration(run.durationMs)} · ↑${run.elevGain}m</div>
      </div>
      <div class="run-card-badge">${run.avgPace} /km</div>
    `;
    card.addEventListener('click', () => openRunDetail(run.id));
    list.appendChild(card);
  });
}

async function openRunDetail(id) {
  const run = await DB.get(id);
  if (!run) return;
  State.modalRun = run;

  document.getElementById('modal-run-title').textContent = formatDate(run.date);
  document.getElementById('md-distance').textContent     = `${run.distance.toFixed(2)}`;
  document.getElementById('md-time').textContent         = formatDuration(run.durationMs);
  document.getElementById('md-pace').textContent         = run.avgPace;
  document.getElementById('md-gain').textContent         = `+${run.elevGain}m`;

  document.getElementById('modal-run-detail').classList.remove('hidden');

  setTimeout(() => {
    renderSummaryMap('modal-map', run.points);
    drawElevationChart('modal-elev-chart', run.points);
  }, 100);
}

// ─── HOME STATS ───────────────────────────────────────────────────────────────
async function refreshHomeStats() {
  const runs = await DB.getAll();
  const totalKm = runs.reduce((a, r) => a + r.distance, 0);
  const bestPace = runs.reduce((best, r) => {
    if (!best) return r;
    return r.speed > best.speed ? r : best;
  }, null);

  document.getElementById('home-total-runs').textContent = runs.length || '0';
  document.getElementById('home-total-km').textContent   = totalKm.toFixed(1) || '0.0';
  document.getElementById('home-best-pace').textContent  = bestPace ? bestPace.avgPace : '--:--';
  document.getElementById('greeting-date').textContent   = new Date().toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long'
  });
}

// ─── EVENTOS ──────────────────────────────────────────────────────────────────
function bindEvents() {
  // Splash
  document.getElementById('btn-enter').addEventListener('click', () => {
    showScreen('screen-home');
    checkGPS();
    refreshHomeStats();
  });

  // Home → Tracking
  document.getElementById('btn-start-run').addEventListener('click', () => {
    initTrackMap();
    startSession();
  });

  // Home → Historial
  document.getElementById('btn-to-history').addEventListener('click', async () => {
    showScreen('screen-history');
    await loadHistory();
  });

  // Tracking: pausa
  document.getElementById('btn-pause').addEventListener('click', pauseSession);

  // Tracking: stop
  document.getElementById('btn-stop').addEventListener('click', () => {
    if (State.session.points.length < 2) {
      showToast('Al menos 2 puntos GPS para guardar');
      stopSession();
      return;
    }
    stopSession();
  });

  // Tracking: centrar mapa
  document.getElementById('btn-center').addEventListener('click', () => {
    if (!trackMap) return;
    trackMap._userInteracted = false;
    const latlngs = trackLine.getLatLngs();
    if (latlngs.length > 0) {
      trackMap.setView(latlngs[latlngs.length-1], trackMap.getZoom());
    }
  });

  // Resumen: guardar
  document.getElementById('btn-save-run').addEventListener('click', async () => {
    if (!State.currentRun) return;
    await DB.save(State.currentRun);
    showToast('Ruta guardada ✓');
    State.currentRun = null;
    showScreen('screen-home');
    refreshHomeStats();
  });

  // Resumen: descartar
  document.getElementById('btn-discard-run').addEventListener('click', () => {
    State.currentRun = null;
    showScreen('screen-home');
    showToast('Ruta descartada');
  });

  // Resumen: exportar GPX
  document.getElementById('btn-export-gpx').addEventListener('click', () => {
    if (State.currentRun) downloadGPX(State.currentRun);
  });

  // Resumen: volver
  document.getElementById('btn-summary-back').addEventListener('click', () => {
    // Volver al home, la ruta actual se pierde si no se guardó
    State.currentRun = null;
    showScreen('screen-home');
  });

  // Historial: volver
  document.getElementById('btn-history-back').addEventListener('click', () => {
    showScreen('screen-home');
  });

  // Historial: importar GPX (útil para probar en desktop archivos del móvil)
  document.getElementById('btn-import-gpx').addEventListener('click', () => {
    document.getElementById('gpx-file-input').click();
  });
  document.getElementById('gpx-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await handleGPXImport(file);
    e.target.value = ''; // permite reimportar el mismo archivo si hace falta
  });

  // Modal: cerrar
  document.getElementById('btn-modal-close').addEventListener('click', () => {
    document.getElementById('modal-run-detail').classList.add('hidden');
    State.modalRun = null;
  });

  // Modal: exportar GPX
  document.getElementById('btn-modal-export').addEventListener('click', () => {
    if (State.modalRun) downloadGPX(State.modalRun);
  });

  // Modal: eliminar
  document.getElementById('btn-modal-delete').addEventListener('click', async () => {
    if (!State.modalRun) return;
    if (!confirm('¿Eliminar esta ruta permanentemente?')) return;
    await DB.del(State.modalRun.id);
    document.getElementById('modal-run-detail').classList.add('hidden');
    State.modalRun = null;
    showToast('Ruta eliminada');
    await loadHistory();
  });

  // Resumen: ver en 3D
  document.getElementById('btn-view-3d-summary').addEventListener('click', () => {
    if (State.currentRun) open3DView(State.currentRun);
  });

  // Modal historial: ver en 3D
  document.getElementById('btn-modal-3d').addEventListener('click', () => {
    if (State.modalRun) {
      document.getElementById('modal-run-detail').classList.add('hidden');
      open3DView(State.modalRun);
    }
  });

  // Vista 3D: volver
  document.getElementById('btn-3d-back').addEventListener('click', () => {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    animPlaying = false;
    // Volver al origen correcto
    if (State.activeRun3D && State.currentRun && State.activeRun3D.id === State.currentRun.id) {
      showScreen('screen-summary');
    } else {
      showScreen('screen-history');
    }
    State.activeRun3D = null;
  });

  // Cerrar modal al hacer clic en el overlay
  document.getElementById('modal-run-detail').addEventListener('click', function(e) {
    if (e.target === this) {
      this.classList.add('hidden');
      State.modalRun = null;
    }
  });

  // Redimensionar charts al girar pantalla
  window.addEventListener('resize', () => {
    if (trackMap) trackMap.invalidateSize();
    if (summaryMap) summaryMap.invalidateSize();
    if (modalMapObj) modalMapObj.invalidateSize();
    if (State.currentRun) drawElevationChart('elevation-chart', State.currentRun.points);
  });
}

// ─── SERVICE WORKER ───────────────────────────────────────────────────────────
function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  // Recarga automática una sola vez cuando un nuevo SW toma el control.
  // Sin esto, skipWaiting()+clients.claim() en el SW no es suficiente:
  // la pestaña sigue ejecutando el app.js viejo hasta que se recarga,
  // así que los fixes nunca llegan a probarse aunque el deploy sea correcto.
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('sw.js')
    .then(reg => {
      console.log('[TrailRun] SW registrado');
      // Si ya hay un SW esperando (descargado pero no activado), pedirle
      // que tome el control ya — cubre el caso de pestañas dejadas abiertas.
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            newWorker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    })
    .catch(e => console.warn('[TrailRun] SW no disponible:', e));
}

// ─── INIT ────────────────────────────────────────────────────────────────────
async function init() {
  await DB.open();
  bindEvents();
  registerSW();
  showScreen('screen-splash');
}

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════════════════════════
// FASE 2+3 — ELEVACIÓN SRTM + VISUALIZACIÓN 3D
// ═══════════════════════════════════════════════════════════════════════════════

// ─── SUAVIZADO DE ELEVACIÓN (media móvil) ─────────────────────────────────────
// Elimina artefactos del sensor GPS sin perder la forma general del perfil.
// window=7 es un buen compromiso para tracks de running (1 punto cada ~3-5s).
function smoothElevation(alts, window = 7) {
  const half = Math.floor(window / 2);
  return alts.map((_, i) => {
    const slice = alts.slice(Math.max(0, i - half), Math.min(alts.length, i + half + 1));
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

// ─── OPEN-ELEVATION API ───────────────────────────────────────────────────────
// API gratuita y open-source que devuelve altitud SRTM para listas de coords.
// Límite: 2000 puntos por petición. Si la ruta tiene más, la submuestreamos.
const OPEN_ELEV_URL = 'https://api.open-elevation.com/api/v1/lookup';
const MAX_ELEV_POINTS = 300; // conservador para móvil

async function fetchSRTMElevation(points) {
  // Submuestrear si hay demasiados puntos
  let sample = points;
  let step = 1;
  if (points.length > MAX_ELEV_POINTS) {
    step = Math.ceil(points.length / MAX_ELEV_POINTS);
    sample = points.filter((_, i) => i % step === 0);
    // Asegurar que el último punto esté incluido
    if (sample[sample.length - 1] !== points[points.length - 1]) {
      sample.push(points[points.length - 1]);
    }
  }

  // Validar coordenadas: Open-Elevation responde 400 si recibe lat/lon
  // inválidos (NaN, fuera de rango, o 0,0 típico de un fix GPS fallido).
  const isValidCoord = (lat, lon) =>
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0);

  const locations = sample
    .filter(p => isValidCoord(p.lat, p.lon))
    .map(p => ({ latitude: p.lat, longitude: p.lon }));

  if (locations.length === 0) {
    throw new Error('Sin coordenadas válidas para consultar elevación');
  }

  const resp = await fetch(OPEN_ELEV_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ locations }),
  });

  if (!resp.ok) {
    // Open-Elevation devuelve { error: "..." } con detalle del motivo del 400
    let detail = '';
    try { detail = (await resp.json()).error || ''; } catch {}
    throw new Error(`Open-Elevation error: ${resp.status}${detail ? ' — ' + detail : ''}`);
  }
  const data = await resp.json();

  // Mapear elevaciones SRTM de vuelta a todos los puntos (interpolación lineal)
  const srtmAlts = data.results.map(r => r.elevation);
  const smoothed  = smoothElevation(srtmAlts);

  // Si submuestreamos, interpolar para el array completo
  if (step === 1) {
    return points.map((_, i) => smoothed[i]);
  }

  return points.map((_, i) => {
    const sIdx  = i / step;
    const lower = Math.floor(sIdx);
    const upper = Math.min(lower + 1, smoothed.length - 1);
    const t     = sIdx - lower;
    return smoothed[lower] * (1 - t) + smoothed[upper] * t;
  });
}

// ─── PREPARAR PUNTOS 3D ───────────────────────────────────────────────────────
// Devuelve array de puntos enriquecidos con elevación SRTM suavizada,
// distancia acumulada y pace por segmento.
async function preparePoints3D(run, onProgress) {
  onProgress('Consultando elevación SRTM…');
  let elevations;
  try {
    elevations = await fetchSRTMElevation(run.points);
  } catch (e) {
    console.warn('[3D] Open-Elevation falló, usando altitud GPS:', e);
    onProgress('Usando altitud GPS (SRTM no disponible)…');
    const rawAlts = run.points.map(p => p.alt ?? 0);
    elevations = smoothElevation(rawAlts);
  }

  onProgress('Calculando métricas de ruta…');

  let cumDist = 0;
  return run.points.map((p, i) => {
    if (i > 0) {
      cumDist += haversine(
        run.points[i-1].lat, run.points[i-1].lon,
        p.lat, p.lon
      );
    }
    return {
      lat:     p.lat,
      lon:     p.lon,
      alt:     elevations[i],
      ts:      p.ts,
      cumDist, // km acumulados hasta este punto
    };
  });
}

// ─── ESPERAR LAYOUT REAL DEL CONTENEDOR ──────────────────────────────────────
// Resuelve cuando el elemento tiene dimensiones > 0, usando doble rAF como
// mínimo (deja que el navegador pinte el display:flex) y un fallback con
// ResizeObserver por si el contenedor tarda más (animaciones CSS, fonts, etc).
function waitForLayout(elId, timeoutMs = 1500) {
  return new Promise(resolve => {
    const el = document.getElementById(elId);
    const hasSize = () => el.offsetWidth > 0 && el.offsetHeight > 0;

    if (hasSize()) {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      return;
    }

    const ro = new ResizeObserver(() => {
      if (hasSize()) {
        ro.disconnect();
        clearTimeout(timer);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }
    });
    ro.observe(el);

    // Fallback por si ResizeObserver no dispara (no debería, pero por si acaso)
    const timer = setTimeout(() => { ro.disconnect(); resolve(); }, timeoutMs);
  });
}

// ─── MOTOR deck.gl ────────────────────────────────────────────────────────────
let deckInstance  = null;
let animFrame     = null;
let animPlaying   = false;
let animProgress  = 0;       // 0..1
const ANIM_SPEED  = 0.0008;  // fracción de ruta por frame (~60fps → ~20s para 5km)

function initDeck(points3D) {
  const container = document.getElementById('deck-container');
  container.innerHTML = '';

  const { DeckGL, PathLayer, ScatterplotLayer, MapView } = deck;

  // Centro de la ruta
  const lats = points3D.map(p => p.lat);
  const lons = points3D.map(p => p.lon);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;

  // Coordenadas completas para la línea de fondo
  const fullPath = points3D.map(p => [p.lon, p.lat, p.alt]);

  deckInstance = new DeckGL({
    container,
    mapStyle: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    initialViewState: {
      longitude: centerLon,
      latitude:  centerLat,
      zoom: 14,
      pitch: 55,
      bearing: -20,
    },
    controller: true,
    layers: buildLayers(points3D, fullPath, 0),
  });
}

function buildLayers(points3D, fullPath, progress) {
  const { PathLayer, ScatterplotLayer } = deck;
  const cutIdx = Math.floor(progress * (points3D.length - 1));
  const traveled = fullPath.slice(0, cutIdx + 1);
  const remaining = fullPath.slice(cutIdx);

  const layers = [
    // Ruta completa (atenuada)
    new PathLayer({
      id: 'path-full',
      data: [{ path: fullPath }],
      getPath: d => d.path,
      getColor: [191, 255, 0, 40],
      getWidth: 4,
      widthUnits: 'pixels',
      pickable: false,
    }),
    // Tramo recorrido
    new PathLayer({
      id: 'path-traveled',
      data: [{ path: traveled }],
      getPath: d => d.path,
      getColor: [191, 255, 0, 220],
      getWidth: 5,
      widthUnits: 'pixels',
      pickable: false,
    }),
  ];

  // Marcador de posición actual
  // Clamp defensivo: cutIdx puede llegar a points3D.length por redondeo
  // de punto flotante cuando progress se acerca a 1, dejando cur=undefined
  // y rompiendo deck.gl (assertion failed en cascada).
  const markerIdx = Math.min(cutIdx, points3D.length - 1);
  const cur = points3D[markerIdx];
  if (cur) {
    layers.push(
      new ScatterplotLayer({
        id: 'position-marker',
        data: [{ pos: [cur.lon, cur.lat, cur.alt + 3] }],
        getPosition: d => d.pos,
        getRadius: 6,
        radiusUnits: 'pixels',
        getFillColor: [191, 255, 0, 255],
        stroked: true,
        getLineColor: [0, 0, 0, 200],
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        pickable: false,
      })
    );
  }

  return layers;
}

function animTick(points3D, fullPath) {
  if (!animPlaying) return;
  if (points3D.length === 0) { animPlaying = false; return; }

  animProgress = Math.min(animProgress + ANIM_SPEED, 1);
  const cutIdx = Math.min(
    Math.floor(animProgress * (points3D.length - 1)),
    points3D.length - 1
  );
  const cur    = points3D[cutIdx];
  if (!cur) { animPlaying = false; return; }

  // Actualizar deck
  deckInstance.setProps({ layers: buildLayers(points3D, fullPath, animProgress) });

  // Actualizar HUD
  document.getElementById('anim-km').textContent       = cur.cumDist.toFixed(2);
  document.getElementById('anim-alt').textContent      = Math.round(cur.alt);
  document.getElementById('anim-progress').textContent = `${Math.round(animProgress * 100)}%`;
  document.getElementById('progress-bar-fill').style.width = `${animProgress * 100}%`;

  if (animProgress >= 1) {
    animPlaying = false;
    updatePlayPauseIcon(false);
    return;
  }

  animFrame = requestAnimationFrame(() => animTick(points3D, fullPath));
}

function updatePlayPauseIcon(playing) {
  document.getElementById('icon-play').style.display  = playing ? 'none' : '';
  document.getElementById('icon-pause').style.display = playing ? '' : 'none';
}

// ─── ENTRADA A VISTA 3D ───────────────────────────────────────────────────────
async function open3DView(run) {
  State.activeRun3D = run;

  // Mostrar pantalla y panel de carga
  showScreen('screen-3d');
  document.getElementById('loading-panel').style.display = 'flex';
  document.getElementById('anim-panel').style.display    = 'none';
  document.getElementById('progress-bar-wrap').style.display = 'none';
  document.getElementById('view3d-title').textContent = formatDate(run.date);

  // Limpiar animación previa
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  animPlaying  = false;
  animProgress = 0;

  function onProgress(msg) {
    document.getElementById('loading-text').textContent = msg;
  }

  // Guard de entrada: sin al menos 2 puntos GPS no hay ruta que animar.
  // Sin esto, preparePoints3D devuelve un array vacío/de 1 elemento y
  // initDeck/animTick acaban indexando fuera de rango más adelante.
  if (!run.points || run.points.length < 2) {
    onProgress(`Esta ruta tiene ${run.points?.length ?? 0} punto(s) GPS — insuficiente para animar`);
    document.getElementById('loading-text').classList.add('loading-error');
    return;
  }

  try {
    const points3D = await preparePoints3D(run, onProgress);
    const fullPath  = points3D.map(p => [p.lon, p.lat, p.alt]);

    onProgress('Renderizando mapa 3D…');

    // El contenedor debe tener layout calculado (ancho/alto > 0) antes de
    // inicializar deck.gl, o el canvas WebGL del mapa base colapsa a 0x0
    // y solo se ve el ScatterplotLayer (el "punto verde") sobre fondo negro.
    await waitForLayout('deck-container');

    initDeck(points3D);

    // Ocultar carga, mostrar controles
    document.getElementById('loading-panel').style.display      = 'none';
    document.getElementById('anim-panel').style.display         = 'flex';
    document.getElementById('progress-bar-wrap').style.display  = 'block';
    updatePlayPauseIcon(false);

    // Bind controles de animación (solo la primera vez por run)
    const btnToggle  = document.getElementById('btn-anim-toggle');
    const btnRestart = document.getElementById('btn-anim-restart');

    // Reemplazar listeners para evitar duplicados
    const newToggle = btnToggle.cloneNode(true);
    const newRestart = btnRestart.cloneNode(true);
    btnToggle.parentNode.replaceChild(newToggle, btnToggle);
    btnRestart.parentNode.replaceChild(newRestart, btnRestart);

    newToggle.addEventListener('click', () => {
      animPlaying = !animPlaying;
      updatePlayPauseIcon(animPlaying);
      if (animPlaying) {
        if (animProgress >= 1) animProgress = 0; // reiniciar si llegó al final
        animFrame = requestAnimationFrame(() => animTick(points3D, fullPath));
      } else {
        if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
      }
    });

    newRestart.addEventListener('click', () => {
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
      animProgress = 0;
      animPlaying  = true;
      updatePlayPauseIcon(true);
      deckInstance.setProps({ layers: buildLayers(points3D, fullPath, 0) });
      document.getElementById('progress-bar-fill').style.width = '0%';
      animFrame = requestAnimationFrame(() => animTick(points3D, fullPath));
    });

    // Autoplay
    animPlaying = true;
    updatePlayPauseIcon(true);
    animFrame = requestAnimationFrame(() => animTick(points3D, fullPath));

  } catch (err) {
    console.error('[3D]', err);
    document.getElementById('loading-text').textContent = `Error: ${err.message}`;
  }
}

