# Plan: SIM-based progressive auto-dialer with TL rules, connected to LeadSquared

## Context
Associates call leads from their own Airtel SIMs. The operations team assigns leads to associates in LeadSquared (LSQ) every day. The system has three parts:

1. **Android app** (associates): press **Start**, and the phone dials, one after another, the leads the associate owns that match their current rule. A "progressive" dialer: the next call starts only after the associate finishes the last one.
2. **Rules dashboard** (TLs and managers), embedded as a custom tab in LSQ: a TL picks an associate or a team, an LSQ dynamic List and a start time.
3. **Backend**: holds the LSQ keys, the rules and the queue logic.

**Key constraints**
- Calls go out from a SIM, so the dialer has to run **on the associate's Android phone**. A web page can't place a SIM call.
- **Filters are LSQ dynamic Lists**, not filters we rebuild. LSQ's personal "My Filters" have no API, but the same filter saved as a Dynamic List can be read through the API. LSQ evaluates the filter, so every LSQ condition works, including activity conditions.
- The dialer **never assigns leads**. It only reads them, filters them by owner and logs calls.

## Glossary
- **Progressive dialer**: dials one lead at a time and waits for the agent to finish.
- **Rule**: target (an associate, or a whole sales group) + an LSQ List + a start time + days of the week.
- **Active rule**: for an associate, the rule whose start time most recently passed today. An associate-level rule beats a team-level rule with the same start time.
- **Disposition**: the outcome tag set after a call.
- **Zero connect / No answer**: the call ended with 0 seconds of talk time. Detected automatically.

## Verified against LSQ (2026-10-31, read-only, with the QC backend's keys)
- `GET LeadManagement.svc/Lists.Get` → `[{ListId, ListName, ListDescription, ListType: "static"|"dynamic", MemberCount}]`. **Returned exactly 500 of ~2,353 Lists**: we still need to find how to page or search. Our test List was among the 500.
- `POST LeadManagement.svc/Leads/Retrieve/BySearchParameter` with
  `{SearchParameters: {ListId, RetrieveBehaviour: "1"}, Columns: {Include_CSV: "ProspectID,FirstName,ProspectStage,OwnerId,OwnerIdName,mx_Total_Connects"}, Sorting: {ColumnName: "CreatedOn", Direction: "1"}, Paging: {PageIndex, PageSize}}`
  → `{RecordCount, Leads: [{LeadPropertyList: [{Attribute, Value}]}]}`. Returned all 13 leads of the test List. `RetrieveBehaviour` "1" recalculates the List; "0" skips the recalculation (faster).
- `GET UserManagement.svc/Users.Get` → `[{ID, FirstName, EmailAddress, Role, StatusCode, MemberOfGroups: ["Team Ayyappan", ...]}]`. That gives us roles and teams for access control.
- The body key is `SearchParameters`.
- `Lists.Get` takes `&SearchText=` (name filter, server side) and `&PageIndex=` (500 per page). `SearchText=Dialer` returns only dialer Lists in one call.
- `UserManagement.svc/User/Retrieve/ByUserId` has `ManagerUserId`, `TeamName`, but a lower limit: 15 calls per 5 s.
- LSQ roles: `Sales_Manager` (8 active) and `Administrator` (13) → manager access. TLs are plain `Sales_User`s, and every associate "reports to" a Sales_Manager, so managers pick TLs.
- A List's first read costs one LSQ call per 200 leads (~0.8 s each), so a 5,000-lead List takes ~20 s cold. Keep dialer Lists scoped (e.g. "assigned today").

## Architecture
```
Android app (associate, Airtel SIM)        Backend (Node/Express + Supabase)                 LeadSquared
 ├ Google login ────── GET /api/me ──────▶ map email → LSQ user (role, groups) ◀── Users.Get (daily sync)
 ├ Start ───────────── GET /api/queue ───▶ active rule → List → leads ◀───────────── Leads/Retrieve/BySearchParameter
 │                                         keep OwnerId == me, drop already dialed
 ├ dials via SIM (ACTION_CALL)
 ├ call state + call-log duration
 └ outcome ─────────── POST /disposition ▶ save attempt (call itself logged to LSQ by Callyzer)
                                                    ▲
Rules dashboard (React, LSQ custom tab) ─ /rules ───┘                          Lists.Get (List picker)
```

### 1. Backend (Node + Express + Supabase)
A **new Supabase project**, separate from the QC app's. Login is **Google** (Workspace, OAuth consent screen "Internal") through Supabase Auth; the backend only sees the Supabase token and links by email. Schema: `backend/supabase/001_users.sql`, `002_rules.sql`.

