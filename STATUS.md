# Envoy — Project Status

Multi-tenant SaaS for deploying branded, rule-governed AI chat and voice agents on client websites. pnpm/Turborepo monorepo, 16 commits (Aug–Sep 2026).

> Based on the README, module layout and uncommitted diff. Tests were not run and README claims were not verified against code.

## What's built

### API (`apps/api`, NestJS)
Modules: account, admin, agent, billing, crm, forms, integrations, leads, pipeline, routing, health. JWT auth with tenant-scope, role, feature and lock guards.

- **Agent engine**
  - LLM providers: mock (default), Groq, Gemini
  - Two-layer hard-rule enforcement (prompt + judge pass that blocks violations before the visitor sees them)
  - Per-turn required-field capture with validation
  - Raw WebSocket conversations, Redis session state
  - BullMQ pipeline for transcripts and AI summaries after completion
- **Voice:** STT/TTS (mock, Groq Whisper, Gemini). Single-shot utterances, not streaming.
- **Billing:** Stripe webhook state machine active → past_due → locked → active; overage and checkout handling.
- **CRM / integrations:** HubSpot (mock mode available), AES-encrypted tokens, async retryable pushes, field mapping; generic integrations module with senders.
- **Forms & leads:** form builder (`packages/builder`) and public form submissions.
- **Account:** retention jobs, email verification, password reset.

### Frontends
- **Portal (`apps/portal`):** login, register, forgot/reset password, verify email; agents (new/detail), conversations, forms, leads, CRM, integrations, billing, settings.
- **Admin console (`apps/admin`):** tenants (pause/resume/revoke), pricing, per-user feature access, audit log, jobs.
- **Widget (`apps/widget`):** Preact chat in an iframe, vanilla-JS loader, demo page.
- **Landing (`apps/landing`):** static marketing site.

### Packages
`db` (Prisma, 12 models, 12 migrations), `types` (Zod contracts), `sdk` (typed fetch client), `builder`, `ui`, `config`.

### Tests
~151 test files, mostly API e2e tests against real Postgres/Redis. Key ones: tenant isolation (`agents.service.isolation.test.ts`), agent engine (`agent-engine.e2e.test.ts`), billing/admin, CRM, voice.

## What's happening now
- Last commits: "landing page", "correcting UI", several "closing gaps" — focus has shifted from backend features to UI polish.
- **Uncommitted (7 files, +64/−10):**
  - Theme toggle emoji (☀/☾) replaced with SVG `SunIcon`/`MoonIcon` in admin and portal
  - Sign-out icon + footer layout in portal sidebar
  - Small accent colour tweaks in CSS

## Gaps / risks
- **Not live-tested:** Stripe, HubSpot, Groq/Gemini — code-complete, exercised only via mocks.
- **Not built:** mobile app (Expo not scaffolded); streaming audio, hold-to-talk, Web Speech fallback.
- **README out of date:** says `packages/ui` is "not yet built" (it has a `src` folder); doesn't cover landing, forms, leads, integrations, routing.
- **Test env:** API tests load remote Neon + Upstash env by default — override all env vars to test locally.
