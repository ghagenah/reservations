/* =========================================================
   Arts Division room reservations — shared form behaviour.

   Each page declares its own space — name, webhook, rooms — in a
   window.SPACE_CONFIG block just before this script loads. Each space is a
   folder beside this file — panetta (one room, so no picker) and darc (two
   rooms).

   Loaded at the end of <body>, so the DOM is already parsed and no
   defer/DOMContentLoaded guard is needed.
   ========================================================= */

/* =========================================================
   CONFIGURATION
   ========================================================= */

/* Everything space-specific comes from the page; everything below the CFG
   lines is Arts Division policy shared by every space. A page that forgets
   its config should fail loudly here, not half-work. */
const CFG = window.SPACE_CONFIG;
if (!CFG || !Array.isArray(CFG.rooms) || CFG.rooms.length === 0) {
  throw new Error('window.SPACE_CONFIG with a rooms list must be declared before reservation.js');
}

const SPACE_NAME         = CFG.spaceName;
const ZAPIER_WEBHOOK_URL = CFG.webhookUrl;
const ROOMS              = CFG.rooms;          // [{ label, calendarId }]
const MAX_GUESTS         = CFG.maxGuests;
const MAX_GUESTS_NOTE    = CFG.maxGuestsNote;

// One key for every space: it can only read public calendars.
const GOOGLE_API_KEY = 'AIzaSyBVsrrO4AdL8NHQPqlEe4fiqpiV76NXbuQ';

// The room's own time zone. Slots are shown and submitted in this zone no
// matter where the person booking happens to be.
// UCSC BAS 0009, "Events with Alcoholic Beverages". Swap in your canonical
// link if this one moves — the URL carries an access token.
const ALCOHOL_POLICY_URL =
  'https://ucscpolicy.ellucid.com/pman/documents/view/112/?security=5917c4f5043157c8189734f41e1f81e62acecd1e';

const TIME_ZONE       = 'America/Los_Angeles';
const TIME_ZONE_LABEL = 'Pacific';

// How far ahead a request may be made, and the notice required. Both are
// enforced on the date input, in validation, and in the draft restore.
const MIN_LEAD_DAYS   = 10;
const MAX_MONTHS_AHEAD = 12;

// Bookable window, in the zone above. Slots start on the hour from START_HOUR
// up to (END_HOUR - 1), so 8 / 22 renders 8:00 AM–9:00 AM through 9:00–10:00 PM.
const START_HOUR = 8;
const END_HOUR   = 22;

/* =========================================================
   ELEMENTS + STATE
   ========================================================= */

const form       = document.getElementById('reservation-form');
const titleInput = document.getElementById('event-title');
const moreDates  = document.getElementById('more-dates');

const repeatFrequency = document.getElementById('repeat-frequency');
const repeatCountWrap = document.getElementById('repeat-count-wrap');
const repeatCount     = document.getElementById('repeat-count');
const repeatPreview   = document.getElementById('repeat-preview');
const occupancyBox = document.getElementById('occupancy');
const descInput  = document.getElementById('description');
const rpName     = document.getElementById('rp-name');
const rpPhone    = document.getElementById('rp-phone');
const rpEmail    = document.getElementById('rp-email');
const totalGuests   = document.getElementById('total-guests');
const guestsUnder21 = document.getElementById('guests-under-21');
const notesInput = document.getElementById('notes');
const alcoholPolicyBox  = document.getElementById('alcohol-policy');
const alcoholAgreeBox   = document.getElementById('alcohol-agree');
const checklistBox      = document.getElementById('checklist-agree');
const sameAsMe     = document.getElementById('same-as-me');
const rpNameField  = document.getElementById('rp-name-field');
const rpEmailField = document.getElementById('rp-email-field');
const errorSummary = document.getElementById('error-summary');
const draftNote    = document.getElementById('draft-note');

// The calendar dialog. Declared here rather than beside its own code further
// down so that anything resetting the form can sync it — a const declared
// late is in the temporal dead zone for everything above it.
const calDialog = document.getElementById('cal-dialog');
const calFrame  = document.getElementById('cal-frame');
const calTitle  = document.getElementById('cal-dialog-title');
const calOpen   = document.getElementById('cal-open');
const calHint   = document.getElementById('cal-hint');

// ucsc.edu and its subdomains, e.g. soe.ucsc.edu
const UCSC_EMAIL = /^[^@\s]+@([a-z0-9-]+\.)*ucsc\.edu$/i;

const DRAFT_KEY = CFG.draftKey;

/* The draft outlives a submission on purpose. A request can still be turned
   away after it is sent — a clash, or times the Zap cannot read — and the
   reply asks the person to come back and choose again. Keeping their answers
   means only the time needs redoing. It also saves repeat bookers retyping
   fields that never change. Consent is still never restored. */
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Where a successful submission lands, and the key it passes details through.
// confirmation.html is shared by every space, so the key is shared too — the
// payload carries the location.
const CONFIRMATION_PAGE = CFG.confirmationPage;
const CONFIRMATION_KEY  = 'reservation-confirmation';

// Consent is never restored from a draft — agreeing has to be a deliberate act
// each time, not something a saved form does on someone's behalf.
const NEVER_RESTORE = ['occupancy', 'checklist-agree', 'alcohol-agree'];

// When the requester is also the responsible party, mirror their details down
// rather than making them type the same thing twice.
function syncSameAsMe() {
  const same = sameAsMe.checked;
  rpNameField.hidden = same;
  rpEmailField.hidden = same;
  if (same) {
    rpName.value = nameInput.value;
    rpEmail.value = emailInput.value;
  }
}

// Reads the selected value of a radio group, or '' when nothing is picked.
function radioValue(name) {
  const picked = form.querySelector(`input[name="${name}"]:checked`);
  return picked ? picked.value : '';
}

// The alcohol policy agreement only applies when alcohol is actually served.
/* The count only appears once a frequency is chosen, and the preview lists
   the actual dates — the one place a requester can see that monthly from the
   31st skips short months, before anything is submitted. */
function syncRepeat() {
  const repeating = !!repeatFrequency.value;
  repeatCountWrap.hidden = !repeating;
  repeatPreview.hidden = true;
  repeatPreview.classList.remove('overflows');
  if (!repeating || !dateInput.value) return;

  const count = Math.floor(Number(repeatCount.value));
  if (!Number.isInteger(count) || count < 2 || count > REPEAT_MAX) return;

  const dates = occurrenceDates(dateInput.value, repeatFrequency.value, count);
  let text = `Books ${dates.length} dates: ${dates.map(shortDate).join(' · ')}.`;
  const last = dates[dates.length - 1];
  if (last > latestBookableDate()) {
    text += ` The last date is past the ${MAX_MONTHS_AHEAD}-month booking window — fewer repeats will fit.`;
    repeatPreview.classList.add('overflows');
  }
  repeatPreview.textContent = text;
  repeatPreview.hidden = false;

  /* Then check those dates against the calendar and say which are taken. The
     grid above only ever shows the first date, so without this the requester
     fills in the whole form before finding out week three is gone. Advisory
     only — submit re-checks, and this must never block typing, so a failure
     just leaves the plain list. A token guards against an older, slower
     lookup landing after a newer one. */
  const token = ++repeatPreviewToken;
  previewSeriesAvailability(dates, token, text);
}

