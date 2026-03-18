// ── Config ──────────────────────────────────────────────────────────────
const API_KEY = 'AIzaSyDqKeq3a0O__Mm7EQLy0zrHYuJUq8Ly1Ps';

// ── State ───────────────────────────────────────────────────────────────
let placesService  = null;
let geocoder       = null;
let allClosed      = [];   // all closed venues after dedup — source of truth, never filtered
let apiCallCount   = 0;

let selectedRadius   = 1000;
let filterPerm       = true;
let filterTemp       = true;
let filterMinRatings = 10;

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

// ── Ratings filter pills — re-render on change ───────────────────────────
document.querySelectorAll('#ratingsPills .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ratingsPills .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterMinRatings = parseInt(btn.dataset.val);
    if (allClosed.length > 0) applyFiltersAndRender();
  });
});

// ── Status filter toggle — re-render on change ───────────────────────────
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

// ── Apply all display filters and re-render ───────────────────────────────
function applyFiltersAndRender() {
  const filtered = allClosed.filter(p => {
    // Status filter
    const s = p.business_status;
    const statusOk = (filterPerm && s === 'CLOSED_PERMANENTLY') ||
                     (filterTemp && s === 'CLOSED_TEMPORARILY');
    if (!statusOk) return false;

    // Ratings filter — treat missing/undefined as 0
    const ratingCount = (p.user_ratings_total != null && !isNaN(p.user_ratings_total))
      ? Number(p.user_ratings_total)
      : 0;
    return ratingCount >= filterMinRatings;
  });

  // Update stats to reflect current filter view
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
        else reject(new Error(`Could not locate "${query}" in Chennai. Try a different name or pincode.`));
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
          setTimeout(() => pagination.nextPage(), 2200);
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
  const nice = ['restaurant', 'cafe', 'bar', 'bakery', 'food', 'meal_takeaway', 'meal_delivery'];
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
  document.getElementById('exportBtn').style.display = 'none';
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
    const types  = ['restaurant', 'cafe'];
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

    // Deduplicate by place_id
    const seen = new Set();
    const deduped = allRaw.filter(p => {
      if (seen.has(p.place_id)) return false;
      seen.add(p.place_id);
      return true;
    });

    // Keep only closed venues — NO ratings filter here, that's applied at render time
    allClosed = deduped.filter(p => {
      const s = p.business_status;
      return s === 'CLOSED_PERMANENTLY' || s === 'CLOSED_TEMPORARILY';
    });

    setProgress(100, `Found ${allClosed.length} closed venue${allClosed.length !== 1 ? 's' : ''}.`);

    document.getElementById('statCalls').textContent = apiCallCount;
    document.getElementById('statsBar').classList.add('visible');

    // Apply display filters (status + ratings) and render
    applyFiltersAndRender();

  } catch (err) {
    showError(err.message);
    showState('empty');
    document.getElementById('emptySubText').textContent = 'Something went wrong. Check the error above and try again.';
  } finally {
    document.getElementById('runBtn').disabled = false;
  }
}

// ── Render cards ──────────────────────────────────────────────────────────
function renderCards(data) {
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';

  if (data.length === 0) {
    showState('empty');
    const minR = filterMinRatings;
    document.getElementById('emptySubText').textContent = allClosed.length > 0
      ? `No venues match the current filters. ${allClosed.length} closed venue${allClosed.length !== 1 ? 's' : ''} found total — try loosening the Min. Ratings filter.`
      : 'No closed venues found here. Try a wider radius or different area.';
    return;
  }

  showState('results');
  document.getElementById('exportBtn').style.display = 'flex';

  data.forEach((place, i) => {
    const isPerm      = place.business_status === 'CLOSED_PERMANENTLY';
    const mapsUrl     = `https://www.google.com/maps/place/?q=place_id:${place.place_id}`;
    const typeLabel   = getReadableType(place.types);
    const ratingCount = (place.user_ratings_total != null) ? Number(place.user_ratings_total) : 0;

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

// ── Export CSV ────────────────────────────────────────────────────────────
function exportCSV() {
  // Export the currently filtered view, not allClosed
  const visible = [...document.querySelectorAll('.venue-card')]
    .filter(c => c.style.display !== 'none')
    .map(c => {
      const idx = parseInt(c.querySelector('.card-num').textContent) - 1;
      return allClosed.find(p => (p.name || '').toLowerCase() === c.dataset.name);
    })
    .filter(Boolean);

  if (!visible.length) return;

  const rows = [['Name', 'Address', 'Type', 'Status', 'Rating', 'Total Ratings', 'Place ID', 'Maps URL']];
  visible.forEach(p => {
    rows.push([
      `"${p.name}"`,
      `"${p.vicinity || ''}"`,
      `"${getReadableType(p.types)}"`,
      p.business_status,
      p.rating || '',
      p.user_ratings_total || '',
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
