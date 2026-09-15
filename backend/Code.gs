/**
 * PittRide — backend
 *
 * A single Apps Script web app endpoint backed by a Google Sheet. Every request
 * is a POST of JSON containing an `action` plus a session `token`, dispatched by
 * `doPost`. The whole handler runs inside a script-level lock so that concurrent
 * writes (two riders claiming the last seat) cannot interleave.
 *
 * Tables live as sheets; the column layouts are declared once in the COL maps
 * below rather than being addressed by bare numeric index at each call site.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SHEETS = {
  RIDES: 'Rides',
  USERS: 'Users',
  SESSIONS: 'Sessions',
  MESSAGES: 'Messages',
  RATINGS: 'Ratings',
  NOTIFICATIONS: 'Notifications',
  ALERTS: 'Alerts',
};

const HEADERS = {
  RIDES: ['ID', 'Email', 'Name', 'Destination', 'Date', 'Seats', 'Price', 'Vibe',
          'Music', 'Luggage', 'Notes', 'Riders', 'Direction', 'Waitlist', 'Affinity',
          'Lat', 'Lon', 'Waypoints', 'DepartureTime', 'PickupLat', 'PickupLon',
          'PickupLabel', 'CancelPolicy', 'PaidStatus'],
  USERS: ['Email', 'Hash', 'Salt', 'Name', 'Gender', 'Bio', 'Role', 'CarInfo', 'JoinDate'],
  SESSIONS: ['Email', 'Token', 'Created'],
  MESSAGES: ['RideID', 'Email', 'Timestamp', 'Message'],
  RATINGS: ['RideID', 'Rater', 'Rated', 'Score', 'Timestamp'],
  NOTIFICATIONS: ['Recipient', 'Type', 'Message', 'RideID', 'Timestamp', 'Read'],
  ALERTS: ['Email', 'Destination', 'Direction', 'DateFrom', 'DateTo', 'MaxPrice', 'Created'],
};

/** Zero-based column indexes, derived from HEADERS so the two cannot drift. */
const COL = Object.keys(HEADERS).reduce((acc, table) => {
  acc[table] = HEADERS[table].reduce((m, name, i) => {
    m[name.toUpperCase()] = i;
    return m;
  }, {});
  return acc;
}, {});

const LIMITS = {
  LOCK_WAIT_MS: 15000,
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  NOTIFICATION_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  RIDE_RETENTION_DAYS: 2,
  MAX_ACTIVE_RIDES: 10,
  MAX_ALERTS: 5,
  MAX_SEATS: 6,
  MAX_PRICE: 500,
  MIN_PASSWORD: 6,
  MAX_TEXT: 500,
  MAX_MESSAGE: 1000,
  NOTIFICATION_PAGE: 30,
  VERIFIED_MIN_RIDES: 3,
  VERIFIED_MIN_RATING: 4,
  CANCEL_NOTICE_MS: 24 * 60 * 60 * 1000,
};

const RATE_LIMITS = {
  AUTH_GLOBAL: { key: 'auth_global', max: 60, windowSec: 300 },
  AUTH_PER_USER: { max: 8, windowSec: 900 },
  MESSAGES: { max: 30, windowSec: 300 },
};

const ALLOWED = {
  vibe: ['Chatty', 'Quiet', 'Mixed'],
  music: ["Driver's Choice", 'Pass the Aux', 'Podcasts/Silence'],
  luggage: ['Backpack Only', 'Carry-on Size', 'Large Trunk Space'],
  direction: ['Leaving Pitt', 'Returning to Pitt'],
  affinity: ['Everyone', 'Women Only'],
  time: ['Early Morning', 'Morning', 'Afternoon', 'Evening', 'Late Night', 'Flexible'],
  cancelPolicy: ['Flexible', '24h Notice', 'No Cancellation'],
};

const EMAIL_PATTERN = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@pitt\.edu$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok(extra) {
  return jsonResponse(Object.assign({ status: 'success' }, extra || {}));
}

function fail(message) {
  return jsonResponse({ status: 'error', message: message });
}

function unauthorized() {
  return jsonResponse({ status: 'unauthorized' });
}

/**
 * Salted SHA-256. Not a key derivation function — see the README's known
 * limitations. Apps Script exposes no native bcrypt/scrypt.
 */
function hashPassword(password, salt) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + ':' + password + ':' + salt
  );
  return digest
    .map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2))
    .join('');
}

/**
 * Escapes user text for safe storage and later rendering, and neutralises
 * spreadsheet formula injection. Because the data layer *is* a spreadsheet, a
 * leading `=`, `+`, `-` or `@` would otherwise be evaluated as a live formula,
 * so every leading trigger character is stripped (not just the first).
 */