let repeatPreviewToken = 0;

async function previewSeriesAvailability(dates, token, baseText) {
  const room = selectedRoom();
  const chosen = slotButtons.filter(button => button.classList.contains('selected'));
  if (!room || !chosen.length) return;   // nothing to check the dates against yet

  const startHour = Number(readZoneClock(new Date(chosen[0].dataset.start)).hour);
  const endHour = Number(readZoneClock(new Date(chosen[chosen.length - 1].dataset.start)).hour) + 1;

  try {
    const first = parseDateValue(dates[0]);
    const last  = parseDateValue(dates[dates.length - 1]);
    const busy = await fetchBusyRange(room.calendarId,
      zonedInstant(first.year, first.month, first.day, 0, 0, 0, 0),
      zonedInstant(last.year, last.month, last.day, 23, 59, 59, 999));

    if (token !== repeatPreviewToken) return;          // a newer lookup won
    const clashes = seriesConflicts(dates, startHour, endHour, busy);
    if (!clashes.length) return;                        // leave the plain list

    repeatPreview.textContent = baseText +
      ` ${clashes.length === 1 ? 'One date is' : clashes.length + ' dates are'} already booked ` +
      `at those hours: ${clashes.map(shortDate).join(' · ')}.`;
    repeatPreview.classList.add('overflows');
  } catch (_) {
    /* Advisory only. Submit does the check that counts. */
  }
}

function syncAlcoholPolicy() {
  const serving = radioValue('alcohol') === 'Yes, alcohol';
  alcoholPolicyBox.hidden = !serving;
  if (!serving) alcoholAgreeBox.checked = false;   // never submit a stale agreement
}
/* =========================================================
   ROOMS
   ========================================================= */

/* A one-room space never shows the picker: its single room is implicit, and
   Panetta stays exactly the form it was. Multi-room spaces get radios built
   from config, so the rooms are defined in one place only. */

function selectedRoom() {
  if (ROOMS.length === 1) return ROOMS[0];
  const label = radioValue('room');
  return ROOMS.find(room => room.label === label) || null;
}

// Where the event happens, for the payload and the confirmation page.
function locationLabel(room) {
  return ROOMS.length === 1 ? SPACE_NAME : `${SPACE_NAME} — ${room.label}`;
}

function buildRoomField() {
  if (ROOMS.length === 1) return;
  const choices = document.getElementById('room-choices');
  ROOMS.forEach(room => {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'room';
    input.value = room.label;
    input.setAttribute('aria-required', 'true');   // the legend carries a *
    const span = document.createElement('span');
    span.textContent = room.label;
    // An optional line describing the room, in the same style the food and
    // vendor choices use for their sub-text.
    if (room.note) {
      const note = document.createElement('span');
      note.className = 'sub';
      note.textContent = room.note;
      span.appendChild(note);
    }
    label.append(input, span);
    choices.appendChild(label);
  });
  document.getElementById('room-field').hidden = false;
}

const nameInput  = document.getElementById('name');
const emailInput = document.getElementById('email');
const deptInput  = document.getElementById('department');
const dateInput  = document.getElementById('date');
const slotsBox   = document.getElementById('slots');
const slotCount  = document.getElementById('slot-count');
const submitBtn  = document.getElementById('submit-btn');
const statusBox  = document.getElementById('status');
const clearBtn   = document.getElementById('clear-btn');

// Labels of currently selected slots, e.g. "9:00 AM – 10:00 AM".
let selectedSlots = [];

// Every rendered slot button, in chronological order.
let slotButtons = [];

// The reservation must be one unbroken run of hours, so the selection is a
// single inclusive index range into slotButtons — or null when nothing is picked.
let selection = null;

// Guards against a slow earlier request overwriting a newer one.
let requestToken = 0;

/* =========================================================
   HELPERS
   ========================================================= */

/* Every displayed and submitted time is Pacific, whatever clock the visitor is
   on: the room is in one place, so 9:00 AM has to mean 9:00 AM there. The
   helpers below convert between Pacific wall-clock readings and real instants,
   reading the offset from the zone itself so PST and PDT both come out right. */

const zoneParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

// What the Pacific wall clock reads at a given instant.
function readZoneClock(date) {
  const parts = {};
  for (const part of zoneParts.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  parts.hour = String(Number(parts.hour) % 24).padStart(2, '0'); // some engines say "24"
  return parts;
}

// The zone's UTC offset in milliseconds at that instant (-7h PDT, -8h PST).
function zoneOffsetMs(date) {
  const p = readZoneClock(date);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - (date.getTime() - date.getMilliseconds());
}

// The instant at which the Pacific clock reads the given date and time.
// `month` is 0-based, matching Date.UTC.
function zonedInstant(year, month, day, hour, minute = 0, second = 0, ms = 0) {
  const naive = Date.UTC(year, month, day, hour, minute, second, ms);
  const instant = naive - zoneOffsetMs(new Date(naive));
  // Near a DST boundary the first guess can sit on the wrong side of the
  // change, so re-read the offset at the instant we actually landed on.
  const settled = naive - zoneOffsetMs(new Date(instant));
  return new Date(settled);
}

// Today's calendar date in Pacific — not the visitor's, which may be a day off.
function todayInZone() {
  const p = readZoneClock(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

// A calendar date offset from today in the room's zone, as "YYYY-MM-DD".
// Date.UTC normalises month and year rollover, so +370 days or +12 months
// both land correctly.
function dateValueFromToday({ days = 0, months = 0 } = {}) {
  const [y, m, d] = todayInZone().split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1 + months, d + days));
  const pad = n => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// The earliest and latest dates a request may be made for.
function earliestBookableDate() { return dateValueFromToday({ days: MIN_LEAD_DAYS }); }
function latestBookableDate()   { return dateValueFromToday({ months: MAX_MONTHS_AHEAD }); }

// "Friday, 12 September 2026" — for messages, where a bare ISO date is unhelpful.
function longDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
}

// "2026-08-28" -> { year, month (0-based), day }
function parseDateValue(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month: month - 1, day };
}

// The most repeats one request may ask for. Also the input's max attribute.
const REPEAT_MAX = 30;

/* The dates a repeating booking lands on, as "YYYY-MM-DD" values, the first
   date included. Pure calendar arithmetic through Date.UTC — a date is not an
   instant, so daylight saving cannot move it.

   Monthly matches RRULE semantics, which is what Google Calendar does when
   the Zap turns these settings into a recurring event: a month without the
   day (the 31st in June) is skipped, and the count keeps going until it is
   met. The preview and the events created from it therefore cannot disagree.
   The guard bounds the worst case — a count of 30 on the 31st spans about
   fifty months, and the booking-window check rejects it long before that. */
