// ── Config ──────────────────────────────────────────────────────────────
const API_KEY = 'AIzaSyDqKeq3a0O__Mm7EQLy0zrHYuJUq8Ly1Ps';

// ── History (localStorage) ───────────────────────────────────────────────
const HISTORY_KEY = 'venueScout_history';
let currentHistory = {};

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); }
  catch { return {}; }
}

function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }
  catch(e) { console.warn('History save failed — localStorage may be full:', e); }
}

function recordAndDiff(places) {
  const history = loadHistory();
  const now = Date.now();
  places.forEach(p => {
    if (!history[p.place_id]) history[p.place_id] = { name: p.name, snaps: [] };
    history[p.place_id].snaps.push({
      ts:      now,
      photos:  p.photos?.length ?? 0,
      ratings: p.user_ratings_total ?? 0
    });
    // Cap at 20 snapshots per venue
    if (history[p.place_id].snaps.length > 20)
      history[p.place_id].snaps = history[p.place_id].snaps.slice(-20);
  });
  saveHistory(history);
  currentHistory = history;
}

// Delta between latest two snapshots for a venue
function getDelta(placeId) {
  const entry = currentHistory[placeId];
  if (!entry || entry.snaps.length < 2) return null;
  const s    = entry.snaps;
  const cur  = s[s.length - 1];
  const prev = s[s.length - 2];
  return {
    photoDelta:   cur.photos  - prev.photos,
    ratingsDelta: cur.ratings - prev.ratings,
    curPhotos:    cur.photos,
    curRatings:   cur.ratings,
    prevPhotos:   prev.photos,
    prevRatings:  prev.ratings,
    runCount:     s.length,
    daysSince:    Math.max(1, Math.round((cur.ts - prev.ts) / 86400000))
  };
}

// Total change first→latest. 0 = completely stagnant. -1 = no history yet.
function getStagnancyScore(placeId) {
  const entry = currentHistory[placeId];
  if (!entry || entry.snaps.length < 2) return -1;
  const first  = entry.snaps[0];
  const latest = entry.snaps[entry.snaps.length - 1];
  return (latest.photos - first.photos) + (latest.ratings - first.ratings);
}

function updateHistoryBadge() {
  const tracked = Object.keys(currentHistory).length;
  const el = document.getElementById('historyBadge');
  if (el) el.textContent = `${tracked} tracked`;
}

function clearHistory() {
  if (!confirm('Clear all scan history? This cannot be undone.')) return;
  localStorage.removeItem(HISTORY_KEY);
  currentHistory = {};
  updateHistoryBadge();
  if (allClosed.length > 0) applyFiltersAndRender();
}

// ── State ───────────────────────────────────────────────────────────────
let placesService  = null;
let geocoder       = null;
let allClosed      = [];   // all closed venues after dedup
let apiCallCount   = 0;
let sortMode       = 'default'; // 'default' | 'stagnant'

let selectedRadius   = 1000;
let filterPerm       = true;
let filterTemp       = true;
let filterMinRatings = 10;

// ── Sort toggle ──────────────────────────────────────────────────────────
function setSort(mode) {
  sortMode = mode;
  document.getElementById('sortDefault').classList.toggle('active', mode === 'default');
  document.getElementById('sortStagnant').classList.toggle('active', mode === 'stagnant');
  if (allClosed.length > 0) applyFiltersAndRender();
}

// ── initMap — called by Google Maps SDK ─────────────────────────────────
function initMap() {
  const map = new google.maps.Map(document.getElementById('map-placeholder'), {
    center: { lat: 13.0827, lng: 80.2707 },
    zoom: 12
  });

  placesService = new google.maps.places.PlacesService(map);
  geocoder      = new google.maps.Geocoder();

  const input         = document.getElementById('areaInput');
  const chennaiBounds = new google.maps.LatLngBounds(
    new google.maps.LatLng(12.8, 79.97),
    new google.maps.LatLng(13.35, 80.55)
  );
  const ac = new google.maps.places.Autocomplete(input, {
    bounds: chennaiBounds,
    strictBounds: false,
    componentRestrictions: { country: 'in' },
    fields: ['name', 'geometry', 'formatted_address']
  });
  ac.addListener('place_changed', () => {
    const place = ac.getPlace();
    if (place && place.name) input.value = place.name;
  });

  // Load history badge on init
  currentHistory = loadHistory();
  updateHistoryBadge();
}
window.initMap = initMap;

