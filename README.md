# Staff rota

A small business plans shifts by location, invites managers and staff, publishes weekly rotas, and approves swaps and leave.

Use Node 24.18.0 and pnpm 11.15.1. Install with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`. Set DATABASE_URL, SESSION_SECRET (32 random bytes or more), PRAMAAN_PROJECT_ID and APP_ORIGIN in your runtime; do not commit them. Set APP_COOKIE_SECURE=false only for local HTTP.

Run `node scripts/migrate.mjs`, `pnpm dev --port 3520`. Open as owner through the platform owner pass, then choose your owner email and password. Public signup is disabled. Invite managers and staff from Team. Import staff using Name,Email CSV; imported rows need invites before sign-in.

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `CIRCLE_NODE_TOTAL=3 pnpm build`, `node scripts/check-contract.mjs`. Tests require a dedicated migrated database; `node scripts/walk.mjs` uses a dedicated migrated database and headless browser. Test accounts are removed after the suite. The walk creates its own records and is intended only for a disposable database.

Email goes through the platform module socket, never directly to an outside service. When off, the screen gives invite links to pass on and states notices were not delivered. See KIT.md for the code map and .scratch/KIT-DONE.md for local handoff evidence.

The kit carries no browser tools. To run `node scripts/walk.mjs`, install `@playwright/test` 1.64.1 outside the kit and set `WALK_BROWSER_MODULE` to its `index.mjs`.
