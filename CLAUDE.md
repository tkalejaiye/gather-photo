# gather.photo — project guide for Claude

Read `PRD.md` (product) and `TECH_SPEC.md` (engineering) before starting any issue. They are the source of truth. The single most important property of this product: **guest uploads must survive a congested venue network** (offline queue + resumable TUS). Treat the network as hostile.

## Commands
- Install: `npm install` (run on your machine — the sandbox has no npm registry access)
- Dev: `npm run dev`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Test: `npm run test`

## Conventions
- TypeScript everywhere. Next.js App Router. Tailwind for styling.
- Keep the **guest bundle tiny** — it must load fast on a low-end Android over 3G. Don't add heavy deps to the guest route (`app/e/[slug]`).
- No iOS-only APIs in the guest flow; it must work cross-platform on the web.
- Compression is ON by default before any upload.
- Secrets (Paystack secret key, Supabase service role) are server-side only — never in client code.
- Database access from the client goes through Supabase with RLS; guests never query the DB directly.

## Workflow (per issue)
1. Pick a Linear issue (project: gather.photo). Read its acceptance criteria + verification.
2. Plan first (explore → plan), then implement.
3. Verify: run typecheck, lint, build, and the issue's tests. Show evidence, don't assert.
4. Have a fresh-context reviewer check the diff against `TECH_SPEC.md` (`/code-review` or the `spec-reviewer` subagent). Fix gaps that affect correctness/requirements.
5. Commit with a descriptive message referencing the issue (e.g. `FRI-12: add IndexedDB upload queue`). Open a PR.
6. `/clear` before starting an unrelated issue.

## Branch / PR
- Branch: `feat/<issue-id>-short-slug` (or `fix/`, `chore/`).
- PR description links the Linear issue and lists how each acceptance criterion was verified.

## Gotchas
- Supabase Storage region: pick the one nearest Lagos (EU-West) for latency.
- Don't introduce video transcoding — photos-first per spec §1.
- Paystack amounts are in **kobo** (naira × 100).