// ── Radius pills ─────────────────────────────────────────────────────────
document.querySelectorAll('#radiusPills .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#radiusPills .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRadius = parseInt(btn.dataset.val);
  });
});

// ── Ratings filter pills ─────────────────────────────────────────────────
document.querySelectorAll('#ratingsPills .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ratingsPills .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterMinRatings = parseInt(btn.dataset.val);
    if (allClosed.length > 0) applyFiltersAndRender();
  });
});

// ── Status filter toggle ─────────────────────────────────────────────────
function toggleFilter(type) {
  if (type === 'perm') {
    filterPerm = !filterPerm;
    document.getElementById('pillPerm').classList.toggle('active', filterPerm);
  } else {
    filterTemp = !filterTemp;
    document.getElementById('pillTemp').classList.toggle('active', filterTemp);
  }
  if (allClosed.length > 0) applyFiltersAndRender();
}

// ── Apply filters, sort, and render ──────────────────────────────────────
function applyFiltersAndRender() {
  let filtered = allClosed.filter(p => {
    const s = p.business_status;
    const statusOk = (filterPerm && s === 'CLOSED_PERMANENTLY') ||
                     (filterTemp && s === 'CLOSED_TEMPORARILY');
    if (!statusOk) return false;
    const ratingCount = (p.user_ratings_total != null && !isNaN(p.user_ratings_total))
      ? Number(p.user_ratings_total) : 0;
    return ratingCount >= filterMinRatings;
  });

  // Sort
  if (sortMode === 'stagnant') {
    filtered = filtered.slice().sort((a, b) => {
      const sa = getStagnancyScore(a.place_id);
      const sb = getStagnancyScore(b.place_id);
      // Untracked places go to the end
      if (sa === -1 && sb === -1) return 0;
      if (sa === -1) return 1;
      if (sb === -1) return -1;
      if (sa !== sb) return sa - sb; // lower score = more stagnant = first
      // Tie-break: more runs = more confident signal, show first
      const ra = currentHistory[a.place_id]?.snaps.length || 0;
      const rb = currentHistory[b.place_id]?.snaps.length || 0;
      return rb - ra;
    });
  }

  // Update stats
  const permCount = filtered.filter(p => p.business_status === 'CLOSED_PERMANENTLY').length;
  const tempCount = filtered.filter(p => p.business_status === 'CLOSED_TEMPORARILY').length;
  document.getElementById('statTotal').textContent = filtered.length;
  document.getElementById('statPerm').textContent  = permCount;
  document.getElementById('statTemp').textContent  = tempCount;

  renderCards(filtered);
}

// ── UI helpers ───────────────────────────────────────────────────────────
function setProgress(pct, text) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressMsg').textContent  = text;
}

function showError(msg) {
  document.getElementById('errorMsg').textContent = msg;
  document.getElementById('errorState').classList.add('visible');
}

function clearError() {
  document.getElementById('errorState').classList.remove('visible');
}

function showState(name) {
  document.getElementById('emptyState').style.display  = name === 'empty'    ? 'flex' : 'none';
  document.getElementById('progressState').classList.toggle('visible', name === 'progress');
  document.getElementById('resultsGrid').style.display = name === 'results'  ? 'grid' : 'none';
}

// ── Geocode ───────────────────────────────────────────────────────────────
function geocodeArea(query) {
  return new Promise((resolve, reject) => {
    geocoder.geocode(
      { address: query + ', Chennai, Tamil Nadu, India' },
      (results, status) => {
        if (status === 'OK' && results[0]) resolve(results[0].geometry.location);
        else reject(new Error(`Could not locate "${query}" in Chennai.`));
      }
    );
  });
}

// ── Grid tiling config ────────────────────────────────────────────────────
const GRID_CONFIG = {
  500:  { grid: 1, subRadius: 500 },
  1000: { grid: 3, subRadius: 500 },
  2000: { grid: 5, subRadius: 600 },
  3000: { grid: 7, subRadius: 600 },
};
const M_PER_LAT = 111000;
const M_PER_LNG = 107900;

