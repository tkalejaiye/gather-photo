# gather.photo — First-Sprint Runbook

A clean, unambiguous starting point for building the MVP with Claude Code. Read alongside `CLAUDE.md`, `PRD.md`, and `TECH_SPEC.md`. Linear: project **gather.photo**, team **Fringeworks** (issue prefix `FRI`).

---

## 0. Prerequisites (you, ~15 min — needs your accounts)

These can't be done by an agent; they need your credentials.

1. **GitHub** — create a repo (e.g. `fringeworks/gather-photo`) and push this folder (see §1).
2. **Supabase** — create a project in an **EU-West** region (closest practical to Lagos). Grab the project URL, anon key, and service-role key. This *is* issue **FRI-6**.
3. **Paystack** — create an account and copy the **test** public + secret keys (needed for M4; not blocking M0–M3).

---

## 1. One-time local setup

```bash
cd gather-photo

# Push to GitHub
git remote add origin git@github.com:fringeworks/gather-photo.git
git push -u origin main

# Install deps (generates package-lock.json — COMMIT IT; CI uses `npm ci`)
npm install
git add package-lock.json && git commit -m "chore: add lockfile" && git push

# Environment
cp .env.example .env.local      # fill in Supabase + Paystack keys

# Sanity check
npm run dev                     # landing + /e/{slug} stub should serve
```

Apply the schema in `supabase/migrations/0001_init.sql` to your Supabase project (SQL editor or `supabase db push`), and create a **private** Storage bucket named `event-media`.

---

## 2. Launch Claude Code

```bash
cd gather-photo
claude            # auto-loads CLAUDE.md
```

- Connect the **Linear MCP** in Claude Code (`claude mcp add` / your existing connector) so it can read issues and move status.
- Install the `gh` CLI and authenticate (`gh auth login`) so Claude Code can open PRs.
- The repo ships a `spec-reviewer` subagent and an `/implement-issue` skill in `.claude/`.

---

## 3. The per-issue loop

For each issue, in its own session:

```
/implement-issue FRI-<n>
```

That skill runs the team workflow: read the issue → read the referenced PRD/spec sections → explore + plan → implement → run the gate (`typecheck`, `lint`, `build`, `test`) → run the `spec-reviewer` on the diff → commit + open a PR → move the issue to **In Review**.

**Rules of the road**
- **One issue per session.** Run `/clear` before starting an unrelated issue — context hygiene is the biggest quality lever.
- **Verify, don't trust.** Require the gate output / a screenshot as evidence before treating an issue as done.
- **Branch:** `feat/fri-<n>-slug` (or `fix/`, `chore/`). PR description links the issue and lists how each acceptance criterion was verified.

---

## 4. Sprint 1 — goal: the guest happy path works end to end

Target milestones **M0 + M1**. Order (respecting dependencies):

| Order | Issue | Notes |
|---|---|---|
| 1 | **FRI-6** Provision Supabase | You do this in the console (§0.2). Unblocks most others. |
| 2 | **FRI-5** Verify build + CI | Confirms green build; commit the lockfile. |
| 3 | **FRI-10** Compression module | No deps — can run in parallel (own worktree). |
| 4 | **FRI-7** Host auth | After FRI-6. |
| 5 | **FRI-8** Create-event + slug + QR | After FRI-7. |
| 6 | **FRI-9** Guest page shell | After FRI-8. |
| 7 | **FRI-11** Single direct upload + register | After FRI-9, FRI-10, FRI-6. Closes the happy path. |

**Do these with a human in the loop** (review diffs closely): FRI-7 and FRI-8 set patterns the rest copy. FRI-10 and the M2 chain are safe to let run more autonomously, but still review.

**Sprint 1 done when:** a host can create an event, a guest opens the link with no login, picks a photo, and it lands in the host's event. (No offline queue yet — that's Sprint 2.)

---

## 5. Sprint 2 — the critical core (M2)

`FRI-12` (IndexedDB queue) → `FRI-13` (resumable TUS + offline resume) → `FRI-15` (media register + dedupe) → `FRI-14` (progress UI). **Sequential, reviewed.** This is the make-or-break of the whole product (TECH_SPEC §5) — slow down here. The real acceptance test is `FRI-23`: ≥90% of uploads complete under a congested/throttled network.

After M2 + M3 (gallery + ZIP) you can run the **real-event validation test** and collect payment manually — M4 (Paystack) only needs to ship once demand is shown.

---

## 6. Parallelization

Independent issues can run in parallel using git worktrees (e.g. FRI-10 alongside FRI-7). Keep dependent issues sequential. Don't parallelize the M2 chain — those build on each other.

```bash
git worktree add ../gather-photo-fri10 -b feat/fri-10-compression
```

---

## 7. Definition of Done (every issue)
Code + tests for the acceptance criteria · `typecheck` + `lint` + `build` + `test` pass · verification evidence shown · `spec-reviewer` diff review (fix correctness/requirement gaps only) · PR opened linking the Linear issue · issue moved to **In Review**.
