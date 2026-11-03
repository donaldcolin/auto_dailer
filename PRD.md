# PRD: LeadSquared Auto-Dialer

2026-10-31 · Donald Colin · Shared copy: https://claude.ai/artifact/UnJ6xBxf5gMU9rzhB2kvid

## Summary

We will build a dialer system with two parts:

1. **An Android app** for associates (counsellors). It dials their LeadSquared leads one after another from their own Airtel SIM and writes every call outcome back to LeadSquared.
2. **A rules dashboard** for team leads and managers, shown as a custom tab inside LeadSquared. Here a TL decides which leads each associate dials, and when. For example: "9 AM: today's fresh leads", "4 PM: leads in the callback stage".

The operations team keeps assigning leads to associates in LeadSquared every day, as today. The dialer never assigns or moves leads between people. TLs only decide **which filter** each associate works on at which time, and each associate gets only the matching leads they own.

## Problem and goals

Associates lose time between calls, and LeadSquared misses many outcomes. Each call means finding the lead, typing the number, waiting, then logging the result by hand. TLs have no way to say "everyone works fresh leads now, callbacks at 4 PM" other than telling people and hoping.

| Goal | Metric | Target |
| --- | --- | --- |
| More dials per associate | Dials per associate per hour | Baseline in week 1 of the pilot, then +50% (to confirm) |
| Every call logged | Calls with an outcome in LeadSquared | 100% |
| TLs steer the work | Associates dialing the filter their TL set | 100%, without manual follow-up |

## Users

| User | Uses | Sees |
| --- | --- | --- |
| Associate (counsellor) | Android app | Only their own leads that match their current rule |
| Team lead (TL) | Dashboard in LeadSquared | Only their own team (their LeadSquared sales group) |
| Manager | Dashboard in LeadSquared | All teams |

Teams and roles come from LeadSquared. Sales groups are already set up there, so nobody keeps a second list.

Hourly call reports are out of scope: the existing team reports already cover them.

## User stories

**TL / manager**
1. As a TL, I build a filter in LeadSquared the way I do today (including advanced filters such as "spoke more than 10 minutes and no meeting booked") and save it as a dynamic List.
2. As a TL, I open the Dialer tab in LeadSquared, pick an associate or my whole team, pick a List and a start time, and save it as a rule.
3. As a TL, I set a day plan: for example "9 AM fresh leads", then "4 PM callback stage".
4. As a TL, I see and change only my own team's rules. A manager sees and changes everyone's.

**Associate**
1. As an associate, I sign in once and press Start.
2. The app dials, one by one, the leads I own that match my current rule, until there are none left.
3. I talk on the normal phone screen when a call connects.
4. I tap one outcome after a connected call, and it shows in LeadSquared. Calls with 0 seconds of talk time are logged as No answer by themselves.
5. I can pause, skip a lead, or stop.

## How rules work

A **rule** is: who (one associate, or a whole team) + which List + from what time.

- **Lists are LeadSquared's own dynamic Lists.** TLs build the filter in LeadSquared's filter screen and save it as a Dynamic List named `Dialer – …`. The dashboard only offers Lists that are dynamic and start with `Dialer –`, so the other ~2,350 Lists don't clutter the picker.
- **The filter always matches LeadSquared exactly**, because LeadSquared evaluates it. Every filter LeadSquared supports works, including activity conditions.
- **One List can serve the whole team.** "Dialer – Fresh leads today" holds everyone's fresh leads. Each associate's queue keeps only the leads they own.
- **Leads drop out by themselves.** The List updates itself, so a lead that no longer matches (for example a "0 connects" lead that just connected) leaves the queue.
- **Time slots:** an associate's active rule is the one whose start time most recently passed today. At 4 PM the queue switches to the 4 PM rule.

Example day for Team Hema:

| From | Who | List |
| --- | --- | --- |
| 9:00 AM | Whole team | Dialer – Fresh leads today |
| 4:00 PM | Whole team | Dialer – Callback stage |
| 4:00 PM | Associate X only | Dialer – R2 completed, no meeting |

An associate-level rule wins over a team-level rule at the same time.

## MVP scope