function buildGridPoints(center, totalRadius) {
  const { grid, subRadius } = GRID_CONFIG[totalRadius] || GRID_CONFIG[1000];
  if (grid === 1) return [center];
  const spacing = subRadius * 0.75;
  const half    = Math.floor(grid / 2);
  const points  = [];
  for (let row = -half; row <= half; row++) {
    for (let col = -half; col <= half; col++) {
      const distM = Math.sqrt(Math.pow(row * spacing, 2) + Math.pow(col * spacing, 2));
      if (distM <= totalRadius + subRadius * 0.5) {
        points.push(new google.maps.LatLng(
          center.lat() + (row * spacing) / M_PER_LAT,
          center.lng() + (col * spacing) / M_PER_LNG
        ));
      }
    }
  }
  return points;
}

// ── Single-point nearby search with full pagination ───────────────────────
function nearbySearchOnePoint(location, radius, type) {
  return new Promise((resolve) => {
    apiCallCount++;
    const allPlaces = [];
    function handlePage(results, status, pagination) {
      if (status === google.maps.places.PlacesServiceStatus.OK && results) {
        allPlaces.push(...results);
        if (pagination && pagination.hasNextPage) {
          apiCallCount++;
          setTimeout(() => pagination.nextPage(handlePage), 2200);
        } else {
          resolve(allPlaces);
        }
      } else {
        resolve(allPlaces);
      }
    }
    placesService.nearbySearch({ location, radius, type }, handlePage);
  });
}

// ── Type label ────────────────────────────────────────────────────────────
function getReadableType(types) {
  const nice = ['restaurant', 'cafe', 'bar', 'bakery', 'ice_cream_shop', 'food', 'meal_takeaway', 'meal_delivery'];
  const found = (types || []).filter(t => nice.includes(t));
  return (found[0] || types?.[0] || 'venue').replace(/_/g, ' ');
}

// ── Main search ───────────────────────────────────────────────────────────
async function startSearch() {
  const area = document.getElementById('areaInput').value.trim();
  if (!area) return;

  clearError();
  allClosed    = [];
  apiCallCount = 0;

  document.getElementById('statsBar').classList.remove('visible');
  document.getElementById('exportBtn').style.display    = 'none';
  document.getElementById('exportKmlBtn').style.display = 'none';
  document.getElementById('runBtn').disabled = true;
  showState('progress');
  setProgress(5, 'Locating area…');

  try {
    if (!placesService || !geocoder) {
      throw new Error('Maps SDK not ready — please wait a moment and try again.');
    }

    setProgress(10, `Locating "${area}" in Chennai…`);
    const center = await geocodeArea(area);

    const gridPoints = buildGridPoints(center, selectedRadius);
    const { subRadius } = GRID_CONFIG[selectedRadius] || GRID_CONFIG[1000];
    const types  = ['restaurant', 'cafe', 'ice_cream_shop'];
    const allRaw = [];
    const total  = gridPoints.length * types.length;
    let   done   = 0;

    for (const point of gridPoints) {
      for (const type of types) {
        done++;
        setProgress(15 + Math.round((done / total) * 70), `Scanning point ${done}/${total} — ${type}s…`);
        const res = await nearbySearchOnePoint(point, subRadius, type);
        allRaw.push(...res);
      }
    }

    setProgress(88, 'Deduplicating…');

    const seen = new Set();
    const deduped = allRaw.filter(p => {
      if (seen.has(p.place_id)) return false;
      seen.add(p.place_id);
      return true;
    });

    const TARGET_TYPES = new Set(['restaurant', 'cafe', 'ice_cream_shop']);
    const typed = deduped.filter(p => (p.types || []).some(t => TARGET_TYPES.has(t)));

    allClosed = typed.filter(p => {
      const s = p.business_status;
      return s === 'CLOSED_PERMANENTLY' || s === 'CLOSED_TEMPORARILY';
    });

    // Record snapshot for all found venues
    setProgress(94, 'Recording history snapshot…');
    recordAndDiff(allClosed);
    updateHistoryBadge();

    setProgress(100, `Found ${allClosed.length} closed venue${allClosed.length !== 1 ? 's' : ''}.`);

    document.getElementById('statCalls').textContent = apiCallCount;
    document.getElementById('statsBar').classList.add('visible');

    applyFiltersAndRender();

  } catch (err) {
    showError(err.message);
    showState('empty');
    document.getElementById('emptySubText').textContent = 'Something went wrong. Check the error above and try again.';
  } finally {
    document.getElementById('runBtn').disabled = false;
  }
}

