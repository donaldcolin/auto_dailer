# Skipped leads come back, due follow-ups jump the queue

Approved by Donald on 2026-11-15.

## Why
- **Skips:** a skipped lead is lost for the day. Skip saves a `skipped` dial attempt, and the server leaves every lead dialed or skipped today out of the queue. Counsellors skip a lead to call it later, not never.
- **Follow-ups:** counsellors set follow-ups (date and time) while dialing a tab such as "Leads assigned today". When one comes due, nothing tells them, and the dialer keeps going through the tab. They want to be told, call the follow-up, then carry on with the tab.

## Goals
1. **Skips:** a lead skipped today goes to the **back** of the current queue, in the order it was skipped. It comes round again after everything else, and skipping it again sends it to the back again.
2. **Follow-ups:** a follow-up that is **due** comes **first** in the queue, whatever tab is open, with a banner naming the lead, its number and when it was due. After it, the tab carries on.

## Non-goals
- No reminders while the dialer is closed.
- The dialer doesn't mark tasks done in LSQ. LSQ's own workflows handle that.
- Follow-ups due on earlier days are left out. The "Overdue task all time" tab covers those.

## Anti-goals
- **No nagging:** a follow-up the counsellor has already called since it came due must not keep jumping the queue, even while its LSQ task is still open.
- **No interrupting a call or a form:** the banner and the reorder only affect which lead comes next.

## Approaches
- **A. LSQ tasks, worked out on the server (chosen).**
  - LSQ turns a form's follow-up field into a task for the lead's owner (e.g. "Follow Up: Shankar Banoth").
  - The server already reads each person's open tasks, cached 2 minutes, in `services/views.js`.
  - This catches follow-ups set anywhere: in the dialer, in LSQ on the web, or by a TL.
  - It lags up to 2 minutes behind LSQ.
- **B. Only follow-ups marked in the dialer:** instant, but misses every other source. Rejected: Donald picked A.
- **Phone-only ordering:** rejected. It can't see LSQ tasks, and it forgets skips when the app restarts.

## Design
### Queue order (server, `getQueue`)
1. TL pushes, as now.
2. **Due follow-ups**, oldest due first.
3. The tab's or rule's leads not called today, as now.
4. **Leads skipped today**, by the time of their last skip, oldest first.

### Skips
- A lead whose **latest** attempt today is `skipped` is no longer left out of the queue; it goes in part 4.
- A lead with any `no_answer` or `connected` attempt today stays out, as now.
- This applies to TL rule queues too, using the rule's own attempts, as today.

### Due follow-ups
- **Source:** the person's open (incomplete) LSQ tasks, all task types.
- **When one is due:** its due time is today in IST and already past.
- **When it stops showing:** the person has dialed that lead (any attempt, including a skip) since the task's due time.
- **Which leads:** only leads the person owns, with a phone. Each is read with `readLeadsByIds` when it isn't already in the loaded rows.
- **Each one is marked** `followUp: { dueAt }` so the app can show the banner.
- **Not shown when a TL rule is running:** TL rules are a schedule the TL set, so the queue leaves follow-ups out then.
  - This is the builder's call; Donald didn't decide it.

### App (`DialerScreen.js`)
- Keeps the server's order. Moving to the next lead after a save, or after a skip, uses the list as the server last sent it, minus handled leads, as now.
- **Skips locally:**
  - A lead skipped in this session moves to the end of the local list straight away, without waiting for the server.
  - `handledRef` no longer drops skipped leads; they are re-ordered instead.
- **Banner:**
  - Shown when the **next** lead to dial, or the one in the countdown, is a follow-up: **"Follow-up due: {name} · {phone} · was due {h:mm am}"**.
  - Also shown when one arrives during the 30-second list refresh while the person is on the list.
  - Uses the app's existing notice style; no new pattern.
- **Counts:** a follow-up isn't counted in the view chips. The open chip's count is the list on screen, which includes it.

## Constraints
- LSQ task dates are UTC, `"YYYY-MM-DD HH:mm:ss.000"`.
- Task reads go through the shared LSQ limiter; the existing 2-minute cache per person is reused.
- JavaScript-only on the phone, so it ships over the air. The backend deploys on Railway.

## Left to the builder
- Exact banner wording and placement within the existing notice style.
- How the task reader is shared between `views.js` and the queue, as long as each person's tasks are still read only once per 2 minutes.
