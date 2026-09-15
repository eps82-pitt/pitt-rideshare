/**
 * Local test harness for backend/Code.gs.
 *
 * Apps Script only runs on Google's servers, so this stubs the handful of
 * platform globals the backend touches (SpreadsheetApp, Utilities, CacheService,
 * LockService, ContentService) against in-memory sheets. That makes it possible
 * to exercise the real handlers before deploying.
 *
 * Run with:  node test/harness.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// --- in-memory Sheets ------------------------------------------------------

function makeSheet(name) {
  const rows = [];
  return {
    name,
    rows,
    getLastRow: () => rows.length,
    appendRow: (row) => rows.push(row.slice()),
    getDataRange: () => ({ getValues: () => rows }),
    getRange: (r, c) => ({
      setValue: (value) => { rows[r - 1][c - 1] = value; },
    }),
    deleteRow: (r) => { rows.splice(r - 1, 1); },
  };
}

function makeSpreadsheet() {
  const sheets = {};
  return {
    sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };
}

let spreadsheet = makeSpreadsheet();
let cache = {};
let uuidCounter = 0;

function resetWorld() {
  spreadsheet = makeSpreadsheet();
  cache = {};
  uuidCounter = 0;
}

// --- platform stubs --------------------------------------------------------

function uuid() {
  uuidCounter += 1;
  const n = uuidCounter.toString(16).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${n}`;
}

const sandbox = {
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    getUuid: uuid,
    computeDigest: (_alg, input) => {
      const buf = crypto.createHash('sha256').update(input, 'utf8').digest();
      // Apps Script returns signed bytes.
      return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
    },
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = v; },
      remove: (k) => { delete cache[k]; },
    }),
  },
  LockService: {
    getScriptLock: () => ({ waitLock: () => true, releaseLock: () => true }),
  },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, setMimeType: () => ({ text }) }),
  },
  module: { exports: {} },
};

const source = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'
);
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'Code.gs' });

const backend = sandbox.module.exports;

// --- helpers ---------------------------------------------------------------

function post(payload) {
  const res = backend.doPost({ postData: { contents: JSON.stringify(payload) } });
  return JSON.parse(res.text);
}

function register(email, name, gender) {
  return post({ action: 'register', email, password: 'hunter22', name, gender });
}

function futureDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().split('T')[0];
}

const baseRide = {
  vibe: 'Quiet',
  music: 'Podcasts/Silence',
  luggage: 'Large Trunk Space',
  direction: 'Leaving Pitt',
  affinity: 'Everyone',
  seats: 2,
  price: 30,
  destination: 'Philadelphia',
};

// --- assertions ------------------------------------------------------------

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label + (detail ? '  -> ' + detail : ''));
  }
}

// --- tests -----------------------------------------------------------------

function testAuth() {
  resetWorld();

  const good = register('eps82@pitt.edu', 'Ethan Steiner', 'Male');
  check('register accepts a valid @pitt.edu address', good.status === 'success', good.message);
  check('register returns a session token', !!good.token);

  const xss = register('"><img src=x onerror=alert(1)>@pitt.edu', 'Bad', 'Male');
  check('register rejects an XSS payload in the local part', xss.status === 'error', JSON.stringify(xss));

  const outside = register('someone@gmail.com', 'Nope', 'Male');
  check('register rejects a non-Pitt domain', outside.status === 'error');

  const dupe = register('eps82@pitt.edu', 'Ethan Again', 'Male');
  check('register rejects a duplicate account', dupe.status === 'error');

  const wrong = post({ action: 'login', email: 'eps82@pitt.edu', password: 'wrongpass' });
  check('login rejects a bad password', wrong.status === 'error');

  const right = post({ action: 'login', email: 'eps82@pitt.edu', password: 'hunter22' });
  check('login accepts the correct password', right.status === 'success' && !!right.token);

  const noToken = post({ action: 'getRides' });
  check('a protected action refuses a missing token', noToken.status === 'unauthorized');

  const badToken = post({ action: 'getRides', token: 'not-a-uuid' });
  check('a protected action refuses a malformed token', badToken.status === 'unauthorized');
}

function testRidesAndBooking() {
  resetWorld();

  const driver = register('driver@pitt.edu', 'Dana Driver', 'Female');
  const rider = register('rider@pitt.edu', 'Riley Rider', 'Male');
  const third = register('third@pitt.edu', 'Tal Third', 'Male');

  const added = post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 1001, date: futureDate(10),
  }));
  check('addRide accepts a valid ride', added.status === 'success', added.message);

  const badSeats = post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 1002, date: futureDate(10), seats: 99,
  }));
  check('addRide rejects an out-of-range seat count', badSeats.status === 'error');

  const past = post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 1003, date: '2020-01-01',
  }));
  check('addRide rejects a date in the past', past.status === 'error');

  let list = post({ action: 'getRides', token: rider.token });
  check('getRides returns the posted ride', list.data.length === 1, JSON.stringify(list));
  check('a new driver is not yet verified', list.data[0].verified === false);
  check('a non-participant sees the driver email masked', list.data[0].email === 'HIDDEN');

  const ownRide = post({ action: 'bookSeat', token: driver.token, id: 1001 });
  check('a driver cannot book their own ride', ownRide.status === 'error');

  const booked = post({ action: 'bookSeat', token: rider.token, id: 1001 });
  check('bookSeat succeeds for another user', booked.status === 'success', booked.message);

  list = post({ action: 'getRides', token: rider.token });
  check('bookSeat decrements the seat count', list.data[0].seats === 1, 'seats=' + list.data[0].seats);
  check('a booked rider sees the driver email', list.data[0].email === 'driver@pitt.edu');
  check('rider names are resolved', list.data[0].riderNames[0] === 'Riley Rider');

  const twice = post({ action: 'bookSeat', token: rider.token, id: 1001 });
  check('bookSeat refuses a double booking', twice.status === 'error');

  post({ action: 'bookSeat', token: third.token, id: 1001 });
  list = post({ action: 'getRides', token: rider.token });
  check('the ride fills to zero seats', list.data[0].seats === 0, 'seats=' + list.data[0].seats);

  const fourth = register('fourth@pitt.edu', 'Fay Fourth', 'Female');
  const full = post({ action: 'bookSeat', token: fourth.token, id: 1001 });
  check('bookSeat refuses a full ride', full.status === 'error');

  const wait = post({ action: 'joinWaitlist', token: fourth.token, id: 1001 });
  check('joinWaitlist succeeds', wait.status === 'success');

  const cancelled = post({ action: 'cancelSeat', token: rider.token, id: 1001 });
  check('cancelSeat succeeds', cancelled.status === 'success', cancelled.message);

  list = post({ action: 'getRides', token: rider.token });
  check('cancelSeat restores the seat', list.data[0].seats === 1, 'seats=' + list.data[0].seats);
  check('cancelSeat clears the promoted waitlist entry', list.data[0].waitlist === '');

  const notifs = post({ action: 'getNotifications', token: fourth.token });
  const promoted = notifs.data.some((n) => n.type === 'waitlist_promoted');
  check('the waitlisted user is notified of the free seat', promoted);
}

function testWomenOnlyFiltering() {
  resetWorld();

  const driver = register('she@pitt.edu', 'Sam Driver', 'Female');
  const man = register('he@pitt.edu', 'Max Rider', 'Male');
  const woman = register('her@pitt.edu', 'Mia Rider', 'Female');

  post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 2001,
    date: futureDate(5), affinity: 'Women Only',
  }));

  const asMan = post({ action: 'getRides', token: man.token });
  check('a women-only ride is hidden server-side from other users', asMan.data.length === 0);

  const asWoman = post({ action: 'getRides', token: woman.token });
  check('a women-only ride is visible to women', asWoman.data.length === 1);

  const blocked = post({ action: 'bookSeat', token: man.token, id: 2001 });
  check('booking a women-only ride is refused', blocked.status === 'error');
}

function testPaymentAuthorisation() {
  resetWorld();

  const driver = register('d2@pitt.edu', 'Dee Two', 'Female');
  const rider = register('r2@pitt.edu', 'Ray Two', 'Male');
  const outsider = register('o2@pitt.edu', 'Ozzy Two', 'Male');

  post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 3001, date: futureDate(4),
  }));
  post({ action: 'bookSeat', token: rider.token, id: 3001 });

  const selfConfirm = post({
    action: 'markPaid', token: rider.token,
    rideId: 3001, riderEmail: 'r2@pitt.edu', status: 'received',
  });
  check('a rider cannot confirm their own payment as received', selfConfirm.status === 'error');

  const markSent = post({
    action: 'markPaid', token: rider.token,
    rideId: 3001, riderEmail: 'r2@pitt.edu', status: 'paid',
  });
  check('a rider can mark their own payment as sent', markSent.status === 'success', markSent.message);

  const confirm = post({
    action: 'markPaid', token: driver.token,
    rideId: 3001, riderEmail: 'r2@pitt.edu', status: 'received',
  });
  check('the driver can confirm receipt', confirm.status === 'success', confirm.message);

  const meddle = post({
    action: 'markPaid', token: outsider.token,
    rideId: 3001, riderEmail: 'r2@pitt.edu', status: 'paid',
  });
  check('an unrelated user cannot touch payment status', meddle.status === 'error');
}

function testMessagingAccessControl() {
  resetWorld();

  const driver = register('d3@pitt.edu', 'Dot Three', 'Female');
  const rider = register('r3@pitt.edu', 'Rio Three', 'Male');
  const snoop = register('s3@pitt.edu', 'Sly Three', 'Male');

  post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 4001, date: futureDate(6),
  }));
  post({ action: 'bookSeat', token: rider.token, id: 4001 });

  const sent = post({
    action: 'sendMessage', token: rider.token, rideId: 4001, message: 'What time?',
  });
  check('a participant can send a message', sent.status === 'success', sent.message);

  const blocked = post({
    action: 'sendMessage', token: snoop.token, rideId: 4001, message: 'hello',
  });
  check('a non-participant cannot send a message', blocked.status === 'error');

  const read = post({ action: 'getMessages', token: driver.token, rideId: 4001 });
  check('the driver can read the thread', read.data.length === 1, JSON.stringify(read));

  const denied = post({ action: 'getMessages', token: snoop.token, rideId: 4001 });
  check('a non-participant cannot read the thread', denied.status === 'error');
}

function testSanitisation() {
  const s = backend.sanitize;

  check('strips a single leading formula trigger', s('=SUM(A1)').indexOf('=') !== 0, s('=SUM(A1)'));
  check('strips repeated leading formula triggers', s('==SUM(A1)').indexOf('=') !== 0, s('==SUM(A1)'));
  check('strips a mixed leading run', s('=+@-HYPERLINK()').indexOf('=') !== 0, s('=+@-HYPERLINK()'));
  check('escapes angle brackets', s('<script>') === '&lt;script&gt;', s('<script>'));
  check('escapes quotes', s('a"b') === 'a&quot;b', s('a"b'));
  check('handles null without throwing', s(null) === '');
  check('caps length at the configured maximum', s('x'.repeat(900)).length === 500);
}

function testAlerts() {
  resetWorld();

  const watcher = register('w@pitt.edu', 'Wes Watcher', 'Male');
  const driver = register('d4@pitt.edu', 'Dev Four', 'Female');

  post({
    action: 'saveAlert', token: watcher.token,
    destination: 'Philadelphia', direction: 'Leaving Pitt', maxPrice: 40,
  });

  post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 5001, date: futureDate(9),
  }));

  const notifs = post({ action: 'getNotifications', token: watcher.token });
  check('a matching ride fires a saved alert', notifs.data.some((n) => n.type === 'ride_alert'),
    JSON.stringify(notifs.data));

  post(Object.assign({}, baseRide, {
    action: 'addRide', token: driver.token, id: 5002,
    date: futureDate(9), destination: 'Cleveland',
  }));

  const after = post({ action: 'getNotifications', token: watcher.token });
  const alertCount = after.data.filter((n) => n.type === 'ride_alert').length;
  check('a non-matching ride does not fire the alert', alertCount === 1, 'count=' + alertCount);
}

// --- run -------------------------------------------------------------------

[
  testAuth,
  testRidesAndBooking,
  testWomenOnlyFiltering,
  testPaymentAuthorisation,
  testMessagingAccessControl,
  testSanitisation,
  testAlerts,
].forEach((fn) => {
  try {
    fn();
  } catch (err) {
    failures.push(fn.name + ' threw: ' + err.stack);
  }
});

console.log('\npassed: ' + passed);
if (failures.length) {
  console.log('failed: ' + failures.length);
  failures.forEach((f) => console.log('  x ' + f));
  process.exit(1);
}
console.log('all checks passed');
