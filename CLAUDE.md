# Auto-dialer — project context

SIM-based progressive auto-dialer for associates (counsellors), plus a rules dashboard for TLs/managers embedded as a LeadSquared (LSQ) custom tab. Separate app from the QC project at `/Users/donaldcolin/Developer/Quality Control`.

- `PRD.md`: the MVP product spec, for the manager. Shared copy: https://claude.ai/artifact/UnJ6xBxf5gMU9rzhB2kvid
- `PLAN.md`: the technical plan (architecture, endpoints, state machine, build order, verification).

## Decisions made (2026-10-30/31)
- Calls go out from each counsellor's **Airtel SIM**, not cloud telephony. So the dialer must be an **Android app**. A web page can't dial a SIM, and iOS doesn't allow auto-dialing.
- **Progressive** dialer (one call at a time, the agent in the loop), not predictive.
- **Separate app**, not inside the QC app.
- Stack: Node/Express backend + React Native (Expo dev build) app with one small Kotlin module (`placeCall`, call-state events, call-log duration).
- Android has no "the other side answered" signal for outgoing SIM calls. Connected = call-log duration > 0; 0 seconds = automatic "No answer".
- Ship as an internal APK: Play Store blocks `READ_CALL_LOG` for apps that aren't the default dialer.
- LSQ keys stay on the backend only.

## Decisions made (2026-10-31, after manager input)
- Three parts: Android app (associates), rules dashboard (React + Vite, served by Express, embedded in an LSQ custom tab), backend.
- The operations team assigns leads in LSQ. The dialer never assigns leads; it filters each queue by `OwnerId`.
- TL filters = LSQ **Dynamic Lists** named `Dialer – …` (LSQ "My Filters" have no API). Rule = target (associate or sales group) + List + start time + days.
- Access by role: managers see all teams, TLs see their own sales group. Roles and groups come from LSQ `Users.Get` (`Role`, `MemberOfGroups`).
- TLs push leads to the dialer by adding LSQ custom activity **283 "Auto Dialer"** to them (manager's choice, 2026-11-03). Pushed leads go first in the owner's queue (`backend/services/pushed.js`). The in-tab filter builder is parked.
- Only LSQ admins can delete activities, so a TL undoes a push by adding Auto Dialer again, usually in bulk, with `mx_Custom_2` ("Remove Auto Dailer") = Yes. The latest activity on the lead decides; a remove wins a same-minute tie (decided 2026-11-06).
- No reports or stats in this app.
- After each call the caller marks their team's LSQ activity in the app; the dialer posts it (`backend/services/activity.js`) with **that person's own LSQ keys**, so LSQ shows them as Created By (HR's reports count by it, decided 2026-11-05). Never fall back to the org key for this.
- **Personal keys**: each person pastes theirs once at setup. Encrypted in `user_lsq_keys` (AES-256-GCM, `LSQ_KEYS_SECRET` on Railway; losing it means everyone re-enters). Never in the APK, never logged or returned. The org key does all reads.
- **Modes**: `users.mode` is `hr` (activity 284 "Auto Dialer - HR activity", since 2026-11-07; it replaced HR Activity 263, with Function and Task Status moved to `mx_Custom_7`/`mx_Custom_8`) or `sales` (218), chosen once in the app's setup and locked. Sales stays closed until tested in the app, then set `SALES_READY=1` on Railway. BDA's "Spoke with" is mandatory in LSQ with no NA option, so unanswered Sales calls send "Student" as a placeholder (Donald's choice, 2026-11-06); remove `notConnected` in `backend/services/activity.js` once an LSQ admin makes the field optional. To fix a wrong team, in Supabase: `update users set mode = null where email = '...';` (the person sets it again on next open).
- Call logging to LSQ is done by **Callyzer** (installed on every associate's phone; API docs: https://developers.callyzer.co/v2.2/). The dialer must not write call activities itself. That would log calls twice.
- Retries are parked for Donald and the manager to decide.
- Recording: the phone's own auto-record + Callyzer upload. The dialer must place calls through the system phone app (`ACTION_CALL`) so both still see them.
- Supabase: a new project, not the QC one. Login is Google (Workspace) via Supabase Auth.
- TLs: managers pick who leads each LSQ sales group (`team_leads` table); LSQ has no TL field. `Sales_Manager`/`Administrator` = manager access.
- Rule start times and weekdays are IST.
- Test phone for step 0: Donald's OnePlus Nord.

## Building the Android app
- Maven Central blocks this network's IP as an "open proxy" (HTTP 403), so Gradle must use Google's mirror: `cd app/android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --init-script ../gradle-mirror/mirror.init.gradle`
- **Release signing key**: `~/.dialer-signing/release.keystore` + `release.properties` (password inside), outside git; wired by `app/plugins/withReleaseSigning.js`. Every APK given to HR/sales must be signed with it, or Android won't install the update over the old app. Donald keeps a backup of both files. Created 2026-11-04, SHA-256 C8:22:0B:F2…D3:74.
- Install: `~/Library/Android/sdk/platform-tools/adb install -r app/android/app/build/outputs/apk/release/app-release.apk`. `app/android/` is generated by `npx expo prebuild -p android`.
- Test against the Mac's backend: `cd backend && PORT=4000 node server.js`, then `adb reverse tcp:4000 tcp:4000` (the app's `EXPO_PUBLIC_API_URL` is `http://localhost:4000`, in `app/.env`).
- Login: Google via Supabase OAuth (redirect `dialer://auth`). The Google OAuth client currently lives in Donald's personal Google Cloud project, Testing mode: new testers must be added as test users there.

## Backend
- `backend/`: Express 5 + Supabase. Tests: `cd backend && npx jest`. Env in `backend/.env` (see `.env.example`); `SUPABASE_URL` is the base `https://<id>.supabase.co`, no `/rest/v1`.

## Reuse from the QC repo (copy, don't reinvent)
- `Quality Control/node_backend/config/lsq.js`: `lsqClient` with the org-wide 5 req/s LSQ rate limiter, plus `lsqUrl`.
- `Quality Control/node_backend/middleware/auth.js`: `verifySupabaseToken`, if Supabase Auth is used.
- LSQ host default: `https://api-in21.leadsquared.com/v2`; env `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY`.

## Still open
See "Open questions" in `PRD.md`. The top blockers: the outcome list (and whether outcomes change LSQ stages or live in Callyzer), `Lists.Get` returning only 500 of about 2,353 Lists, and login inside the LSQ tab.
