// ── Config ──────────────────────────────────────────────────────────────
const API_KEY = 'AIzaSyDqKeq3a0O__Mm7EQLy0zrHYuJUq8Ly1Ps';

// ── State ───────────────────────────────────────────────────────────────
let placesService = null;
let geocoder      = null;
let allResults    = [];
let apiCallCount  = 0;

// Selected radius from pills
let selectedRadius = 1000;

// Filter toggles
let filterPerm = true;
let filterTemp = true;

// ── initMap — called by Google Maps SDK ─────────────────────────────────
function initMap() {
  const map = new google.maps.Map(document.getElementById('map-placeholder'), {
    center: { lat: 13.0827, lng: 80.2707 },
    zoom: 12
  });

  placesService = new google.maps.places.PlacesService(map);
  geocoder      = new google.maps.Geocoder();

  // Autocomplete biased to Chennai
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

// ── Status filter toggle ─────────────────────────────────────────────────
function toggleFilter(type) {
  if (type === 'perm') {
    filterPerm = !filterPerm;
    document.getElementById('pillPerm').classList.toggle('active', filterPerm);
  } else {
    filterTemp = !filterTemp;
    document.getElementById('pillTemp').classList.toggle('active', filterTemp);
  }
}

// ── UI helpers ───────────────────────────────────────────────────────────
function setProgress(pct, text) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressMsg').textContent  = text;
}

function showError(msg) {
  const el = document.getElementById('errorState');
  document.getElementById('errorMsg').textContent = msg;
  el.classList.add('visible');
}

function clearError() {
  document.getElementById('errorState').classList.remove('visible');
}