Copy from the QC repo, don't rewrite:
- `Quality Control/node_backend/config/lsq.js`: `lsqClient` (5 req/s org limiter) and `lsqUrl`. Copy as-is.
- `Quality Control/node_backend/middleware/auth.js`: `verifySupabaseToken`.

Tables:
- `users(id, email, name, lsq_user_id, lsq_role, access, groups text[], synced_at)`. Filled at first `/api/me` and refreshed daily from `Users.Get`.
- `team_leads(group_name, lsq_user_id, set_by, updated_at)`. Managers pick TLs: LSQ has no TL field.
- `rules(id, target_type 'user'|'group', target_id, list_id, list_name, start_time, days int[], created_by, updated_at)`.
- `dial_attempts(id, user_id, rule_id, prospect_id, phone, outcome, talk_seconds, started_at, note)`.

Endpoints:
| Endpoint | Who | Does |
|---|---|---|
| `GET /api/me` | all | Called after Supabase email login (done in the app/dashboard). Links the LSQ user by email on first call; re-reads role and groups daily. 403 if no active LSQ user has that email. |
| `GET /api/lists` | TL, manager | LSQ Lists that are `dynamic` and named `Dialer – …`, for the picker. Uses `Lists.Get?SearchText=Dialer`. |
| `GET /api/team` | TL, manager | The caller's groups (all for a manager), each with its TL and active associates. |
| `PUT/DELETE /api/team/:group/lead` | manager | Set or clear who leads a group. |
| `GET/POST/PUT/DELETE /api/rules` | TL, manager | Rules in the caller's scope. A TL can target their groups and the associates in them; a manager can target anyone. Times are IST. |
| `GET /api/queue` | any login | Leads for the active rule, owned by the caller, minus leads dialed under this rule today. |
| `POST /disposition` | associate | `{prospectId, phone, outcome, talkSeconds, startedAt, note?}` → `dial_attempts` row (and an LSQ stage change, if the outcome list needs one). No call activity: Callyzer already logs every SIM call to LSQ. |

**Queue logic** (`GET /api/queue`):
1. Find the associate's active rule (associate rule beats group rule; latest start time ≤ now; today's weekday in `days`).
2. Read that List's leads. **Cache per List for about 5 minutes**, so one LSQ read serves the whole team. Page through all of them (PageSize 200).
3. Keep leads with `OwnerId == lsq_user_id`.
4. Drop leads with a `dial_attempts` row under this rule today. This covers Callyzer's sync delay before LSQ's own fields (e.g. Total Connects) catch up.
5. Order as LSQ returns them (open question).

**Rate limit:** every LSQ call goes through the copied `lsqClient`. The QC app shares the same org limit of 5/s. Use `RetrieveBehaviour: "1"` only when the cache refreshes.

### 2. Rules dashboard (React + Vite, served by the same Express app)
- One screen: the team's associates as rows. Each row shows today's rules in time order, with add/edit/delete. A team-wide row sits on top.
- Rule form: target, List (dropdown from `/lists`), start time, days.
- **Embedding in LSQ:** add it as a custom tab or menu item in LSQ. The Express app sends `Content-Security-Policy: frame-ancestors https://*.leadsquared.com` so the iframe works.
- **Login in the tab:** Google blocks its sign-in page inside iframes, so "Sign in with Google" opens a popup and hands the session back. Never trust a user id passed in the URL.

### 3. Android app (React Native, Expo dev build, one small Kotlin module)
The Kotlin module (about 100 lines) does three things:
- `placeCall(number)`: `Intent.ACTION_CALL` with `CALL_PHONE`. On dual-SIM phones, pass the Airtel SIM's `PhoneAccountHandle`.
- `onCallState(cb)`: `TelephonyCallback` (API 31+) / `PhoneStateListener`, IDLE → OFFHOOK → IDLE.
- `lastCallDuration(number)`: reads `CallLog.Calls` for the talk seconds.

**Why the call log:** Android has no "the other side picked up" signal for outgoing SIM calls. A call counts as connected when its call-log duration is more than 0, and 0 means No answer, set automatically.

State machine (plain JS, one file):
```
IDLE --Start--> FETCHING --> DIALING --(OFFHOOK)--> IN_CALL --(IDLE)--> WRAP_UP
WRAP_UP: duration==0 → auto "No answer" → wait 3 s → next
         duration>0  → outcome buttons → on tap → next
Pause: finish current call, don't dial next.  Stop: clear queue, back to IDLE.
Queue empty → refetch → still empty → "All done for now" (poll /queue every few minutes for the next rule).
```

Screens: **Login**, and **Dialer**: current lead card (name, stage), Start/Pause/Stop, Skip with a 5 s countdown, and outcome buttons after a connected call.

