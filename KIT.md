# Staff rota kit

## Where things live

- `app/page.tsx`: sign-in for every role; public signup is disabled.
- `app/shell.tsx`: navigation; `app/site.ts`: editable business name.
- `app/rota/page.tsx`: weekly rota; `app/availability/page.tsx`: personal availability and leave.
- `app/team/page.tsx`: invitations and staff CSV import; `app/settings/page.tsx`: owner-editable locations, positions and shift types.
- `app/rota-screen.tsx`: shared rota forms, shift actions, approval screens and weekly hours.
- `app/owner/page.tsx`: owner sign-in settings, opened through the one-use owner pass.
- `app/invite/page.tsx`: one-use invite acceptance and sign-in.
- `app/password-reset/page.tsx`, `app/reset-password/page.tsx`, `app/reset-password/form.tsx`: reset email request and chosen password.
- `app/api/account/[action]/route.ts`: unchanged accounts routes and owner pass.
- `app/api/rota/route.ts`: authenticated queries and same-origin changes.
- `app/api/rota/export/route.ts`: scoped weekly shifts and hours download.
- `app/api/invites/route.ts`: bounded same-origin invite check and acceptance.
- `app/api/health/route.ts`: unchanged health route.
- `lib/accounts.ts`: unchanged reviewed accounts, password hashing, sessions and owner pass.
- `lib/runtime.ts`: one shared database pool and account settings.
- `lib/rota/access.ts`: workspace membership, owner and manager checks, staff identity and first-use seeds.
- `lib/rota/data.ts`: scoped rows, locked mutations, location time conversion, copy, publish, swaps, claims, availability, leave, warnings and hours export.
- `lib/rota/invites.ts`: random hashed one-use invites, expiry and server-chosen roles.
- `lib/rota/csv.ts`: quoted CSV parser and atomic staff import; `lib/rota/words.ts`: input and CSV formula checks; `lib/rota/origin.ts`: configured link origin.
- `lib/email.ts`, `lib/modules.ts`: one platform email module client; no direct vendor calls.
- `lib/roles/http.ts`: bounded same-origin body reader and safe error answers.
- `lib/rota/rota.pg.spec.ts`: real database, role, race, invite, CSV and module-off tests.
- `scripts/walk.mjs`: headless browser journey, owner-pass and access checks; `scripts/fake-door.mjs`: fake platform email.
- `scripts/migrate.mjs`: ordered, digest-checked migrations; `scripts/check-contract.mjs`: product-loop local contract gates.
- `src/db/migrations/0001`–`0004`: unchanged starter tables; `0100-rota.sql`: rota rows and database exclusion lock that refuses overlapping assignments.
- `app/theme.css`, `app/ui.tsx`, `components/pramaan/password-reset/password-panel.tsx`: shared theme and block adaptations.

## Add a field

Add an additive migration numbered after 0100. For example, a shift note belongs on shifts, then in snapshot and the parameterised change query in lib/rota/data.ts, the form in app/rota-screen.tsx and a database test. Keep every query scoped to workspace_id. Keep existing migrations unchanged.

## Add a page

Add app/example/page.tsx and its pramaan.feature.json. Reuse the authenticated API. Check manager or owner on the server for restricted actions; hidden buttons do not grant security. Add the entry point, checklist and browser coverage.

## Add a role

app_users.role stores sign-in roles; workspace_members.role grants workspace access. Only the owner may grant manager. Invitations select the role on the server, never during acceptance. Extend the migration checks, owner invitation controls and lib/rota/access.ts. Reuse requireUser for all reads and requireRole for account role checks; rota membership and row scope must also pass. Add denied and cross-workspace tests.

## Journeys that ship working

create-week, invite-staff, edit-settings, owner-settings, signed-out, password-reset-off, publish-week, approved-swap, open-shift-claim, availability-and-leave.

The headless walk additionally signs in real manager/staff accounts from invitations, exercises multi-account journeys, races two claims, rejects double booking, and inspects downloaded CSV. Email delivery journeys are needs-capability until the platform module is enabled. No live calls in tests.

## Scheduling rules

Weeks start Monday. Shift dates use each location’s time zone, including when copying a week. Repeated or missing clock-change times are refused. Assignment overlap is an exclusion constraint in the database, even for direct SQL. Workspace row locks serialize claims, publishing and approvals; the last claimant receives a conflict. Availability and approved leave produce warnings; a manager may publish despite warnings. Published shift editing is locked. Staff can offer only their own published shifts and cannot approve requests. Requests and availability are personal; published rotas show the team schedule. Hours count elapsed shift hours, including overnight shifts, in the week where the shift starts.

## Local measurement

Local memory values are sampled summed process memory on the development host. They are not container memory claims. Use `CIRCLE_NODE_TOTAL=3 pnpm build` to limit the local build to two workers on a many-core machine without changing the starter configuration. Full container CI runs in product-loop when this repository is pinned. `scripts/measure-draft.mjs` measures development startup on port 3521.
