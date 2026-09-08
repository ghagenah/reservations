# The Zapier side

The half of this system that is not in this repository. The form posts to a
webhook; the calendar event, the booking record and all four emails happen in
Zapier, where they can only be read by clicking through the editor.

This is the overview. Field names, step IDs and merge expressions live in the
Zap editor and in `email-templates/` — they are not repeated here. *Known
problems* below is the exception, and is worth reading before changing anything.

Zapier can generate documentation for a Zap. It has been wrong at least once,
describing the reschedule filter as an AND when the Zap actually uses an OR —
which inverted the meaning entirely. Check the editor before trusting it.

See [README.md](README.md) for the front end.

## Shape

```
                        form
                          │  POST, 30 fields
                          ▼
            ┌──────────────────────────────┐
            │ [PARENT]  new booking        │
            └──────────────────────────────┘
                          │  creates the record, then calls
                          ▼
       ┌────────────────────────────────────────────┐
       │ [CHILD]  Process Panetta Booking Logic     │
       │                                            │
       │   checks the calendar for the hours asked  │
       │   for, and writes one of three outcomes:   │
       │                                            │
       │     free    →  event created, Pending      │
       │     busy    →  Time Conflict               │
       │     error   →  Time Conflict               │
       │                                            │
       │   emails the requester either way          │
       └────────────────────────────────────────────┘
                          │  writes the outcome
                          ▼
       ╔════════════════════════════════════════════╗
       ║    Zapier Table · Panetta Reservations     ║
       ╚════════════════════════════════════════════╝
                          │
                          │  ANY update to a record fires
                          │  both of these — only their
                          │  filters tell them apart
              ┌───────────┴───────────┐
              ▼                       ▼
   ┌─────────────────────┐  ┌─────────────────────┐
   │ [PARENT]            │  │ [PARENT]            │
   │ rescheduled booking │  │ approval            │
   │                     │  │                     │
   │ runs if the date or │  │ runs if the status  │
   │ start or end        │  │ became Approved     │
   │ changed             │  │                     │
   └─────────────────────┘  └─────────────────────┘
              │                       │
              ▼                       ▼
    deletes the old event     adds the requester to
    and re-runs [CHILD]       the event, then sends
                              the approved email
```

Three parent Zaps and one child, around a Zapier Table that holds every
booking. The child is the only step that decides whether a booking happens; the
parents decide when to run it.

## The four parts

**New booking.** Catches the form's POST, creates the table record, hands off to
the child.

**The child, Process Panetta Booking Logic.** The only place that decides
whether a booking happens. Waits briefly to serialise simultaneous requests,
checks the calendar for the requested hours, then either creates the event and
marks the record `Pending Approval`, or marks it `Time Conflict` and asks the
requester to pick another time. A failure of the calendar query itself is caught
and treated as a third outcome.

**Reschedule.** Fires when a record is edited. Its filter continues if the date
**or** the start **or** the end changed — any one of the three is enough — and
stops otherwise, so editing a title or an email address touches nothing. When it
does continue, it deletes the old calendar event and re-runs the child for the
new time. Because the child runs again, a reschedule sends the request-received
email a second time and returns the record to `Pending Approval` — an
already-approved booking that gets moved silently needs approving again.

**Approval.** Fires when an administrator sets a record to `Approved`. Adds the
requester to the calendar event so it lands in their own calendar, then sends
the approval email. It needs the event to already exist, so approving a record
that hit a conflict has nothing to work with.

## Record status

```
Pending Approval ──(administrator)──▶ Approved ──▶ approval email
Time Conflict    (dead end — the requester is asked to submit again)
```

## Three layers of conflict detection

The form checks availability too, which is why a conflict email should be rare:

1. **Prefetch** — 45 days, cached 5 minutes. What the slot grid is drawn from.
2. **Re-check at submit** — live, about a second before the POST. Catches
   anything booked while the form was being filled in. Fails open: if the check
   cannot run, the submission proceeds.
3. **The child Zap** — the last word, and the only layer that can see another
   request already in flight.

If conflict emails start arriving often, the problem is in layer 1 or 2, not the
room being busy.

## Known problems

**A rescheduled booking emails two blank rows.** The request-received and
conflict templates show the responsible party and the guest count; the reschedule
Zap passes neither to the child. Both values are already on the record it just
looked up.

**The approved email shows the record as it was before the update.** The approval
Zap looks the row up for its current state, then the email reads the trigger's
pre-update snapshot instead. Identical for a status-only edit, stale for any edit
that also changes a time.

**A calendar failure is reported to the requester as their mistake.** When the
availability query itself fails, the *invalid times* email goes out, telling them
their start and end times contradict each other. True for one cause; a Google
outage or an expired connection produces the same message. That path also records
`Time Conflict`, so an API failure and a real double-booking are
indistinguishable in the table.

**Reschedule and approval can run at once.** Both trigger on any record update,
so an edit that changes a time *and* approves it satisfies both filters. They run
concurrently: one deletes the calendar event and creates a new one, while the
other looks up the old one to add an attendee. Outcomes include an approval email
for an event that no longer exists. Worth deciding whether an administrator
should ever do both in one edit, and making it impossible rather than merely
discouraged.

**Three timezone spellings.** The form works in `America/Los_Angeles`, the
reschedule Zap in `PST8PDT`, and the calendar's own events are labelled
`America/New_York`. The first two agree in practice. The third is cosmetic today
but would matter if recurring events were ever added, because recurrence is
expanded in the event's own timezone. Worth setting the calendar to Pacific.

## Worth changing

**Use the ISO timestamps.** The form already sends the start and end as full
instants carrying the Pacific offset, DST included. The Zaps recombine a date
with plain-text times like `11:00 AM` instead, which is more parsing and more to
go wrong.

**Repeats (multi-day-booking branch).** The form sends three new fields:
`repeatFrequency` (`Does not repeat` / `Daily` / `Weekly` / `Monthly`),
`repeatCount` (total occurrences, `1` when not repeating) and `repeatDates`
(the expanded list, `YYYY-MM-DD` comma-joined). Frequency and count plug into
the Zap's existing recurrence fields on the calendar event. Two things to
know: the form checks **every** date for conflicts at submit, but the child
Zap's own availability check only guards the first date — the last-word layer
does not see the rest of the series. And monthly from the 29th–31st follows
RRULE semantics (short months are skipped, the count still completes), which
is also what Google does, so the form's preview and the created events agree.

**DARC needs its own Zap.** The DARC form has two rooms and sends the chosen room
with every request for exactly this reason — branch on it to pick which calendar
to check and write to. The existing Zaps are Panetta-specific throughout: the
calendar, the hardcoded street address, the email copy.

## Editing the emails

The four templates in `email-templates/` are **pasted into Zapier by hand**. A
change in this repository is not live until someone pastes it, and nothing warns
you when they drift.

| File | Sent when |
|---|---|
| `success.html` | request received, time held |
| `conflict.html` | the hours were already booked |
| `invalid.html` | the availability check failed — see above |
| `approved.html` | an administrator approved it |