function sanitize(text) {
  if (text === null || text === undefined) return '';
  return text
    .toString()
    .replace(/^[=+\-@\t\r]+/, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .trim()
    .substring(0, LIMITS.MAX_TEXT);
}

/** Fixed-window counter in the script cache. Returns false once over budget. */
function withinRateLimit(key, max, windowSec) {
  const cache = CacheService.getScriptCache();
  const used = parseInt(cache.get(key) || '0', 10);
  if (used >= max) return false;
  cache.put(key, String(used + 1), windowSec);
  return true;
}

/** Fetches a sheet, creating it with its header row if absent. */
function getSheet(spreadsheet, table) {
  const name = SHEETS[table];
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS[table]);
  return sheet;
}

/** Rows below the header, or [] for an empty table. */
function getRows(spreadsheet, table) {
  const sheet = spreadsheet.getSheetByName(SHEETS[table]);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  return sheet.getDataRange().getValues().slice(1);
}

function splitEmails(cell) {
  return (cell || '')
    .toString()
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function hasDeparted(dateValue) {
  const end = new Date(dateValue);
  end.setHours(23, 59, 59, 999);
  return end < new Date();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet() {
  return ContentService.createTextOutput('404');
}

/** Actions callable without a session token. */
const PUBLIC_ACTIONS = ['login', 'register'];

const ROUTES = {
  logout:           (ctx) => handleLogout(ctx),
  getRides:         (ctx) => handleGetRides(ctx),
  addRide:          (ctx) => handleAddRide(ctx),
  editRide:         (ctx) => handleEditRide(ctx),
  deleteRide:       (ctx) => handleDeleteRide(ctx),
  bookSeat:         (ctx) => handleBookSeat(ctx),
  cancelSeat:       (ctx) => handleCancelSeat(ctx),
  joinWaitlist:     (ctx) => handleJoinWaitlist(ctx),
  getProfile:       (ctx) => handleGetProfile(ctx),
  updateProfile:    (ctx) => handleUpdateProfile(ctx),
  sendMessage:      (ctx) => handleSendMessage(ctx),
  getMessages:      (ctx) => handleGetMessages(ctx),
  getNotifications: (ctx) => handleGetNotifications(ctx),
  markNotifRead:    (ctx) => handleMarkNotificationsRead(ctx),
  rateUser:         (ctx) => handleRateUser(ctx),
  getUserRating:    (ctx) => handleGetUserRating(ctx),
  getAnalytics:     (ctx) => handleGetAnalytics(ctx),
  markPaid:         (ctx) => handleMarkPaid(ctx),
  saveAlert:        (ctx) => handleSaveAlert(ctx),
  getAlerts:        (ctx) => handleGetAlerts(ctx),
  deleteAlert:      (ctx) => handleDeleteAlert(ctx),
};

/**
 * Single POST endpoint. Serialised by a script-wide lock: the booking path is a
 * read-modify-write on a seat count, so without this two simultaneous requests
 * could both observe the last free seat and both decrement it.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LIMITS.LOCK_WAIT_MS);
  } catch (err) {
    return fail('Server busy. Please try again.');
  }

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    let request;
    try {
      request = JSON.parse(e.postData.contents);
    } catch (err) {
      return fail('Invalid request.');
    }

    const action = request.action;
    if (!action) return fail('Missing action.');

    if (PUBLIC_ACTIONS.indexOf(action) !== -1) {
      return handleAuth(spreadsheet, request);
    }

    if (!request.token || !UUID_PATTERN.test(request.token)) return unauthorized();

    const email = validateSession(spreadsheet, request.token);
    if (!email) return unauthorized();

    const route = ROUTES[action];
    if (!route) return fail('Unknown action.');

    return route({ ss: spreadsheet, user: email, data: request });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function handleAuth(spreadsheet, data) {
  const email = (data.email || '').toString().toLowerCase().trim();

  if (!EMAIL_PATTERN.test(email)) return fail('Enter a valid @pitt.edu email.');
  if (!data.password || data.password.length < LIMITS.MIN_PASSWORD) {
    return fail('Password must be ' + LIMITS.MIN_PASSWORD + '+ characters.');
  }

  const global = RATE_LIMITS.AUTH_GLOBAL;
  if (!withinRateLimit(global.key, global.max, global.windowSec)) {
    return fail('Too many attempts. Try again shortly.');
  }

  const sheet = getSheet(spreadsheet, 'USERS');
  const rows = getRows(spreadsheet, 'USERS');
  const c = COL.USERS;

  if (data.action === 'register') {
    if (rows.some(row => row[c.EMAIL] === email)) return fail('Account already exists.');
    if (!data.name || !data.gender) return fail('Name and gender are required.');

    const salt = Utilities.getUuid();
    sheet.appendRow([
      email,
      hashPassword(data.password, salt),
      salt,
      sanitize(data.name),
      sanitize(data.gender),
      '',
      'user',
      '',
      new Date().toISOString(),
    ]);
    return ok({ token: createSession(spreadsheet, email), role: 'user' });
  }

  const perUser = RATE_LIMITS.AUTH_PER_USER;
  const attemptKey = 'auth_' + email;
  if (!withinRateLimit(attemptKey, perUser.max, perUser.windowSec)) {
    return fail('Too many failed attempts. Locked for 15 minutes.');
  }

  const match = rows.find(row =>
    row[c.EMAIL] === email &&
    row[c.HASH] === hashPassword(data.password, row[c.SALT])
  );

  if (!match) return fail('Invalid credentials.');

  CacheService.getScriptCache().remove(attemptKey);
  return ok({
    token: createSession(spreadsheet, email),
    role: match[c.ROLE] || 'user',
  });
}

function createSession(spreadsheet, email) {
  const token = Utilities.getUuid();
  getSheet(spreadsheet, 'SESSIONS').appendRow([email, token, Date.now()]);
  return token;
}

/** Returns the session's email, or null if absent or expired. */
function validateSession(spreadsheet, token) {
  const sheet = spreadsheet.getSheetByName(SHEETS.SESSIONS);
  if (!sheet || sheet.getLastRow() <= 1) return null;

  const rows = sheet.getDataRange().getValues();
  const c = COL.SESSIONS;

  for (let i = rows.length - 1; i > 0; i--) {
    if (rows[i][c.TOKEN] !== token) continue;
    if (Date.now() - rows[i][c.CREATED] > LIMITS.SESSION_TTL_MS) {
      sheet.deleteRow(i + 1);
      return null;
    }
    return rows[i][c.EMAIL];
  }
  return null;
}

function handleLogout(ctx) {
  const sheet = ctx.ss.getSheetByName(SHEETS.SESSIONS);
  if (sheet) {
    const rows = sheet.getDataRange().getValues();
    for (let i = rows.length - 1; i > 0; i--) {
      if (rows[i][COL.SESSIONS.TOKEN] === ctx.data.token) {
        sheet.deleteRow(i + 1);
        break;
      }
    }
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const EMPTY_USER = {
  name: '', gender: 'Unknown', bio: '', role: 'user', car: '', joined: '',
};

/**
 * Reads Users, Rides and Ratings once each and returns lookup maps.
 *
 * The previous implementation called a per-user and a per-driver helper from
 * inside the ride loop, and each of those re-read an entire sheet — quadratic
 * in sheet reads. Building the aggregates up front makes the read path linear.
 */
function buildStats(spreadsheet) {
  const users = {};
  getRows(spreadsheet, 'USERS').forEach(row => {
    const c = COL.USERS;
    users[row[c.EMAIL]] = {
      name: row[c.NAME],
      gender: row[c.GENDER],
      bio: row[c.BIO],
      role: row[c.ROLE] || 'user',
      car: row[c.CARINFO] || '',
      joined: row[c.JOINDATE] || '',
    };
  });

  const ratingTotals = {};
  getRows(spreadsheet, 'RATINGS').forEach(row => {
    const c = COL.RATINGS;
    const target = row[c.RATED];
    if (!ratingTotals[target]) ratingTotals[target] = { sum: 0, count: 0 };
    ratingTotals[target].sum += row[c.SCORE];
    ratingTotals[target].count += 1;
  });

  const completedRides = {};
  const cutoff = startOfToday();
  getRows(spreadsheet, 'RIDES').forEach(row => {
    const c = COL.RIDES;
    if (new Date(row[c.DATE]) < cutoff) {
      const driver = row[c.EMAIL];
      completedRides[driver] = (completedRides[driver] || 0) + 1;
    }
  });

  return { users: users, ratingTotals: ratingTotals, completedRides: completedRides };
}

function userFrom(stats, email) {
  return stats.users[email] || EMPTY_USER;
}

function ratingFor(stats, email) {
  const totals = stats.ratingTotals[email];
  if (!totals || totals.count === 0) return { avg: 0, count: 0 };
  return {
    avg: Math.round((totals.sum / totals.count) * 10) / 10,
    count: totals.count,
  };
}

/** A driver is "verified" once they have enough completed rides at a good average. */
function isVerified(stats, email) {
  const rating = ratingFor(stats, email);
  const completed = stats.completedRides[email] || 0;
  return completed >= LIMITS.VERIFIED_MIN_RIDES &&
         rating.avg >= LIMITS.VERIFIED_MIN_RATING;
}

function addNotification(spreadsheet, recipient, type, message, rideId) {
  getSheet(spreadsheet, 'NOTIFICATIONS').appendRow([
    recipient, type, message, rideId || '', new Date().toISOString(), false,
  ]);
}

function displayName(stats, email) {
  return userFrom(stats, email).name || email.split('@')[0];
}

// ---------------------------------------------------------------------------
// Rides — read
// ---------------------------------------------------------------------------

function handleGetRides(ctx) {
  const stats = buildStats(ctx.ss);
  const viewer = userFrom(stats, ctx.user);
  const rows = getRows(ctx.ss, 'RIDES');
  const c = COL.RIDES;

  const rides = [];

  rows.forEach(row => {
    const riders = splitEmails(row[c.RIDERS]);
    const isDriver = row[c.EMAIL] === ctx.user;
    const isRider = riders.indexOf(ctx.user) !== -1;
    const isAdmin = viewer.role === 'admin';
    const isParticipant = isDriver || isRider || isAdmin;

    // Restricted rides are filtered server-side, so the data never reaches a
    // browser that should not see it.
    if (row[c.AFFINITY] === 'Women Only' && viewer.gender !== 'Female' && !isParticipant) {
      return;
    }

    rides.push({
      id: row[c.ID],
      email: isParticipant ? row[c.EMAIL] : 'HIDDEN',
      name: row[c.NAME],
      destination: row[c.DESTINATION],
      date: row[c.DATE],
      seats: row[c.SEATS],
      price: row[c.PRICE],
      vibe: row[c.VIBE],
      music: row[c.MUSIC],
      luggage: row[c.LUGGAGE],
      notes: row[c.NOTES],
      riders: row[c.RIDERS],
      riderNames: riders.map(email => displayName(stats, email)),
      direction: row[c.DIRECTION],
      waitlist: row[c.WAITLIST],
      affinity: row[c.AFFINITY],
      lat: row[c.LAT],
      lon: row[c.LON],
      waypoints: row[c.WAYPOINTS] || '',
      time: row[c.DEPARTURETIME] || '',
      pickupLat: row[c.PICKUPLAT] || '',
      pickupLon: row[c.PICKUPLON] || '',
      pickupLabel: row[c.PICKUPLABEL] || '',
      cancelPolicy: row[c.CANCELPOLICY] || 'Flexible',
      paidStatus: row[c.PAIDSTATUS] || '',
      verified: isVerified(stats, row[c.EMAIL]),
    });
  });

  return ok({ data: rides });
}

// ---------------------------------------------------------------------------
// Rides — write
// ---------------------------------------------------------------------------

/** Returns an error string, or null when the payload is acceptable. */
function validateRide(data) {
  const seats = parseInt(data.seats, 10);
  const price = parseFloat(data.price);

  if (isNaN(seats) || seats < 1 || seats > LIMITS.MAX_SEATS) {
    return 'Seats must be between 1 and ' + LIMITS.MAX_SEATS + '.';
  }
  if (isNaN(price) || price < 0 || price > LIMITS.MAX_PRICE) {
    return 'Price must be between $0 and $' + LIMITS.MAX_PRICE + '.';
  }
  if (!data.destination || data.destination.length < 2) return 'Destination is required.';
  if (!data.date) return 'Date is required.';

  const enumChecks = [
    ['vibe', data.vibe], ['music', data.music], ['luggage', data.luggage],
    ['direction', data.direction], ['affinity', data.affinity],
  ];
  for (let i = 0; i < enumChecks.length; i++) {
    const field = enumChecks[i][0];
    const value = enumChecks[i][1];
    if (ALLOWED[field].indexOf(value) === -1) return 'Invalid ' + field + ' option.';
  }

  if (data.time && ALLOWED.time.indexOf(data.time) === -1) return 'Invalid departure time.';
  if (data.cancelPolicy && ALLOWED.cancelPolicy.indexOf(data.cancelPolicy) === -1) {
    return 'Invalid cancellation policy.';
  }
  return null;
}

function handleAddRide(ctx) {
  const data = ctx.data;
  const invalid = validateRide(data);
  if (invalid) return fail(invalid);

  const sheet = getSheet(ctx.ss, 'RIDES');
  const rows = getRows(ctx.ss, 'RIDES');
  const c = COL.RIDES;

  const active = rows.filter(row => row[c.EMAIL] === ctx.user).length;
  if (active >= LIMITS.MAX_ACTIVE_RIDES) {
    return fail('You already have ' + LIMITS.MAX_ACTIVE_RIDES + ' active rides.');
  }

  if (new Date(data.date) < startOfToday()) return fail('Date must be today or later.');

  const stats = buildStats(ctx.ss);
  const name = userFrom(stats, ctx.user).name || sanitize(data.name);

  sheet.appendRow([
    data.id,
    ctx.user,
    name,
    sanitize(data.destination),
    data.date,
    parseInt(data.seats, 10),
    parseFloat(data.price),
    data.vibe,
    data.music,
    data.luggage,
    sanitize(data.notes),
    '',
    data.direction,
    '',
    data.affinity,
    data.lat || '',
    data.lon || '',
    sanitize(data.waypoints),
    data.time || 'Flexible',
    data.pickupLat || '',
    data.pickupLon || '',
    sanitize(data.pickupLabel),
    data.cancelPolicy || 'Flexible',
    '',
  ]);

  notifyMatchingAlerts(ctx.ss, data);
  return ok();
}

/** Locates a ride by id. Returns { rowNumber, row } or null. */
function findRide(spreadsheet, rideId) {
  const sheet = spreadsheet.getSheetByName(SHEETS.RIDES);
  if (!sheet || sheet.getLastRow() <= 1) return null;

  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][COL.RIDES.ID]) === String(rideId)) {
      return { sheet: sheet, rowNumber: i + 1, row: values[i] };
    }
  }
  return null;
}