function occurrenceDates(startValue, frequency, count) {
  const { year, month, day } = parseDateValue(startValue);
  const iso = d => d.toISOString().slice(0, 10);
  const out = [];
  if (frequency === 'Monthly') {
    for (let m = 0; out.length < count && m < 60; m++) {
      const d = new Date(Date.UTC(year, month + m, day));
      if (d.getUTCDate() === day) out.push(iso(d));
    }
  } else {
    const step = frequency === 'Daily' ? 1 : 7;
    for (let i = 0; i < count; i++) {
      out.push(iso(new Date(Date.UTC(year, month, day + i * step))));
    }
  }
  return out;
}

/* Which of a series' dates clash with the busy intervals, for a block running
   from startHour to endHour wall-clock. Each date gets its own instants, so a
   series crossing a daylight-saving change keeps its hours. */
function seriesConflicts(dates, startHour, endHour, busy) {
  return dates.filter(value => {
    const { year, month, day } = parseDateValue(value);
    return overlapsBusy(zonedInstant(year, month, day, startHour),
                        zonedInstant(year, month, day, endHour), busy);
  });
}

// Short date for the preview line, e.g. "Mon, Sep 14".
function shortDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

// Plain text, e.g. "8:00 AM". Newer ICU versions put a narrow no-break space
// (U+202F) before AM/PM, which looks identical but isn't a space to anything
// matching on text downstream — so flatten it to a normal one.
function formatTime(date) {
  return date
    .toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' })
    .replace(/[\u202f\u00a0]/g, ' ');
}

// RFC 3339 carrying the Pacific offset, e.g. "2026-08-31T11:00:00-07:00".
function toZonedISO(date) {
  const p = readZoneClock(date);
  const offset = zoneOffsetMs(date);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 3600000)).padStart(2, '0');
  const mm = String(Math.floor(abs / 60000) % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

function formatSlotLabel(start, end) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

function showStatus(message, kind) {
  statusBox.textContent = message;
  statusBox.className = `status ${kind}`;
  statusBox.hidden = false;
}

function clearStatus() {
  statusBox.hidden = true;
  statusBox.textContent = '';
}

function updateSlotCount() {
  if (!selection) {
    slotCount.hidden = true;
    clearBtn.hidden = true;
    return;
  }
  const n = selection.end - selection.start + 1;
  const from = formatTime(new Date(slotButtons[selection.start].dataset.start));
  const to   = formatTime(new Date(slotButtons[selection.end].dataset.end));
  slotCount.textContent = `${n} hour${n === 1 ? '' : 's'} · ${from} – ${to}`;
  slotCount.hidden = false;
  clearBtn.hidden = false;
}

function resetSlots(message) {
  selectedSlots = [];
  slotButtons = [];
  selection = null;
  updateSlotCount();
  slotsBox.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'placeholder';
  el.textContent = message;
  slotsBox.appendChild(el);
}

/* =========================================================
   GOOGLE CALENDAR
   ========================================================= */

// Returns busy intervals as [{ start: Date, end: Date }] for the given day.
/* Availability is fetched once for a whole window and reused, so changing the
   date does not mean waiting on the network each time. Anything outside that
   window, or a cache older than the TTL, falls back to a live single-day
   query — the behaviour the form had before. */

const PREFETCH_DAYS = 45;
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;

// calendarId -> { from, to, intervals, fetchedAt }. One entry per room, so a
// two-room space can answer for either without the caches trampling each other.
const availabilityByCal = new Map();
let prefetchInFlight = null;

// Google returns at most 250 events per page. A single day never approaches
// that, but a 45-day window on a busy calendar can — and events past the cap
// come back silently, which would render booked hours as free.
async function fetchBusyRange(calendarId, timeMin, timeMax) {
  const intervals = [];
  let pageToken = null;
  let pages = 0;

  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    );
    url.searchParams.set('key', GOOGLE_API_KEY);
    url.searchParams.set('timeMin', timeMin.toISOString());
    url.searchParams.set('timeMax', timeMax.toISOString());
    url.searchParams.set('singleEvents', 'true');   // expand recurring events
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url.toString());

    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (body && body.error && body.error.message) detail = body.error.message;
      } catch (_) { /* response body was not JSON */ }
      throw new Error(detail);
    }

    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];

    items
      .filter(event => event.status !== 'cancelled')
      .forEach(event => {
        // All-day events carry `date` rather than `dateTime`. Use the event's
        // own dates: deriving them from the query bounds would turn one all-day
        // event into a 45-day block across the entire window.
        if (event.start && event.start.date) {
          const [sy, sm, sd] = event.start.date.split('-').map(Number);
          const endDate = (event.end && event.end.date) || null;
          const [ey, em, ed] = endDate
            ? endDate.split('-').map(Number)
            : [sy, sm, sd + 1];                       // Google's end date is exclusive
          intervals.push({
            start: zonedInstant(sy, sm - 1, sd, 0),
            end: zonedInstant(ey, em - 1, ed, 0)
          });
          return;
        }
        if (!event.start || !event.start.dateTime || !event.end || !event.end.dateTime) return;
        intervals.push({
          start: new Date(event.start.dateTime),
          end: new Date(event.end.dateTime)
        });
      });

    pageToken = data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < 10);   // a stop, in case the token never clears

  return intervals;
}

// One day, live. Used whenever the cache cannot answer.
function fetchBusyIntervals(calendarId, day) {
  return fetchBusyRange(
    calendarId,
    zonedInstant(day.year, day.month, day.day, 0, 0, 0, 0),
    zonedInstant(day.year, day.month, day.day, 23, 59, 59, 999)
  );
}

// Fetch the whole window in one request. Failure is silent: the cache stays
// empty and every date falls back to a live query, exactly as before.
function prefetchAvailability() {
  // Start at the first bookable date: the days inside the notice period can
  // never be chosen, so caching them wastes the window.
  const [y, m, d] = earliestBookableDate().split('-').map(Number);
  const from = zonedInstant(y, m - 1, d, 0, 0, 0, 0);
  const to   = zonedInstant(y, m - 1, d + PREFETCH_DAYS, 23, 59, 59, 999);

  // Every room's window in parallel. At this room's traffic the extra request
  // for a second calendar is nothing, and either can fail without the other.
  prefetchInFlight = Promise.all(ROOMS.map(room =>
    fetchBusyRange(room.calendarId, from, to)
      .then(intervals => {
        availabilityByCal.set(room.calendarId, { from, to, intervals, fetchedAt: Date.now() });
      })
      .catch(() => { availabilityByCal.delete(room.calendarId); })
  )).finally(() => { prefetchInFlight = null; });

  return prefetchInFlight;
}

/* The cached intervals answer for a day only if the window covers it and the
   data is still fresh. Every interval is handed to renderSlots regardless of
   which day it falls on: an interval from another date simply never overlaps
   this date's slots, so no per-day bucketing is needed. */
function cachedBusyFor(calendarId, day) {
  const entry = availabilityByCal.get(calendarId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > AVAILABILITY_TTL_MS) return null;

  const dayStart = zonedInstant(day.year, day.month, day.day, 0, 0, 0, 0);
  const dayEnd   = zonedInstant(day.year, day.month, day.day, 23, 59, 59, 999);
  if (dayStart < entry.from || dayEnd > entry.to) return null;

  return entry.intervals;
}

