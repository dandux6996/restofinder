// --- Config ----------------------------------------------------------------
const API_KEY = 'AIzaSyDqKeq3a0O__Mm7EQLy0zrHYuJUq8Ly1Ps';

// --- State -----------------------------------------------------------------
let placesService = null;
let geocoder = null;
let allResults = [];
let apiCallCount = 0;

// --- Called by Google Maps SDK on load (static script tag in index.html) ---
function initMap() {
  const map = new google.maps.Map(document.getElementById('map-placeholder'), {
    center: { lat: 13.0827, lng: 80.2707 },
    zoom: 12
  });

  placesService = new google.maps.places.PlacesService(map);
  geocoder      = new google.maps.Geocoder();

  // Autocomplete restricted to Chennai
  const input        = document.getElementById('areaInput');
  const chennaiBounds = new google.maps.LatLngBounds(
    new google.maps.LatLng(12.8, 79.97),
    new google.maps.LatLng(13.35, 80.55)
  );
  const autocomplete = new google.maps.places.Autocomplete(input, {
    bounds: chennaiBounds,
    strictBounds: false,
    componentRestrictions: { country: 'in' },
    fields: ['name', 'geometry', 'formatted_address']
  });
  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace();
    if (place && place.name) input.value = place.name;
  });
}

// Expose globally so the Maps SDK callback can find it
window.initMap = initMap;

// --- UI helpers ------------------------------------------------------------
function setProgress(pct, text) {
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressText').textContent = text;
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('visible');
}

function clearError() {
  document.getElementById('errorMsg').classList.remove('visible');
}

// --- Core logic ------------------------------------------------------------
function geocodeArea(query) {
  return new Promise((resolve, reject) => {
    geocoder.geocode(
      { address: query + ', Chennai, Tamil Nadu, India' },
      (results, status) => {
        if (status === 'OK' && results[0]) {
          resolve(results[0].geometry.location);
        } else {
          reject(new Error(`Could not locate "${query}" in Chennai. Try a different name or pincode.`));
        }
      }
    );
  });
}

function nearbySearch(location, radius, type) {
  return new Promise((resolve) => {
    apiCallCount++;
    const request = { location, radius, type };
    const allPlaces = [];

    function doPage(nextPageFn) {
      if (nextPageFn) {
        setTimeout(() => nextPageFn.nextPage(), 2000);
      }
    }

    function runSearch(req) {
      placesService.nearbySearch(req, (results, status, pagination) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && results) {
          allPlaces.push(...results);
          if (pagination && pagination.hasNextPage) {
            apiCallCount++;
            setTimeout(() => pagination.nextPage(), 2000);
          } else {
            resolve(allPlaces);
          }
        } else {
          resolve(allPlaces);
        }
      });
    }

    runSearch(request);
  });
}

function getReadableTypes(types) {
  const nice = ['restaurant', 'cafe', 'bar', 'bakery', 'food', 'meal_takeaway', 'meal_delivery'];
  const found = types.filter(t => nice.includes(t));
  if (found.length === 0) return types[0]?.replace(/_/g, ' ') || '—';
  return found[0].replace(/_/g, ' ');
}