function showState(name) {
  document.getElementById('emptyState').style.display    = name === 'empty'    ? 'flex'  : 'none';
  document.getElementById('progressState').classList.toggle('visible', name === 'progress');
  document.getElementById('resultsGrid').style.display   = name === 'results'  ? 'grid'  : 'none';
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
// Each radius gets a grid of sub-circles so the whole area is covered.
// sub-radius is small enough to get ≤60 results per point (3 pages × 20).
// Points are spaced at ~0.7× sub-radius to ensure generous overlap.
//
//  selectedRadius | grid  | sub-radius | ~points | ~max API calls
//  500 m          |  1×1  |   500 m    |    1    |    6
//  1000 m         |  3×3  |   500 m    |    9    |   54
//  2000 m         |  5×5  |   600 m    |   25    |  150
//  3000 m         |  7×7  |   600 m    |   49    |  294
//
const GRID_CONFIG = {
  500:  { grid: 1, subRadius: 500  },
  1000: { grid: 3, subRadius: 500  },
  2000: { grid: 5, subRadius: 600  },
  3000: { grid: 7, subRadius: 600  },
};

// Metres per degree (approximate for Chennai lat ~13°)
const M_PER_LAT = 111000;
const M_PER_LNG = 107900;

function buildGridPoints(center, totalRadius) {
  const { grid, subRadius } = GRID_CONFIG[totalRadius] || GRID_CONFIG[1000];
  if (grid === 1) return [center];

  const spacing = subRadius * 0.75; // 75% of sub-radius = good overlap
  const half    = Math.floor(grid / 2);
  const points  = [];

  for (let row = -half; row <= half; row++) {
    for (let col = -half; col <= half; col++) {
      const lat = center.lat() + (row * spacing) / M_PER_LAT;
      const lng = center.lng() + (col * spacing) / M_PER_LNG;
      // Only include points whose centre is within the user's chosen radius
      const distM = Math.sqrt(
        Math.pow(row * spacing, 2) + Math.pow(col * spacing, 2)
      );
      if (distM <= totalRadius + subRadius * 0.5) {
        points.push(new google.maps.LatLng(lat, lng));
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
          // Google requires a short delay before calling nextPage()
          setTimeout(() => pagination.nextPage(), 2200);
        } else {
          resolve(allPlaces);
        }
      } else {
        resolve(allPlaces); // ZERO_RESULTS or error — just return empty
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

  if (!filterPerm && !filterTemp) {
    showError('Select at least one status filter (Permanently or Temporarily Closed).');
    return;
  }

  clearError();
  allResults   = [];
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

    // Build grid of search points covering the full radius
    const gridPoints = buildGridPoints(center, selectedRadius);
    const { subRadius } = GRID_CONFIG[selectedRadius] || GRID_CONFIG[1000];
    const types  = ['restaurant', 'cafe'];
    const allRaw = [];
    const total  = gridPoints.length * types.length;
    let   done   = 0;

    setProgress(15, `Scanning ${gridPoints.length} grid point${gridPoints.length > 1 ? 's' : ''} across the area…`);

    for (const point of gridPoints) {
      for (const type of types) {
        done++;
        const pct = 15 + Math.round((done / total) * 70);
        setProgress(pct, `Scanning point ${done}/${total} — ${type}s…`);
        const res = await nearbySearchOnePoint(point, subRadius, type);
        allRaw.push(...res);
      }
    }

    setProgress(88, 'Deduplicating & filtering…');

    // Deduplicate by place_id
    const seen    = new Set();
    const deduped = allRaw.filter(p => {
      if (seen.has(p.place_id)) return false;
      seen.add(p.place_id);
      return true;
    });

    // Filter by closed status
    const filtered = deduped.filter(p => {
      const s = p.business_status;
      if (filterPerm && s === 'CLOSED_PERMANENTLY') return true;
      if (filterTemp && s === 'CLOSED_TEMPORARILY') return true;
      return false;
    });

    allResults = filtered;
    setProgress(100, `Found ${filtered.length} closed venue${filtered.length !== 1 ? 's' : ''}.`);

    const permCount = filtered.filter(p => p.business_status === 'CLOSED_PERMANENTLY').length;
    const tempCount = filtered.filter(p => p.business_status === 'CLOSED_TEMPORARILY').length;
    document.getElementById('statTotal').textContent = filtered.length;
    document.getElementById('statPerm').textContent  = permCount;
    document.getElementById('statTemp').textContent  = tempCount;
    document.getElementById('statCalls').textContent = apiCallCount;
    document.getElementById('statsBar').classList.add('visible');

    renderCards(filtered);

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
    document.getElementById('emptySubText').textContent =
      'No closed venues found here. Try a wider radius or different area.';
    return;
  }

  showState('results');
  document.getElementById('exportBtn').style.display = 'flex';

  data.forEach((place, i) => {
    const isPerm    = place.business_status === 'CLOSED_PERMANENTLY';
    const mapsUrl   = `https://www.google.com/maps/place/?q=place_id:${place.place_id}`;
    const typeLabel = getReadableType(place.types);

    const card = document.createElement('div');
    card.className = `venue-card ${isPerm ? 'perm' : 'temp'}`;
    card.style.animationDelay = `${i * 0.04}s`;
    card.dataset.name = (place.name || '').toLowerCase();
    card.dataset.addr = (place.vicinity || '').toLowerCase();

    const ratingHtml = place.rating
      ? `<span class="star-icon">★</span>
         <span>${place.rating}</span>
         <span class="rating-count">(${place.user_ratings_total || 0})</span>`
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

// ── Filter table ──────────────────────────────────────────────────────────
function filterTable() {
  const q = document.getElementById('tableSearch').value.toLowerCase();
  document.querySelectorAll('.venue-card').forEach(card => {
    const match = card.dataset.name.includes(q) || card.dataset.addr.includes(q);
    card.style.display = match ? '' : 'none';
  });
}

// ── Export CSV ────────────────────────────────────────────────────────────
function exportCSV() {
  if (!allResults.length) return;
  const rows = [['Name', 'Address', 'Type', 'Status', 'Rating', 'Total Ratings', 'Place ID', 'Maps URL']];
  allResults.forEach(p => {
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
  const area = document.getElementById('areaInput').value.replace(/\s+/g, '_');
  a.download = `closed_venues_${area}_${Date.now()}.csv`;
  a.click();
}
