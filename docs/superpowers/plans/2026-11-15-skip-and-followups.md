# Skipped Leads Come Back, Due Follow-ups Jump the Queue: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skipped leads go to the back of the queue instead of being dropped for the day. LSQ follow-up tasks that come due today go to the front, with a banner.

**Architecture:**
- **Server:** `getQueue` decides the order: pushes, then due follow-ups, then the tab, then today's skips.
- **Follow-ups:** they come from the person's open LSQ tasks. `services/views.js` already reads these and caches them for 2 minutes.
- **App:** keeps the order the server sends, and mirrors skips locally so the reorder is instant. It shows a banner when the next lead is a follow-up.

**Tech Stack:** Express 5 + Supabase + LSQ (`backend/`, Jest); React Native/Expo app (`app/`), shipped over the air with `app/publish-update.sh`.

**Spec:** `docs/superpowers/specs/2026-11-15-skip-and-followups-design.md`

## Global Constraints
- **Dates:** LSQ task dates are UTC, `"YYYY-MM-DD HH:mm:ss.000"`. "Today" means the IST day (`istNow(now).midnightIso`).
- **Task reads:** each person's open tasks are read at most once per 2 minutes. Reuse the `views.js` cache; never add a second reader.
- **Skips:** a lead with any `no_answer` or `connected` attempt today stays out of the queue. Only leads whose attempts today are all `skipped` come back, at the end.
- **No nagging:** a follow-up isn't shown once the person has made any dial attempt on that lead since its due time.
- **TL rules:** when a TL rule is running, no follow-ups are added.
- **Phone:** JavaScript only, so no new APK. Commits and pushes need Donald's OK, and so does publishing the app update.

## Review Focus
1. **A skip saved in the background while the queue reloads:** the skipped lead must not jump back to the front. Test in Task 3: `pending()` keeps local skips last whatever order the server sends.
2. **A follow-up lead also in the open tab:** it appears once, at the front, and not again further down. Test in Task 2.
3. **A follow-up due later today:** not shown yet. Test in Task 2.
4. **A follow-up due yesterday:** never shown. Test in Task 2.
5. **A follow-up on a lead someone else owns,** such as after a reassignment: not shown. Test in Task 2.

---

### Task 1: Server: skipped leads go to the back

**Files:**
- Modify: `backend/services/queue.js`: `getQueue` (the `dialedToday` query and the `rest` ordering) and `viewCounts`.
- Test: `backend/tests/queue_source.test.js`

**Interfaces:**
- Produces: `splitAttempts(attempts: {prospect_id, outcome, started_at}[]) -> { done: Set<string>, skippedAt: Map<string, string> }` in `queue.js`, exported. `done` holds leads with any non-skipped attempt. `skippedAt` maps each lead whose attempts are all skips to the ISO time of its latest skip.

- [ ] **Step 1: Write the failing tests** in `queue_source.test.js`:
  - `test('a lead skipped today comes back at the end, oldest skip first')`
    - Owned leads: `a, b, c, d`.
    - `mockDialRows`: `[{prospect_id:'b', outcome:'skipped', started_at:'2026-11-03T05:00:00Z'}, {prospect_id:'a', outcome:'skipped', started_at:'2026-11-03T04:00:00Z'}]`.
    - Expect leads `['c','d','a','b']`.
  - `test('a lead skipped then called today stays out')`
    - `mockDialRows`: `b` skipped, then `b` `no_answer`.
    - Expect `b` absent.
  - `test('chip counts include leads skipped today')`
    - With `viewCounts`: one skipped lead is counted, one `no_answer` lead isn't.
- [ ] **Step 2: Run** `cd backend && npx jest tests/queue_source.test.js`. Expected: the 3 new tests FAIL.
- [ ] **Step 3: Implement**
  - Select `prospect_id, outcome, started_at` from `dial_attempts`.
  - Build `splitAttempts`, and pass `done` to `ownQueue` in place of today's set.
  - Sort `rest`: leads not in `skippedAt` keep their order; leads in `skippedAt` go after them, sorted by skip time, ascending.
  - `viewCounts` uses `done` too.
  - Update the comment on `getQueue`.
- [ ] **Step 4: Run** `npx jest`. Expected: all tests pass.
- [ ] **Step 5: Commit**, with OK: `git commit -m "Queue: leads skipped today come back at the end"`

### Task 2: Server: due follow-ups first

**Files:**
- Modify: `backend/services/views.js`: split the task read so the raw open tasks can be reused.
- Modify: `backend/services/queue.js`: `getQueue`.
- Test: `backend/tests/queue_source.test.js` (its `views` mock gains `openTasks`) and `backend/tests/views.test.js`, which must still pass.

**Interfaces:**
- Consumes: `splitAttempts` from Task 1; `readLeadsByIds(ids)` and `toLead` in `queue.js`.
- Produces:
  - `views.openTasks(lsqUserId: string) -> Promise<{RelatedEntityId: string, DueDate: string}[]>`, cached 2 minutes under the existing `tasks:` key. The current `getTasks` sets are built from it.
  - `dueFollowUps(tasks, attempts, now) -> {prospectId, dueAt: string}[]` in `queue.js`, exported and pure.
    - Keeps tasks due in `[IST midnight, now]`.
    - Drops a task when an attempt on that lead has `started_at >= dueAt`.
    - Keeps the earliest due time per lead, sorted oldest first.
    - `dueAt` is ISO UTC.
  - **Queue reply:** each follow-up lead carries `followUp: { dueAt }`.