function handleEditRide(ctx) {
  const invalid = validateRide(ctx.data);
  if (invalid) return fail(invalid);

  const found = findRide(ctx.ss, ctx.data.id);
  if (!found || found.row[COL.RIDES.EMAIL] !== ctx.user) return fail('Ride not found.');

  const c = COL.RIDES;
  const d = ctx.data;

  const updates = [
    [c.DESTINATION, sanitize(d.destination)],
    [c.DATE, d.date],
    [c.SEATS, parseInt(d.seats, 10)],
    [c.PRICE, parseFloat(d.price)],
    [c.VIBE, d.vibe],
    [c.MUSIC, d.music],
    [c.LUGGAGE, d.luggage],
    [c.NOTES, sanitize(d.notes)],
    [c.DIRECTION, d.direction],
    [c.AFFINITY, d.affinity],
    [c.WAYPOINTS, sanitize(d.waypoints)],
    [c.DEPARTURETIME, d.time || 'Flexible'],
    [c.PICKUPLABEL, sanitize(d.pickupLabel)],
    [c.CANCELPOLICY, d.cancelPolicy || 'Flexible'],
  ];

  if (d.lat) updates.push([c.LAT, d.lat]);
  if (d.lon) updates.push([c.LON, d.lon]);
  if (d.pickupLat) updates.push([c.PICKUPLAT, d.pickupLat]);
  if (d.pickupLon) updates.push([c.PICKUPLON, d.pickupLon]);

  updates.forEach(pair => {
    found.sheet.getRange(found.rowNumber, pair[0] + 1).setValue(pair[1]);
  });

  return ok();
}

