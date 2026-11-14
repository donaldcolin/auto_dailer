# Sales Smart Views in the dialer

The sales Smart View tabs (created by Tejas N, shared to all of sales, read from LSQ on 2026-11-14) appear in the app as chips under "Your leads". LeadSquared has no API for Smart Views, so **the dialer works each tab out itself** in `backend/services/views.js`.

## Why not Lists
Tried first (2026-11-14) and dropped:
- A List can't be limited to "the current user", so each one is org-wide. "Open lead to be called" was 377,796 leads and "Leads without Task" about 254K. Reading one person's leads out of that isn't possible in time.
- Sales users' own keys can't read a List an admin made (LSQ: "you don't have access to the list").

The `Dialer – …` Lists made for this aren't used any more and can be deleted.

## How it works
For each person:
1. **Their own leads,** newest change first: `Leads.Get` by owner, up to 4,000, cached 2 minutes.
2. **Shared facts for the whole org,** read with LSQ's activity advanced search:
   - BDA facts, cached 15 minutes: Demo Conducted, Hostelier, Hindi Medium and "Not interested" from 218 **and 286**, plus Application Status (266) Completed.
   - Leads with an Outbound Phone Call (22) today, cached 2 minutes.
   - Both are warmed at server start. After that, an expired copy is served while a fresh one loads, so nobody waits.
3. **Their tasks:** open tasks cached 2 minutes; completed tasks cached 30 minutes, needed only for "Leads without Task".

Switching tabs then takes well under a second.

Field numbers differ between 218 and 286 (same labels):

| Field | 218 | 286 |
|---|---|---|
| Activity Type | c1 | c1 |
| Student Grade | c3 | c2 |
| How was the session | c17 | c13 |

## The 8 tabs
**Disposition (open)** means Lead Disposition is not Not Interested, Future Lead, Disqualified, Non-eligible stream or Financial Constraint lead.

1. **Leads assigned today:** Owner Assigned Date and Time is today. LSQ stores this field in IST, not UTC.
2. **Pending follow up for today:** an open task due later today. One already past due is "overdue" in LSQ.
3. **Lead with zero connect:**
   - Disposition (open).
   - Total Connects = 0 and Total Calls ≤ 25.
   - No outbound call today.
4. **Demo conducted not registered:**
   - Has a 218/286 with Activity Type = Demo Conducted.
   - No 266 with Completed.
   - No 218/286 with How was the session = Not interested.
   - Disposition is not Applied or Applied from different number.
5. **Overdue task all time:** an open task past its due time.
6. **Hot Lead - Outreach + Organic:**
   - Source is one of the 44 in `HOT_SOURCES`.
   - Created after 17 Aug 2026.
   - Disposition (open) and Total Calls ≤ 20.
   - No outbound call today.
   - No 218/286 with Student Grade = Hostelier.
7. **Leads without Task:** Disposition (open), with no task at all, open or completed.
8. **Open lead to be called:**
   - Disposition (open) and Total Calls ≤ 20.
   - No outbound call today.
   - No 218/286 with Hindi Medium or with Demo Conducted.
   - No 266 Completed.

Every tab sorts by Modified On, newest first. The dialer also drops leads it dialed today and leads without a phone number.

## When a tab changes in LSQ
Change the matching rule in `views.js` (and its test in `tests/views.test.js`) the same way. The tab's settings are in the LSQ web app's IndexedDB `keyval-store` under `smartview-meta-data`, at `Tabs[].TabContentConfiguration.FetchCriteria.AdvancedSearchText`.

## Limits
- **Leads:** a counsellor owning over 4,000 leads misses their oldest in views.
- **Completed tasks:** at most 20,000 are read per person.
- **Tasks are read by their owner.** For "Leads without Task", the few leads left after that are checked one by one with `RetrieveTaskByLeadId`, because a previous owner's task also counts in LSQ (Hemanth and dollyy had a completed one owned by Aparna).
- **Checked against LSQ for one sales user** (Vinay, 2026-11-14): all 8 tabs match.
