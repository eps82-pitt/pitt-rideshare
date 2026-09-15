/**
 * PittRide — frontend
 *
 * No framework and no build step. State lives in a handful of module-level
 * variables; `renderAll()` redraws from that state. Mutations are optimistic:
 * local state changes and the UI repaints immediately, then reconciles against
 * the server on the next sync, because the Apps Script backend has latency
 * measured in seconds rather than milliseconds.
 *
 * The API URL is supplied by config.js, which is gitignored.
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration and state
// ---------------------------------------------------------------------------

const API_URL = (window.PITTRIDE_CONFIG || {}).apiUrl;

const SYNC_INTERVAL_MS = 30000;
const SYNC_THROTTLE_MS = 10000;
const CHAT_POLL_MS = 8000;
const FARE_DEBOUNCE_MS = 1000;
const TOAST_DURATION_MS = 2200;

const PITT = { lat: 40.4406, lon: -79.9959 };

const DEPARTURE_ICONS = {
  'Early Morning': '🌅',
  'Morning': '☀️',
  'Afternoon': '🌤',
  'Evening': '🌆',
  'Late Night': '🌙',
  'Flexible': '🕐',
};

const NOTIFICATION_ICONS = {
  new_booking: '✅',
  waitlist_promoted: '🎉',
  ride_alert: '🔔',
  payment: '💰',
};

let session = JSON.parse(localStorage.getItem('ps') || 'null');
let rides = JSON.parse(localStorage.getItem('pd') || '[]');
let notifications = [];

let activeDirection = 'Leaving Pitt';
let dateFilter = 'all';
let filters = { cheap: false, women: false, trunk: false, quiet: false };

let userRole = 'user';
let userGender = 'Unknown';
let userCar = '';

let mapVisible = false;
let leafletMap = null;
let markerLayer = null;

let registerMode = false;
let lastSyncAt = 0;
let activeChatRideId = null;
let chatPollTimer = null;
let fareTimer = null;
let selectedRating = 0;
let confirmResolver = null;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark'
    ? 'light'
    : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('pt', next);
}

function applyStoredTheme() {
  const stored = localStorage.getItem('pt');
  if (stored) {
    document.documentElement.setAttribute('data-theme', stored);
  } else if (matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function toast(message, success = true) {
  const el = document.createElement('div');
  el.className = 'tt ' + (success ? 'ok' : 'er');
  el.innerHTML = `<span>${success ? '✓' : '!'}</span>${message}`;
  $('tw').appendChild(el);

  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }, TOAST_DURATION_MS);
}

/** Deterministic avatar colour so a given name always gets the same hue. */
function colorFromString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 48%, 50%)`;
}

function initialsFrom(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  const first = parts[0][0] || '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  } catch (err) {
    return value;
  }
}

function timeAgo(timestamp) {
  const minutes = Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

function isToday(value) {
  return new Date().toDateString() === new Date(value).toDateString();
}

function isTomorrow(value) {
  const target = new Date();
  target.setDate(target.getDate() + 1);
  return target.toDateString() === new Date(value).toDateString();
}

function isThisWeekend(value) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daysToSaturday = (6 - today.getDay() + 7) % 7 || 7;
  const saturday = new Date(today);
  saturday.setDate(today.getDate() + daysToSaturday);
  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);

  const target = new Date(value).toDateString();
  return target === saturday.toDateString() || target === sunday.toDateString();
}

function hasDeparted(value) {
  const end = new Date(value);
  end.setHours(23, 59, 59, 999);
  return end < new Date();
}

function routeLabel(ride) {
  return ride.direction === 'Returning to Pitt'
    ? ride.destination + ' → Pitt'
    : ride.destination;
}

function riderEmails(ride) {
  return String(ride.riders || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function callApi(payload) {
  const response = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify(Object.assign({
      token: session && session.token,
      email: session && session.email,
    }, payload)),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

/** Promise-based replacement for window.confirm, styled to match the app. */
function confirmDialog(icon, title, message, confirmLabel = 'Confirm', confirmClass = 'bp') {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $('cf-icon').textContent = icon;
    $('cf-title').textContent = title;
    $('cf-msg').textContent = message;

    const button = $('cf-ok');
    button.textContent = confirmLabel;
    button.className = 'bt bs ' + confirmClass;

    $('cfmod').classList.add('open');
  });
}

function resolveConfirm(value) {
  if (confirmResolver) confirmResolver(value);
  confirmResolver = null;
  $('cfmod').classList.remove('open');
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function showAuthForm(existingAccount) {
  $('onboard-screen').style.display = 'none';
  $('auth-form').style.display = 'block';
  if (existingAccount) {
    registerMode = false;
    updateAuthLabels();
  }
}

function updateAuthLabels() {
  $('rfs').style.display = registerMode ? 'block' : 'none';
  $('atit').textContent = registerMode ? 'Create account' : 'Sign in';
  $('asub').textContent = registerMode
    ? 'Sign up with your @pitt.edu email'
    : 'Use your @pitt.edu email';
  $('abtn').textContent = registerMode ? 'Create Account' : 'Sign In';
  $('rtog').textContent = registerMode
    ? 'Have an account? Sign in'
    : 'Need an account? Sign up';
}

function toggleRegisterMode() {
  registerMode = !registerMode;
  updateAuthLabels();
}

async function submitAuth() {
  const email = $('em').value.trim();
  const password = $('pw').value;
  const button = $('abtn');

  if (!email || !password) return toast('Fill in all fields', false);

  const payload = {
    action: registerMode ? 'register' : 'login',
    email,
    password,
  };

  if (registerMode) {
    payload.name = $('rn').value;
    payload.gender = $('rg').value;
    if (!payload.name || !payload.gender) {
      return toast('Name and gender are required', false);
    }
  }

  const restoreButton = () => {
    button.classList.remove('bt-loading');
    button.textContent = registerMode ? 'Create Account' : 'Sign In';
    button.disabled = false;
  };

  button.classList.add('bt-loading');
  button.disabled = true;

  try {
    const result = await callApi(payload);
    if (result.status !== 'success') {
      toast(result.message, false);
      return restoreButton();
    }
    session = { email, token: result.token };
    userRole = result.role || 'user';
    localStorage.setItem('ps', JSON.stringify(session));
    location.reload();
  } catch (err) {
    toast('Network error', false);
    restoreButton();
  }
}

function logout() {
  callApi({ action: 'logout' }).finally(() => {
    localStorage.clear();
    location.reload();
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function syncRides(force) {
  if (!session) return;
  if (!force && Date.now() - lastSyncAt < SYNC_THROTTLE_MS) return;

  if (rides.length === 0) $('skel').style.display = 'block';

  try {
    const result = await callApi({ action: 'getRides' });
    if (result.status === 'success') {
      rides = result.data;
      localStorage.setItem('pd', JSON.stringify(rides));
      lastSyncAt = Date.now();
      renderAll();
      if (mapVisible) updateMapMarkers();
    } else if (result.status === 'unauthorized') {
      logout();
    }
  } catch (err) {
    /* offline: keep showing the cached rides */
  }

  $('skel').style.display = 'none';
  pollNotifications();
}

async function pollNotifications() {
  if (!session) return;
  try {
    const result = await callApi({ action: 'getNotifications' });
    notifications = result.data || [];
    $('nd').style.display = result.unread > 0 ? 'block' : 'none';
  } catch (err) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

function setDirection(direction) {
  activeDirection = direction;
  $('bo').className = 'db' + (direction === 'Leaving Pitt' ? ' on' : '');
  $('br').className = 'db' + (direction === 'Returning to Pitt' ? ' on' : '');
  renderAll();
  if (mapVisible) updateMapMarkers();
}

function setDateFilter(value) {
  dateFilter = value;
  document.querySelectorAll('.dc').forEach(chip => chip.classList.remove('on'));
  $('dc-' + value).classList.add('on');
  renderAll();
}

function toggleFilter(name) {
  filters[name] = !filters[name];
  $('fc-' + name).classList.toggle('on');
  renderAll();
  if (mapVisible) updateMapMarkers();
}

/** Applies the active direction, search text, chips and sort to `rides`. */
function visibleRides() {
  const query = $('srch').value.toLowerCase();

  let result = rides.filter((ride) => {
    if (ride.direction !== activeDirection) return false;

    const haystack = (ride.destination + ' ' + (ride.waypoints || '')).toLowerCase();
    if (!haystack.includes(query)) return false;

    // Mirrors the server-side rule so cached rides stay consistent.
    const restricted = ride.affinity === 'Women Only';
    const participant = ride.email === session.email ||
      riderEmails(ride).indexOf(session.email) !== -1;
    if (restricted && userGender !== 'Female' && !participant) return false;

    return true;
  });

  if (filters.cheap) result = result.filter(r => r.price <= 30);
  if (filters.women) result = result.filter(r => r.affinity === 'Women Only');
  if (filters.trunk) result = result.filter(r => r.luggage === 'Large Trunk Space');
  if (filters.quiet) result = result.filter(r => r.vibe === 'Quiet');

  if (dateFilter === 'today') result = result.filter(r => isToday(r.date));
  else if (dateFilter === 'tmrw') result = result.filter(r => isTomorrow(r.date));
  else if (dateFilter === 'wknd') result = result.filter(r => isThisWeekend(r.date));

  const sortKey = $('srt').value;
  result.sort((a, b) => {
    // Departed rides always sink, whatever the chosen sort.
    const aPast = hasDeparted(a.date);
    const bPast = hasDeparted(b.date);
    if (aPast !== bPast) return aPast ? 1 : -1;

    if (sortKey === 'date') return new Date(a.date) - new Date(b.date);
    if (sortKey === 'price') return a.price - b.price;
    if (sortKey === 'priceh') return b.price - a.price;
    if (sortKey === 'seats') return b.seats - a.seats;
    return 0;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderRideList();
  renderTrips();
  renderProfileActivity();
}

function rideActions(ride) {
  const mine = ride.email === session.email;
  const booked = riderEmails(ride).indexOf(session.email) !== -1;
  const waitlisted = String(ride.waitlist || '').includes(session.email);
  const past = hasDeparted(ride.date);

  const rate = `<button class="bt bo bs" onclick="openRatingModal('${ride.email}','${ride.id}','${ride.name}')">⭐ Rate</button>`;

  if (past) {
    if (booked) {
      return `<button class="bt bo bs" onclick="openRatingModal('${ride.email}','${ride.id}','${ride.name}')">⭐ Rate Driver</button>`;
    }
    if (mine) {
      return `<button class="bt bd bs" onclick="deleteRide('${ride.id}')">Remove</button>`;
    }
    return '<button class="bt bo bs" disabled>Expired</button>';
  }

  if (mine) {
    return `<div class="brow">
      <button class="bt bg bs" onclick="openEditModal('${ride.id}')">Edit</button>
      <button class="bt bd bs" onclick="deleteRide('${ride.id}')">Delete</button>
    </div>`;
  }
  if (booked) {
    return `<div class="brow">
      <button class="bt bo bs" onclick="cancelSeat('${ride.id}')">Cancel</button>
      ${rate}
    </div>`;
  }
  if (ride.seats > 0) {
    return `<button class="bt bp bs" onclick="bookSeat('${ride.id}')">Claim Seat</button>`;
  }
  if (waitlisted) {
    return '<button class="bt bo bs" disabled>Waitlisted</button>';
  }
  return `<button class="bt bo bs" onclick="joinWaitlist('${ride.id}')">Join Waitlist</button>`;
}

function seatDots(ride) {
  const booked = riderEmails(ride).length;
  const total = ride.seats + booked;
  let dots = '';
  for (let i = 0; i < Math.min(total, 6); i++) {
    dots += `<div class="sd${i < booked ? ' tk' : ''}"></div>`;
  }
  return dots;
}

function riderAvatars(ride) {
  const names = ride.riderNames || [];
  if (names.length === 0) return '';

  const avatars = names.slice(0, 4).map(name =>
    `<div class="rider-mini" style="background:${colorFromString(name)}" title="${name}">${initialsFrom(name)}</div>`
  ).join('');

  const overflow = names.length > 4
    ? `<span class="rider-count">+${names.length - 4}</span>`
    : '';

  const firstNames = names.slice(0, 3).map(n => n.split(' ')[0]).join(', ') +
    (names.length > 3 ? ' +more' : '');

  return `<div class="rider-row">${avatars}${overflow}<span class="rider-count">${firstNames}</span></div>`;
}

function rideCard(ride) {
  const mine = ride.email === session.email;
  const booked = riderEmails(ride).indexOf(session.email) !== -1;
  const past = hasDeparted(ride.date);
  const label = routeLabel(ride);

  const departure = ride.time && ride.time !== 'Flexible'
    ? `<span>${DEPARTURE_ICONS[ride.time] || '🕐'} ${ride.time}</span>`
    : '<span>🕐 Flexible</span>';

  const chat = (!past && (booked || mine))
    ? `<button class="bt bo bs" style="margin-top:5px" onclick="openChat('${ride.id}')">💬 Chat</button>`
    : '';

  const payments = ((booked || mine) && !past)
    ? `<button class="bt bo bs" style="margin-top:5px" onclick="openPaymentModal('${ride.id}')">💰 Payments</button>`
    : '';

  const waypoints = ride.waypoints ? `<div class="wp">↳ Via ${ride.waypoints}</div>` : '';
  const verified = ride.verified ? '<span class="vbadge">✓ Verified</span>' : '';
  const restricted = ride.affinity === 'Women Only'
    ? '<span class="tg tg-w">Women Only</span>'
    : '';
  const policy = ride.cancelPolicy && ride.cancelPolicy !== 'Flexible'
    ? `<span class="tg tg-cancel">${ride.cancelPolicy}</span>`
    : '';

  const pickup = ride.pickupLabel
    ? `<div class="pickup-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${ride.pickupLabel}</div>`
    : '';

  return `<div class="rc${mine ? ' mine' : ''}${booked ? ' booked' : ''}${past ? ' expired' : ''}"
    role="article" aria-label="Ride to ${label} by ${ride.name}">
    <div class="top">
      <div class="av" style="background:${colorFromString(ride.name)}" aria-hidden="true">${initialsFrom(ride.name)}</div>
      <div class="di">
        <div class="dn">${ride.name}${verified}</div>
        <div class="dm">${ride.direction}</div>
      </div>
      <div class="pr" aria-label="$${ride.price} per seat">$${ride.price}</div>
    </div>
    <div class="dst">${label}</div>${waypoints}${pickup}
    <div class="meta-row">
      <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${formatDate(ride.date)}</span>
      ${departure}
    </div>
    <div class="tags">
      <span class="tg">${ride.vibe}</span>
      <span class="tg">${ride.music}</span>
      <span class="tg">${ride.luggage}</span>
      ${restricted}${policy}
    </div>
    <div class="seats-vis">${seatDots(ride)}<span class="sl">${ride.seats} left</span></div>
    ${riderAvatars(ride)}
    ${ride.notes ? `<div class="nt">${ride.notes}</div>` : ''}
    <div class="actions">${rideActions(ride)}${chat}${payments}</div>
  </div>`;
}