function handleDeleteRide(ctx) {
  const stats = buildStats(ctx.ss);
  const found = findRide(ctx.ss, ctx.data.id);
  if (!found) return fail('Ride not found.');

  const c = COL.RIDES;
  const isOwner = found.row[c.EMAIL] === ctx.user;
  const isAdmin = userFrom(stats, ctx.user).role === 'admin';
  if (!isOwner && !isAdmin) return fail('Ride not found.');

  splitEmails(found.row[c.RIDERS]).forEach(rider => {
    addNotification(ctx.ss, rider, 'ride_cancelled',
      'Ride to ' + found.row[c.DESTINATION] + ' was cancelled.', ctx.data.id);
  });

  found.sheet.deleteRow(found.rowNumber);
  return ok();
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

function handleBookSeat(ctx) {
  const found = findRide(ctx.ss, ctx.data.id);
  if (!found) return fail('Ride not found.');

  const c = COL.RIDES;
  const row = found.row;
  const riders = splitEmails(row[c.RIDERS]);
  const stats = buildStats(ctx.ss);

  if (row[c.EMAIL] === ctx.user) return fail("You can't book your own ride.");
  if (parseInt(row[c.SEATS], 10) <= 0) return fail('This ride is full.');
  if (riders.indexOf(ctx.user) !== -1) return fail('You already booked this ride.');
  if (row[c.AFFINITY] === 'Women Only' && userFrom(stats, ctx.user).gender !== 'Female') {
    return fail('This ride is women only.');
  }
  if (hasDeparted(row[c.DATE])) return fail('This ride has expired.');

  found.sheet.getRange(found.rowNumber, c.SEATS + 1)
    .setValue(parseInt(row[c.SEATS], 10) - 1);
  found.sheet.getRange(found.rowNumber, c.RIDERS + 1)
    .setValue(riders.concat([ctx.user]).join(','));

  const waitlist = splitEmails(row[c.WAITLIST]).filter(email => email !== ctx.user);
  found.sheet.getRange(found.rowNumber, c.WAITLIST + 1).setValue(waitlist.join(','));

  addNotification(ctx.ss, row[c.EMAIL], 'new_booking',
    displayName(stats, ctx.user) + ' booked your ride to ' + row[c.DESTINATION] + '.',
    ctx.data.id);

  return ok();
}

function handleCancelSeat(ctx) {
  const found = findRide(ctx.ss, ctx.data.id);
  if (!found) return fail('Ride not found.');

  const c = COL.RIDES;
  const row = found.row;
  const riders = splitEmails(row[c.RIDERS]);
  if (riders.indexOf(ctx.user) === -1) return fail('You are not booked on this ride.');

  const policy = row[c.CANCELPOLICY] || 'Flexible';
  if (policy === 'No Cancellation') {
    return fail('This ride has a no-cancellation policy.');
  }
  if (policy === '24h Notice') {
    const departure = new Date(row[c.DATE]);
    departure.setHours(0, 0, 0, 0);
    if (departure.getTime() - Date.now() < LIMITS.CANCEL_NOTICE_MS) {
      return fail('You must cancel at least 24 hours before departure.');
    }
  }

  const stats = buildStats(ctx.ss);

  found.sheet.getRange(found.rowNumber, c.RIDERS + 1)
    .setValue(riders.filter(email => email !== ctx.user).join(','));
  found.sheet.getRange(found.rowNumber, c.SEATS + 1)
    .setValue(parseInt(row[c.SEATS], 10) + 1);

  addNotification(ctx.ss, row[c.EMAIL], 'booking_cancelled',
    displayName(stats, ctx.user) + ' cancelled on your ride to ' + row[c.DESTINATION] + '.',
    ctx.data.id);

  // Promote the next person on the waitlist into the freed seat.
  const waitlist = splitEmails(row[c.WAITLIST]);
  if (waitlist.length > 0) {
    const promoted = waitlist.shift();
    addNotification(ctx.ss, promoted, 'waitlist_promoted',
      'A seat opened on the ride to ' + row[c.DESTINATION] + '.', ctx.data.id);
    found.sheet.getRange(found.rowNumber, c.WAITLIST + 1).setValue(waitlist.join(','));
  }

  return ok();
}

function handleJoinWaitlist(ctx) {
  const found = findRide(ctx.ss, ctx.data.id);
  if (!found) return fail('Ride not found.');

  const c = COL.RIDES;
  const waitlist = splitEmails(found.row[c.WAITLIST]);
  if (waitlist.indexOf(ctx.user) !== -1) return fail('You are already waitlisted.');

  found.sheet.getRange(found.rowNumber, c.WAITLIST + 1)
    .setValue(waitlist.concat([ctx.user]).join(','));
  return ok();
}

// ---------------------------------------------------------------------------
// Payment tracking
// ---------------------------------------------------------------------------

function handleMarkPaid(ctx) {
  const found = findRide(ctx.ss, ctx.data.rideId);
  if (!found) return fail('Ride not found.');

  const c = COL.RIDES;
  const row = found.row;
  const isDriver = row[c.EMAIL] === ctx.user;
  const rider = ctx.data.riderEmail;

  // A rider may only ever mark their own payment as sent; only the driver may
  // confirm receipt. The previous version let a rider confirm their own payment.
  if (isDriver) {
    if (ctx.data.status !== 'received' && ctx.data.status !== 'unpaid') {
      return fail('Drivers can only confirm or reset a payment.');
    }
  } else if (rider === ctx.user) {
    if (ctx.data.status !== 'paid' && ctx.data.status !== 'unpaid') {
      return fail('Riders can only mark their own payment as sent.');
    }
  } else {
    return fail('Not authorised.');
  }

  let paid = {};
  try {
    paid = JSON.parse(row[c.PAIDSTATUS] || '{}');
  } catch (err) {
    paid = {};
  }
  paid[rider] = ctx.data.status;
  found.sheet.getRange(found.rowNumber, c.PAIDSTATUS + 1).setValue(JSON.stringify(paid));

  const stats = buildStats(ctx.ss);
  const actor = displayName(stats, ctx.user);

  if (ctx.data.status === 'paid') {
    addNotification(ctx.ss, row[c.EMAIL], 'payment',
      actor + ' marked their payment as sent for the ride to ' + row[c.DESTINATION] + '.',
      ctx.data.rideId);
  } else if (ctx.data.status === 'received') {
    addNotification(ctx.ss, rider, 'payment',
      actor + ' confirmed receiving your payment.', ctx.data.rideId);
  }

  return ok();
}

// ---------------------------------------------------------------------------
// Saved search alerts
// ---------------------------------------------------------------------------

function handleSaveAlert(ctx) {
  const sheet = getSheet(ctx.ss, 'ALERTS');
  const rows = getRows(ctx.ss, 'ALERTS');
  const c = COL.ALERTS;

  const mine = rows.filter(row => row[c.EMAIL] === ctx.user).length;
  if (mine >= LIMITS.MAX_ALERTS) {
    return fail('You have ' + LIMITS.MAX_ALERTS + ' alerts. Delete one first.');
  }

  sheet.appendRow([
    ctx.user,
    sanitize(ctx.data.destination).toLowerCase(),
    ctx.data.direction || '',
    ctx.data.dateFrom || '',
    ctx.data.dateTo || '',
    ctx.data.maxPrice || '',
    new Date().toISOString(),
  ]);
  return ok();
}

function handleGetAlerts(ctx) {
  const sheet = ctx.ss.getSheetByName(SHEETS.ALERTS);
  if (!sheet || sheet.getLastRow() <= 1) return ok({ data: [] });

  const values = sheet.getDataRange().getValues();
  const c = COL.ALERTS;
  const alerts = [];

  for (let i = 1; i < values.length; i++) {
    if (values[i][c.EMAIL] !== ctx.user) continue;
    alerts.push({
      row: i + 1,
      destination: values[i][c.DESTINATION],
      direction: values[i][c.DIRECTION],
      dateFrom: values[i][c.DATEFROM],
      dateTo: values[i][c.DATETO],
      maxPrice: values[i][c.MAXPRICE],
      created: values[i][c.CREATED],
    });
  }
  return ok({ data: alerts });
}

function handleDeleteAlert(ctx) {
  const sheet = ctx.ss.getSheetByName(SHEETS.ALERTS);
  if (!sheet) return ok();

  const values = sheet.getDataRange().getValues();
  const target = ctx.data.row;
  if (target && values[target - 1] && values[target - 1][COL.ALERTS.EMAIL] === ctx.user) {
    sheet.deleteRow(target);
  }
  return ok();
}

/** Notifies every user whose saved alert matches a newly posted ride. */
function notifyMatchingAlerts(spreadsheet, ride) {
  const rows = getRows(spreadsheet, 'ALERTS');
  if (rows.length === 0) return;

  const c = COL.ALERTS;
  const destination = (ride.destination || '').toLowerCase();
  const rideDate = new Date(ride.date);
  const price = parseFloat(ride.price);

  rows.forEach(row => {
    const wantedDest = row[c.DESTINATION];
    const wantedDir = row[c.DIRECTION];
    const from = row[c.DATEFROM] ? new Date(row[c.DATEFROM]) : null;
    const to = row[c.DATETO] ? new Date(row[c.DATETO]) : null;
    const ceiling = row[c.MAXPRICE] ? parseFloat(row[c.MAXPRICE]) : Infinity;

    if (wantedDest && destination.indexOf(wantedDest) === -1) return;
    if (wantedDir && wantedDir !== ride.direction) return;
    if (from && rideDate < from) return;
    if (to && rideDate > to) return;
    if (price > ceiling) return;

    addNotification(spreadsheet, row[c.EMAIL], 'ride_alert',
      'New ride to ' + ride.destination + ' posted for $' + ride.price +
      '. Matches your alert.', ride.id);
  });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function handleGetProfile(ctx) {
  const stats = buildStats(ctx.ss);
  const user = userFrom(stats, ctx.user);
  const rating = ratingFor(stats, ctx.user);
  const c = COL.RIDES;

  let posted = 0;
  let booked = 0;
  getRows(ctx.ss, 'RIDES').forEach(row => {
    if (row[c.EMAIL] === ctx.user) posted++;
    if (splitEmails(row[c.RIDERS]).indexOf(ctx.user) !== -1) booked++;
  });

  return ok({
    name: user.name,
    gender: user.gender,
    bio: user.bio,
    role: user.role,
    car: user.car,
    joined: user.joined,
    rating: rating.avg,
    ratingCount: rating.count,
    verified: isVerified(stats, ctx.user),
    posted: posted,
    booked: booked,
  });
}

function handleUpdateProfile(ctx) {
  const sheet = ctx.ss.getSheetByName(SHEETS.USERS);
  if (!sheet) return fail('Profile not found.');

  const values = sheet.getDataRange().getValues();
  const c = COL.USERS;

  for (let i = 1; i < values.length; i++) {
    if (values[i][c.EMAIL] !== ctx.user) continue;
    if (ctx.data.bio !== undefined) {
      sheet.getRange(i + 1, c.BIO + 1).setValue(sanitize(ctx.data.bio));
    }
    if (ctx.data.car !== undefined) {
      sheet.getRange(i + 1, c.CARINFO + 1).setValue(sanitize(ctx.data.car));
    }
    return ok();
  }
  return fail('Profile not found.');
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** True when the user is the driver, a booked rider, or an admin. */
function canAccessRide(spreadsheet, stats, user, rideId) {
  const rows = getRows(spreadsheet, 'RIDES');
  const c = COL.RIDES;

  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][c.ID]) !== String(rideId)) continue;
    return rows[i][c.EMAIL] === user ||
           splitEmails(rows[i][c.RIDERS]).indexOf(user) !== -1 ||
           userFrom(stats, user).role === 'admin';
  }
  return false;
}