function overlapsBusy(slotStart, slotEnd, busy) {
  return busy.some(interval => interval.start < slotEnd && interval.end > slotStart);
}

/* =========================================================
   SLOT RENDERING
   ========================================================= */

function renderSlots(day, busy) {
  selectedSlots = [];
  slotButtons = [];
  selection = null;
  updateSlotCount();
  slotsBox.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'slot-grid';
  const now = new Date();
  let availableCount = 0;

  for (let hour = START_HOUR; hour < END_HOUR; hour++) {
    const start = zonedInstant(day.year, day.month, day.day, hour);
    const end   = zonedInstant(day.year, day.month, day.day, hour + 1);
    const label = formatSlotLabel(start, end);

    const isPast   = end <= now;
    const isBooked = overlapsBusy(start, end, busy);
    const disabled = isPast || isBooked;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot' + (disabled ? ' unavailable' : '');
    button.dataset.label = label;
    button.dataset.start = start.toISOString();
    button.dataset.end   = end.toISOString();
    button.dataset.index = String(slotButtons.length);

    const time = document.createElement('span');
    time.className = 'slot-time';
    time.textContent = formatTime(start);
    const until = document.createElement('span');
    until.className = 'until';
    until.textContent = disabled
      ? (isBooked ? 'Booked' : 'Past')
      : `to ${formatTime(end)}`;
    button.append(time, until);

    if (disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.title = `${label} — ${isBooked ? 'already booked' : 'already passed'}`;
    } else {
      availableCount++;
      button.setAttribute('aria-pressed', 'false');
      button.title = label;
      const index = slotButtons.length;
      button.addEventListener('click', () => handleSlotClick(index));
    }

    slotButtons.push(button);
    grid.appendChild(button);
  }

  slotsBox.appendChild(grid);

  if (availableCount === 0) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.style.marginTop = '12px';
    note.textContent = 'No open hours on this date. Please try another day.';
    slotsBox.appendChild(note);
  }
}

// A click either starts a block, grows it by one hour at either edge, or
// shrinks it from an edge. Anything that would split or scatter the block is
// refused — non-adjacent hours are locked out before they can be clicked.
function handleSlotClick(index) {
  if (slotButtons[index].disabled) return;

  if (!selection) {
    selection = { start: index, end: index };
  } else if (index === selection.start && index === selection.end) {
    selection = null;                                   // drop the only hour
  } else if (index === selection.start) {
    selection = { start: index + 1, end: selection.end };
  } else if (index === selection.end) {
    selection = { start: selection.start, end: index - 1 };
  } else if (index === selection.start - 1 || index === selection.end + 1) {
    selection = {
      start: Math.min(index, selection.start),
      end: Math.max(index, selection.end)
    };
  } else if (index > selection.start && index < selection.end) {
    showStatus('Hours must stay back-to-back — trim the block from either end.', 'info');
    return;
  } else {
    return;                                             // locked, not adjacent
  }

  if (statusBox.classList.contains('error')) clearStatus();
  applySelection();
}

// Repaints every slot from `selection` and rebuilds the chronological label list.
function applySelection() {
  selectedSlots = [];

  slotButtons.forEach((button, i) => {
    if (button.disabled) return;   // booked or past — keeps its own styling

    const isSelected = selection !== null && i >= selection.start && i <= selection.end;
    const isEdge     = selection !== null && (i === selection.start || i === selection.end);
    const isAdjacent = selection !== null && (i === selection.start - 1 || i === selection.end + 1);
    const isLocked   = selection !== null && !isSelected && !isAdjacent;

    button.classList.toggle('selected', isSelected);
    button.classList.toggle('interior', isSelected && !isEdge);
    button.classList.toggle('blocked', isLocked);
    button.setAttribute('aria-pressed', String(isSelected));

    if (isLocked) {
      button.setAttribute('aria-disabled', 'true');
      button.title = `${button.dataset.label} — not back-to-back with your selection`;
    } else {
      button.removeAttribute('aria-disabled');
      button.title = button.dataset.label;
    }

    if (isSelected) selectedSlots.push(button.dataset.label);
  });

  updateSlotCount();
  // Which repeat dates clash depends on the hours chosen, so re-run the
  // preview. Guarded: this also runs during setup, before the control exists.
  if (typeof syncRepeat === 'function' && repeatFrequency) syncRepeat();
}

function clearSelection() {
  selection = null;
  applySelection();
  if (statusBox.classList.contains('error')) clearStatus();
}

/* =========================================================
   AVAILABILITY LOAD
   ========================================================= */

async function loadAvailability() {
  clearStatus(); // drop any message left over from a previous date
  const value = dateInput.value;
  if (!value) {
    resetSlots('Select a date to see available times.');
    return;
  }

  const room = selectedRoom();
  if (!room) {
    resetSlots('Choose a room to see available times.');
    return;
  }

  const day = parseDateValue(value);
  const token = ++requestToken;

  // Drop the old day's block before the spinner goes up, so the badge and
  // Clear button can't linger over a date they no longer describe.
  selectedSlots = [];
  slotButtons = [];
  selection = null;
  updateSlotCount();
  if (!cachedBusyFor(room.calendarId, day)) {
    slotsBox.innerHTML =
      '<div class="loading"><span class="spinner"></span>Checking calendar availability&hellip;</div>';
  }

  try {
    // If the window is still loading, wait for it rather than firing a
    // duplicate request for a day it is about to cover.
    if (prefetchInFlight) await prefetchInFlight;
    if (token !== requestToken) return;

    const cached = cachedBusyFor(room.calendarId, day);
    if (cached) {
      renderSlots(day, cached);          // no network, no spinner
      return;
    }

    const busy = await fetchBusyIntervals(room.calendarId, day);
    if (token !== requestToken) return; // a newer date was picked
    renderSlots(day, busy);
  } catch (error) {
    if (token !== requestToken) return;

    slotsBox.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'slot-error';
    box.textContent = `Couldn't load calendar availability: ${error.message}`;

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.textContent = 'Try again';
    retry.addEventListener('click', loadAvailability);

    box.appendChild(document.createElement('br'));
    box.appendChild(retry);
    slotsBox.appendChild(box);
  }
}

/* =========================================================
   DEMO FILL  —  TESTING ONLY, REMOVE WHEN NO LONGER NEEDED
   =========================================================

   Only appears with ?demo=1 in the URL. It is deliberately not shown to
   ordinary visitors: a one-click "fill everything" button on a live booking
   page would eventually produce a junk reservation, and every submission here
   becomes a real calendar event. Titles are prefixed TEST so anything that
   does get submitted is obvious in the calendar and in Zapier.            */

const DEMO_MODE = new URLSearchParams(location.search).has('demo');

// Every demo address is this one real inbox. Generated names like
// first.last@ucsc.edu look plausible enough to belong to an actual person at
// UCSC, and a test reservation must never mail a stranger.
const DEMO_EMAIL = 'ghagenah@ucsc.edu';