// ── Build delta row HTML ──────────────────────────────────────────────────
function buildDeltaHtml(place) {
  const snap = currentHistory[place.place_id];
  if (!snap || snap.snaps.length === 0) return '';

  const d = getDelta(place.place_id);

  if (!d) {
    // First time this venue was seen
    const cur = snap.snaps[0];
    return `
      <div class="card-delta delta-new">
        <span class="delta-stat">
          <span class="delta-icon">📸</span>
          <span class="delta-val">${cur.photos} photo refs</span>
        </span>
        <span class="delta-dot">·</span>
        <span class="delta-stat">
          <span class="delta-icon">⭐</span>
          <span class="delta-val">${cur.ratings.toLocaleString()} ratings</span>
        </span>
        <span class="delta-badge badge-new">First scan</span>
      </div>`;
  }

  // Has previous snapshot — show delta
  const pDelta = d.photoDelta;
  const rDelta = d.ratingsDelta;
  const isStagnant = pDelta === 0 && rDelta === 0;

  const pClass = pDelta > 0 ? 'dval-up' : 'dval-zero';
  const rClass = rDelta > 0 ? 'dval-up' : 'dval-zero';
  const pStr   = pDelta > 0 ? `+${pDelta}` : '±0';
  const rStr   = rDelta > 0 ? `+${rDelta}` : '±0';

  // Note: Places API caps photo refs at 10, so 10→10 is expected for active venues
  const photoNote = d.curPhotos >= 10 ? '≥10' : `${d.curPhotos}`;

  return `
    <div class="card-delta ${isStagnant ? 'delta-stagnant' : 'delta-active'}">
      <span class="delta-stat">
        <span class="delta-icon">📸</span>
        <span class="delta-val">${d.prevPhotos}→${photoNote}</span>
        <span class="${pClass}">(${pStr})</span>
      </span>
      <span class="delta-dot">·</span>
      <span class="delta-stat">
        <span class="delta-icon">⭐</span>
        <span class="${rClass}">${rStr} ratings</span>
      </span>
      <span class="delta-meta">${d.runCount} runs · ${d.daysSince}d gap</span>
      ${isStagnant
        ? `<span class="delta-badge badge-stagnant">No activity</span>`
        : `<span class="delta-badge badge-active">Active</span>`}
    </div>`;
}

// ── Render cards ──────────────────────────────────────────────────────────
function renderCards(data) {
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';

  if (data.length === 0) {
    showState('empty');
    document.getElementById('emptySubText').textContent = allClosed.length > 0
      ? `No venues match the current filters. ${allClosed.length} closed venue${allClosed.length !== 1 ? 's' : ''} found total — try loosening filters.`
      : 'No closed venues found here. Try a wider radius or different area.';
    return;
  }

  showState('results');
  document.getElementById('exportBtn').style.display    = 'flex';
  document.getElementById('exportKmlBtn').style.display = 'flex';

  data.forEach((place, i) => {
    const isPerm      = place.business_status === 'CLOSED_PERMANENTLY';
    const mapsUrl     = `https://www.google.com/maps/place/?q=place_id:${place.place_id}`;
    const typeLabel   = getReadableType(place.types);
    const ratingCount = (place.user_ratings_total != null) ? Number(place.user_ratings_total) : 0;
    const deltaHtml   = buildDeltaHtml(place);

    const card = document.createElement('div');
    card.className = `venue-card ${isPerm ? 'perm' : 'temp'}`;
    card.style.animationDelay = `${i * 0.04}s`;
    card.dataset.name = (place.name || '').toLowerCase();
    card.dataset.addr = (place.vicinity || '').toLowerCase();

    const ratingHtml = place.rating
      ? `<span class="star-icon">★</span>
         <span>${place.rating}</span>
         <span class="rating-count">(${ratingCount.toLocaleString()})</span>`
      : `<span style="color:var(--text-3)">No rating</span>`;

    card.innerHTML = `
      <div class="card-top">
        <span class="card-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="card-name">${place.name}</span>
        <span class="status-chip ${isPerm ? 'chip-perm' : 'chip-temp'}">
          ${isPerm ? '● PERM' : '◐ TEMP'}
        </span>
      </div>
      <div class="card-addr">
        <svg class="addr-icon" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        ${place.vicinity || '—'}
      </div>
      <div class="card-meta">
        <span class="card-type">${typeLabel}</span>
        <div class="card-right">
          <div class="card-rating">${ratingHtml}</div>
          <a class="maps-link" href="${mapsUrl}" target="_blank" onclick="event.stopPropagation()">
            Maps
            <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        </div>
      </div>
      ${deltaHtml}
    `;
    grid.appendChild(card);
  });
}