function handleSendMessage(ctx) {
  const body = (ctx.data.message || '').toString();
  if (!ctx.data.rideId || !body.trim()) return fail('Message is empty.');

  const limit = RATE_LIMITS.MESSAGES;
  if (!withinRateLimit('msg_' + ctx.user, limit.max, limit.windowSec)) {
    return fail('Slow down a moment.');
  }

  const stats = buildStats(ctx.ss);
  if (!canAccessRide(ctx.ss, stats, ctx.user, ctx.data.rideId)) {
    return fail('You are not a participant on this ride.');
  }

  getSheet(ctx.ss, 'MESSAGES').appendRow([
    ctx.data.rideId,
    ctx.user,
    new Date().toISOString(),
    sanitize(body).substring(0, LIMITS.MAX_MESSAGE),
  ]);

  const found = findRide(ctx.ss, ctx.data.rideId);
  if (found) {
    const c = COL.RIDES;
    const recipients = [found.row[c.EMAIL]]
      .concat(splitEmails(found.row[c.RIDERS]))
      .filter(email => email !== ctx.user);

    const sender = displayName(stats, ctx.user);
    recipients.forEach(email => {
      addNotification(ctx.ss, email, 'new_message',
        sender + ' messaged in the ride to ' + found.row[c.DESTINATION] + '.',
        ctx.data.rideId);
    });
  }

  return ok();
}