| In | Not in |
| --- | --- |
| Android app, shared as an internal APK | iPhone (iOS doesn't allow auto-dialing) |
| Rules dashboard as a LeadSquared custom tab | Building filters inside our dashboard (LeadSquared does it) |
| Role-based access from LeadSquared sales groups | Reports and live stats (existing reports cover it) |
| Queue from dynamic Lists, filtered by lead owner | Assigning or moving leads (the operations team does it) |
| Start, Pause, Stop, Skip | Predictive dialing (needs cloud telephony) |
| Automatic No answer for 0-second calls | Recording inside our app (the phone's recorder + Callyzer already do it) |
| Outcome buttons, written back to LeadSquared | Play Store release |

## Functional requirements

**Login and access**
1. Associates, TLs and managers sign in with their work email. The backend links each person to the LeadSquared user with the same email. No match means no access, with a clear message.
2. Role and team come from LeadSquared (user role and sales groups), refreshed daily.
3. LeadSquared keys stay on the server and never reach the phone or the browser.

**Dashboard (TL / manager)**
1. Opens as a custom tab inside LeadSquared.
2. Shows the team's associates and each one's rules for today.
3. Create / edit / delete a rule: target (associate or team), List, start time, days of the week.
4. A TL can only target associates in their own sales group. A manager can target anyone.

**Dialing (associate)**
1. Start dials the next lead from the Airtel SIM. On a dual-SIM phone, the app always uses the Airtel SIM.
2. Before each dial, a 5-second countdown shows the lead's name and stage, with a Skip button.
3. The associate talks on the normal phone call screen.
4. Dialing keeps running with the screen locked or another app open, with a notification showing it's running.
5. When the current rule's queue is empty, the app shows "All done for now" until the next rule starts.

**Outcomes**
1. A call with 0 seconds of talk time is saved as No answer, with no tap needed.
2. After a connected call, the associate taps an outcome. The list of outcomes, and whether each one changes the lead stage, is an open question below.
3. **Call logging is already done by Callyzer**, which runs on every associate's phone and sends each SIM call to LeadSquared (this is what updates fields like Total Connects). The dialer does not log calls itself, so calls are never logged twice.

## Non-functional requirements and constraints

- **Phones:** Android 10 or newer, with an Airtel SIM, Callyzer installed, and the phone's auto call recording turned on. The app needs permission to place calls, read phone state and read the call log.
- **Recording:** every dialer call must be recorded and show up in Callyzer, the same as a hand-dialed call. The dialer must never record calls itself or use a different calling app.
- **Distribution:** an internal APK, not the Play Store. Google Play only lets the default phone app read the call log, and we need it to tell connected calls from unanswered ones.
- **LeadSquared limits:** the org allows 5 API requests per second in total, shared with the QC app. The backend reads each List once for everyone who uses it and caches it for a few minutes, so a team of 20 doesn't mean 20× the calls.
- **No lost outcomes:** with no internet, the phone saves outcomes and sends them when it reconnects.
- **Security:** HTTPS only. Each person can read only what their role allows.

## Risks and compliance

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Airtel or TRAI flags a SIM as spam for high call volume | SIM blocked | A person is on every call; respect DNC; a daily dial cap per SIM after checking with Airtel |
| Callyzer isn't installed or not syncing on a phone | Calls don't reach LeadSquared; filters like Total Connects go stale | Callyzer on every pilot phone is a setup requirement; the dialer skips leads it already dialed today, which covers Callyzer's sync delay |
| Very large Lists are slow to recalculate | Slow queue start | Cache per List; test with a List of several thousand leads |
| Android can't say exactly when the other side picks up | A call could be logged wrong | Use the call log's talk time; check against 50 real calls |
| Phone makers kill background apps | Dialing stops | Foreground service; a one-time battery-setting guide per phone |
| Dialer calls are not recorded | QC can't review these calls | The dialer places a normal SIM call through the phone's own call screen, so the phone's auto-record and Callyzer's upload work as they do today. Checked before the pilot: every test call must have a recording in Callyzer |

## Milestones

Estimated weeks for one developer:

| Phase | When | What |
| --- | --- | --- |
| 1. Backend | Weeks 1–2 | Login, LeadSquared user/team sync, rules, List reader + queue |
| 2. Dashboard | Weeks 2–3 | Rules screen, access by role, embedded in LeadSquared |
| 3. Phone app | Weeks 3–5 | Dial, talk-time detection, Start/Pause/Stop, outcomes to LeadSquared |
| Gate | End of week 5 | 50 test calls logged right; a TL rule switch at a set time works |
| 4. Pilot | Weeks 6–7 | One team, measure dials per hour, fix what breaks |
| Gate | End of week 7 | Go / no-go for all teams |

## Already verified (2026-10-31)

- A Dynamic List created in LeadSquared ("Dialer – Appointment Booked YESTERDAY TEST") can be found and read through the API: 13 leads, each with stage, owner and Total Connects.
- LeadSquared's user API returns each user's role and sales groups (e.g. "Team Ayyappan", "Team Hema"), so access by team needs no extra setup.

## Open questions

- [ ] **Outcomes:** what buttons does the associate need, and which ones change the lead stage (e.g. Not connected → Callback stage)?
- [ ] **Retries:** does an unanswered lead come back to the same associate, and when? (Donald + manager to decide.) Until then, retries happen through TL rules, e.g. a 4 PM callback List.
- [ ] **When a rule's queue runs out early:** wait for the next rule (current plan), or move to the next rule straight away?
- [ ] **Order inside a queue:** oldest first, newest first, or something else?
- [ ] **Roles:** which LeadSquared roles count as TL and as manager?
- [ ] **Login inside the LeadSquared tab:** can the tab pass who is signed in, or do TLs sign in to the tab once?
- [ ] Who can add the custom tab in LeadSquared (admin access)?
- [ ] Which team runs the pilot, and how many associates?
- [ ] What is a safe number of dials per SIM per day? (ask Airtel)
- [ ] Which phone models will the pilot use? Auto-record has to be on in each phone's own call settings, and that setting is in a different place on each brand.
