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
- **Callbacks** (2026-11-10): when a lead the person dialed today without connecting calls back and they pick up, the form opens for that lead once the call ends ("Called you back"). Only while the dialer is open, never over a call being marked. `POST /api/lead/callback` decides from today's `dial_attempts`.
- **OnePlus call log types**: the Nord logs some calls as 100 (outgoing) / 101 (incoming answered) instead of 2 / 1. `DialerModule.kt` accepts both; without it, answered calls were read as not connected.
- **Open on laptop** (2026-11-10): a button above the form sends the lead to the person's laptop; the Chrome extension in `extension/` (unpacked, Developer mode, Google sign-in as the same person) opens it in LSQ via Supabase Realtime on `laptop_opens`. Build the zip with `extension/build.sh`. Its fixed ID needs `https://bdkpchdhfldljgimmmncchffoajobpbm.chromiumapp.org/**` in Supabase Auth redirect URLs.
- **Recordings Callyzer can't find** (2026-11-10, BYOD phones): ☰ → Settings → Call recordings finds the folder a phone really saves recordings in (often hidden; needs "All files access", which Play forbids but our sideloaded APK may use), and after each call, while the dialer is open, copies new ones (same name and time) into `Recordings/Kalvium Calls`; each person points Callyzer there once. Copy, never move. The Google Phone app keeps recordings in its private storage: no app can reach them, so those phones use Callyzer's share option. Code: `lib/recordings.js`, `RecordingsScreen.js`, `findRecentAudio` / `copyNewRecordings` in `DialerModule.kt`.
- **Settings** (v4, 2026-11-12, `SettingsScreen.js`, stored on the phone in `lib/prefs.js`): the SIM calls go out from (dual-SIM BYOD phones; `placeCall` sets the SIM's `PhoneAccountHandle`; asked on the first call when none is chosen) and "Open leads on my laptop" when each call starts. Not yet proven on a phone whose default SIM differs from the chosen one; some OEM phone apps may ignore the hint and still ask.
- **HR form rules** (2026-11-12): the 284 form shows each round's fields the way LSQ's "HR Activity form V1" rules do (`rules` in `FORMS[284]`, `shown` in both `backend/services/activity.js` and `app/ActivityForm.js`). Screening, R1 and R2 were copied from LSQ; R3, R4, Culture fit and Final follow the same pattern, unchecked. Values a rule hides are not posted. If HR changes the LSQ form rules, change them here too.
- **Speed** (2026-11-12): Save is instant: activities go into a phone outbox (`lib/outbox.js`) and are sent in the background, retried every 30 s and on open (a lost reply can post twice; no dedupe yet). The app opens from its last profile, form and queue (`lib/cache.js`). Railway logs `[slow]` requests over 2 s and `[lsq]` waits on the org-wide 5/s limit and 429s.
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

## Shipping updates to 126 phones (decided 2026-11-10)
- JS changes go over the air (`expo-updates`, EAS Update free plan, Expo account `donaldcolind`, channel `production`): `app/publish-update.sh "what changed"`. Phones download it on one open and run it from the next. Always use the script: plain `eas update --environment` skips `app/.env`, and that bundle shows a blank screen (happened in testing, 2026-11-10); the script refuses to publish a bundle without the backend and Supabase addresses.
- `runtimeVersion` uses the **fingerprint** policy, which hashes `modules/dialer/android`, native deps and config plugins. A native change gives a new fingerprint, so older APKs never receive that update: build a new APK instead.
- New APK: bump `android.versionCode` in `app.json`, build, then `cd backend && node scripts/upload-apk.js` (checks the release key, uploads `dialer-<versionCode>.apk` to the public Supabase bucket `app`, prints the values), then set `APK_URL` and `APK_BUILD` on Railway. Older phones show "A new version of the app is ready"; new users install from `<backend>/download`.

## Backend
- `backend/`: Express 5 + Supabase. Tests: `cd backend && npx jest`. Env in `backend/.env` (see `.env.example`); `SUPABASE_URL` is the base `https://<id>.supabase.co`, no `/rest/v1`.

## Reuse from the QC repo (copy, don't reinvent)
- `Quality Control/node_backend/config/lsq.js`: `lsqClient` with the org-wide 5 req/s LSQ rate limiter, plus `lsqUrl`.
- `Quality Control/node_backend/middleware/auth.js`: `verifySupabaseToken`, if Supabase Auth is used.
- LSQ host default: `https://api-in21.leadsquared.com/v2`; env `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY`.

## Still open
See "Open questions" in `PRD.md`. The top blockers: the outcome list (and whether outcomes change LSQ stages or live in Callyzer), `Lists.Get` returning only 500 of about 2,353 Lists, and login inside the LSQ tab.
