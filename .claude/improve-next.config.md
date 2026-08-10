---
backlog_path: .claude/improvement-backlog.md
rules_glob: .claude/rules/*.md
gate: nvm use 20 >/dev/null 2>&1 && npm test
extra_gates:
  - when: diff touches app/, components/, lib/, next.config.mjs, or package.json
    run: nvm use 20 >/dev/null 2>&1 && npm run build
merge_tool: git
dev_url: http://localhost:3001
dev_restart: npm run dev
---

# Kin — /improve-next project notes & guardrails

Single-user self-hosted family calendar (Next.js 16 App Router + better-sqlite3),
deployed on Coolify. Honor these on every pass:

## Environment / gate
- **Node 20 for all npm/node commands** (`nvm use 20`). Default Node 25 + a broken Xcode
  CLT can't compile the better-sqlite3 native addon. The dev server runs on **:3001**.
- Gate = `npm test` (node --test). The build gate (`npm run build`) is an extra gate when
  app/component/lib/config code changes — it must stay green with `output: 'standalone'`.

## Git / PR
- **No `Co-Authored-By`** in any commit, comment, or PR (user rule).
- **Never self-merge** — a human approves every merge.
- Deploy = `git push origin main` → Coolify auto-deploys **kin.example.com**. Litestream→R2
  backups run *inside* the app container (Dockerfile + docker-entrypoint.sh).
- No GitHub review bots/CI are configured yet — when remote checks are absent, the local
  `requesting-code-review` subagent IS the review gate (Step 6).

## Architecture invariants (don't break without asking)
- **Auth on every API route** via `guard()` + `isAuthed()` → 401. The `proxy.js` cookie gate
  is convenience, not the security boundary.
- **`export const dynamic = 'force-dynamic'`** on every route so Next never evaluates the DB
  at build time.
- **better-sqlite3 is native**: kept out of the bundle via `serverExternalPackages`; `lib/db.js`
  uses an in-memory DB when `NEXT_PHASE === 'phase-production-build'` (build must never touch the
  data volume — this fixed a real SQLITE_BUSY deploy failure). Don't regress either.
- **Migrations: append a new function to the `migrations` array in `lib/migrate.js`** (index+1 =
  user_version). Never edit an existing migration. New-tables-only migrations are safe; table
  rebuilds need a row-count guard + run with FK off (the runner handles this).
- **Validation is server-side** in `lib/validate.js`; all writes are transactions that append an
  audit snapshot (`lib/event-writes.js`, `lib/schedule-writes.js`).
- Cookies are `secure` in production → app must be served over HTTPS.

## Browser-verify (Step 9)
- Cookies are `httpOnly` + `secure`-in-prod. **Never type the password into a login field.**
  To verify authed pages on the **dev** server (`NODE_ENV=development` → non-secure cookie):
  mint a session token via `POST /api/auth/login` on a server whose `APP_PASSWORD`/`AUTH_SECRET`
  you control, then inject it with `document.cookie='tt_session=<value>; path=/'` (the token is a
  signed session value, not a credential). Then navigate the changed route(s), confirm 0 console
  errors, screenshot desktop + 375px.
