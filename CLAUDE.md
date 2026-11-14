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
- **Modes**: `users.mode` is `hr` (activity 284 "Auto Dialer - HR activity", since 2026-11-07; it replaced HR Activity 263, with Function and Task Status moved to `mx_Custom_7`/`mx_Custom_8`) or `sales` (activity 286 "Auto Dailer - BDA activity", since 2026-11-14: BDA Activity 218's fields under different numbers, so the dialer's calls can be told apart; "Interested Kalvium Programe -C" and 4 Dream collage options are not in it, Donald's call). Chosen once in the app's setup and locked. Sales stays closed until tested in the app, then set `SALES_READY=1` on Railway. "Spoke with" is optional in 286, so unanswered Sales calls no longer send the "Student" placeholder that 218 needed. To fix a wrong team, in Supabase: `update users set mode = null where email = '...';` (the person sets it again on next open).
- Call logging to LSQ is done by **Callyzer** (installed on every associate's phone; API docs: https://developers.callyzer.co/v2.2/). The dialer must not write call activities itself. That would log calls twice.
- Retries are parked for Donald and the manager to decide.
- **Incoming calls from leads** (v5, 2026-11-12): any of the person's leads calling the business SIM (Settings → Call from) is named during the call ("On a call with …") and its form opens when it ends ("Called you", or "Called you back" if dialed today without connecting). Works with the dialer stopped or the phone locked: a per-SIM `PhoneStateListener` gives the number, the app comes to the front natively, and a light keep-alive (no wake lock, "Dialer is on") stops Android freezing the app; a frozen app catches up from the call log on open. `POST /api/lead/identify` matches today's dials, then LSQ by phone; associates only get their own leads. `/api/lead/callback` stays for v4 phones.
- **OnePlus call log types**: the Nord logs some calls as 100 (outgoing) / 101 (incoming answered) instead of 2 / 1. `DialerModule.kt` accepts both; without it, answered calls were read as not connected.
- **Open on laptop** (2026-11-10): a button above the form sends the lead to the person's laptop; the Chrome extension in `extension/` (unpacked, Developer mode, Google sign-in as the same person) opens it in LSQ via Supabase Realtime on `laptop_opens`. Build the zip with `extension/build.sh`. Its fixed ID needs `https://bdkpchdhfldljgimmmncchffoajobpbm.chromiumapp.org/**` in Supabase Auth redirect URLs.
- **Recordings Callyzer can't find** (2026-11-10, BYOD phones): ☰ → Settings → Call recordings finds the folder a phone really saves recordings in (often hidden; needs "All files access", which Play forbids but our sideloaded APK may use), and after each call, while the dialer is open, copies new ones (same name and time) into `Recordings/Kalvium Calls`; each person points Callyzer there once. Copy, never move. The Google Phone app keeps recordings in its private storage: no app can reach them, so those phones use Callyzer's share option. Code: `lib/recordings.js`, `RecordingsScreen.js`, `findRecentAudio` / `copyNewRecordings` in `DialerModule.kt`.
- **Settings** (v4, 2026-11-12, `SettingsScreen.js`, stored on the phone in `lib/prefs.js`): the SIM calls go out from (dual-SIM BYOD phones; `placeCall` sets the SIM's `PhoneAccountHandle`; asked on the first call when none is chosen) and "Open leads on my laptop" when each call starts. Not yet proven on a phone whose default SIM differs from the chosen one; some OEM phone apps may ignore the hint and still ask.
- **HR form rules** (2026-11-12): the 284 form shows each round's fields the way LSQ's "HR Activity form V1" rules do (`rules` in `FORMS[284]`, `shown` in both `backend/services/activity.js` and `app/ActivityForm.js`). Screening, R1 and R2 were copied from LSQ; R3, R4, Culture fit and Final follow the same pattern, unchecked. Values a rule hides are not posted. If HR changes the LSQ form rules, change them here too.
- **Speed** (2026-11-12): Save is instant: activities go into a phone outbox (`lib/outbox.js`) and are sent in the background, retried every 30 s and on open; a retry makes the backend check LSQ for the same activity at the same time before posting (a double post was seen 2026-11-12). The app opens from its last profile, form and queue (`lib/cache.js`). Railway logs `[slow]` requests over 2 s and `[lsq]` waits and 429s.
- **LSQ rate limits, measured** (2026-11-14, 3 am, org key): lead reads (`Leads.Get`, `Leads.GetById`, `Leads/Retrieve/BySearchParameter`) allow **15 per 5 s**; `LeadsMetaData.Get` allowed 29 before refusing; responses carry no rate-limit headers. `config/lsq.js` gives lead reads a 3-per-1.1 s lane inside the overall 5-per-1.1 s. Unknown: whether the limit is per org or per access key (ask LSQ).
- **Recent activity** (2026-11-12, `backend/services/history.js`): one row per call, the activity's name as the heading and the outcome below: the reason when it didn't connect, "Spoke 2m 4s" (talk time from `dial_attempts`, else Callyzer's Duration) with the round and status when it did. A marked activity and Callyzer's log of the same call are merged.
- **Views = Smart Views** (2026-11-14, sales only): LSQ has no Smart Views API, and Lists failed: they're org-wide ("Open lead to be called" 377,796 leads) and sales keys can't read an admin's List. So `backend/services/views.js` works out the 8 tabs from each person's own leads (org key) plus shared, cached facts: BDA 218/286 + 266 via activity advanced search (15 min), outbound calls today (2 min), the person's tasks. Warmed at boot; stale copies are served while refreshing, so a tab switch is ~0.5 s. Rules are copied from Tejas's tabs: **when a tab changes in LSQ, change `views.js` too** (`SMART_VIEWS.md`). A running TL rule wins over a view. Activity advanced search shares the 3-per-1.1 s lane (it gave 429s at 5).
- **Replacing Callyzer ("CMS")** is planned for a separate fork about 6 months out; nothing for it goes in this repo.
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
- Login: Google via Supabase OAuth (redirect `dialer://auth`). The Google OAuth client lives in the Kalvium Workspace Cloud project "Kalvium Dialer", audience Internal (moved 2026-11-14): any @kalvium.com account can sign in, nobody else. Redirect URI `https://astdnpkyyonnebexuyrr.supabase.co/auth/v1/callback`.

## Shipping updates to 126 phones (decided 2026-11-10)
- JS changes go over the air (`expo-updates`, EAS Update free plan, Expo account `donaldcolind`, channel `production`): `app/publish-update.sh "what changed"`. Phones download it on one open and run it from the next. Always use the script: plain `eas update --environment` skips `app/.env`, and that bundle shows a blank screen (happened in testing, 2026-11-10); the script refuses to publish a bundle without the backend and Supabase addresses.
- `runtimeVersion` uses the **fingerprint** policy, which hashes `modules/dialer/android`, native deps and config plugins. A native change gives a new fingerprint, so older APKs never receive that update: build a new APK instead.
- New APK: bump `android.versionCode` in `app.json`, build, then `cd backend && node scripts/upload-apk.js` (checks the release key, uploads `dialer-<versionCode>.apk` to the public Supabase bucket `app`, prints the values), then set `APK_URL` and `APK_BUILD` on Railway. Older phones show "A new version of the app is ready"; new users install from `<backend>/download`.

## Backend
- `backend/`: Express 5 + Supabase. Tests: `cd backend && npx jest`. Env in `backend/.env` (see `.env.example`); `SUPABASE_URL` is the base `https://<id>.supabase.co`, no `/rest/v1`.

## Reuse from the QC repo (copy, don't reinvent)
- `Quality Control/node_backend/config/lsq.js`: `lsqClient` with a 5 req/s LSQ rate limiter (too fast for lead reads, see the measured limits above; the QC app still uses it), plus `lsqUrl`.
- `Quality Control/node_backend/middleware/auth.js`: `verifySupabaseToken`, if Supabase Auth is used.
- LSQ host default: `https://api-in21.leadsquared.com/v2`; env `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY`.

## Still open
See "Open questions" in `PRD.md`. The top blockers: the outcome list (and whether outcomes change LSQ stages or live in Callyzer), `Lists.Get` returning only 500 of about 2,353 Lists, and login inside the LSQ tab.