const EMPTY_RIDES = `<div class="emp">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 15h8M9 9h.01M15 9h.01"/></svg>
  <p>No rides match</p><p class="sub">Try different filters or dates</p>
</div>`;

const EMPTY_TRIPS = `<div class="emp">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>
  <p>No trips yet</p><p class="sub">Book or post a ride</p>
</div>`;

function renderRideList() {
  const matches = visibleRides();
  $('cnt').textContent = matches.length + ' ride' + (matches.length === 1 ? '' : 's');
  $('rl').innerHTML = matches.map(rideCard).join('') || EMPTY_RIDES;
}

/** Google Calendar template link, defaulting to a 2pm–4pm block. */
function calendarLink(ride) {
  const day = new Date(ride.date).toISOString().replace(/[-:]|\.\d+/g, '').substring(0, 8);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Ride to ' + routeLabel(ride),
    dates: `${day}T140000Z/${day}T160000Z`,
    details: 'Driver: ' + ride.name,
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

function myRides() {
  return rides.filter(ride =>
    ride.email === session.email ||
    riderEmails(ride).indexOf(session.email) !== -1
  );
}

function renderTrips() {
  const cards = myRides().map((ride) => {
    const past = hasDeparted(ride.date);
    const departure = ride.time && ride.time !== 'Flexible' ? ' · ' + ride.time : '';

    const actions = past
      ? `<button class="bt bo bs" onclick="openRatingModal('${ride.email}','${ride.id}','${ride.name}')">⭐ Rate</button>`
      : `<button class="bt bg bs" onclick="window.open('${calendarLink(ride)}')">📅 Calendar</button>
         <button class="bt bo bs" onclick="openChat('${ride.id}')">💬 Chat</button>`;

    return `<div class="tc" style="${past ? 'opacity:.5' : ''}">
      <div class="dst">${routeLabel(ride)}${past ? ' <span style="font-size:.6em;color:var(--err);font-weight:700">PAST</span>' : ''}</div>
      <div class="meta">${formatDate(ride.date)}${departure} · ${ride.name}</div>
      <div class="brow">${actions}</div>
    </div>`;
  });

  $('tl').innerHTML = cards.join('') || EMPTY_TRIPS;
}

function renderProfileActivity() {
  const posted = rides.filter(r => r.email === session.email).length;
  const booked = rides.filter(r => riderEmails(r).indexOf(session.email) !== -1).length;

  $('ps-rides').textContent = posted;
  $('ps-booked').textContent = booked;

  const history = myRides().map((ride) => {
    const role = ride.email === session.email ? 'Driver' : 'Rider';
    return `<div class="ph-item">
      <div>
        <div class="ph-dest">${routeLabel(ride)}</div>
        <div class="ph-meta">${formatDate(ride.date)} · ${role}</div>
      </div>
      <div class="ph-price">$${ride.price}</div>
    </div>`;
  });

  $('ph-list').innerHTML = history.join('') ||
    '<p style="color:var(--t3);font-size:.82em">No ride history yet.</p>';
}

// ---------------------------------------------------------------------------
// Ride mutations (optimistic)
// ---------------------------------------------------------------------------

async function bookSeat(id) {
  const ride = rides.find(r => String(r.id) === String(id));
  if (!ride) return;
  if (hasDeparted(ride.date)) return toast('This ride has expired', false);

  const confirmed = await confirmDialog('🎟️', 'Claim Seat?',
    `Book a seat on ${ride.name}'s ride to ${ride.destination} for $${ride.price}?`,
    'Claim Seat', 'bp');
  if (!confirmed) return;

  ride.seats -= 1;
  ride.riders = riderEmails(ride).concat([session.email]).join(',');
  renderAll();
  toast('Confirmed!');

  callApi({ action: 'bookSeat', id }).then(() => syncRides(true));
}

async function cancelSeat(id) {
  const confirmed = await confirmDialog('🚫', 'Cancel Booking?',
    'Your seat will be released and someone on the waitlist may take it.',
    'Cancel Seat', 'bd');
  if (!confirmed) return;

  const ride = rides.find(r => String(r.id) === String(id));
  if (ride) {
    ride.seats += 1;
    ride.riders = riderEmails(ride).filter(e => e !== session.email).join(',');
    renderAll();
    toast('Cancelled');
  }

  callApi({ action: 'cancelSeat', id }).then(() => syncRides(true));
}

async function deleteRide(id) {
  const confirmed = await confirmDialog('🗑️', 'Delete Ride?',
    'This will permanently remove the ride and notify all booked riders.',
    'Delete', 'bd');
  if (!confirmed) return;

  rides = rides.filter(r => String(r.id) !== String(id));
  renderAll();
  toast('Deleted');

  callApi({ action: 'deleteRide', id }).then(() => syncRides(true));
}

async function joinWaitlist(id) {
  const ride = rides.find(r => String(r.id) === String(id));
  if (!ride) return;
  if (hasDeparted(ride.date)) return toast('This ride has expired', false);

  const confirmed = await confirmDialog('⏳', 'Join Waitlist?',
    `You'll be notified if a seat opens up on this ride to ${ride.destination}.`,
    'Join', 'bp');
  if (!confirmed) return;

  ride.waitlist = (ride.waitlist ? ride.waitlist + ',' : '') + session.email;
  renderAll();
  toast('Waitlisted');

  callApi({ action: 'joinWaitlist', id }).then(() => syncRides(true));
}

// ---------------------------------------------------------------------------
// Posting and editing
// ---------------------------------------------------------------------------

function updateDestinationLabel() {
  const returning = $('pd').value === 'Returning to Pitt';
  $('pde-label').textContent = returning ? 'Coming From' : 'Destination';
  $('pde').placeholder = returning
    ? "e.g. Philadelphia (where you're leaving from)"
    : 'e.g. Philadelphia';
}

/**
 * Geocodes the typed destination and suggests a per-seat fare.
 *
 * Great-circle distance is inflated by 25% to approximate road distance, then
 * costed at roughly 3.50 per 25 miles of fuel plus 0.05/mile of wear and a flat
 * 5, split across the driver and every seat.
 */
function suggestFare(destinationId, latId, lonId, hintId, seatsId) {
  clearTimeout(fareTimer);

  const destination = $(destinationId).value.trim();
  const seats = parseInt($(seatsId).value, 10) || 3;
  if (!destination) return;

  fareTimer = setTimeout(async () => {
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
        encodeURIComponent(destination + ', USA');
      const matches = await (await fetch(url)).json();
      if (matches.length === 0) return;

      const { lat, lon } = matches[0];
      $(latId).value = lat;
      $(lonId).value = lon;

      const toRad = (deg) => deg * Math.PI / 180;
      const dLat = toRad(lat - PITT.lat);
      const dLon = toRad(lon - PITT.lon);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(PITT.lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
      const miles = 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.25;

      const cost = (miles / 25) * 3.5 + miles * 0.05 + 5;
      const perSeat = Math.max(5, Math.ceil(cost / (1 + seats)));

      $(hintId).textContent = `~${Math.round(miles)} mi · $${perSeat}/seat suggested`;
    } catch (err) {
      /* geocoding is advisory only */
    }
  }, FARE_DEBOUNCE_MS);
}

function postFormValues() {
  return {
    id: Date.now(),
    name: $('pfn').value || 'Driver',
    destination: $('pde').value,
    waypoints: $('pst').value,
    date: $('pda').value,
    seats: $('pse').value,
    price: $('ppr').value,
    direction: $('pd').value,
    affinity: $('paf').value,
    vibe: $('pvi').value,
    music: $('pmu').value,
    luggage: $('plu').value,
    notes: $('pno').value,
    lat: $('pla').value,
    lon: $('plo').value,
    time: $('ptm').value,
    cancelPolicy: $('pcp').value,
    pickupLabel: $('ppl').value,
  };
}

async function postRide() {
  const button = $('post-btn');
  const payload = Object.assign({ action: 'addRide' }, postFormValues());

  if (!payload.destination || !payload.date || !payload.seats || !payload.price) {
    return toast('Fill in the required fields', false);
  }
  if (new Date(payload.date) < new Date(new Date().toDateString())) {
    return toast('Date must be today or later', false);
  }
  const seats = parseInt(payload.seats, 10);
  if (seats < 1 || seats > 6) return toast('Seats must be 1 to 6', false);
  const price = parseFloat(payload.price);
  if (price < 0 || price > 500) return toast('Price must be $0 to $500', false);

  button.classList.add('bt-loading');
  button.disabled = true;

  try {
    await callApi(payload);
    ['pde', 'pst', 'pno', 'ppl'].forEach(id => { $(id).value = ''; });
    toast('Posted!');
    syncRides(true);

    const tripsTab = document.querySelector('.ni[data-t="trips"]');
    if (tripsTab) switchView(tripsTab);
  } catch (err) {
    toast('Error posting ride', false);
  }

  button.classList.remove('bt-loading');
  button.disabled = false;
  button.textContent = 'Post Ride';
}

function openEditModal(id) {
  const ride = rides.find(r => String(r.id) === String(id));
  if (!ride) return;

  const fields = {
    ei: ride.id, edi: ride.direction, ede: ride.destination,
    ela: ride.lat, elo: ride.lon, est: ride.waypoints || '',
    eda: String(ride.date || '').split('T')[0], ese: ride.seats, epr: ride.price,
    eaf: ride.affinity, evi: ride.vibe, emu: ride.music, elu: ride.luggage,
    eno: ride.notes, etm: ride.time || 'Flexible',
    ecp: ride.cancelPolicy || 'Flexible', epl: ride.pickupLabel || '',
  };
  Object.keys(fields).forEach(id2 => { $(id2).value = fields[id2]; });

  $('emod').classList.add('open');
}

function closeEditModal() {
  $('emod').classList.remove('open');
}

async function submitEdit() {
  const payload = {
    action: 'editRide',
    id: $('ei').value,
    destination: $('ede').value,
    waypoints: $('est').value,
    date: $('eda').value,
    seats: $('ese').value,
    price: $('epr').value,
    direction: $('edi').value,
    affinity: $('eaf').value,
    vibe: $('evi').value,
    music: $('emu').value,
    luggage: $('elu').value,
    notes: $('eno').value,
    lat: $('ela').value,
    lon: $('elo').value,
    time: $('etm').value,
    cancelPolicy: $('ecp').value,
    pickupLabel: $('epl').value,
  };

  closeEditModal();
  toast('Saving…');
  await callApi(payload);
  syncRides(true);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function toggleMap() {
  mapVisible = !mapVisible;
  const container = $('mapbox');

  if (!mapVisible) {
    container.style.display = 'none';
    $('rl').style.display = '';
    return;
  }

  container.style.display = 'block';
  $('rl').style.display = 'none';

  if (!leafletMap) {
    leafletMap = L.map('mapbox').setView([PITT.lat, PITT.lon], 6);
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { attribution: '' }
    ).addTo(leafletMap);
    markerLayer = L.layerGroup().addTo(leafletMap);
  }

  setTimeout(() => {
    leafletMap.invalidateSize();
    updateMapMarkers();
  }, 100);
}

function updateMapMarkers() {
  if (!leafletMap) return;
  markerLayer.clearLayers();

  const bounds = [];
  visibleRides()
    .filter(ride => ride.lat && !hasDeparted(ride.date))
    .forEach((ride) => {
      const marker = L.marker([ride.lat, ride.lon]);
      marker.bindPopup(`<b>${routeLabel(ride)}</b><br>$${ride.price} · ${ride.seats} seats`);
      markerLayer.addLayer(marker);
      bounds.push([ride.lat, ride.lon]);
    });

  if (bounds.length > 0) {
    leafletMap.flyToBounds(bounds, { padding: [30, 30] });
  } else {
    leafletMap.flyTo([PITT.lat, PITT.lon], 6);
  }
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function switchView(element) {
  const target = element.dataset.t;

  document.querySelectorAll('.v').forEach(view => view.classList.remove('on'));
  $('v-' + target).classList.add('on');

  document.querySelectorAll('.ni, .dni').forEach(item => item.classList.remove('on'));
  document.querySelectorAll(`[data-t="${target}"]`).forEach(item => item.classList.add('on'));

  if (target === 'rider') syncRides();
  if (target === 'profile') loadProfile();
  if (target === 'admin') loadAdminStats();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function loadProfile() {
  try {
    const profile = await callApi({ action: 'getProfile' });
    if (profile.status !== 'success') return;

    userRole = profile.role || 'user';
    userGender = profile.gender;
    userCar = profile.car || '';

    $('pfn').value = profile.name;
    $('pfg').value = profile.gender;
    $('pnd').textContent = profile.name;
    $('pgd').textContent = profile.gender;
    $('pfb').value = profile.bio || '';
    $('pcar').value = userCar;

    $('pav').textContent = initialsFrom(profile.name);
    $('pav').style.background = colorFromString(profile.name);

    $('fc-women').style.display = userGender === 'Female' ? '' : 'none';
    $('ps-rating').textContent = profile.rating > 0 ? '★ ' + profile.rating : '—';

    $('prd').textContent = profile.rating > 0
      ? '★'.repeat(Math.round(profile.rating)) +
        ` ${profile.rating} (${profile.ratingCount} ratings)` +
        (profile.verified ? ' ✓ Verified' : '')
      : 'No ratings yet';

    $('pdate').textContent = profile.joined
      ? 'Member since ' + new Date(profile.joined)
          .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : '';

    renderAll();
    loadAlerts();
  } catch (err) {
    /* ignore */
  }
}

async function saveProfile() {
  await callApi({
    action: 'updateProfile',
    bio: $('pfb').value,
    car: $('pcar').value,
  });
  toast('Saved!');
}

// ---------------------------------------------------------------------------
// Saved alerts
// ---------------------------------------------------------------------------

async function loadAlerts() {
  try {
    const result = await callApi({ action: 'getAlerts' });
    const alerts = result.data || [];

    if (alerts.length === 0) {
      $('alert-list').innerHTML =
        '<p style="font-size:.78em;color:var(--t3)">No alerts set. Create one to get notified.</p>';
      return;
    }

    $('alert-list').innerHTML = alerts.map((alert) => {
      let summary = alert.destination || 'Any destination';
      if (alert.direction) summary += ` · ${alert.direction}`;
      if (alert.maxPrice) summary += ` · Under $${alert.maxPrice}`;

      const range = (alert.dateFrom || alert.dateTo)
        ? `<div class="al-meta">${alert.dateFrom ? formatDate(alert.dateFrom) : 'Any'} → ${alert.dateTo ? formatDate(alert.dateTo) : 'Any'}</div>`
        : '';

      return `<div class="alert-card">
        <div><div class="al-info">🔔 ${summary}</div>${range}</div>
        <div class="al-del" onclick="deleteAlert(${alert.row})" aria-label="Delete alert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    /* ignore */
  }
}

function openAlertModal() { $('almod').classList.add('open'); }
function closeAlertModal() { $('almod').classList.remove('open'); }

async function saveAlert() {
  const destination = $('al-dest').value.trim();
  if (!destination) return toast('Enter a destination', false);

  await callApi({
    action: 'saveAlert',
    destination,
    direction: $('al-dir').value,
    dateFrom: $('al-from').value,
    dateTo: $('al-to').value,
    maxPrice: $('al-max').value,
  });

  closeAlertModal();
  toast('Alert created!');
  loadAlerts();
}

async function deleteAlert(row) {
  await callApi({ action: 'deleteAlert', row });
  toast('Alert removed');
  loadAlerts();
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const PAYMENT_LABELS = {
  received: '✅ Confirmed',
  paid: '💸 Sent',
  unpaid: '⏳ Unpaid',
};

function openPaymentModal(id) {
  const ride = rides.find(r => String(r.id) === String(id));
  if (!ride) return;

  const body = $('pay-body');
  const emails = riderEmails(ride);
  const names = ride.riderNames || [];
  const isDriver = ride.email === session.email;

  let paid = {};
  try {
    paid = JSON.parse(ride.paidStatus || '{}');
  } catch (err) {
    paid = {};
  }

  if (emails.length === 0) {
    body.innerHTML =
      '<p style="text-align:center;color:var(--t3);padding:20px">No riders yet.</p>';
    $('paymod').classList.add('open');
    return;
  }

  const intro = `<p style="font-size:.82em;color:var(--t3);margin-bottom:12px">${
    isDriver ? 'Track payments from your riders:' : 'Mark your payment status:'
  }</p>`;

  const rows = emails.map((email, index) => {
    const name = names[index] || email.split('@')[0];
    const status = paid[email] || 'unpaid';
    const label = PAYMENT_LABELS[status];

    if (isDriver) {
      let control = '<span style="font-size:.75em;color:var(--t3)">Waiting…</span>';
      if (status === 'paid') {
        control = `<button class="bt bg bs" style="width:auto" onclick="markPayment('${ride.id}','${email}','received')">Confirm</button>`;
      } else if (status === 'received') {
        control = '<span style="font-size:.75em;color:var(--ok)">Done</span>';
      }

      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--b1)">
        <div>
          <div style="font-weight:700;font-size:.85em">${name}</div>
          <div style="font-size:.7em;color:var(--t3)">${label}</div>
        </div>
        <div class="brow" style="width:auto;gap:4px">${control}</div>
      </div>`;
    }

    if (email !== session.email) return '';

    let control = '';
    if (status === 'unpaid') {
      control = `<button class="bt bp bs" onclick="markPayment('${ride.id}','${email}','paid')">Mark as Paid</button>`;
    } else if (status === 'paid') {
      control = '<p style="font-size:.82em;color:var(--warn)">Waiting for driver to confirm…</p>';
    } else {
      control = '<p style="font-size:.82em;color:var(--ok)">Driver confirmed payment!</p>';
    }

    return `<div style="padding:12px 0;text-align:center">
      <p style="font-weight:700;font-size:.9em;margin-bottom:4px">Your payment: ${label}</p>
      <p style="font-size:.78em;color:var(--t3);margin-bottom:12px">Amount: $${ride.price}</p>
      ${control}
    </div>`;
  });

  body.innerHTML = intro + rows.join('');
  $('paymod').classList.add('open');
}

function closePaymentModal() { $('paymod').classList.remove('open'); }

async function markPayment(rideId, riderEmail, status) {
  await callApi({ action: 'markPaid', rideId, riderEmail, status });
  toast(status === 'paid' ? 'Marked as paid' : 'Payment confirmed!');
  closePaymentModal();
  syncRides(true);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function loadAdminStats() {
  try {
    const result = await callApi({ action: 'getAnalytics' });
    if (!result.stats) return;

    $('su').textContent = result.stats.users;
    $('sr').textContent = result.stats.rides;
    $('sm').textContent = '$' + result.stats.economy.toLocaleString();
    $('smg').textContent = result.stats.messages;
  } catch (err) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function openChat(rideId) {
  activeChatRideId = rideId;
  $('cmod').classList.add('open');
  loadMessages();
}

function closeChat() {
  $('cmod').classList.remove('open');
  activeChatRideId = null;
  clearInterval(chatPollTimer);
}

async function loadMessages() {
  if (!activeChatRideId) return;
  const box = $('cbox');

  try {
    const result = await callApi({ action: 'getMessages', rideId: activeChatRideId });
    const bubbles = (result.data || []).map(message =>
      `<div class="cb ${message.email === session.email ? 'cm' : 'ct'}">
        <div class="cs">${message.name || message.email.split('@')[0]}</div>${message.message}
      </div>`
    );

    box.innerHTML = bubbles.join('') ||
      '<p style="text-align:center;color:var(--t3);padding:24px;font-size:.85em">No messages yet</p>';
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    /* ignore */
  }

  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => {
    if (activeChatRideId) loadMessages();
  }, CHAT_POLL_MS);
}

async function sendMessage() {
  const input = $('cin');
  const text = input.value.trim();
  if (!text || !activeChatRideId) return;

  input.value = '';
  await callApi({ action: 'sendMessage', rideId: activeChatRideId, message: text });
  loadMessages();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function openNotifications() {
  $('nmod').classList.add('open');
  renderNotifications();
  callApi({ action: 'markNotifRead' }).then(() => {
    $('nd').style.display = 'none';
  });
}

function closeNotifications() { $('nmod').classList.remove('open'); }

function renderNotifications() {
  if (notifications.length === 0) {
    $('nlist').innerHTML =
      '<div style="text-align:center;padding:32px;color:var(--t3);font-size:.85em">No notifications</div>';
    return;
  }

  $('nlist').innerHTML = notifications.map((item) => {
    const icon = NOTIFICATION_ICONS[item.type] ||
      (String(item.type).includes('cancel') ? '❌' : '💬');
    return `<div class="nit${item.read ? '' : ' ur'}">
      <div class="nic">${icon}</div>
      <div class="nb"><p>${item.message}</p><div class="nt2">${timeAgo(item.time)}</div></div>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

function openRatingModal(email, rideId, name) {
  selectedRating = 0;
  $('re').value = email;
  $('rr').value = rideId;
  $('rw').textContent = 'Rate ' + name;

  const row = $('srow');
  row.innerHTML = '';

  for (let score = 1; score <= 5; score++) {
    const star = document.createElement('span');
    star.className = 'sb2';
    star.textContent = '★';
    star.onclick = () => {
      selectedRating = score;
      row.querySelectorAll('.sb2').forEach((s, i) => s.classList.toggle('lit', i < score));
    };
    row.appendChild(star);
  }

  $('rmod').classList.add('open');
}

function closeRatingModal() { $('rmod').classList.remove('open'); }

async function submitRating() {
  if (selectedRating < 1) return toast('Pick a rating', false);

  const result = await callApi({
    action: 'rateUser',
    ratedUser: $('re').value,
    rideId: $('rr').value,
    score: selectedRating,
  });

  if (result.status === 'success') {
    closeRatingModal();
    toast('Rated!');
  } else {
    toast(result.message || 'Error', false);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function init() {
  applyStoredTheme();

  if (!API_URL) {
    toast('Missing config.js — copy config.example.js and set your API URL', false);
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  $('pda').min = today;
  $('eda').min = today;

  if (!session) return;

  document.body.classList.add('logged-in');
  $('v-auth').style.display = 'none';
  $('v-rider').classList.add('on');
  $('nav').style.display = 'block';
  $('lob').style.display = 'flex';
  $('nbtn').style.display = 'flex';

  loadProfile().then(() => {
    if (userRole === 'admin') {
      $('atab').style.display = 'flex';
      $('atab2').style.display = 'flex';
    }
  });

  renderAll();
  syncRides(true);

  setInterval(() => syncRides(), SYNC_INTERVAL_MS);
  setInterval(pollNotifications, SYNC_INTERVAL_MS);
}

init();
