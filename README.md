# gather.photo

Collect every photo and video your guests capture at an event — one QR code, no app, no login. Built Lagos-first (offline-resilient uploads, low-end Android, Paystack, WhatsApp sharing).

## Docs
- [`PRD.md`](./PRD.md) — product requirements
- [`TECH_SPEC.md`](./TECH_SPEC.md) — engineering design (source of truth)
- [`CLAUDE.md`](./CLAUDE.md) — how to work in this repo

## Stack
Next.js (App Router, PWA) · Supabase (Postgres/Auth/Storage) · TUS resumable uploads · Paystack · Tailwind · TypeScript.

## Getting started
```bash
npm install
cp .env.example .env.local   # fill in Supabase + Paystack keys
npm run dev
```
Apply the DB schema in `supabase/migrations/0001_init.sql` to your Supabase project.

## Project tracking
Work is tracked in Linear (project: **gather.photo**, team: Fringeworks), broken into milestones M0–M5 (see `TECH_SPEC.md` §11). Each issue carries its own acceptance criteria and verification steps.
