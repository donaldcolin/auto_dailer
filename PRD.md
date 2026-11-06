# PRD: LeadSquared Auto-Dialer

Updated 2026-11-06 · Donald Colin · Report and shareable copy: https://claude.ai/artifact/Eybnoss9ccKfFVQrZotcfg

The 31 Oct version, with the rules dashboard as the main mechanism, is in git history (`ad70381`).

## Summary

An Android app that calls one lead at a time from the person's own SIM, with the person in the loop. After each call they mark it, and the dialer saves that to LeadSquared under their name.

HR goes first (about 150 dials a day per person). Sales follows on the same app. Until an LSQ admin makes "Spoke with" optional on the BDA form, unanswered Sales calls record "Student" there as a placeholder.

## Users

| User | Uses | Does |
| --- | --- | --- |
| HR caller | Android app | Calls their own leads and marks each call |
| Sales caller (later) | Android app | Same, with the BDA form |
| TL | LeadSquared | Adds the Auto Dialer activity to push leads; tells the team to tap Refresh leads |
| Operations | LeadSquared | Assigns leads; the dialer never assigns or moves them |

## Requirements

**Queue**
1. Pushed leads (activity 283) come first, oldest push first, even if their stage is closed. A push leaves the queue once the lead is dialed after it. Pushes older than 7 days are ignored.
2. Then the person's own leads, newest 300, skipping Signup Done, Payment Done, Customer and Disqualified.
3. HR team members also skip leads that have ever connected.

**Calling**
1. Start begins the loop. Each lead shows a 5-second countdown, then a normal SIM call through the phone's own call app.
2. Touching the lead screen pauses the countdown; lifting continues it. Back to list and Skip are always available.
3. Dialing keeps running with another app open, with a notification showing it is running.

**Marking**
1. Connected means the call log shows more than 0 seconds; Android gives no other signal.
2. Not connected asks for a reason. Connected opens the team's form, in the same order and sections as LeadSquared. Nothing is saved until the person marks it.
3. If LeadSquared refuses the key, the activity is not saved and the person is told to update their key. There is no fallback to another key.
4. Callyzer logs the calls themselves. The dialer never writes call activities, so nothing is logged twice.

**Setup and security**
1. Each person pastes their own LeadSquared keys once. The server checks them first, and flags a mismatch if the first activity is credited to someone else.
2. The team (HR or Sales) is locked after setup. A wrong choice is fixed by an admin in the database.
3. Keys stay on the server, encrypted, and are never logged or returned to the phone.

**Phones and release**
1. Android 10 or newer, with the SIM, Callyzer and the phone's auto call recording set up.
2. Shared as a signed APK, not through the Play Store, which blocks call-log access for apps that aren't the default dialer.
3. No reports or stats in this app; the existing LeadSquared reports cover them.

## Not built yet

- Rules dashboard in a LeadSquared tab (parked; the rules API exists on the backend, unused)
- Saving marks offline (a failed save shows an error and the person taps Save again)
- Always using the Airtel SIM on dual-SIM phones
- Daily dial cap per SIM
- Recovering an unmarked call if the app is killed
- Protection against saving the same activity twice
- Error reporting and app version numbers
- Extra push fields: Assign To, Call After, Priority, Note for Caller, Status

## Open questions

- [ ] **Retries:** does an unanswered lead come back, and when? (Donald and manager.)
- [ ] Does HR need the 32 fields under More fields, such as R1–R4 interviews?
- [ ] What is a safe number of dials per SIM per day? (ask Airtel)
- [ ] Is the rules dashboard still wanted, now that pushes work? If yes: `Lists.Get` returning only 500 of about 2,353 Lists, and login inside the LSQ tab, are its blockers.
- [ ] Who makes "Spoke with" optional on the BDA form, and when does Sales start?
- [ ] Do dialer calls show up with a recording in Callyzer on each pilot phone?