- [ ] **Step 1: Write the failing tests:**
  - `dueFollowUps` with `now = 2026-11-03T10:00:00Z`; IST midnight is 2026-11-02T18:30Z.
    - Kept, sorted oldest first: due `2026-11-03 09:00:00.000` and `2026-11-03 04:00:00.000`.
    - Dropped (later today): due `2026-11-03 11:00:00.000`.
    - Dropped (yesterday): due `2026-11-02 12:00:00.000`.
    - Dropped (dialed since due): an attempt at `2026-11-03T09:30:00Z` on the 09:00 lead.
  - `test('due follow-ups come right after pushes, once, with followUp')`
    - `views.openTasks` mocked to return a task on `c`, due today and already past.
    - Owned leads: `a, b, c`.
    - Expect order `['c','a','b']`, with `c.followUp.dueAt` set.
  - `test('a follow-up on a lead someone else owns is left out')`
  - `test('no follow-ups while a TL rule runs')`
- [ ] **Step 2: Run** `npx jest tests/queue_source.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement**
  - Add `openTasks` in `views.js`, and rebuild `getTasks` on top of it so `views.test.js` keeps passing.
  - In `getQueue`, when there's no rule:
    - Fetch `views.openTasks(profile.lsq_user_id)` together with the other reads, and treat a failure like pushes do: log it and carry on with none.
    - Compute `dueFollowUps`.
    - Take the lead objects from the loaded rows when present, otherwise from `readLeadsByIds`.
    - Keep only ones the person owns, with a phone, that aren't pushed or in `done`.
    - Put them after pushes, and remove them from `rest`.
- [ ] **Step 4: Run** `npx jest`. Expected: all tests pass.
- [ ] **Step 5: Commit**, with OK: `git commit -m "Queue: LSQ follow-ups due today come first"`

### Task 3: App: skip sends the lead to the back

**Files:**
- Modify: `app/DialerScreen.js`: `skip()` and `pending()`.
- Modify: `app/lib/outbox.js`: `waitingLeads`.

**Interfaces:**
- Consumes: the queue order from Tasks 1 and 2.
- Produces: `skippedRef: Map<prospectId, number>`, the time of the skip, in `DialerScreen`.

- [ ] **Step 1: Change `waitingLeads`** to ignore outbox items whose `body.outcome === 'skipped'`, so a skip waiting to be sent doesn't hide the lead.
- [ ] **Step 2: Change `skip()`** to set `skippedRef.current.set(id, Date.now())` instead of `markHandled`. The `save('skipped', null)`, the toast and `next()` stay.
- [ ] **Step 3: Change `pending()`:**
  - After filtering handled and waiting leads, move the leads in `skippedRef` to the end, sorted by skip time.
  - A lead that is later saved as called is removed by `markHandled`, as now.
- [ ] **Step 4: Check by hand on the OnePlus.** Build the release APK and install it with `adb install -r`.
  - Skip lead 1 in the countdown: lead 2 comes up next.
  - On the list, lead 1 is now last.
  - After about 30 s, and after Refresh leads, it's still last.
- [ ] **Step 5: Commit**, with OK: `git commit -m "App: a skipped lead goes to the back of the queue"`

### Task 4: App: follow-up banner

**Files:**
- Modify: `app/DialerScreen.js`: the countdown screen and the list screen.

**Interfaces:**
- Consumes: `lead.followUp.dueAt` from Task 2.

- [ ] **Step 1: Countdown screen.** When `lead.followUp` is set, show a banner above the lead in the existing notice style:
  - Text: **"Follow-up due · was due {h:mm am}"**, formatted with `toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })`.
  - The lead's name and number already show just below, so the banner doesn't repeat them.
  - `accessibilityRole="alert"`.
- [ ] **Step 2: List screen.** While idle, if the first lead of the queue has `followUp`, show the same banner above the list, with the lead's name: **"Follow-up due: {name} · was due {time}"**.
  - Tapping **Start** dials it first, which happens anyway from the queue order.
  - Keep the phone number out of the banner here. It's on the call screen, and a list banner would show numbers to anyone near the phone.
  - This is the builder's call. The spec's "{phone}" is met on the countdown screen, where the number is already shown.
- [ ] **Step 3: Check by hand on the OnePlus** against Donald's test lead `2a18651f-4c7f-4c7c-880b-d64254892537`.
  - In LSQ, give it a follow-up task due a few minutes ago.
  - After Refresh leads, it heads the list with the banner.
  - Start: the countdown shows the banner.
  - Call or skip it: the banner is gone and the tab continues.
- [ ] **Step 4: Commit**, with OK: `git commit -m "App: banner for a due follow-up"`

### Task 5: Ship
- [ ] **Step 1:** Run `cd backend && npx jest`. Expected: all tests pass.
- [ ] **Step 2:** Push, with OK. Railway deploys the backend.
- [ ] **Step 3:** Publish, with OK: `cd app && ./publish-update.sh "Skipped leads come back; due follow-ups first"`
- [ ] **Step 4:** Update `CLAUDE.md` with one decisions line: skips go to the back, due follow-ups come from LSQ open tasks due today and are not shown after a dial since the due time, and none while a TL rule runs. Commit, with OK.
