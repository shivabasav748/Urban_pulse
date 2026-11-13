# Women-driver preference and safety feedback

## Rider: "Prefer a woman driver"
- The option sits under Booking → Safety preferences. It is **off by default**, kept for the browser session, and shown again before confirming ("Woman driver requested…").
- The rider's gender is never collected. The preference is stored per request (`rides.women_driver_pref`, `trip_groups.women_driver_pref`).
- It is a **hard eligibility constraint** in `_rank`, `_dispatch` (re-checked under the captain's row lock), `_accept_offer`, and every reassignment path. It is never a ranking bonus.
- If no eligible captain is available, the ride stops at `no_driver_found` and the rider chooses: **keep waiting** (re-dispatched every sweep for 5 minutes, preference kept) or **search all captains** (preference removed explicitly by the rider). The system never drops it on its own.
- Riders never see which captains are opted in: no counts, no ineligibility reasons. Those live only in the judge-only `dispatch_audit`.

## Captain: opt-in
- Self-service card with a plain-language explanation and an explicit confirmation: "I confirm I am a woman captain and want to receive requests from riders who prefer a woman driver."
- Withdrawal is available at any time. Withdrawing releases any pending preference offer to the next eligible captain. An active trip is never interrupted (concurrency scenario 5b; SQL test I).
- Stored in a **separate table**, `captain_preferences`, not on `driver_profiles`, because a captain's profile row is readable by the rider assigned to them. RLS: the captain can read only their own row, an admin can read all, and riders and other captains can read none. Writes go only through `set_women_riders_optin`, and every change is appended to `captain_preference_audit` (admin-only).
- Gender is never inferred from a name, photo or voice. The 5 simulated demo opt-ins are a fixed, name-independent subset (every third simulated plate), flagged `simulated`.
- No effect on any other ride: `_rank` uses the opt-in only as a filter, and only for requests that ask for it. It is not part of any score.

### Regulatory position (researched 13 Nov 2026)
A MoRTH amendment to the Motor Vehicle Aggregator Guidelines 2025 (about 15 Dec 2025, clause 15.6, per secondary sources; the MoRTH PDF was not readable) lets passengers choose a same-gender driver where available. Karnataka adoption was not found. Our opt-in design is consistent with "where available": it never forces a match and never silently drops the preference.

### Privacy-preserving verification design (not implemented)
A production onboarding flow could add `verification_status` (`self_declared` → `pending_review` → `verified` / `rejected`) next to the opt-in:
- **Evidence handling:** the evidence (e.g. a document check by an onboarding officer or an identity-verification vendor) is reviewed out of band. Only the status, reviewer, timestamp and a reference id are stored. No document images are kept in the dispatch database.
- **Who sees the status:** dispatch reads only `verified` (or `self_declared`, by policy). Riders see neither the status nor the flag. The captain sees their own status. Admin reads are audited.
- **Badges:** no badge until `verified` exists. Today every opt-in is `self_declared`, and the UI says so.

### Limitations before a public launch
- **Self-declared, not verified.** The UI says so and never shows a "verified woman driver" badge. A production launch needs a documented verification process, data-protection review (sensitive personal data under India's DPDP Act 2023), legal review of non-discrimination obligations, a grievance channel, and a policy for misuse.
- Supply may be thin: in the Arena low-supply scenario, 0 to 29% of preference requests were served across three seeds (seeds 1, 7 and 42), with no violations.

## Safety feedback (separate from any star rating)
- Shown after a completed ride. Optional and skippable: overall feeling of safety (1–5, required); driving, vehicle and conduct (1–5, optional); a comment of up to 500 characters.
- `submit_safety_feedback` requires the rider of that ride, a completed status and an assigned captain. A unique `ride_id` means one entry per ride. Riders see only their own rows; captains see no rows and never the reporter.
- **Publishing threshold: 5 entries** (`settings.safety_min_feedback`). Below it, the captain card says "Not enough safety feedback yet." and shows only the count. At or above it, the mean, labelled "Passenger-reported, from N completed rides". Five keeps a single unhappy trip from defining a captain while still appearing within a demo. It is a judgement call and needs revisiting with real volumes. No ratings are seeded.
- `captain_safety_summary` returns aggregates only, to the captain, an admin, or the rider currently assigned to that captain.

## Safety reports
- Available from an active or completed trip ("Safety concern" / "Report a concern"). Category (unsafe driving, harassment, vehicle condition, unexpected route, other), a description of at least 10 characters, a submission time and a review status (open → under review → resolved or dismissed). One report per trip per rider.
- RLS: the reporter sees their own report and the admin sees all. **The captain sees neither the report nor the reporter.**
- Admin review (`review_safety_report`) is recorded in the append-only `safety_report_audit`.
- **No automatic penalties:** reports and ratings never change dispatch or take a captain offline (SQL test: "an unreviewed report does not suspend…").

## Tests
- SQL `pnpm db:safety`, sections A–F and I: permissions, RLS, ownership, unfinished rides, duplicates, threshold, review audit.
- Concurrency 5a, 5b and 5e.
- E2E: women-driver matched, no eligible captain with the rider's choice, feedback and report with judge review.
