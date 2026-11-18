# Dialer State in a Zustand Store, DialerScreen Split: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the dialer's shared state into one Zustand store and split `app/DialerScreen.js` (1,172 lines, about 30 `useState` and 15 `useRef`) into focused files. What a counsellor sees and does doesn't change.

**Architecture:**
- **Store:** `app/lib/dialerStore.js` holds everything that timers, phone events and saves read after a render: phase, current lead, the call in progress, the queue, handled and skipped leads, views, the open view, the form and its values.
- **Call flow:** call events, the countdown, the outbox and incoming calls read and write the store through `useDialer.getState()`. This replaces the copy-the-state refs (`phaseRef`, `queueRef`, `viewRef`, `callRef`, `handledRef`, `skippedRef`, `formRef`, `pausedRef`). The flow functions (next, dial, finishCall, skip, save, submit, incoming) move out of the component into `app/lib/callFlow.js`.
- **Screens:** they read only what they draw. UI-only state (menus, toasts, a chip's scroll position) stays local.

**Tech Stack:** React Native 0.8x / Expo SDK 58, `zustand` 5 (pure JavaScript, no native code), `jest-expo` for tests (dev only).

**Spec:** none written. The design was agreed in chat on 2026-11-17: Zustand, plus the split, plus `persist` replacing `lib/cache.js` for the dialer, with no visible change. This plan is the record. Rulings are provisional against that chat.

## Global Constraints
- **No visible change:** same screens, copy, order, timing (5-second countdown, 1-second hold after save) and API calls.
- **JavaScript only:** no native module changes, so it ships over the air with `app/publish-update.sh`. `zustand` and `jest-expo` add no native code.
- **What persists:**
  - Kept on the phone: only the queue per view, the views list and the form, under the existing key scheme per person (`<email>`) and mode.
  - Never kept: phase, current lead or the call in progress. An app restart must never reopen a call screen.
- **`lib/cache.js` stays for `App.js`,** which keeps the profile there. Only the dialer's keys move to the store.
- **Phone checks** happen on Donald's OnePlus over adb, with his account in sales mode and test leads only.
- **Commits, pushes and the publish** each need Donald's OK.

## Review Focus
1. **Skip near the end of the countdown:** the countdown must not dial the skipped lead from an old reading of state. Test in Task 2.
2. **A view switch while the queue loads:** the old view's reply must not overwrite the new view's list. Test in Task 2.
3. **App restart with saved state:** the app opens on the list (phase idle), never on the call or form screen. Test in Task 1.
4. **An answered incoming call while a form is open:** that form saves first, then the incoming form opens (`pendingIncoming`). Test in Task 2.
5. **App resume during a call:** coming back to the app during a call keeps the call screen, and the form opens once the call ends. Checked by hand in Task 4, because it needs real phone events.

---

### Task 1: Store, the pure queue order, and tests

**Files:**
- Create: `app/lib/queueOrder.js`, `app/lib/dialerStore.js`, `app/lib/__tests__/queueOrder.test.js`, `app/lib/__tests__/dialerStore.test.js`
- Modify: `app/package.json` (add `zustand`; add dev dependency `jest-expo`, plus `"test": "jest"` and the `"jest": { "preset": "jest-expo" }` config)

**Interfaces:**
- Produces:
  - `pendingLeads(leads, { handled: Set<string>, skipped: Map<string, number>, waiting: Set<string> }) -> Lead[]`, in `queueOrder.js`. It keeps the order of the leads not yet handled, then puts the skipped ones at the end, earliest skip first. This is today's `pending()` filter and sort, moved out unchanged.
  - `useDialer`, a Zustand store with `persist`. It's keyed `dialer-<email>`, through `createJSONStorage(() => localStorage)`.
    - Keys: `phase`, `lead`, `call`, `queue: { leads, rule, source, upcoming }` (the open view's), `queues: Record<viewId, queue>` (every view's last reply, for instant switching), `handled: string[]`, `skipped: Record<string, number>`, `paused`, `view`, `views`, `form`, `formMode`, `values`, `talkSeconds`, `callback`, `incoming`, `pendingIncoming`.
    - Actions: `setPhase(p)`, `setLead(l)`, `setQueue(q)`, `markHandled(id)`, `markSkipped(id, at)`, `resetHandled()`, `setView(id)`, `setViews(list)`, `setForm(form, mode)`, `setValues(v)`.
    - `partialize` keeps only `queues` (by view id), `views`, `form` and `formMode`.
  - `initDialer(email)`: points the store's persistence at that person's key and rehydrates it. It's called once by `DialerScreen` before its first render.

- [ ] **Step 1: Install the libraries.** In `app/`, run `npm install zustand` and `npm install -D jest-expo jest`. Expected: `package.json` lists `zustand` under dependencies and `jest-expo` under devDependencies.
- [ ] **Step 2: Write the failing tests:**
  - `queueOrder.test.js`:
    - `test('handled and waiting leads drop out; skipped go last, earliest skip first')`
      - Leads `a,b,c,d`; handled `{b}`; skipped `{a:2, c:1}`; waiting `{}`.
      - Expect `['d','c','a']`.
    - `test('a skipped lead that is also handled is gone')`
  - `dialerStore.test.js`:
    - `test('after a restart the store opens idle with no lead or call, but keeps queues, views and form')`
      - Set phase `'calling'`, a lead, a queue, a form. Persist, rehydrate a fresh store, then expect `phase === 'idle'`, `lead === null`, `call === null`, and the queue and form unchanged.
    - `test('markSkipped then markHandled leaves the lead handled only')`
- [ ] **Step 3: Run** `cd app && npx jest lib`. Expected: FAIL, because the modules don't exist yet.
- [ ] **Step 4: Implement** `queueOrder.js` (move the body of today's `pending()`) and `dialerStore.js` as above. `localStorage` is the same global that `lib/cache.js` uses. In tests, stub it with a `Map`-backed object in a `jest.setup.js`.
- [ ] **Step 5: Run** `npx jest`. Expected: all pass.
- [ ] **Step 6: Commit,** with OK: `git commit -m "App: dialer store (zustand) and queue order, with tests"`

### Task 2: Move the call flow out of the component

**Files:**
- Create: `app/lib/callFlow.js`, `app/lib/__tests__/callFlow.test.js`
- Modify: `app/DialerScreen.js`
  - Delete: `next`, `dial`, `finishCall`, `skip`, `save`, `submit`, `loadQueue`, `pending`, `pickView`, `prefetchViews`, `loadShown`, `autoOpenOnLaptop`, `listenIncoming`, `incomingEnded`, `catchUpIncoming`, `openIncoming`, `refresh`, `refreshNow` and the ten state-copy refs.
  - Keep: the `useEffect`s that register phone listeners. They now call `callFlow` functions.

**Interfaces:**
- Consumes: `useDialer` and `pendingLeads` from Task 1.
- Produces: `createCallFlow({ api, Dialer, enqueue, waitingLeads, loadPrefs, showToast, setError })`, which returns an object holding the functions named in the Files list above (the ones deleted from `DialerScreen.js`), with today's signatures.
  - Every read of current state inside them uses `useDialer.getState()`. None reads a component closure.
  - `dial()` reads the lead from `useDialer.getState().lead`, never from a parameter captured at render.

- [ ] **Step 1: Write the failing tests** in `callFlow.test.js`. Mock `api`, `Dialer` (`placeCall`, `isInCall`, `lastOutgoingCall`) and `enqueue`.
  - `test('skip during the countdown: the next lead is dialed, never the skipped one')`
    - Queue `a,b`. Run `next()`, then `skip()`, then the countdown's `dial()`.
    - Expect `placeCall` to be called with `b`'s phone.
  - `test('only skipped leads left: pauses instead of dialing')`
    - Expect `phase === 'paused'` and `placeCall` not called.
  - `test('a queue reply for a view the person has left is ignored')`
    - Call `pickView('v1')`, then `pickView('v2')` before `v1`'s `api` resolves.
    - Expect the store queue to equal `v2`'s reply.
  - `test('an answered incoming call during a form waits, then opens after save')`
    - With phase `'outcome'`, `openIncoming(item, 'next')` sets `pendingIncoming`.
    - `submit()` then opens that lead's form.
  - `test('call end: the call-log row sets talk time and opens outcome or reason')`
    - `lastOutgoingCall` returns `durationSec: 0`, so expect phase `'reason'`.
    - With `12`, expect phase `'outcome'` and `talkSeconds === 12`.
  - `test('laptop opens once per lead, at the countdown when chosen')`
    - Prefs `{autoLaptop:true, laptopWhen:'countdown'}`, then run `next()` and `dial()`.
    - Expect exactly one `open-on-laptop` call.
- [ ] **Step 2: Run** `npx jest lib/__tests__/callFlow.test.js`. Expected: FAIL, because `callFlow.js` is missing.
- [ ] **Step 3: Implement** `callFlow.js` by moving each function's body over unchanged, except that state reads and writes go through the store. `DialerScreen` creates the flow once (`useMemo`) and passes it down.
- [ ] **Step 4: Run** `npx jest`. Expected: all pass. Then build and install with `assembleRelease` and `adb install -r`. The app should open on the list.
- [ ] **Step 5: Commit,** with OK: `git commit -m "App: call flow out of DialerScreen, state read from the store"`

### Task 3: Split the screens

**Files:**
- Create:
  - `app/components/LeadParts.js`: `LeadDetails`, `LatestNote`, `LeadHistory`, `dueText`, `ago`, `locationOf`, moved unchanged.
  - `app/screens/ListScreen.js`: the segmented switch, view chips, lead rows and follow-up rows.
  - `app/screens/CallScreen.js`: the countdown, calling and paused lead screens.
  - `app/screens/MarkScreen.js`: the lead card, Open on laptop, the reason list and `ActivityForm`, inside the `KeyboardAvoidingView`.
- Modify: `app/DialerScreen.js`. It becomes the shell: header, menu, Settings, Recordings, the key modal, toast, footer buttons and error line, choosing a screen by `phase`.
  - Target under 350 lines.

**Interfaces:**
- Consumes: `useDialer` with selectors (e.g. `useDialer(s => s.lead)`), and the flow from Task 2 via a prop or React context.
- Produces: `ListScreen({ flow })`, `CallScreen({ flow })`, `MarkScreen({ flow })`. Each reads its data from the store.

- [ ] **Step 1: Move the leaf components** into `LeadParts.js` and import them back. Run `npx jest`. Expected: pass. The APK still builds.
- [ ] **Step 2: Extract `ListScreen`, then `CallScreen`, then `MarkScreen`,** one at a time. Check after each:
  - the release bundle builds: `./gradlew app:createBundleReleaseJsAndAssets --rerun` succeeds;
  - `adb exec-out screencap` of that screen looks the same as before the change.
- [ ] **Step 3: Confirm the old state is gone:** `grep -c "useRef" app/DialerScreen.js` shows at most 5, the UI-only ones (toast timer, chip positions, countdown bar, dragging, load sequence), and `wc -l` shows under 350.
- [ ] **Step 4: Commit,** with OK: `git commit -m "App: DialerScreen split into list, call and mark screens"`

### Task 4: Phone check, then publish
- [ ] **Step 1: Install on the OnePlus** and run the whole flow by hand, ticking each item:
  1. The app opens on the cached list straight away.
  2. Switching views and back is instant, and the counts are right.
  3. Start → countdown → skip → the next lead.
  4. Only skipped leads left → paused.
  5. A call that connects → outcome form, and Save is instant.
  6. A call that doesn't → reason, one tap.
  7. A due follow-up shows its banner and goes first.
  8. Mid-call, switch to the dialer and back to the call; when the call ends, the form opens.
  9. An incoming call from a test lead is named during the call, and its form opens after.
  10. The laptop opens at the countdown when set.
  11. The keyboard on Notes lets you scroll the whole form.
  12. Kill the app mid-call and reopen: it opens on the list.
- [ ] **Step 2: Update `CLAUDE.md`** with one line: dialer state lives in `app/lib/dialerStore.js` (Zustand), the call flow in `app/lib/callFlow.js`, the screens in `app/screens/`, and app tests run with `cd app && npx jest`.
- [ ] **Step 3: Publish,** with OK: commit, push, then `cd app && ./publish-update.sh "Dialer: state store and split screens (no visible change)"`.