const DEMO = {
  titles: ['Faculty planning session', 'Guest lecture reception', 'Department retreat',
           'Thesis defense', 'Research group meeting', 'Visiting scholar talk'],
  descriptions: [
    'Monthly planning meeting with a short presentation and discussion.',
    'Reception for a visiting speaker, with a talk beforehand.',
    'Working session for the department, with a break in the middle.',
    'Dissertation defense followed by a brief celebration.'
  ],
  firstNames: ['Alex', 'Priya', 'Jordan', 'Mei', 'Sam', 'Rosa', 'Ken', 'Amara'],
  lastNames: ['Alvarez', 'Chen', 'Okafor', 'Nguyen', 'Ramirez', 'Patel', 'Brooks', 'Yamada'],
  departments: ['Politics', 'History', 'Astronomy', 'Literature',
                'Environmental Studies', 'Sociology', 'Anthropology'],
  notes: ['', '', 'We may need an extra table near the entrance.',
          'One attendee is arriving early to set up slides.']
};

const randomOf = list => list[Math.floor(Math.random() * list.length)];
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function setValue(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setRadio(name, value) {
  const radio = form.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// A calendar date a few days out, counted in the room's own time zone.
function demoDateValue() {
  return dateValueFromToday({ days: randomInt(MIN_LEAD_DAYS, MIN_LEAD_DAYS + 21) });
}

async function fillDemo() {
  const button = document.getElementById('fill-demo');
  button.disabled = true;
  button.textContent = 'Filling\u2026';
  clearErrors();
  clearStatus();

  const first = randomOf(DEMO.firstNames);
  const last = randomOf(DEMO.lastNames);

  setValue(titleInput, `TEST \u2014 ${randomOf(DEMO.titles)}`);
  setValue(descInput, randomOf(DEMO.descriptions));
  setValue(nameInput, `${first} ${last}`);
  setValue(emailInput, DEMO_EMAIL);
  setValue(deptInput, randomOf(DEMO.departments));

  sameAsMe.checked = false;
  syncSameAsMe();
  const rpFirst = randomOf(DEMO.firstNames);
  const rpLast = randomOf(DEMO.lastNames);
  setValue(rpName, `${rpFirst} ${rpLast}`);
  setValue(rpPhone, `(831) 555-${String(randomInt(0, 9999)).padStart(4, '0')}`);
  setValue(rpEmail, DEMO_EMAIL);

  const total = randomInt(6, 60);
  setValue(totalGuests, String(total));
  setRadio('openToPublic', randomOf(['Yes, open to the public', 'Not open to the public']));
  occupancyBox.checked = true;

  setRadio('food', randomOf(['Yes, self-service food', 'Yes, catered food', 'No, food will not be served']));
  setRadio('outsideVendor', randomOf(['Yes, outside vendor', 'No, outside vendor']));

  const servingAlcohol = Math.random() < 0.5;
  setRadio('alcohol', servingAlcohol ? 'Yes, alcohol' : 'No alcohol');
  syncAlcoholPolicy();
  if (servingAlcohol) {
    setValue(guestsUnder21, String(randomInt(0, Math.min(5, total))));
    alcoholAgreeBox.checked = true;
  }

  setValue(notesInput, randomOf(DEMO.notes));
  checklistBox.checked = true;

  if (ROOMS.length > 1) setRadio('room', randomOf(ROOMS).label);

  // Pick a real open block, which means waiting on the live availability check.
  setValue(dateInput, demoDateValue());
  await loadAvailability();

  const firstFree = slotButtons.findIndex(slot => !slot.disabled);
  if (firstFree !== -1) {
    slotButtons[firstFree].click();
    const next = slotButtons[firstFree + 1];
    if (next && !next.disabled) next.click();          // a two-hour block
  } else {
    showStatus('Demo fill: that date has no open hours. Pick another date.', 'info');
  }

  saveDraft();
  button.disabled = false;
  button.textContent = 'Fill with demo info';
}

/* =========================================================
   DRAFT PERSISTENCE
   ========================================================= */

/* A long form is easy to lose to a closed tab or a flat battery, so what has
   been typed is kept in this browser until the reservation is sent. It never
   leaves the device, and the agreement checkboxes are deliberately excluded. */

let saveTimer = null;

function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const draft = { at: Date.now() };
      form.querySelectorAll('input, textarea, select').forEach(el => {
        if (!el.id && !el.name) return;
        if (NEVER_RESTORE.includes(el.id)) return;
        if (el.type === 'checkbox') draft['#' + el.id] = el.checked;
        else if (el.type === 'radio') { if (el.checked) draft['@' + el.name] = el.value; }
        else if (el.id) draft['#' + el.id] = el.value;
      });
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (_) { /* private mode, or storage is full — drafts are a nicety */ }
  }, 400);
}

function restoreDraft() {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch (_) { return; }
  if (!draft || typeof draft !== 'object') return;
  if (Date.now() - (draft.at || 0) > DRAFT_TTL_MS) { clearDraft(); return; }

  let restoredAnything = false;

  Object.entries(draft).forEach(([key, value]) => {
    if (key === 'at') return;                  // the timestamp, not a field
    const name = key.slice(1);
    if (key.startsWith('@')) {
      const radio = form.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
      if (radio) { radio.checked = true; restoredAnything = true; }
      return;
    }
    const el = document.getElementById(name);
    if (!el || NEVER_RESTORE.includes(name)) return;
    if (el.type === 'checkbox') { el.checked = !!value; if (value) restoredAnything = true; }
    else if (value) {
      // A date saved before today is no longer bookable, so let it go.
      // A saved date can fall inside the notice period while the draft sat idle.
      if (el.type === 'date' && (value < earliestBookableDate() || value > latestBookableDate())) return;
      el.value = value;
      restoredAnything = true;
    }
  });

  if (!restoredAnything) return;

  syncSameAsMe();
  syncAlcoholPolicy();
  syncRepeat();
  syncCalendarDialog();   // a restored room has to reach the link too
  draftNote.hidden = false;

  // Re-check the calendar for the restored date rather than trusting old availability.
  if (dateInput.value) loadAvailability();
}

function clearDraft() {
  // Cancel any save still sitting in the debounce, or it fires after this and
  // writes the draft straight back.
  clearTimeout(saveTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* nothing to clear */ }
  draftNote.hidden = true;
}

function discardDraft() {
  clearDraft();
  form.reset();
  clearErrors();
  clearStatus();
  syncSameAsMe();
  syncAlcoholPolicy();
  syncRepeat();
  syncCalendarDialog();   // the reset cleared the room; the link named it
  resetSlots('Select a date to see available times.');
  titleInput.focus();
}

/* =========================================================
   SUBMISSION
   ========================================================= */