function handleGetMessages(ctx) {
  const stats = buildStats(ctx.ss);
  if (!canAccessRide(ctx.ss, stats, ctx.user, ctx.data.rideId)) {
    return fail('You are not a participant on this ride.');
  }

  const c = COL.MESSAGES;
  const messages = getRows(ctx.ss, 'MESSAGES')
    .filter(row => String(row[c.RIDEID]) === String(ctx.data.rideId))
    .map(row => ({
      email: row[c.EMAIL],
      name: displayName(stats, row[c.EMAIL]),
      time: row[c.TIMESTAMP],
      message: row[c.MESSAGE],
    }));

  return ok({ data: messages });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function handleGetNotifications(ctx) {
  const sheet = ctx.ss.getSheetByName(SHEETS.NOTIFICATIONS);
  if (!sheet || sheet.getLastRow() <= 1) return ok({ data: [], unread: 0 });

  const values = sheet.getDataRange().getValues();
  const c = COL.NOTIFICATIONS;
  const items = [];
  let unread = 0;

  for (let i = values.length - 1; i > 0; i--) {
    if (values[i][c.RECIPIENT] !== ctx.user) continue;

    const read = values[i][c.READ] === true || values[i][c.READ] === 'true';
    if (!read) unread++;

    if (items.length < LIMITS.NOTIFICATION_PAGE) {
      items.push({
        row: i + 1,
        type: values[i][c.TYPE],
        message: values[i][c.MESSAGE],
        rideId: values[i][c.RIDEID],
        time: values[i][c.TIMESTAMP],
        read: read,
      });
    }
  }

  return ok({ data: items, unread: unread });
}

function handleMarkNotificationsRead(ctx) {
  const sheet = ctx.ss.getSheetByName(SHEETS.NOTIFICATIONS);
  if (!sheet || sheet.getLastRow() <= 1) return ok();

  const values = sheet.getDataRange().getValues();
  const c = COL.NOTIFICATIONS;

  for (let i = 1; i < values.length; i++) {
    if (values[i][c.RECIPIENT] === ctx.user && values[i][c.READ] !== true) {
      sheet.getRange(i + 1, c.READ + 1).setValue(true);
    }
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

function handleRateUser(ctx) {
  const score = parseInt(ctx.data.score, 10);
  if (isNaN(score) || score < 1 || score > 5) return fail('Score must be 1 to 5.');
  if (!ctx.data.ratedUser || ctx.data.ratedUser === ctx.user) return fail('Invalid target.');

  const sheet = getSheet(ctx.ss, 'RATINGS');
  const c = COL.RATINGS;

  const already = getRows(ctx.ss, 'RATINGS').some(row =>
    String(row[c.RIDEID]) === String(ctx.data.rideId) &&
    row[c.RATER] === ctx.user &&
    row[c.RATED] === ctx.data.ratedUser
  );
  if (already) return fail('You already rated this person for this ride.');

  sheet.appendRow([
    ctx.data.rideId, ctx.user, ctx.data.ratedUser, score, new Date().toISOString(),
  ]);
  return ok();
}

function handleGetUserRating(ctx) {
  if (!ctx.data.userEmail) return fail('Missing email.');
  const rating = ratingFor(buildStats(ctx.ss), ctx.data.userEmail);
  return ok({ avg: rating.avg, count: rating.count });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function handleGetAnalytics(ctx) {
  const stats = buildStats(ctx.ss);
  if (userFrom(stats, ctx.user).role !== 'admin') return fail('Admin only.');

  const c = COL.RIDES;
  const rides = getRows(ctx.ss, 'RIDES');

  const economy = rides.reduce((total, row) =>
    total + splitEmails(row[c.RIDERS]).length * (parseFloat(row[c.PRICE]) || 0), 0);

  return ok({
    stats: {
      users: Object.keys(stats.users).length,
      rides: rides.length,
      economy: Math.round(economy),
      messages: getRows(ctx.ss, 'MESSAGES').length,
    },
  });
}

// ---------------------------------------------------------------------------
// Scheduled cleanup (attach these to time-driven triggers)
// ---------------------------------------------------------------------------

/** Deletes rows from the bottom up so surviving row numbers stay valid. */
function deleteRowsWhere(sheet, predicate) {
  if (!sheet || sheet.getLastRow() <= 1) return;
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (predicate(values[i])) sheet.deleteRow(i + 1);
  }
}

function autoDeletePastRides() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = startOfToday();
  cutoff.setDate(cutoff.getDate() - LIMITS.RIDE_RETENTION_DAYS);
  deleteRowsWhere(ss.getSheetByName(SHEETS.RIDES),
    row => new Date(row[COL.RIDES.DATE]) < cutoff);
}

function cleanExpiredSessions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  deleteRowsWhere(ss.getSheetByName(SHEETS.SESSIONS),
    row => Date.now() - row[COL.SESSIONS.CREATED] > LIMITS.SESSION_TTL_MS);
}

function cleanOldNotifications() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = Date.now() - LIMITS.NOTIFICATION_TTL_MS;
  deleteRowsWhere(ss.getSheetByName(SHEETS.NOTIFICATIONS),
    row => new Date(row[COL.NOTIFICATIONS.TIMESTAMP]).getTime() < cutoff);
}

// Exported for the local test harness; ignored by Apps Script.
if (typeof module !== 'undefined') {
  module.exports = { doPost, doGet, sanitize, hashPassword, validateRide, COL, HEADERS };
}
