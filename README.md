# PittRide

A peer-to-peer rideshare board for University of Pittsburgh students. Full-stack web app with a serverless backend, built solo.

**Status:** working prototype, not publicly deployed.

<!-- TODO: add 2-3 screenshots here. Search view, ride card, and map view are the ones worth showing. -->

## The problem

Students heading home for breaks coordinate rides through scattered GroupMe and Facebook posts. There's no search, no way to filter by date or price, no record of who's reliable, and no structure for splitting gas. PittRide replaces that with a searchable board where accounts are gated to `@pitt.edu`, drivers accumulate ratings, and each trip gets its own chat.

## Features

- **Auth** gated to `@pitt.edu`, with salted SHA-256 password hashing and UUID session tokens on a 7-day expiry
- **Ride posting and booking** with live seat counts, waitlists, and automatic promotion of the next person when a seat frees up
- **Search and filtering** by destination, direction, date window, price ceiling, luggage capacity, and ride vibe
- **Map view** using Leaflet with Nominatim geocoding, plus a Haversine-distance fare suggestion
- **Per-trip group chat** scoped to the driver and booked riders
- **Notifications** across six event types, plus saved-search alerts that fire when a matching ride is posted
- **Bidirectional 1–5 star ratings** and a driver verification heuristic (3+ completed rides at a 4.0+ average)
- **Payment status tracking** between driver and riders
- **Women-only rides**, filtered server-side so restricted rides never reach an unauthorized client
- **Cancellation policies** (flexible / 24h notice / none), enforced on the server
- Light and dark themes, three responsive breakpoints, PWA manifest

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla JavaScript, no framework |
| Maps | Leaflet.js |
| Backend | Google Apps Script (single `doPost` endpoint) |
| Data | Google Sheets, 7 tables |
| Geocoding | Nominatim (OpenStreetMap) |

No build step and no framework, deliberately — the whole thing is a static file plus a script deployment.

## Architecture

A single `doPost` endpoint dispatches on an `action` field. Every action except `login` and `register` requires a session token, which is regex-checked for UUID shape and then validated against the Sessions table. The entire handler body runs inside a script-level `LockService` mutex with a 15-second wait timeout.

Seven sheets act as tables:

- `Users` — email, password hash, salt, profile fields, role
- `Sessions` — email, token, creation timestamp
- `Rides` — 24 columns, denormalized (riders and waitlist stored as comma-joined email strings)
- `Messages` — ride ID, sender, timestamp, body
- `Ratings` — ride ID, rater, rated, score
- `Notifications` — recipient, type, body, read flag
- `Alerts` — saved search criteria per user

Three time-driven triggers handle cleanup: expired sessions, notifications older than 30 days, and rides more than two days past.

## Engineering notes

**The concurrent booking race.** Two riders claiming the last seat at the same moment would each read `seats = 1`, each decrement, and the ride would end up oversold with a negative seat count. Fixed by wrapping the whole `doPost` body in a script-wide lock so writes serialize. This caps throughput — every request queues behind every other request — which is a tradeoff I took knowingly in exchange for correctness at this scale.

**Formula injection into the spreadsheet.** Because the data layer *is* a spreadsheet, a user typing `=IMPORTRANGE(...)` into a notes field would have it evaluated as a live formula by Sheets. The sanitizer strips leading `=`, `+`, `-`, `@`, tab, and carriage return before any write.

**Optimistic UI.** Booking and cancelling mutate local state and re-render immediately, then reconcile against the server on the next sync. Makes a backend with multi-second latency feel responsive.

**Server-side access control on restricted rides.** Women-only rides are filtered in `handleGetRides` rather than hidden in the client, so the data never reaches a browser that shouldn't have it. Driver emails are likewise masked to `HIDDEN` for anyone who isn't the driver, a booked rider, or an admin.

## Known limitations

Listing these because they're the part I learned the most from.

- **The read path doesn't scale.** `handleGetRides` calls `getUser()` and `isVerified()` once per ride, and each of those re-reads an entire sheet — so it's quadratic in sheet reads. Fine at tens of rides, would collapse at thousands. The fix is one bulk read of Users and Rides into memory, then in-process lookups.
- **Password hashing is a single SHA-256 pass, not a key derivation function.** It's salted, but it isn't iterated, so it's cheap to attack offline. Apps Script has no native bcrypt or scrypt; a real deployment should delegate to Google OAuth instead of storing passwords at all.
- **Email validation is a suffix check only.** `endsWith('@pitt.edu')` accepts strings that aren't valid email addresses, and those strings get rendered into the DOM — a stored XSS vector. Needs a real format validator on the local part.
- **No email verification**, so a `@pitt.edu` address is unproven.
- **Session tokens live in `localStorage`**, readable by any successful XSS.
- **Payment status is self-reported** — there's no payment processing, and the authorization check on status updates is looser than it should be.
- **Formula-injection stripping removes only one leading character**, so `==SUM(1)` survives as `=SUM(1)`.

## Running it locally

1. Create a Google Sheet. Open Extensions → Apps Script on it.
2. Paste `backend/Code.gs` into the script editor.
3. Deploy → New deployment → Web app, executing as yourself, accessible to anyone.
4. Copy the deployment URL into the `API` constant in the frontend.
5. Open the frontend as a static file, or serve it with any static host.

The sheets and header rows are created automatically on first write.

> The deployment URL is intentionally not committed. Supply your own.

## Tests

`test/harness.js` stubs the Apps Script platform globals (SpreadsheetApp,
Utilities, CacheService, LockService, ContentService) against in-memory sheets so
the real handlers can be exercised without deploying:

```
node test/harness.js
```

48 checks cover auth and session handling, seat booking and waitlist promotion,
server-side filtering of restricted rides, payment authorisation, message access
control, saved-search alerts, and input sanitisation.