async function startSearch() {
  const area = document.getElementById('areaInput').value.trim();
  if (!area) { showError('Please enter an area name or pincode.'); return; }

  const filterPerm = document.getElementById('filterPerm').checked;
  const filterTemp = document.getElementById('filterTemp').checked;
  if (!filterPerm && !filterTemp) { showError('Please select at least one status filter.'); return; }

  const radius = parseInt(document.getElementById('radiusInput').value);

  clearError();
  allResults  = [];
  apiCallCount = 0;

  document.getElementById('emptyState').style.display    = 'none';
  document.getElementById('tableWrap').classList.remove('visible');
  document.getElementById('progressWrap').classList.add('visible');
  document.getElementById('runBtn').disabled             = true;
  document.getElementById('exportBtn').classList.remove('visible');
  document.getElementById('resultCount').textContent     = '';
  ['statTotal','statPerm','statTemp','statCalls'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });

  try {
    if (!placesService || !geocoder) {
      throw new Error('Google Maps SDK not ready yet. Please wait a moment and try again.');
    }

    setProgress(15, `Locating "${area}" in Chennai…`);
    const center = await geocodeArea(area);

    const types  = ['restaurant', 'cafe'];
    const allRaw = [];

    for (let i = 0; i < types.length; i++) {
      setProgress(25 + (i * 30), `Scanning for ${types[i]}s in the area…`);
      const results = await nearbySearch(center, radius, types[i]);
      allRaw.push(...results);
    }

    setProgress(85, 'Filtering closed venues…');

    const seen   = new Set();
    const deduped = allRaw.filter(p => {
      if (seen.has(p.place_id)) return false;
      seen.add(p.place_id);
      return true;
    });

    const filtered = deduped.filter(p => {
      const s = p.business_status;
      if (filterPerm && s === 'CLOSED_PERMANENTLY')  return true;
      if (filterTemp && s === 'CLOSED_TEMPORARILY')  return true;
      return false;
    });

    allResults = filtered;
    setProgress(100, 'Done!');

    const permCount = filtered.filter(p => p.business_status === 'CLOSED_PERMANENTLY').length;
    const tempCount = filtered.filter(p => p.business_status === 'CLOSED_TEMPORARILY').length;
    document.getElementById('statTotal').textContent = filtered.length;
    document.getElementById('statPerm').textContent  = permCount;
    document.getElementById('statTemp').textContent  = tempCount;
    document.getElementById('statCalls').textContent = apiCallCount;

    renderTable(filtered);

  } catch (err) {
    showError(err.message);
    document.getElementById('emptyState').style.display = 'flex';
  } finally {
    document.getElementById('progressWrap').classList.remove('visible');
    document.getElementById('runBtn').disabled = false;
  }
}

function renderTable(data) {
  const tbody = document.getElementById('resultsBody');
  tbody.innerHTML = '';

  if (data.length === 0) {
    document.getElementById('tableWrap').classList.remove('visible');
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('emptyState').querySelector('.empty-text').textContent =
      'No closed venues found in this area.\nTry expanding the radius or a different area.';
    document.getElementById('resultCount').textContent = '';
    return;
  }

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('tableWrap').classList.add('visible');
  document.getElementById('resultCount').textContent = `— ${data.length} venues`;
  document.getElementById('exportBtn').classList.add('visible');

  data.forEach((place, i) => {
    const isPerm = place.business_status === 'CLOSED_PERMANENTLY';
    const tr     = document.createElement('tr');
    tr.className = isPerm ? 'perm' : 'temp';

    const statusBadge = isPerm
      ? `<span class="status-badge badge-perm">● PERM. CLOSED</span>`
      : `<span class="status-badge badge-temp">● TEMP. CLOSED</span>`;

    const rating = place.rating
      ? `<span class="star">★</span> ${place.rating} <span style="color:var(--muted);font-size:10px;">(${place.user_ratings_total || 0})</span>`
      : `<span style="color:var(--muted)">—</span>`;

    const mapsUrl = `https://www.google.com/maps/place/?q=place_id:${place.place_id}`;

    tr.innerHTML = `
      <td style="color:var(--muted);font-family:'Space Mono',monospace;font-size:11px;">${i + 1}</td>
      <td class="name">${place.name}</td>
      <td class="addr">${place.vicinity || '—'}</td>
      <td class="type-cell">${getReadableTypes(place.types || [])}</td>
      <td>${statusBadge}</td>
      <td class="rating-cell">${rating}</td>
      <td><a href="${mapsUrl}" target="_blank">View ↗</a></td>
    `;
    tr.dataset.name = (place.name || '').toLowerCase();
    tr.dataset.addr = (place.vicinity || '').toLowerCase();
    tbody.appendChild(tr);
  });
}

function filterTable() {
  const q = document.getElementById('tableSearch').value.toLowerCase();
  document.querySelectorAll('#resultsBody tr').forEach(tr => {
    const match = tr.dataset.name.includes(q) || tr.dataset.addr.includes(q);
    tr.style.display = match ? '' : 'none';
  });
}

function exportCSV() {
  if (!allResults.length) return;
  const rows = [['Name', 'Address', 'Type', 'Status', 'Rating', 'Total Ratings', 'Place ID', 'Maps URL']];
  allResults.forEach(p => {
    rows.push([
      `"${p.name}"`,
      `"${p.vicinity || ''}"`,
      `"${getReadableTypes(p.types || [])}"`,
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
