# Meta (Instagram and Facebook) readiness checklist

Nothing here connects a production account. These are checks to complete before the
staging connector is built and tested. Answers go in the right-hand column.

## A. Accounts (founder)
| Check | Answer |
|---|---|
| Iddav's Instagram is a Professional account (Business or Creator) | |
| It is linked to the Iddav WildStay Facebook Page | |
| Who are the Page admins (names only) | |
| A Meta Business portfolio exists and owns the Page and the Instagram account | |
| Business Verification status (not started / submitted / verified) | |

## B. Developer app (founder, with me)
| Check | Answer |
|---|---|
| A Meta developer app exists (the old IMI "form token" connection suggests one may) | |
| App type and mode (Development / Live) | |
| The founder has the Administrator role on the app | |
| Privacy policy URL and data-deletion URL ready (required for Live mode) | |

## C. What we will request (read-only first; publishing stays off in staging)
- Instagram API with Instagram Login: `instagram_business_basic`, `instagram_business_manage_insights`, `instagram_business_manage_comments`.
- Facebook Login for Business (Pages): `pages_show_list`, `pages_read_engagement`.
- Publishing scopes (`instagram_business_content_publish`, `pages_manage_posts`) only later, after review, with publishing approval gates in IMI ONE.
- Permission names are rechecked against Meta's documentation when we build; they have changed before.

## D. Development mode (what is possible before App Review)
In Development mode an app can read the accounts of people who hold a role on the app
(administrator, developer, tester). That lets IMI ONE staging read Iddav's own posts,
comments and insights once the founder connects them, without App Review. Other
people's accounts need App Review and Live mode.

## E. Data handling decisions (before connecting)
| Decision | Proposed |
|---|---|
| Where tokens are stored | Encrypted on the server (existing CONNECTIONS_KEY scheme), never in the browser |
| Which brand owns the connection | Per workspace (needs a per-brand connections table; today it is one per platform) |
| What is stored | Post ids, captions, timestamps, metric values with retrieval time; no follower personal data |
| Retention and deletion | Deleted with the connection; data-deletion callback for Meta |
| Staging vs production | Separate Meta app or a separate test account for staging, so staging never holds production tokens |