// ── Text search filter ────────────────────────────────────────────────────
function filterTable() {
  const q = document.getElementById('tableSearch').value.toLowerCase();
  document.querySelectorAll('.venue-card').forEach(card => {
    card.style.display = (card.dataset.name.includes(q) || card.dataset.addr.includes(q)) ? '' : 'none';
  });
}

// ── Export KML ────────────────────────────────────────────────────────────
function exportKML() {
  const visible = getVisiblePlaces();
  if (!visible.length) return;

  const areaName  = document.getElementById('areaInput').value.trim() || 'Closed Venues';
  const ICON_PERM = 'http://maps.google.com/mapfiles/ms/icons/red-dot.png';
  const ICON_TEMP = 'http://maps.google.com/mapfiles/ms/icons/yellow-dot.png';

  const placemarks = visible.map(p => {
    const isPerm  = p.business_status === 'CLOSED_PERMANENTLY';
    const lat     = p.geometry?.location?.lat?.() ?? '';
    const lng     = p.geometry?.location?.lng?.() ?? '';
    const rating  = p.rating ? `Rating: ${p.rating} (${p.user_ratings_total || 0} reviews)` : 'No rating';
    const status  = isPerm ? 'Permanently Closed' : 'Temporarily Closed';
    const mapsUrl = `https://www.google.com/maps/place/?q=place_id:${p.place_id}`;
    const icon    = isPerm ? ICON_PERM : ICON_TEMP;
    if (lat === '' || lng === '') return '';

    // Include delta info in KML description
    const d = getDelta(p.place_id);
    const deltaNote = d
      ? `Runs tracked: ${d.runCount} | Photo refs: ${d.prevPhotos}→${d.curPhotos} | Ratings Δ: ${d.ratingsDelta >= 0 ? '+' : ''}${d.ratingsDelta}`
      : 'First scan — no delta yet';

    return `
    <Placemark>
      <name>${escapeXml(p.name)}</name>
      <description><![CDATA[
        <b>${escapeXml(p.name)}</b><br/>
        ${escapeXml(p.vicinity || '')} <br/><br/>
        Status: <b>${status}</b><br/>
        ${rating}<br/>
        ${deltaNote}<br/><br/>
        <a href="${mapsUrl}" target="_blank">Open in Google Maps</a>
      ]]></description>
      <Style><IconStyle><Icon><href>${icon}</href></Icon></IconStyle></Style>
      <Point><coordinates>${lng},${lat},0</coordinates></Point>
    </Placemark>`;
  }).filter(Boolean).join('\n');

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(areaName)} — Closed Venues</name>
    <description>Closed restaurants, cafes and coffee shops in ${escapeXml(areaName)}, Chennai.</description>
    ${placemarks}
  </Document>
</kml>`;

  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `${areaName.replace(/\s+/g, '_')}_closed_venues.kml`;
  a.click();
  document.getElementById('importBanner').classList.add('visible');
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── Shared helper ─────────────────────────────────────────────────────────
function getVisiblePlaces() {
  return [...document.querySelectorAll('.venue-card')]
    .filter(c => c.style.display !== 'none')
    .map(c => allClosed.find(p => (p.name || '').toLowerCase() === c.dataset.name))
    .filter(Boolean);
}

function exportCSV() {
  const visible = getVisiblePlaces();
  if (!visible.length) return;

  const rows = [['Name', 'Address', 'Type', 'Status', 'Rating', 'Total Ratings',
                  'Photo Refs (cur)', 'Photo Delta', 'Ratings Delta', 'Runs Tracked',
                  'Place ID', 'Maps URL']];
  visible.forEach(p => {
    const d = getDelta(p.place_id);
    rows.push([
      `"${p.name}"`,
      `"${p.vicinity || ''}"`,
      `"${getReadableType(p.types)}"`,
      p.business_status,
      p.rating || '',
      p.user_ratings_total || '',
      d ? d.curPhotos   : (p.photos?.length ?? 0),
      d ? d.photoDelta  : 'N/A',
      d ? d.ratingsDelta: 'N/A',
      d ? d.runCount    : 1,
      p.place_id,
      `"https://www.google.com/maps/place/?q=place_id:${p.place_id}"`
    ]);
  });

  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `closed_venues_${document.getElementById('areaInput').value.replace(/\s+/g, '_')}_${Date.now()}.csv`;
  a.click();
}