Background: a **foreground service** with a notification keeps the loop alive while the call screen is on top.

**Recording:** `placeCall` must use the system phone app (`ACTION_CALL` to the default dialer), never our own in-call UI or a VoIP path. The phone's auto-record and Callyzer only see calls that go through the normal phone app.

Permissions: `CALL_PHONE`, `READ_PHONE_STATE`, `READ_CALL_LOG`, `FOREGROUND_SERVICE`, `POST_NOTIFICATIONS`. Ship as an **internal APK**. Play blocks `READ_CALL_LOG` for apps that aren't the default dialer.

## Build order (each step is usable on its own)
0. **Phone test (1 day, throwaway):** an Expo dev build with one "Call" button and a hard-coded team number, on Donald's OnePlus Nord (Callyzer installed, auto-record on). Pass when: the call goes out on the Airtel SIM, the call-log duration is right (0 s when unanswered), the phone saves a recording, and Callyzer uploads it and logs the call to LSQ. A failure here changes the plan.
   **Result (2026-11-03, OnePlus CPH2805, Android 16, Jio SIM):** ✅ calls go out through the system phone app; ✅ call log gives 0 s for an unanswered call and the right talk time for answered ones (23 s, 11 s); ✅ the phone records calls placed by our app, saved to `Music/Recordings/Call Recordings/`, once "Record all calls" is on (it was off; setting `oplus_customize_all_call_audio_record`); no crashes. **Still to check:** Airtel SIM choice on a dual-SIM phone, and Callyzer uploading the recording and logging to LSQ, both on a counsellor's phone. Phone setup must include turning on "Record all calls". On OnePlus/Oppo phones the app could read that global setting at Start and refuse to dial while it's off; other brands use other settings.
1. ✅ Backend: Supabase token check, LSQ user link (role, groups), `/api/me`, `/api/lists`.
2. ✅ Backend: `team_leads`, `rules`, `dial_attempts`; `/api/team`, `/api/rules` with scope checks, `/api/queue` (5-min shared List cache, owner filter, dialed-today filter).
   **Tested 2026-11-03:** 17 jest tests, plus 26/26 end-to-end checks with the live server against the real Supabase project and real LSQ, as manager, as TL and as associate (same login, access switched in the DB), test rows cleaned up. The test List was empty that day, so the queue returned the right rule with 0 leads; the lead read itself was checked on a 200-lead page of All Leads.
3. Dashboard: the rules screen, embedded in an LSQ tab.
4. Android: login, then a lead list with a "Call" button (single dial through the Kotlin module), plus call-log talk time.
5. Android: state machine, Start/Pause/Stop, auto No answer, outcome buttons → `/disposition` (once the outcome list is decided).
6. Foreground service, countdown/skip, offline outcome queue.

## Verification
- Backend unit tests (`cd backend && npx jest`): active-rule selection (associate beats group, latest start ≤ now, weekday), owner filter, "already dialed under this rule" filter, a TL can't write a rule for another group.
- curl `/queue` as two associates on the same team List: each gets only their own leads, and the two together equal the List.
- Change a rule's start time to one minute ahead: `/queue` switches List when that minute passes.
- Large List: time a full read of a List with several thousand leads, and count the LSQ calls it uses.
- Phone, with team numbers and Callyzer installed: one answers → outcome saved, and Callyzer's call shows in LSQ; one rejects → auto No answer; Pause during a call → no next dial; locked screen → dialing goes on; dual-SIM → Airtel SIM used.
- Dashboard opens inside the LSQ tab, and a TL sees only their team.
- **Recording:** for every connected test call, Callyzer shows a recording (`call_recording_url` set in Callyzer's `/call-log/history`, or visible in the Callyzer dashboard). Test on each phone model in the pilot. Any connected call without a recording blocks the pilot.

## Open (blocks the step named)
- Outcome list and stage changes → step 5.
- Retries (Donald + manager) → after step 5. Until then, TLs use callback Lists.
- Google OAuth client (Web) + Supabase Google provider → before step 3. An Android OAuth client → step 4.
- A dialer List with leads in it, for a queue test with real leads (the test List is "yesterday"-based and empty on Mondays).

## Out of scope
- Reports and live stats (existing team reports cover them).
- Building filters in our dashboard, and assigning leads.
- Recording inside our app (Android 10+ blocks third-party recording). Recording is done by the phone's own recorder, and Callyzer uploads it.
- Predictive dialing, iOS.

## Risk to know
- TRAI/DoT rules: many calls from a personal SIM can get it flagged or blocked by Airtel. Keep the agent in the loop, respect DNC, and check the volume per SIM with Airtel.