// Errors are collected for the whole form, then shown together — one field at
// a time would mean a scroll and a resubmit for each mistake on a form this long.
function fieldErrors() {
  const errors = [];
  const add = (el, message) => errors.push({ el, message });
  const blank = el => !el.value.trim();

  if (blank(titleInput)) add(titleInput, 'Enter an event title.');
  if (blank(descInput)) add(descInput, 'Add a brief description of your event.');
  if (blank(nameInput)) add(nameInput, 'Enter your full name.');
  if (blank(emailInput) || !emailInput.checkValidity()) add(emailInput, 'Enter a valid email address.');
  if (blank(deptInput)) add(deptInput, 'Enter the UCSC department making this request.');

  if (sameAsMe.checked) {
    // The responsible party must be reachable at a ucsc.edu address, so when
    // that party is the requester their own address has to qualify.
    if (!UCSC_EMAIL.test(emailInput.value.trim())) {
      add(emailInput, 'You are listed as the responsible party, so this must be a ucsc.edu address.');
    }
  } else {
    if (blank(rpName)) add(rpName, 'Name the UCSC responsible party for this event.');
    if (!UCSC_EMAIL.test(rpEmail.value.trim())) {
      add(rpEmail, 'The responsible party must have a ucsc.edu email address.');
    }
  }

  if (rpPhone.value.replace(/\D/g, '').length < 10) {
    add(rpPhone, 'Enter a 10-digit cell phone number for the responsible party.');
  }

  if (ROOMS.length > 1 && !selectedRoom()) {
    add(form.querySelector('input[name="room"]'), 'Choose a room.');
  }

  if (!dateInput.value) {
    add(dateInput, 'Choose a date.');
  } else if (dateInput.value < earliestBookableDate()) {
    add(dateInput, `Requests need at least ${MIN_LEAD_DAYS} days' notice. ` +
                   `The earliest date available is ${longDate(earliestBookableDate())}.`);
  } else if (dateInput.value > latestBookableDate()) {
    add(dateInput, `Requests can only be made up to ${MAX_MONTHS_AHEAD} months ahead. ` +
                   `The latest date available is ${longDate(latestBookableDate())}.`);
  } else if (selectedSlots.length === 0) {
    add(slotsBox, 'Select at least one time slot.');
  }

  if (repeatFrequency.value) {
    const count = Number(repeatCount.value);
    if (!Number.isInteger(count) || count < 2 || count > REPEAT_MAX) {
      add(repeatCount, `Enter how many times in total, from 2 to ${REPEAT_MAX}.`);
    } else if (dateInput.value && dateInput.value >= earliestBookableDate()) {
      const dates = occurrenceDates(dateInput.value, repeatFrequency.value, count);
      const last = dates[dates.length - 1];
      if (last > latestBookableDate()) {
        add(repeatCount, `That many repeats runs past the ${MAX_MONTHS_AHEAD}-month booking window — ` +
                         `the last date would be ${longDate(last)}. Reduce the count.`);
      }
    }
  }

  const total = Number(totalGuests.value);
  if (blank(totalGuests) || !Number.isFinite(total) || total < 1) {
    add(totalGuests, 'Enter the total number of guests.');
  } else if (total > MAX_GUESTS) {
    add(totalGuests, MAX_GUESTS_NOTE);
  }

  if (!radioValue('openToPublic')) {
    add(form.querySelector('input[name="openToPublic"]'), 'Say whether the event is open to the general public.');
  }

  if (!occupancyBox.checked) {
    add(occupancyBox, 'Confirm your reservation will not exceed the listed occupancy.');
  }

  if (!radioValue('food')) {
    add(form.querySelector('input[name="food"]'), 'Say whether your event will include food.');
  }

  if (!radioValue('outsideVendor')) {
    add(form.querySelector('input[name="outsideVendor"]'), 'Say whether your event will use an outside vendor.');
  }

  const alcohol = radioValue('alcohol');
  if (!alcohol) {
    add(form.querySelector('input[name="alcohol"]'), 'Say whether your event will serve alcohol.');
  } else if (alcohol === 'Yes, alcohol') {
    const under21 = Number(guestsUnder21.value);
    if (blank(guestsUnder21) || !Number.isFinite(under21) || under21 < 0) {
      add(guestsUnder21, 'Enter the number of guests under 21 (enter 0 if none).');
    } else if (Number.isFinite(total) && under21 > total) {
      add(guestsUnder21, 'Guests under 21 can\u2019t exceed the total number of guests.');
    }
    if (!alcoholAgreeBox.checked) {
      add(alcoholAgreeBox, 'Confirm you agree to abide by the University Alcohol Policy.');
    }
  }

  if (!checklistBox.checked) add(checklistBox, 'Review and agree to the event checklist.');

  return errors;
}

// The block an error message should be attached to.
function errorAnchor(el) {
  return el.closest('.field, fieldset, .occupancy, .checklist, .conditional, .slots-section') || el;
}

function clearErrors() {
  form.querySelectorAll('.field-error').forEach(node => node.remove());
  form.querySelectorAll('.has-error').forEach(node => node.classList.remove('has-error'));
  form.querySelectorAll('[aria-invalid]').forEach(node => node.removeAttribute('aria-invalid'));
  errorSummary.hidden = true;
  errorSummary.innerHTML = '';
}

