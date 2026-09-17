# Security

What changed in this pass, and — importantly — what YOU still need to do
outside the code, since some of this can't be verified or deployed from
inside a sandboxed code environment.

## Fixed in code

**1. No route protection → added `ProtectedRoute`.**
Every page (`/app`, `/profile`, `/report`, `/sos`, `/community`, `/safewalk`,
`/analytics`, `/leaderboard`) was reachable by anyone just by typing the URL,
regardless of login state. `src/components/ProtectedRoute.tsx` now gates all
of these behind sign-in and redirects to `/login?next=...`. (Marketing pages
— `/guides`, `/features`, `/about`, `/support`, `/blog` — stay public, as
intended.) This is enforced the same way whether or not Firebase is
configured — see next point.

**2. Login accepted any password, and worked differently than it looked.**
`AuthContext.signIn`/`signUp` originally never checked anything — any email
and any password "logged in" successfully, and every route was reachable
without logging in at all. Fixed properly, in two layers:
- **With Firebase configured:** `AuthContext` calls real Firebase Auth
  (`signInWithEmailAndPassword` / `createUserWithEmailAndPassword`) —
  wrong passwords, weak passwords, and duplicate sign-ups are all rejected.
- **Without Firebase configured** (no `.env` — the default state if you
  haven't set up a project yet): `src/lib/localAuth.ts` provides a real,
  self-contained auth system. Passwords are salted and SHA-256 hashed
  before being stored in `localStorage`; sign-in genuinely checks the hash
  and rejects wrong passwords / unknown emails (with the same error message
  for both, so a login attempt can't be used to enumerate registered
  emails); sessions persist across page reloads, same as Firebase's own
  persistence would. **This local mode is real enough to build and test a
  real login flow against, but it is not a security boundary** — anyone
  with devtools access to that specific browser can read or edit its
  localStorage directly. It exists so the app has a working login without
  requiring you to stand up a Firebase project first; production use should
  run on the real Firebase Auth path.

**3. Hardcoded, exposed Google Maps API key.**
`src/components/MapView.tsx` had a real key pasted directly into source
(`"AIzaSyDPSB2vQBBig0LBjiUyb6kKw6Q7ZrQYiHs"`), which means it's been
committed to source control and shipped in every built JS bundle. Changed to
read from `import.meta.env.VITE_GOOGLE_MAPS_API_KEY`. **You must still
rotate this key** (see below) — moving it to an env var doesn't undo the
exposure that already happened.

**4. No Firestore security rules at all.**
There was no `firestore.rules` file in the repo. If this project's Firestore
was ever deployed without one, it's either running on "test mode" defaults
(open to anyone for 30 days, then locked) or fully open. Added
`firestore.rules` + `firebase.json` + `firestore.indexes.json`:
- Deny-by-default for every collection except `liveLocations`.
- `liveLocations/{uid}`: a device can only create/update/delete **its own**
  document (`request.auth.uid == uid`), and the write is schema-validated
  (lat/lng ranges, required fields, server-generated timestamp only — a
  client can't fake `updatedAt`).
- Reads require *some* authenticated session (anonymous auth counts), never
  a fully anonymous HTTP request.
- **This file does nothing until you deploy it** — see below.

**5. Client code didn't actually match what the rules above require.**
`getDeviceId()` returned a random `localStorage` string that could differ
from the real Firebase Auth uid, especially before anonymous sign-in
resolved. Rules keyed on `request.auth.uid == docId` would silently reject
every write in that window. `src/lib/firebase.ts` now exposes
`getResolvedUid()`, which `LocationContext` waits on before writing/deleting,
so the document id always matches the real authenticated uid.

**6. Unrestricted file upload on the report form.**
`ReportIncidentPage`'s photo upload trusted the `accept="image/*"` HTML
attribute alone — trivially bypassed — with no size limit, so a malicious or
just-huge file could be read straight into a base64 string and crash the
tab. Now re-validates MIME type (`jpeg/png/webp/gif` only) and caps size at
5MB, with an inline error instead of silently failing. Report descriptions
are also capped (500 chars) with a visible counter.

**7. No input caps on emergency contacts.**
`SOSContext.addContact` now trims and length-caps name/phone/relation, and
rejects contacts with an empty name or phone.

**8. No Content-Security-Policy.**
Added a CSP + `Referrer-Policy` meta tag in `index.html`, restricting
scripts/styles/images/network calls to the origins this app actually needs
(self, Google Fonts, Google Maps/Firebase, OpenStreetMap tiles, the OSRM
router). Also added a stricter, header-based CSP plus `X-Frame-Options`,
`X-Content-Type-Options`, and `Permissions-Policy` in `firebase.json`'s
`hosting.headers` — a `<meta>` tag physically cannot set frame-ancestors or
X-Content-Type-Options, those need to be real HTTP response headers, which
only apply if/when you deploy via Firebase Hosting.

## You still need to do this yourself

Nothing above deploys itself — I don't have network/CLI access in this
environment, so none of this has actually been applied to a live Firebase
project. In order:

1. **Rotate the exposed Google Maps API key.** Go to Google Cloud Console →
   APIs & Credentials, delete/regenerate the key that was hardcoded, put the
   new one only in `.env` (never in source), and add **HTTP referrer
   restrictions** limiting it to your actual domain(s).
2. **Deploy the Firestore rules:** `firebase deploy --only firestore:rules`
   (requires the Firebase CLI and being logged into the right project).
   Until you run this, `firestore.rules` in this repo is inert.
3. **Enable Firebase App Check** on the project (reCAPTCHA/App Attest) if
   you want to stop automated/scripted abuse of your Firebase project, not
   just browser-side users — App Check can't be configured from client code
   alone.
4. **If you deploy on Firebase Hosting**, run
   `firebase deploy --only hosting` to actually apply the security headers
   in `firebase.json`. If you use a different host (Vercel/Netlify/etc.),
   port the same `headers` block to that platform's config instead.
5. **Keep dependencies patched.** Run `npm audit` periodically once you can
   install packages (blocked in this sandbox) and update anything flagged.
6. **Decide what "law-enforcement" role should really gate**, if anything.
   Right now `role` is just a display/UX label read from `localStorage` —
   it is not a real authorization boundary. If any feature needs to be
   restricted to verified law-enforcement accounts, that check has to live
   in Firestore rules or a backend function keyed on a trusted claim (e.g.
   a Firebase custom claim you set server-side), never a client-side field.

## Explicitly out of scope here

- Server-side rate limiting / abuse detection (needs Cloud Functions or a
  real backend — this app is currently a static SPA + Firestore).
- Email verification / MFA (Firebase Auth supports both; not wired up here).
- A real content-moderation pipeline for user-submitted reports/photos.
