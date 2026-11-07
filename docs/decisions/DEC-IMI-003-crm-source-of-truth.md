# DEC-IMI-003: The Iddav CRM is the single source of truth for enquiries

| Field | Value |
| --- | --- |
| Decision ID | DEC-IMI-003 |
| Owner / approver | Rama Krishna Vaddi |
| Class | B (brand/commercial) |
| Status | **Draft: effective only when Rama records the date and signs below** |
| Settles | The open item in DEC-IMI-002: "TFR-REU-002/007 keep staff-operations data out of IMI tables; the Enterprise Suite decision says one shared backend. Record which wins." |
| Supersedes | The "Enquiries (CRM inside IMI)" part of the pilot authorised in DEC-IMI-002 |

## Decision

The Iddav CRM (`iddav-crm`, a separate Worker and database) is the single source of truth for enquiries, guests, guest parties, properties,
rooms, rates, quotations, safari services and bookings. IMI does not keep a second copy. IMI reads what it needs from the CRM through an
authorised, read-only API, and keeps its own records for what IMI owns: campaigns, content, publications, decisions, outcomes and learning.

## What changes in IMI

1. **Campaign results come from the CRM.** The campaign funnel (enquiries, qualified, quoted, booked, room nights, booked value, margin, top
   loss reason, results by channel) is read from the CRM for each IMI campaign code (`CMP-0003`, with `-2` for post 2 and `-IG` for the
   channel). "Close outcome" turns those CRM numbers into an IMI Outcome, as before.
2. **No new enquiries in IMI.** Creating, staging and editing enquiries in IMI is switched off once the CRM is connected. The website form
   sends enquiries to the CRM. The old IMI public form answers that enquiries are taken by the CRM.
3. **Older IMI enquiries stay, read-only.** Records captured in IMI during the pilot remain visible and can still be erased on request
   ("Delete personal data"). They are not copied to the CRM automatically; Rama decides whether any should be entered there by hand.
4. **No personal data crosses.** IMI receives counts, values and campaign codes only: never a name, a phone number or an email address.

## Conditions

- The CRM's `INTAKE_KEY` and IMI's `CRM_SERVICE_KEY` are the same long random value, kept as Worker secrets and never in the code, the repository
  or a browser. IMI calls the CRM from its backend only.
- If the CRM cannot be reached, IMI says so plainly and shows no invented numbers.
- Pilot data remains pilot data until the Phase 0 exit, as DEC-IMI-002 states.

## Not changed

- Content Studio, Connections, approvals, the owner PIN, AI caps and the audit log (DEC-IMI-002).
- IMI keeps no staff-operations data, which is what TFR-REU-002/007 ask for.

## Review

Review after the first campaign's outcome window closes, comparing IMI's reported results with the CRM's own records for the same campaign.

Effective date: ____________   Signed: ____________ (Rama Krishna Vaddi)
