# Sales Smart Views, mirrored as dialer Lists

Read from LSQ on 2026-11-14 (Smart View tab settings, created by Tejas N and shared to sales). LeadSquared has no API for Smart Views, so each tab becomes a **dynamic List** named `Dialer – <tab name>` with the same conditions. The dialer reads the List and keeps only the caller's own leads.

## How to build each List in LSQ
1. Go to Leads → Manage Leads → Advanced Search, and add the conditions listed for the tab below.
2. Save the search as a **dynamic** List named exactly `Dialer – <tab name>`.
3. **Leave out any Lead Owner condition.** The dialer filters each person's own leads itself.
4. **Wherever a condition says "BDA Activity (218)", add the same condition for "Auto Dailer - BDA activity (286)".** Sales has saved calls to 286 since 2026-11-14, so a rule that only looks at 218 misses every call marked in the dialer. The field names are the same in 286; only their internal numbers differ.

Every tab sorts by **Modified On, newest first**. The dialer uses the same order.

Two conditions repeat across several tabs:
- **Disposition (open)**: Lead Disposition is not Not Interested, Future Lead, Disqualified, Non-eligible stream or Financial Constraint lead.
- **Not called today**: the lead has no Outbound Phone Call Activity (22) with Start Time today.

## The 8 tabs

### 1. Leads assigned today
- Owner was assigned **today**. In LSQ this is "to the current user"; in the List, use "Owner changed today", and the dialer keeps only the caller's leads.

### 2. Pending follow up for today
- Has a task of any type, status **pending**, due **today**.

### 3. Lead with zero connect
- Disposition (open).
- Total Connects = 0.
- Total Calls ≤ 25.
- Not called today.

### 4. Demo conducted not registered
- Has a BDA Activity (218 **or 286**) with Activity Type = Demo Conducted.
- Has no Application Status (266) activity with Application Payment Status = Completed.
- Has no BDA Activity (218 **or 286**) with How was the session = Not interested.
- Lead Disposition is not Applied or Applied from different number.

### 5. Overdue task all time
- Has a task of any type with status **overdue**.

### 6. Hot Lead - Outreach + Organic
Described as school outreach leads and organic enquiries.
- Lead Source is one of the 47 sources in the LSQ tab: Social Media, Inbound Phone call, WA Lead, Influencer, Unknown, YouTube…, Instagram…, websiteform, School, School_Outreach, blogs, YT_…, and the rest. Copy the list exactly from the tab.
- Created On after 17 Aug 2026.
- Not called today.
- Disposition (open).
- Has no BDA Activity (218 **or 286**) with Student Grade = Hostelier.
- Total Calls ≤ 20.

### 7. Leads without Task
- Has no task of any type.
- Disposition (open).

### 8. Open lead to be called
- Disposition (open).
- Total Calls ≤ 20.
- Not called today.
- Has no BDA Activity (218 **or 286**) with Student Grade = Hindi Medium.
- Has no BDA Activity (218 **or 286**) with Activity Type = Demo Conducted.
- Has no Application Status (266) activity with Application Payment Status = Completed.

## Notes
- **Same tabs for the whole team:** all 8 are shared admin tabs (shared by the same admin), so every sales user sees the same set.
- **The "Not called today" rule relies on Callyzer** logging the call as activity 22. Calls made through the dialer are also kept out of every dialer tab for the rest of the day by the dialer itself.
- **When a tab changes in LSQ,** change its List the same way. The dialer has no copy of the rules.