function showErrors(errors) {
  clearErrors();

  const list = document.createElement('ul');

  errors.forEach((error, i) => {
    const anchor = errorAnchor(error.el);
    anchor.classList.add('has-error');

    const id = `err-${i}`;
    const note = document.createElement('p');
    note.className = 'field-error';
    note.id = id;
    note.textContent = error.message;
    anchor.appendChild(note);

    if (error.el.tagName === 'INPUT' || error.el.tagName === 'TEXTAREA') {
      error.el.setAttribute('aria-invalid', 'true');
    }

    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${id}`;
    link.textContent = error.message;
    link.addEventListener('click', event => {
      event.preventDefault();
      anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (error.el.focus) error.el.focus({ preventScroll: true });
    });
    item.appendChild(link);
    list.appendChild(item);
  });

  const heading = document.createElement('h2');
  heading.textContent = errors.length === 1
    ? 'One thing needs fixing before you can submit'
    : `${errors.length} things need fixing before you can submit`;

  errorSummary.append(heading, list);
  errorSummary.hidden = false;
  errorSummary.scrollIntoView({ block: 'center', behavior: 'smooth' });
  errorSummary.focus({ preventScroll: true });
}

async function handleSubmit(event) {
  event.preventDefault();
  clearStatus();

  const errors = fieldErrors();
  if (errors.length) {
    showErrors(errors);
    return;
  }

  clearErrors();

  const chosen = slotButtons.filter(button => button.classList.contains('selected'));
  const day = parseDateValue(dateInput.value);
  const room = selectedRoom();   // validation guarantees one is chosen

  // The UI can only build a contiguous block, but the webhook depends on it —
  // so confirm the run really is unbroken before anything is sent.
  const indices = chosen.map(button => Number(button.dataset.index));
  const isContiguous = indices.every((value, i) => i === 0 || value === indices[i - 1] + 1);
  if (!isContiguous) {
    showStatus('Please select a single block of back-to-back hours.', 'error');
    return;
  }

  /* Availability was read when the date was picked, and this form takes
     several minutes to fill in. Confirm the hours are still free before
     sending, or two people who started at the same time both get a hold and
     two groups turn up. This is a live query, never the cache. */
  /* The button carries the progress. Info messages in the status box below
     were unreadable — three of them replaced each other inside a few hundred
     milliseconds — so that box is now only used for things worth stopping to
     read: a clash, or a failure. */
  submitBtn.disabled = true;
  const submitLabel = submitBtn.textContent;
  submitBtn.textContent = 'Sending…';

  /* The series this request expands to, or null for a one-off. Validation has
     already confirmed the count and that the last date fits the window. */
  const plan = repeatFrequency.value ? {
    frequency: repeatFrequency.value,
    dates: occurrenceDates(dateInput.value, repeatFrequency.value,
                           Math.floor(Number(repeatCount.value)))
  } : null;

  let stillFree = true;
  let checkRan = false;
  try {
    if (plan) {
      /* One range query spanning the whole series, then each date's hours
         checked against it — not a query per date. The block's wall-clock
         hours come from the chosen slots; each date gets its own instants so
         a series crossing a daylight-saving change keeps its hours. */
      const first = parseDateValue(plan.dates[0]);
      const last  = parseDateValue(plan.dates[plan.dates.length - 1]);
      const busy = await fetchBusyRange(room.calendarId,
        zonedInstant(first.year, first.month, first.day, 0, 0, 0, 0),
        zonedInstant(last.year, last.month, last.day, 23, 59, 59, 999));

      const startHour = Number(readZoneClock(new Date(chosen[0].dataset.start)).hour);
      const lastSlotStart = Number(readZoneClock(new Date(chosen[chosen.length - 1].dataset.start)).hour);
      const clashes = seriesConflicts(plan.dates, startHour, lastSlotStart + 1, busy);
      checkRan = true;

      if (clashes.length) {
        stillFree = false;
        showStatus(
          `Sorry — ${clashes.length === 1 ? 'one of your repeat dates already has a booking'
                                          : clashes.length + ' of your repeat dates already have bookings'} ` +
          `during those hours: ${clashes.map(longDate).join('; ')}. ` +
          `Your details are still here — adjust the repeat settings, or pick different hours.`,
          'error'
        );
      }
    } else {
      const fresh = await fetchBusyIntervals(room.calendarId, day);
      const taken = chosen.filter(button =>
        overlapsBusy(new Date(button.dataset.start), new Date(button.dataset.end), fresh));
      checkRan = true;

      if (taken.length) {
        stillFree = false;
        availabilityByCal.delete(room.calendarId);   // now known to be wrong
        renderSlots(day, fresh);           // repaint with the truth; clears the selection
        const which = taken.map(b => b.dataset.label.split(' – ')[0]).join(', ');
        showStatus(
          `Sorry — ${which} ${taken.length === 1 ? 'was' : 'were'} booked while you were filling this in. ` +
          `Your details are still here; please pick another time.`,
          'error'
        );
        slotsBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  } catch (_) {
    /* The check could not run — a network blip, or the calendar refusing.
       What happens next depends on whether this is a series, because the two
       cases have different last lines of defence. See below. */
  }

  /* A single date may go unverified: the Zap checks it again before creating
     anything, so a clash is still caught. A series may not. The Zap only
     re-checks the first date — the rest arrive as recurrence settings that
     Google expands, and Google will happily write over an existing booking.
     Submitting a series without this check is the one path that can
     double-book somebody silently, so refuse it instead. */
  if (plan && !checkRan) {
    stillFree = false;
    showStatus(
      'We could not check the calendar for your repeat dates just now, and a repeating ' +
      'request is not re-checked after it is sent. Your details are still here — ' +
      'please try again in a moment.',
      'error'
    );
  }

  if (!stillFree) {
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;
    return;
  }

  const slotDetails = chosen.map(button => ({
    label: button.dataset.label,
    start: toZonedISO(new Date(button.dataset.start)),
    end: toZonedISO(new Date(button.dataset.end))
  }));

  // The block runs from the first selected hour to the last — one interval,
  // since the selection is guaranteed contiguous.
  const blockStart = new Date(chosen[0].dataset.start);
  const blockEnd   = new Date(chosen[chosen.length - 1].dataset.end);

  const payload = {
    // --- The five fields the Zap maps ---------------------------------
    eventTitle: titleInput.value.trim(),
    email: emailInput.value.trim(),
    date: dateInput.value,                    // "2026-08-31"
    startTime: formatTime(blockStart),        // "11:00 AM"
    endTime: formatTime(blockEnd),            // "2:00 PM"

    // Which room, by label — a one-room space sends its only room. A
    // multi-room Zap branches on this to pick the calendar it writes to.
    room: room.label,
    location: locationLabel(room),

    // Free text, empty when unused. When it is NOT empty someone has to read it
    // and duplicate the event by hand — availability was never checked for the
    // dates named here, so the Zap should make a filled-in value impossible to
    // miss rather than burying it in the body of a notification.
    additionalDates: moreDates.value.trim(),
    occupancyAgreement: 'Yes',

    // --- Repeats. The Zap has matching frequency and count fields; the dates
    // are what those settings expand to, so an admin can read the series
    // without doing calendar arithmetic. Every date was checked at submit.
    repeatFrequency: repeatFrequency.value || 'Does not repeat',
    repeatCount: plan ? String(plan.dates.length) : '1',
    repeatDates: plan ? plan.dates.join(', ') : '',

    // --- Extras, safe to leave unmapped ------------------------------
    name: nameInput.value.trim(),
    department: deptInput.value.trim(),
    eventDescription: descInput.value.trim(),

    responsiblePartyName: rpName.value.trim(),
    responsiblePartyPhone: rpPhone.value.trim(),
    responsiblePartyEmail: rpEmail.value.trim(),

    totalGuests: totalGuests.value.trim(),
    guestsUnder21: radioValue('alcohol') === 'Yes, alcohol' ? guestsUnder21.value.trim() : 'N/A',
    openToPublic: radioValue('openToPublic'),

    food: radioValue('food'),
    outsideVendor: radioValue('outsideVendor'),
    alcohol: radioValue('alcohol'),
    alcoholPolicyAgreement: radioValue('alcohol') === 'Yes, alcohol' ? 'Yes' : 'N/A',

    additionalNotes: notesInput.value.trim(),
    checklistAgreement: 'Yes',
    // Same two moments as full timestamps, in case a step ever needs them
    // without having to recombine the date and the plain-text time.
    startTimeISO: toZonedISO(blockStart),     // "2026-08-31T11:00:00-07:00"
    endTimeISO: toZonedISO(blockEnd),         // "2026-08-31T14:00:00-07:00"
    // Form encoding has no nesting, so the hour list goes as one string.
    selectedSlots: selectedSlots.join(', '),
    hours: String(chosen.length),
    timeZone: TIME_ZONE,
    submittedAt: new Date().toISOString()
  };


  try {
    // Form-encoded rather than JSON on purpose. Zapier's catch hook answers a
    // CORS preflight without Access-Control-Allow-Headers, so a JSON
    // content-type gets the POST blocked by the browser before it is sent.
    // application/x-www-form-urlencoded is safelisted, needs no preflight, and
    // Zapier reads it as flat top-level fields.
    const response = await fetch(ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      body: new URLSearchParams(payload)
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    // The draft is deliberately kept: see DRAFT_TTL_MS.

    // Hand the confirmation page just enough to show what was requested.
    // sessionStorage, not the URL — a name and email do not belong in a query
    // string, browser history, or a referrer header.
    try {
      sessionStorage.setItem(CONFIRMATION_KEY, JSON.stringify({
        eventTitle: payload.eventTitle,
        date: payload.date,
        startTime: payload.startTime,
        endTime: payload.endTime,
        location: payload.location,
        // Which form this came from, so "Make another reservation" returns
        // here rather than to whichever space the shared page defaults to.
        returnTo: window.location.pathname,
        responsiblePartyName: payload.responsiblePartyName,
        totalGuests: payload.totalGuests,
        name: payload.name,
        email: payload.email
      }));
    } catch (_) { /* the confirmation page copes without it */ }

    // Leave the button disabled: the request is gone, and the page is about to
    // change. Re-enabling invites a second submission during the navigation.
    window.location.assign(CONFIRMATION_PAGE);
    return;
  } catch (error) {
    showStatus(`Something went wrong sending your reservation: ${error.message}. Please try again.`, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;
  }
}

/* =========================================================
   INIT
   ========================================================= */

buildRoomField();   // before draft restore, so a saved room can be re-checked

document.getElementById('tz-note').textContent = TIME_ZONE_LABEL;
dateInput.min = earliestBookableDate();
dateInput.max = latestBookableDate();
document.getElementById('date-window-text').textContent =
  `Requests need at least ${MIN_LEAD_DAYS} days' notice, and can be made up to ` +
  `${MAX_MONTHS_AHEAD} months ahead — so between ${longDate(dateInput.min)} and ${longDate(dateInput.max)}.`;
dateInput.addEventListener('change', () => { loadAvailability(); syncRepeat(); });
repeatFrequency.addEventListener('change', syncRepeat);
repeatCount.addEventListener('input', syncRepeat);
form.querySelectorAll('input[name="room"]').forEach(radio =>
  radio.addEventListener('change', () => { loadAvailability(); syncCalendarDialog(); syncRepeat(); }));
clearBtn.addEventListener('click', clearSelection);

prefetchAvailability();

/* A tab left open for a while is the case most likely to act on stale data,
   so expire the window on return and let the next date pick refetch. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  for (const [calId, entry] of availabilityByCal) {
    if (Date.now() - entry.fetchedAt > AVAILABILITY_TTL_MS) availabilityByCal.delete(calId);
  }
});
sameAsMe.addEventListener('change', syncSameAsMe);
[nameInput, emailInput].forEach(input =>
  input.addEventListener('input', () => { if (sameAsMe.checked) syncSameAsMe(); }));
document.getElementById('discard-draft').addEventListener('click', discardDraft);
form.addEventListener('input', saveDraft);
form.addEventListener('change', saveDraft);
restoreDraft();

if (DEMO_MODE) {
  document.getElementById('demo-bar').hidden = false;
  document.getElementById('fill-demo').addEventListener('click', fillDemo);
}
document.getElementById('alcohol-policy-link').href = ALCOHOL_POLICY_URL;
form.querySelectorAll('input[name="alcohol"]')
    .forEach(radio => radio.addEventListener('change', syncAlcoholPolicy));
form.addEventListener('submit', handleSubmit);

// ---------- Calendar dialog ----------
// Built from the rooms list and TIME_ZONE rather than a pasted URL, so the
// dialog cannot drift from the availability lookup above.

/* One room's calendar — always the one being booked. Overlaying several would
   say nothing about which bookings belong to which room, since showCalendars=0
   hides Google's legend. There is always a room by the time this runs: a
   one-room space has an implicit one, and a multi-room space cannot open the
   dialog until a room is picked.

   Opens on the week view: it lays out actual hour blocks, which is what
   someone about to pick time slots needs. Month only says a day has something
   on it. showTabs=1 keeps Google's own switcher, so month and list are a
   click away without reloading the frame. */
function calendarEmbedUrl(room) {
  return 'https://calendar.google.com/calendar/embed'
    + `?src=${encodeURIComponent(room.calendarId)}`
    + `&ctz=${encodeURIComponent(TIME_ZONE)}`
    + '&mode=WEEK&showTitle=0&showPrint=0&showTabs=1&showCalendars=0';
}

/* Keeps the link, the frame and the heading on the current room. The frame is
   only reloaded once it has actually been opened — before that it is still
   about:blank and reloading it would fetch the calendar for someone who never
   looked. */
function syncCalendarDialog() {
  const multi = ROOMS.length > 1;
  const room = selectedRoom();

  /* With more than one room there is no sensible calendar to show until one
     is picked — overlaying both says nothing about the room being booked. The
     label says what to do rather than just going grey. */
  /* With more than one room there is nothing to show until one is picked. The
     link is made invisible rather than removed, so its space is already
     reserved and the fields below do not jump when a room is chosen. Its
     label is left alone while hidden, so the space held matches the text
     that will appear in it. */
  const empty = multi && !room;
  calHint.classList.toggle('is-empty', empty);
  if (empty) return;

  /* Name the room once one is chosen, so it is obvious whose calendar opens.
     A one-room space leaves it off — naming the only room is noise. */
  calOpen.textContent = multi ? `View the full calendar for ${room.label}`
                              : 'View the full calendar';

  const url = calendarEmbedUrl(room);
  document.getElementById('cal-newtab').href = url;
  if (calFrame.getAttribute('src') !== 'about:blank') calFrame.setAttribute('src', url);

  calTitle.textContent = multi && room ? `${room.label} availability` : 'Room availability';
}

syncCalendarDialog();

calOpen.addEventListener('click', () => {
  // Loaded on first open only; reopening reuses the frame already there.
  if (calFrame.getAttribute('src') === 'about:blank') {
    calFrame.setAttribute('src', calendarEmbedUrl(selectedRoom()));
  }
  calDialog.showModal();
});

document.getElementById('cal-close').addEventListener('click', () => calDialog.close());

// Esc is handled explicitly rather than left to the dialog's native cancel.
// Note the limit: once someone clicks into the calendar, keystrokes belong to
// that cross-origin frame and never reach this page, so the close button and
// the backdrop are what actually get people out from there.
calDialog.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  calDialog.close();
});

// Clicking the backdrop closes it. The dialog is the click target only when the
// press lands outside its own box, so compare against its bounds.
calDialog.addEventListener('click', event => {
  if (event.target !== calDialog) return;
  const box = calDialog.getBoundingClientRect();
  const inside = event.clientX >= box.left && event.clientX <= box.right
              && event.clientY >= box.top  && event.clientY <= box.bottom;
  if (!inside) calDialog.close();
});
