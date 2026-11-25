# Envoy — Project Details (FYP Source Document)

> Master reference for deriving other FYP documents (SRS, SDD, proposal, final report, test plan, user manual, presentation). Written from the actual codebase, README and Prisma schema. Sections marked **[Verify]** are things to confirm or fill in yourself (course name, supervisor, team, dates, evaluation results).

---

## 1. Project Identity

| Item | Detail |
|---|---|
| **Name** | Envoy |
| **One-line description** | A multi-tenant SaaS platform that lets businesses deploy branded, rule-governed AI chat and voice agents on their own websites, capture structured lead data from conversations, and route it into their CRM and other tools. |
| **Type** | Web platform (SaaS), B2B |
| **Repository** | pnpm + Turborepo monorepo, TypeScript throughout |
| **Development period** | Aug 2026 – Sep 2026 (16 commits, first 2026-08-19 migration) |
| **Student / supervisor / university** | **[Verify]** |

---

## 2. Problem Statement

Small and mid-size businesses lose leads because their websites cannot hold a qualifying conversation outside working hours, and generic chatbots have three weaknesses:

1. **Uncontrolled output.** A plain LLM chatbot may promise refunds, quote prices, or say things the business never approved.
2. **Unstructured results.** A chat transcript is not a lead. Staff still have to read it and re-type details into a CRM.
3. **Operator burden.** Platform providers have no safe way to host many businesses, meter usage, bill them, and switch features or access on and off per customer.

## 3. Proposed Solution

Envoy gives each business (a **tenant**) a portal where, without writing code, they:

- define an **agent** (script, required data fields, hard rules, widget appearance),
- publish it and paste a one-line **embed snippet** into their site,
- let visitors converse by **text or voice**,
- receive **structured captured data**, a transcript and an AI summary,
- have that data **automatically pushed** to a CRM, Google Calendar, email or a webhook.

A separate **operator (admin) console** lets the platform owner manage tenants, pricing, per-user feature access, billing locks, and an audit trail.

## 4. Objectives

1. Build a multi-tenant platform with strict tenant data isolation.
2. Build an agent engine that collects typed, validated fields and never lets a hard-rule violation reach the visitor.
3. Provide an embeddable, iframe-isolated widget with text and voice.
4. Provide usage-based billing with an automatic lock/unlock lifecycle.
5. Provide an operator console with per-feature access control and a full audit log.
6. Route captured data to external systems asynchronously, without slowing the visitor.
7. Make every external dependency (LLM, STT/TTS, CRM, Stripe, email, calendar) swappable and runnable in a no-credentials "mock" mode so the full system is demoable and testable offline.
8. **(Next phase, section 17)** Evolve the engine from a single-pass chatbot into a deeply configurable agent runtime: goals, tool calling, knowledge and memory, and a harness (guardrails, tracing, evaluation, self-improvement) that keeps autonomous agents safe, measurable and continuously improving.

## 5. Scope

### In scope (built)
Agent builder, conversation engine, widget (text + voice), lead/conversation dashboard, custom form builder, CRM + integrations routing, billing and lock engine, admin console, authentication and account management, marketing landing site.

### Out of scope / deferred
- Mobile app (Expo) — not scaffolded.
- Streaming (chunked) audio; hold-to-talk; Web Speech API fallback.
- Live verification of Stripe, HubSpot, Groq, Gemini (code-complete; exercised through mocks only).
- Setting `Conversation.channel = "voice"` automatically (field exists; voice chats still record as `chat`).

---

## 6. Stakeholders and Users (Actors)

| Actor | Role in system | Access |
|---|---|---|
| **Visitor** | Anonymous end user of a client's website; chats with the agent or fills a form | Public widget, public form pages (no login) |
| **Tenant Owner** (`owner`) | Business account holder; full control of its workspace, billing, account deletion | Portal |
| **Tenant Staff** (`staff`) | Team member of a tenant | Portal, limited by per-user feature flags |
| **Platform Admin** (`platform_admin`) | Operator of the whole SaaS | Admin console only; created through a bootstrap-secret-gated endpoint, no public signup |
| **External systems** | Stripe, HubSpot, Google Calendar, Resend (email), Groq, Gemini, tenant webhooks | Server-to-server |

---

## 7. System Architecture

### 7.1 Monorepo layout

```
apps/
  api/       NestJS backend: REST + WebSocket + BullMQ workers          (port 4000)
  portal/    Tenant web portal (Next.js 15, React 19)                    (port 3001)
  admin/     Operator console (Next.js 15, React 19)                     (port 3002)
  landing/   Static marketing site (Next.js 15)                          (port 3000)
  widget/    Embeddable chat widget (Vite + Preact) + vanilla-JS loader  (port 5173)
packages/
  db/        Prisma schema + generated client       (@envoy/db)
  types/     Zod contracts shared by all surfaces   (@envoy/types)
  sdk/       Typed fetch client for portal + admin  (@envoy/sdk)
  builder/   Block/form builder UI component        (@envoy/builder)
  ui/        Shared UI package (currently empty src)
  config/    Shared tsconfig
```

### 7.2 Technology stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node ≥ 22) |
| Backend | NestJS 10, raw `ws` WebSocket server, class-less Zod validation pipes |
| Database | PostgreSQL 16 via Prisma ORM (12 migrations) |
| Cache / queue | Redis 7, ioredis, BullMQ 5 |
| Web apps | Next.js 15 (App Router), React 19 |
| Widget | Preact 10, Vite 5 |
| Validation / contracts | Zod 3 (single source of truth shared client ↔ server) |
| Payments | Stripe 17 |
| Email | Resend |
| AI | Groq (LLM + Whisper STT), Google Gemini (LLM + TTS), Mock providers |
| Testing | Vitest (+ `unplugin-swc` for Nest DI), ~151 test files |
| Tooling | pnpm 10 workspaces, Turborepo, Docker Compose (Postgres + Redis) |

### 7.3 Logical architecture

```
 Visitor's browser                         Envoy platform                              External
 ┌──────────────────┐   loader.js    ┌────────────────────────────┐
 │ Client website   │──── iframe ───▶│ Widget (Preact)            │
 └──────────────────┘                └──────────┬─────────────────┘
                                                │ WebSocket /ws/agent/:agentId
                                     ┌──────────▼─────────────────┐   ┌─────────────┐
                                     │ API (NestJS)               │──▶│ LLM / STT / │
 Tenant ──▶ Portal (Next.js) ──REST─▶│  Auth · Guards · Agents    │   │ TTS provider│
 Admin  ──▶ Admin  (Next.js) ──REST─▶│  Conversation engine       │   └─────────────┘
                                     │  Rule enforcer · Extractor │
                                     │  Billing · Admin · Forms   │──▶ Stripe
                                     └───┬───────────┬────────────┘
                                         │           │ enqueue
                                  ┌──────▼───┐  ┌────▼─────────────────┐
                                  │PostgreSQL│  │ Redis (sessions +    │
                                  │ (Prisma) │  │ BullMQ queues)       │
                                  └──────────┘  └────┬─────────────────┘
                                                     │ workers
                          Pipeline (transcript+summary) · CRM push · Integrations push
                                                     │──▶ HubSpot · Google Calendar · Email · Webhook
```

### 7.4 Key architectural decisions (use these as "Design Rationale" in the report)

1. **Shared Zod contracts (`@envoy/types`).** The same schema validates in the builder UI, the public renderer, and the server, so what the UI hides is also skipped by the server.
2. **Provider abstraction + mock default.** LLM, STT, TTS, CRM, email and calendar each sit behind an interface with a deterministic mock, selected by environment variable. The system is fully demoable with zero API keys.
3. **Non-streaming agent replies.** A reply is generated, judged for rule violations, and only then sent. A token that already violated a rule cannot be retracted, so streaming to the visitor was rejected.
4. **Async side effects.** Transcript/summary generation, CRM push and integrations push run on BullMQ queues after completion, so a slow third-party API never blocks the visitor.
5. **Centralised lock enforcement.** A locked tenant only flips `Tenant.subscriptionStatus`; no agent rows are mutated. Enforcement lives in two places: `TenantLockGuard` (HTTP 423) and the WebSocket session-start check.
6. **Per-user, live feature gating.** `FeatureAccess` is stored on the `User` and checked on every request, not embedded in the JWT, so admin changes take effect immediately.
7. **Separate Redis connections** for session state and BullMQ (avoids BullMQ's blocking-connection problem).
8. **Raw `ws` instead of Nest `@WebSocketGateway`**, because the latter is socket.io-shaped and does not map cleanly to a path-parameterised route.

---

## 8. Functional Requirements

Use the IDs below directly in an SRS.

### 8.1 Authentication and Account (FR-AUTH)
- **FR-AUTH-1** Tenant registration creates a tenant, an `owner` user and a subscription.
- **FR-AUTH-2** Email/password login issues a short-lived JWT access token and a rotating refresh token in an httpOnly cookie.
- **FR-AUTH-3** Refresh tokens are stored only as SHA-256 hashes, rotated on each use; reuse of an already-rotated token (past a grace period) revokes all of that user's sessions (theft detection).
- **FR-AUTH-4** Sessions are scoped (`portal` vs `admin`) with separate cookies; a forged cookie under the wrong scope fails at the DB.
- **FR-AUTH-5** Password reset and email verification use single-use, expiring, hashed tokens.
- **FR-AUTH-6** The first `platform_admin` is minted only via `POST /auth/register-admin` gated by `ADMIN_BOOTSTRAP_SECRET`.
- **FR-AUTH-7** Account owner can view, export (data portability) and delete the account.
- **FR-AUTH-8** A retention job purges data per retention policy.

### 8.2 Agent Management (FR-AGENT)
- **FR-AGENT-1** Create / list / view / update agents (`draft`, `live`, `paused`).
- **FR-AGENT-2** Each agent has a script (system prompt), up to 50 required fields, up to 50 hard rules, and a widget config.
- **FR-AGENT-3** Required-field types: `text`, `email`, `phone`, `number`, `date`, `select`, `boolean`; keys must be identifiers; `select` needs ≥1 option.
- **FR-AGENT-4** Hard rules have `action` (`block` / `escalate`) and `severity` (`low` / `medium` / `high`).
- **FR-AGENT-5** Widget config: primary colour, logo, position (bottom-right/left), greeting, launcher label, theme (light/dark/auto), up to 6 quick replies. Edits go live without redeploy.
- **FR-AGENT-6** Each agent has a unique `publicToken` used by the embed snippet.
- **FR-AGENT-7** An agent may attach a lead form that the widget shows inline (form must be same tenant and `live`).
- **FR-AGENT-8** The public endpoint `GET /agents/public/:publicToken` returns widget config, voice-enabled flag and lead form for the widget.

### 8.3 Conversation Engine (FR-CONV)
- **FR-CONV-1** Visitor connects over WebSocket to `/ws/agent/:agentId` and sends `session.start` with the public token.
- **FR-CONV-2** The engine builds a prompt from a stable prefix (script + fields + rules, cacheable) and a volatile suffix (data captured so far).
- **FR-CONV-3** Each turn runs a separate extraction pass; every value is validated against its field-type schema before merging into `capturedData`.
- **FR-CONV-4** **Two-layer rule enforcement:** (1) rules injected into the prompt; (2) a post-generation judge checks the candidate reply before sending. A `block` violation triggers one regeneration with feedback, then a safe generic fallback. Every violation is logged to `ruleViolationsBlocked`.
- **FR-CONV-5** Completion is detected via a model-emitted marker which is stripped before display; the visitor receives `session.completed` with captured data.
- **FR-CONV-6** A locked or paused tenant's agent rejects new sessions (`locked` message); in-flight conversations finish.
- **FR-CONV-7** Live session state is held in Redis.
- **FR-CONV-8** Captured data is sanitised before storage.

### 8.4 Voice (FR-VOICE)
- **FR-VOICE-1** The widget records one utterance (tap to start / tap to stop), sends it as base64 over the existing WebSocket.
- **FR-VOICE-2** Server runs STT, sends a `transcript` message, feeds the text to the same engine, runs TTS, returns `agent.audio` (WAV).
- **FR-VOICE-3** Voice is gated per tenant by the `voice` add-on in `priceConfig`; the mic button only renders when enabled.
- **FR-VOICE-4** Gemini's raw 24 kHz / 16-bit / mono PCM is wrapped in a WAV header server-side.

### 8.5 Post-Conversation Pipeline (FR-PIPE)
- **FR-PIPE-1** After completion a BullMQ job assembles the transcript and generates an AI summary, with retries; a permanent failure sets `aiSummaryError`.
- **FR-PIPE-2** `CaptureRoutingService` fans captured data out to the CRM and every enabled integration, one queue job each, so one failure never blocks the others.
- **FR-PIPE-3** Each push records its outcome (`crmPushedAt`, `crmExternalId`, `crmPushError`, `integrationStatus`) and can be manually retried from the portal.

### 8.6 CRM and Integrations (FR-INT)
- **FR-INT-1** HubSpot CRM connection (OAuth, or instant mock connect when no client ID is set); tokens are AES-256-GCM encrypted at rest (`iv:authTag:ciphertext`).
- **FR-INT-2** Tenant-editable field mapping from agent field keys to CRM property names; unmapped keys pass through.
- **FR-INT-3** Integrations: `calendar` (Google Calendar event), `email` (Resend), `webhook` (tenant URL). One per type per tenant; enable/disable and per-type config.
- **FR-INT-4** Tenant-supplied URLs (webhooks, API-sourced dropdowns) are blocked from resolving to private/loopback addresses (SSRF protection, `safe-fetch`).
- **FR-INT-5** CRM and integrations are gated by the `crm` and `integrations` feature flags (off by default).

### 8.7 Custom Forms (FR-FORM)
- **FR-FORM-1** Tenants build multi-step, conditional lead forms.
- **FR-FORM-2** Field types: text, textarea, email, phone, number, date, select, radio, checkbox, multiselect, file, hidden, content.
- **FR-FORM-3** Conditional visibility with `all`/`any` rules over operators `equals`, `not_equals`, `contains`, `gt`, `lt`, `is_empty`, `is_not_empty`.
- **FR-FORM-4** Dropdown options may come from a tenant API via a server-side proxy (dependent dropdowns with `{{fieldKey}}` placeholders); API headers/keys never reach the browser.
- **FR-FORM-5** Hidden fields populate from URL query params (e.g. UTM) with a default.
- **FR-FORM-6** File upload with a ~1.5 MB cap. Regex validation uses `safe-regex` to prevent ReDoS.
- **FR-FORM-7** Public form pages at `/f/:token`; submissions are validated server-side with the same schema and routed through the same CRM/integrations path.
- **FR-FORM-8** View, delete and CSV-export submissions.

### 8.8 Leads and Conversations Dashboard (FR-DASH)
- **FR-DASH-1** Conversation list and detail (captured data, transcript, AI summary, rule violations, CRM/integration status).
- **FR-DASH-2** Conversation and lead statistics.
- **FR-DASH-3** Unified **Leads** feed merging completed conversations and form submissions, newest first.
- **FR-DASH-4** Export, gated by the `export` feature flag.

### 8.9 Billing (FR-BILL)
- **FR-BILL-1** Each tenant has a subscription: monthly rate, per-conversation overage rate, included conversations, billing-cycle day (all money in integer cents).
- **FR-BILL-2** Stripe Checkout and Customer Portal sessions.
- **FR-BILL-3** Webhook state machine: `invoice.payment_failed` → `past_due` (grace); second failure → `locked`; `invoice.paid` → `active` instantly.
- **FR-BILL-4** Webhook signature verification when `STRIPE_WEBHOOK_SECRET` is set; unsigned payloads accepted only in local dev.
- **FR-BILL-5** Usage reporting and overage billing; `lastOverageBilledCycleEnd` prevents double-billing in one cycle.
- **FR-BILL-6** Every tenant gets a `local_<tenantId>` stand-in Stripe customer ID so lock/unlock is testable without Stripe.
- **FR-BILL-7** The portal shows a global banner when the tenant is locked.

### 8.10 Operator Console (FR-ADMIN)
- **FR-ADMIN-1** Tenant list, detail and statistics.
- **FR-ADMIN-2** Pause, resume, soft-revoke (row never deleted) and hard-delete a tenant.
- **FR-ADMIN-3** Edit per-tenant pricing (`PriceConfig`: currency, base monthly, per-conversation rate, included conversations, add-ons for CRM and voice).
- **FR-ADMIN-4** Toggle per-user feature access: `conversations`, `crm`, `recordings`, `export`, `voice`, `integrations`, `forms`.
- **FR-ADMIN-5** Trigger overage billing for a tenant.
- **FR-ADMIN-6** Audit log of every mutating admin action, attributed to the acting admin.
- **FR-ADMIN-7** Failed background-job inspector with retry (`/admin/jobs`).

### 8.11 Landing Site (FR-LAND)
- **FR-LAND-1** Static marketing page that links into the portal's `/register` and `/login`; portal URL from `NEXT_PUBLIC_PORTAL_URL`.

### 8.12 UX (FR-UX)
Light/dark theme toggle in portal and admin (follows OS by default), responsive sidebar, toast confirmations, `aria-current` navigation, widget "thinking" indicator.

---

## 9. Non-Functional Requirements

| ID | Category | Requirement / how it is met |
|---|---|---|
| NFR-1 | **Security: tenant isolation** | `TenantScopeGuard` + tenant-scoped queries; proven by `agents.service.isolation.test.ts` against a real Postgres (tenant A cannot read, list or mutate tenant B). |
| NFR-2 | **Security: auth** | Hashed passwords (bcrypt), hashed refresh/verification tokens, rotating sessions with theft detection, role guard, per-app cookie scope, rate limiting. |
| NFR-3 | **Security: secrets at rest** | OAuth tokens AES-256-GCM encrypted. |
| NFR-4 | **Security: SSRF/ReDoS/XSS** | `safe-fetch`, `safe-regex`, `sanitize-captured-data`, signed OAuth state. |
| NFR-5 | **Safety** | Hard rules enforced twice; violations never reach the visitor and are auditable. |
| NFR-6 | **Performance** | Slow work off the request path via queues; stable prompt prefix allows provider-side caching. |
| NFR-7 | **Reliability** | Queue retries, recorded failure state, manual retry, failed-job inspector, health endpoint. |
| NFR-8 | **Extensibility** | Provider interfaces; closed, central enums for feature keys and field types. |
| NFR-9 | **Testability** | Mock providers; e2e tests boot the real Nest app and drive real WebSockets. |
| NFR-10 | **Embeddability** | Iframe isolation, dependency-free loader, correct `allow="microphone"` delegation. |
| NFR-11 | **Privacy / compliance** | Account export and deletion, retention job, soft-revoke with audit trail. |
| NFR-12 | **Accessibility** | `aria-current`, focus-visible styles, theme support. |
| NFR-13 | **Auditability** | Every admin mutation recorded with admin ID. |

---

## 10. Data Model (Prisma / PostgreSQL)

**Tables:** `tenants`, `users`, `sessions`, `verification_tokens`, `agents`, `conversations`, `crm_connections`, `integrations`, `forms`, `form_submissions`, `subscriptions`, `audit_logs`.

**Enums:** SubscriptionStatus (`active`, `past_due`, `locked`, `cancelled`), UserRole (`owner`, `staff`, `platform_admin`), AgentStatus (`draft`, `live`, `paused`), ConversationChannel (`chat`, `voice`), ConversationStatus (`in_progress`, `completed`, `abandoned`), OutcomeType (`demo_booking`, `order`, `complaint`, `appointment`), CrmProvider (`hubspot`), IntegrationType (`calendar`, `email`, `webhook`), FormStatus (`draft`, `live`), SessionScope (`portal`, `admin`), VerificationPurpose (`password_reset`, `email_verify`).

### Entities and key fields

| Entity | Key fields | Relations |
|---|---|---|
| **Tenant** | name, industry, subscriptionStatus, `priceConfig` (JSON) | 1—N users, agents, conversations, forms, submissions, integrations, CRM connections, audit logs; 1—1 subscription |
| **User** | email (unique), passwordHash, emailVerifiedAt, role, `featureAccess` (JSON); `tenantId` nullable for platform admins | N—1 tenant; 1—N sessions, verification tokens, audit logs |
| **Session** | tokenHash (unique), appScope, expiresAt, rotatedAt, revokedAt | N—1 user |
| **VerificationToken** | tokenHash, purpose, expiresAt, usedAt | N—1 user |
| **Agent** | name, status, script, `requiredFields`, `hardRules`, `widgetConfig` (JSON), `publicToken` (unique), `leadFormId` | N—1 tenant; N—1 form (optional); 1—N conversations |
| **Conversation** | channel, status, outcomeType, `capturedData`, transcriptText, aiSummary, aiSummaryError, `ruleViolationsBlocked`, recordingUrl, crmPushedAt/ExternalId/Error, `integrationStatus` | N—1 agent, N—1 tenant |
| **CrmConnection** | provider, encrypted `oauthTokens`, `fieldMapping` | unique (tenant, provider) |
| **Integration** | type, `config`, encrypted `oauthTokens`, enabled | unique (tenant, type) |
| **Form** | name, status, `schema` (JSON, FormSchema), `publicToken` | 1—N submissions, 1—N agents |
| **FormSubmission** | `data`, CRM push fields, `integrationStatus` | N—1 form, N—1 tenant |
| **Subscription** | status, monthlyRate, usageRate, includedConversations, billingCycleDay, Stripe IDs, lastOverageBilledCycleEnd, lockedAt, unlockedAt | 1—1 tenant |
| **AuditLog** | adminUserId, tenantId?, action, `meta` | N—1 user, N—1 tenant |

All tenant-owned tables cascade on tenant delete, except `AuditLog.tenantId` which is set to null to preserve history.

---

## 11. API Reference (REST + WebSocket)

Base URL `http://localhost:4000`. Guards: JWT auth on all non-public routes; `TenantLockGuard` returns **423** for locked tenants (billing and admin exempt); `@RequireFeature(x)` returns **403** if the user lacks the flag.

| Area | Endpoints |
|---|---|
| **Auth** | `POST /auth/register`, `/login`, `/register-admin`, `/refresh`, `/logout`, `/password-reset/request`, `/password-reset/confirm`, `/verify-email/request`, `/verify-email/confirm` |
| **Account** (owner) | `GET /account`, `GET /account/export`, `DELETE /account` |
| **Agents** | `POST /agents`, `GET /agents`, `GET /agents/:id`, `PATCH /agents/:id`; public `GET /agents/public/:publicToken` |
| **Conversations** | `GET /conversations`, `GET /conversations/stats`, `GET /conversations/:id`, `POST /conversations/:id/complete` |
| **Leads** | `GET /leads`, `GET /leads/stats` |
| **Forms** (flag `forms`) | `GET/POST /forms`, `POST /forms/options/test`, `GET/PATCH/DELETE /forms/:id`, `GET /forms/:id/submissions`, `GET /forms/:id/submissions/export`, `DELETE /forms/:id/submissions/:submissionId` |
| **Public forms** | `GET /public/forms/:token`, `POST /public/forms/:token/submit`, `POST /public/forms/:token/options/:fieldKey` |
| **CRM** (flag `crm`) | `GET /crm/connection`, `POST /crm/connect`, `PATCH /crm/mapping`, `DELETE /crm/connection`, `POST /crm/push/:conversationId`, `POST /crm/push/submission/:submissionId`, `GET /crm/callback` |
| **Integrations** (flag `integrations`) | `GET /integrations`, `POST /integrations/{webhook,email,calendar}/connect`, `PATCH /integrations/:type/config`, `DELETE /integrations/:type`, `POST /integrations/:type/push/:conversationId`, `POST /integrations/:type/push/submission/:submissionId`, `GET /integrations/calendar/callback` |
| **Billing** | `GET /billing/subscription`, `POST /billing/checkout`, `POST /billing/portal`, `GET /billing/usage`, `POST /webhooks/stripe` |
| **Admin** (`platform_admin`) | `GET /admin/tenants`, `/tenants/stats`, `/tenants/:id`; `PATCH /admin/tenants/:id/{pause,resume,pricing}`; `POST /admin/tenants/:id/bill-overage`; `DELETE /admin/tenants/:id` (soft) and `/hard`; `PATCH /admin/tenants/:id/users/:uid/access`; `GET /admin/audit-log`; `GET /admin/jobs/failed`; `POST /admin/jobs/:queue/:id/retry` |
| **Health** | `GET /health` |

### WebSocket protocol (`/ws/agent/:agentId`, defined in `@envoy/types/ws`)

| Direction | Message | Purpose |
|---|---|---|
| Client → Server | `session.start {agentId, publicToken}` | Begin session |
| | `user.message {text ≤ 4000}` | Text turn |
| | `user.audio {chunk(base64), mimeType}` | One full voice utterance |
| Server → Client | `session.ready {widgetConfig}` | Session accepted |
| | `agent.message {text/delta, done}` | Agent reply |
| | `agent.audio {chunk, mimeType}` | Synthesised reply |
| | `transcript {text}` | What STT heard |
| | `session.completed {outcomeType?, capturedData}` | Conversation finished |
| | `locked {message}` | Tenant locked |
| | `error {message}` | Failure |

---

## 12. Key Workflows (for sequence diagrams)

### 12.1 Tenant onboarding
Register → tenant + owner + subscription created (`local_<id>` Stripe stand-in) → email verification → login → portal dashboard.

### 12.2 Create and publish an agent
Portal → *New agent* → script, required fields, hard rules, widget style → save as `draft` → set `live` → copy embed snippet containing `publicToken`.

### 12.3 Visitor conversation (core flow)
1. Loader injects iframe → widget fetches public config.
2. WebSocket `session.start` → server checks agent is live and tenant not locked → `session.ready`.
3. For each `user.message`: build prompt → LLM generates candidate → judge checks hard rules → (regenerate once on `block`) → send `agent.message`; extractor updates `capturedData` (validated per field type).
4. Completion marker → `session.completed`.
5. Async: pipeline job (transcript + summary) and routing fan-out to CRM/integrations.

### 12.4 Voice turn
`user.audio` → STT → `transcript` message → same engine call as a text turn → TTS → `agent.audio`.

### 12.5 Billing lock/unlock
`invoice.payment_failed` → `past_due`; second failure → `locked` (HTTP 423, WS `locked`); `invoice.paid` → `active` immediately.

### 12.6 Admin governance
Admin login → open tenant → pause / edit pricing / toggle a user's feature → action written to `AuditLog` with the admin's ID.

### 12.7 Form submission
Visitor opens `/f/:token` → multi-step conditional form → submit → server re-validates with the shared schema → stored → routed to CRM + integrations.

---

## 13. Frontend Pages

**Portal (`:3001`)**: `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/f/[token]` (public form), `/dashboard` (overview), `/dashboard/agents/new`, `/dashboard/agents/[id]` (configure, embed snippet), `/dashboard/conversations`, `/dashboard/conversations/[id]`, `/dashboard/leads`, `/dashboard/forms`, `/dashboard/forms/[id]`, `/dashboard/crm`, `/dashboard/integrations`, `/dashboard/billing`, `/dashboard/settings`.

**Admin (`:3002`)**: `/login`, `/` , `/tenants`, `/tenants/[id]`, `/audit-log`, `/jobs`.

**Landing (`:3000`)**: single marketing page.

**Widget (`:5173`)**: chat UI (`Widget.tsx`), `loader.js` (what clients embed), `demo.html`.

---

## 14. Testing and Verification

- **Framework:** Vitest; ~151 test files, mostly API e2e tests that boot the real Nest app against real Postgres and Redis.
- **Load-bearing tests:**
  - `agents.service.isolation.test.ts` — tenant isolation.
  - `agent-engine.e2e.test.ts` — full WS conversation, field collection, completion, async persistence; hard-rule block never reaches visitor.
  - `billing-and-admin.e2e.test.ts` — 12 assertions on lock/unlock chain and the admin surface (including 403 for non-admin).
  - `crm.e2e.test.ts` — connect, mapping, auto-push, manual re-push, 403 without feature.
  - `voice.e2e.test.ts` — audio in → transcript, reply and WAV out.
  - Also: auth, password reset, account, forms, leads, integrations, health, public agents, admin jobs, subscription webhook, billing cycle/usage/checkout, token crypto, safe-fetch, OAuth state, hubspot provider, pipeline processor, shared-type schema tests, builder tests.
- **Manual / browser verification (real headless Chrome):** register through the portal → build and publish an agent → converse via the widget → see captured data, transcript and summary in the portal; admin pause/resume with a live 423 check; CRM mock connect and auto-push; voice with a fake microphone device.
- **Known test-infra limitation:** e2e files each start their own BullMQ worker on shared queue names, which can log harmless Prisma errors under concurrent runs; tests never fail from it.
- **Environment note:** API tests default to remote Neon + Upstash env values; override all env vars to run locally.

---

## 15. Setup and Deployment

```bash
cp packages/db/.env.example packages/db/.env
cp apps/api/.env.example apps/api/.env
docker compose up -d        # Postgres 16 :5432, Redis 7 :6379
pnpm install
pnpm db:migrate
pnpm dev                    # landing :3000, portal :3001, admin :3002, api :4000, widget :5173
```

**Environment switches (all default to mock):** `LLM_PROVIDER` (mock/groq/gemini), `STT_PROVIDER` (mock/groq), `TTS_PROVIDER` (mock/gemini), `CRM_PROVIDER` (mock/hubspot). Secrets: `JWT_ACCESS_SECRET`, `CRM_TOKEN_ENCRYPTION_KEY`, `ADMIN_BOOTSTRAP_SECRET`, `STRIPE_*`, `HUBSPOT_*`, `GOOGLE_*`, `RESEND_*`, `GROQ_*`, `GEMINI_*`, `CORS_ORIGINS`, `PORTAL_URL`.

**Production notes:** refresh cookies become `Secure` under `NODE_ENV=production`; unsigned Stripe webhooks are rejected in production; landing deploys as an independent static project.

---

## 16. Engineering Lessons Learned (good material for the report's "Challenges" chapter)

1. **esbuild breaks Nest DI.** `emitDecoratorMetadata` is not implemented by esbuild, so injected providers silently become `undefined`. Fix: real `tsc` for dev/build and `unplugin-swc` for Vitest.
2. **`@UsePipes` applies to every decorated parameter**, validating the JWT payload against the body schema. Fix: attach the pipe to `@Body(pipe)` only.
3. **Void Nest handlers return 200 with an empty body**, and `res.json()` threw, silently breaking admin buttons. Found only by browser testing; fixed in the SDK.
4. **Next.js `next build` validates `layout.tsx` exports strictly**; helper exports pass in dev but fail production builds.
5. **Module resolution differs by runtime:** NodeNext (API) needs `.js` suffixes; bundler resolution (Next/Vite) needs extensionless imports.
6. **Iframe microphone delegation:** `allow="microphone"` is required on the embed iframe; caught before the first browser test.
7. **Gemini TTS returns headerless PCM**, wrapped into WAV server-side.
8. **Streaming vs safety trade-off:** non-streaming replies chosen so rule violations can be intercepted.

---

## 17. Limitations and Future Work

**Limitations**
- Stripe, HubSpot, Groq and Gemini are code-complete but untested against live accounts.
- Voice is single-utterance, not real-time streaming.
- Voice conversations are recorded with channel `chat`.
- `packages/ui` is empty; portal and admin use their own components/styles.
- CRM supports HubSpot only (Zoho was dropped in a later migration).
- The leads feed uses a growing `limit` instead of a true cursor across two sources.
- **Model choice is only partly per tenant.** LLM calls can now use a tenant's own key and model (section 17.5.0). Voice (STT/TTS) is still a single process-wide provider chosen by env vars, using the platform's keys.
- **The agentic runtime is only partly built.** Agents can now run in `agentic` mode (section 17.1.0 lists what exists). Still missing: calendar and CRM tools, custom HTTP tools, knowledge/RAG, long-term memory, multi-agent routing, the scenario/evaluation harness, visitor- and staff-confirmation approval modes, and a live simulator. Classic mode (one completion per turn) remains the default and the evaluation baseline.

**Future work**

### 17.1 Planned direction: Deep Agentic Runtime and Harness Engineering (core of the project's next phase)

**Where we are.** Today an Envoy agent is a configurable *form-filling chatbot*. Its whole behaviour is: a script, a list of required fields, a list of hard rules and a widget skin. The engine is a single pass per turn (generate, judge, extract). That is reliable and safe, but shallow: the agent cannot *do* anything, cannot pursue a goal beyond "collect these fields", and cannot adapt its strategy.

**Where we are going.** Turn the engine into a general **agent runtime** and the portal into an **agent studio**, so a tenant can configure *what an agent is trying to achieve, what it is allowed to do, what it knows, and how it behaves*, and the platform guarantees it does so safely. The engineering focus of the project becomes the **harness**: everything around the model that makes an agent dependable (loop, tools, state, guardrails, evaluation, observability), rather than the model itself.

**Principle:** *the model proposes, the harness disposes.* The LLM suggests thoughts and actions; deterministic code validates, authorises, executes, limits and records them.

#### 17.1.0 Implementation status (updated 2026-11-24)

**Built and tested (phases 1 and 2):**
- `AgentSpec` in `@envoy/types`: persona, goals (primary/secondary with success criteria), per-tool permissions with per-conversation call caps, runtime limits (`maxSteps`, `maxToolCallsPerTurn`, `toolTimeoutMs`, `extractionFallback`). `runtime.mode` is `classic` (default, unchanged behaviour) or `agentic`.
- Versioned agent configuration: every change to script, fields, rules, widget or spec snapshots an `AgentVersion`; non-config edits do not; restore creates a new version; concurrent edits are rejected; pre-versioning agents get a baseline snapshot on first edit. Each conversation records the version it ran on.
- Provider tool calling: `completeWithTools` on the LLM interface, implemented for the deterministic mock (scripted tool-using agent), Groq (OpenAI-compatible) and Gemini. Groq and Gemini are code-complete with wire-format unit tests but not live-tested, like every real provider here.
- Tool registry and seven built-in tools: `capture_field`, `update_goal`, `end_conversation`, `handoff_to_human`, plus the opt-in integration tools `lookup_crm_contact`, `check_calendar_availability` and `book_meeting`. The harness validates arguments, enforces permissions, per-conversation caps and timeouts, hides internal errors from the model, and refuses `end_conversation` until required fields are captured and primary goals are resolved.
- Bounded agent loop: step and tool budgets, tools withdrawn once the conversation is ending, safe fallback replies on model failure, and the same two-layer hard-rule enforcement on the final reply as classic mode. Optional safety-net extraction pass.
- Run trace: every model call, tool execution, judge verdict and limit hit is stored (`AgentRunStep`) and exposed at `GET /conversations/:id/trace` (tenant-scoped). Goal progress and handoff reason are stored on the conversation and passed to the completion pipeline.
- Portal: "Agent behavior" editor (mode, persona, goals, tools with caps, limits), version history with restore, and a run-trace viewer, goal progress and handoff notice on the conversation page.
- Tests: unit tests for the types, tool wire formats, tool registry and loop; an end-to-end WebSocket suite covering a full tool-using conversation with trace, human handoff, a disabled tool, hard-rule blocking, classic agents unaffected, spec validation, versioning, tenant scoping and the pre-versioning backfill.

- Integration tools are **opt-in per agent** (off unless the tenant enables them) and only offered while the CRM or calendar is connected. Guards: a CRM lookup returns only found + first name and only for the email the visitor gave in that conversation; availability returns busy times only (no event details), max 14 days per query; booking rejects past and >90-day times, re-checks the slot is free immediately before inserting, invites only the visitor's own captured email, and is capped at 2 per conversation unless the tenant sets a different cap. Provider errors are never shown to the model. Mock mode (CRM and calendar) is deterministic; the real HubSpot search and Google freeBusy/events calls are code-complete but not live-tested, and HubSpot connections made before the read scope was added must reconnect.

**Also built (phase 3 and 5 pieces, 2026-11-24): playground, scenarios and the publish check.**
- **Playground** (`/dashboard/agents/:id/test`): chat with the saved version of any agent, published or not, with each reply expandable to the steps the agent took (model calls, tools, rule checks) plus live captured data and goal progress. It runs the real engine and agent loop, with the same hard-rule enforcement and model routing a visitor gets.
- **Safe by construction.** A simulation has no `Conversation` row: it can't create a lead, a CRM push, a stored trace, a violation count, or conversation billing. Side effects go through a `RunSink` that is in-memory for simulations and database-backed for live runs. CRM and calendar tools run against a per-scenario sandbox (known contacts, busy times) and never touch real systems, so an agent's CRM/calendar tools can be tried with nothing connected. Model calls are real and metered on the tenant's key or the shared model (400 simulated messages per workspace per day).
- **Scenarios:** a scripted visitor plus declarative expectations (completes, outcome, handoff, captured fields and values, tools that must or must not be used, goals achieved, text a reply must or must not contain, blocked-violation bounds, finishes within N messages). One pure evaluator (`evaluateScenario`) grades every run and names each failed check with what happened. A playground conversation can be saved as a scenario, with expectations pre-filled from what just happened.
- **Version-aware status:** each run records the agent version it ran on, so "passing" always means passing on the current version. Editing the agent makes its scenarios "not run on this version".
- **Publish check:** publishing an agent whose scenarios are failing or haven't run on this version shows what's wrong and offers *Run scenarios, then publish*, *Publish anyway*, or cancel. It is advisory in the portal, not enforced by the API.
- **Model comparison:** the same suite runs on the current setup and on a chosen key and model side by side, with pass counts, token use and average time per setup (17.5 side-by-side comparison). The comparison never changes the agent.
- **Tests:** evaluator (46 types tests), runner and sandbox unit tests, 10 end-to-end tests (including checks that nothing real is created and that another tenant's agent, scenarios and runs are unreachable), form conversion, and playground, editor and manager component tests.

**Not built yet (same section's remaining phases):** scenarios whose visitor is an LLM persona rather than a fixed script; API-level (rather than portal-level) enforcement of the publish check; scheduled or CI runs; running scenarios against unsaved edits (tests use the saved version); simulated-message limits configurable per plan; a tool to create CRM records mid-conversation (the completion push already does this), `confirm`-style approval modes, the HTTP tool builder, knowledge base and memory, simulator and scenario suite, MCP client/server, BYOK model routing, workflows, and the improvement harness.

#### 17.1.1 Configurable agent definition (the "agent spec")

Replace today's fixed fields with a versioned, Zod-validated `AgentSpec` shared by studio, runtime and tests (same pattern as `FormSchema`).

| Section | What the tenant can customise |
|---|---|
| **Identity and persona** | Name, role, tone, language(s), style examples, what it must never reveal. |
| **Goals** | One primary goal plus sub-goals with success criteria, e.g. "book a demo", "qualify budget above X", "resolve a complaint or escalate". Each goal has a measurable completion test, a priority and an optional deadline in turns. |
| **Strategy / playbook** | Stages or states (greet, discover, qualify, propose, close), entry and exit conditions, and what the agent may do in each stage. |
| **Tools** | The set of tools the agent may call, with per-tool permissions, limits and approval mode (section 17.1.3). |
| **Knowledge** | Documents, URLs, FAQs and structured data the agent may retrieve from (RAG, section 17.1.4). |
| **Memory policy** | What to remember within a session, across a visitor's sessions, and across the tenant. |
| **Guardrails** | Existing hard rules (block / escalate), plus tool-use policies, topic allow/deny lists, PII handling, spend and step budgets. |
| **Model and runtime settings** | Model per role (chat, planner, extractor, judge), temperature, max steps, max tokens, timeouts, fallback model. |
| **Handoff** | When and how to transfer to a human, and what context to pass. |
| **Widget** | Existing appearance settings. |

Specs are versioned (`AgentVersion`), diffable, testable and roll-back-able. This is also what the improvement harness (17.4) edits.

#### 17.1.2 The agent loop (runtime)

Replace the single-completion turn with a bounded **perceive, think, act, observe** loop:

1. **Perceive:** load session state, goals, captured data, memory and retrieved knowledge.
2. **Plan/think:** the model decides the next step: reply, ask for a field, call a tool, update goal status, hand off, or finish.
3. **Validate:** the harness checks the proposed action against the spec (is the tool allowed, are arguments valid per the tool's Zod schema, within budget, does it pass policy).
4. **Act:** execute the tool or send the reply.
5. **Observe:** feed the tool result back (sanitised) and repeat until the model emits a visitor-facing reply, a goal completes, or a limit is hit.
6. **Judge and send:** the existing two-layer hard-rule enforcement still runs before anything reaches the visitor.

Loop guarantees: maximum steps and tokens per turn, per-tool timeouts, loop and repeat detection, graceful fallback message on any failure, and every step written to the run trace. Planner and chat roles can use different models (a cheap model to route, a stronger one to answer). Streaming of the final reply can be revisited once enforcement can run on partial output.

#### 17.1.3 Tool calling

**Tool = name + description + input/output Zod schema + permission + executor.** The model sees only the schema; the harness owns execution.

*Built-in tools (platform provided):*
- `capture_field` / `update_goal`: structured capture and goal progress (replaces the separate extraction pass with explicit, validated calls).
- `search_knowledge`: retrieve from the tenant's knowledge base.
- `check_calendar_availability` and `book_meeting`: via the existing Google Calendar integration.
- `create_crm_record` / `lookup_crm_contact`: via the existing CRM provider.
- `send_email` / `send_sms`: via the workflow messaging providers (17.3), with consent checks.
- `lookup_order` / `check_status`: via a tenant API.
- `handoff_to_human`, `end_conversation`.

*Tenant-defined tools:* a no-code **HTTP tool builder** where the tenant gives a name, a description for the model, an endpoint, auth headers (stored encrypted, never sent to the model or browser), and an input and output schema. Reuses the existing server-side proxy and `safe-fetch` SSRF protection used by form dropdown APIs.

*Later:* **MCP client support**, so an Envoy agent can use any MCP server as a tool source (the opposite direction, Envoy itself being an MCP server, is section 17.2).

*Tool governance:* per-tool allow list per agent; **approval modes** (`auto`, `confirm with visitor`, `confirm with tenant staff`, `disabled`); argument validation and redaction; rate limits and cost caps per tool and per conversation; idempotency keys for side-effecting tools; dry-run mode for testing; tool outputs treated as untrusted data (prompt-injection defence); every call logged with arguments, result, latency and who authorised it.

#### 17.1.4 Knowledge and memory

- **Knowledge base (RAG):** upload files, crawl site pages, paste FAQs; chunk, embed, store (pgvector in the existing PostgreSQL keeps the stack small); retrieval with citations; tenant-isolated indexes; staleness and re-sync controls.
- **Short-term memory:** session history with summarisation and trimming to fit the context window.
- **Working memory:** structured per-conversation state (goals, stage, captured data, open questions), already partly present in Redis session state.
- **Long-term memory:** returning-visitor profile and past-conversation summaries (opt-in, consent aware), plus per-agent lessons from the improvement harness.

#### 17.1.5 Multi-agent and orchestration (stretch)

A **router agent** that triages (sales, support, billing) and hands off to specialist agents with their own specs; supervisor/worker patterns for complex tasks; shared state and a clear handoff contract. Each specialist keeps its own tools, goals and guardrails.

#### 17.1.6 Harness engineering: the dependable-agent infrastructure

This is the intended research and engineering contribution of the FYP.

| Harness layer | Purpose |
|---|---|
| **Runtime and orchestration** | Bounded agent loop, state machine for stages and goals, retries, timeouts, fallbacks, resumable sessions. |
| **Tool layer** | Registry, schema validation, permissions, approval modes, sandboxed execution, idempotency, cost tracking. |
| **Guardrails and policy** | Layered enforcement: input checks (injection, PII), tool-policy checks, output judge (existing hard rules), budget limits, escalation. |
| **Context engineering** | Stable prefix versus volatile suffix (already built, enables provider prompt caching), dynamic context assembly, retrieval, summarisation, token budgeting. |
| **Observability** | Full trace per run (every prompt, thought, tool call, observation, verdict, cost, latency); a trace viewer in the portal; metrics and alerts. |
| **Evaluation** | Scenario suites with simulated visitors, deterministic and LLM-judge scoring, regression tests on every spec change, replay of real conversations (see 17.4). |
| **Improvement loop** | Insight, proposal, test, approve, deploy, measure (17.4). |
| **Security** | Prompt-injection resistance, tool sandboxing, secret isolation, SSRF protection (exists), least-privilege tools, audit trail. |
| **Cost and quota control** | Token and tool-cost accounting per run, per agent, per tenant, feeding `PriceConfig` billing. |
| **Provider abstraction** | Multiple models and providers behind one interface, with a deterministic mock for tests (exists), including tool-call-capable mocks. |

#### 17.1.7 Agent Studio (portal UI)

- **Spec editor** with sections for persona, goals, playbook, tools, knowledge, memory, guardrails and model settings, backed by the shared schema.
- **Tool library** with enable, permission and approval controls, plus the HTTP tool builder with a "test this tool" button.
- **Goal and stage designer** (visual flow of stages and exit conditions).
- **Simulator / playground:** chat with the draft agent, with a side panel showing thoughts, tool calls, retrieved sources, goal progress and rule checks live.
- **Scenario test suite:** save visitor scripts and expected outcomes; run on every change.
- **Trace viewer:** step-by-step replay of any real conversation.
- **Versions:** compare, publish, roll back; **templates** for common agents (sales qualifier, support triage, appointment booker, complaint handler).

#### 17.1.8 Proposed data model additions

`AgentVersion` (spec snapshot), `Tool` (tenant-defined tool config, encrypted secrets), `AgentTool` (per-agent permissions and approval mode), `KnowledgeSource` and `KnowledgeChunk` (with embeddings), `RunTrace` and `RunStep` (thought, tool call, observation, verdict, tokens, cost, latency), `Goal` and `GoalProgress` per conversation, `Memory` (scoped: visitor, tenant, agent), `Scenario` and `ScenarioRun`.

#### 17.1.9 Suggested phases

1. **Foundation:** versioned `AgentSpec`, run trace recorder, and a provider interface with native tool-call support (including a tool-capable mock).
2. **Agent loop and built-in tools:** bounded loop, goals with completion tests, `capture_field`, `update_goal`, `handoff_to_human`, calendar and CRM tools, tool validation, limits and logging.
3. **Studio v1:** spec editor, playground with live trace, tool permissions and approval modes, trace viewer.
4. **Custom tools and knowledge:** HTTP tool builder, RAG with pgvector and citations, memory policies.
5. **Evaluation harness:** scenario suites, simulated visitors, regression gating on publish (this is the base for 17.4).
6. **Advanced:** MCP tool sources, multi-agent routing, planner/executor model split, long-term memory.

#### 17.1.10 Suggested functional requirements (for the SRS)

- **FR-AGT-1** A tenant can define an agent's persona, goals, stages, tools, knowledge, memory policy, guardrails and model settings, stored as a versioned spec.
- **FR-AGT-2** Each turn runs a bounded loop that can call tools and observe results before replying, within configured step, token and time limits.
- **FR-AGT-3** Goals have measurable success criteria; the runtime tracks and records progress and completion.
- **FR-AGT-4** Every tool call is schema-validated, permission-checked, rate-limited and logged.
- **FR-AGT-5** Tools support approval modes (auto, visitor confirm, staff confirm, disabled).
- **FR-AGT-6** Tenants can define custom HTTP tools without code; secrets are never exposed to the model or the browser.
- **FR-AGT-7** Agents can retrieve from a tenant knowledge base and cite sources.
- **FR-AGT-8** Hard-rule enforcement and tool policies apply to every reply and action before it takes effect.
- **FR-AGT-9** A full trace of every run is stored and viewable.
- **FR-AGT-10** Tenants can test a draft agent in a simulator and run saved scenarios before publishing.
- **FR-AGT-11** Agents can hand off to a human with conversation context.
- **FR-AGT-12** Tool usage and model cost are metered per run and billed through the existing pricing model.

#### 17.1.11 Risks and how the design answers them

| Risk | Mitigation |
|---|---|
| Autonomy causes harmful or costly actions | Least-privilege tools, approval modes, budgets, dry-run, kill switch, audit log. |
| Prompt injection via visitor text, tool output or knowledge documents | Treat all as untrusted data, schema-validated arguments, policy checks outside the model, output judge. |
| Non-determinism makes bugs hard to find | Full traces, replay, scenario regression tests, mock provider. |
| Latency and cost grow with loop steps | Step and token caps, cheap planner models, caching of the stable prefix, early exit. |
| Complexity overwhelms non-technical tenants | Templates, sensible defaults, simulator, progressive disclosure in the studio. |
| Over-scoping for an FYP | Phased plan; phases 1 to 3 already form a complete, demonstrable contribution. |

#### 17.1.12 How to evaluate this for the FYP report

Compare the current single-pass agent (baseline) with the tool-using, goal-driven agent on the same simulated-visitor scenarios: goal completion rate, fields correctly captured, turns to completion, number of hard-rule violations reaching the visitor (target: zero), tool-call success rate, cost per conversation and latency. Include an ablation (with and without tools, with and without the judge layer) and report failures honestly.

### 17.2 Planned direction: AI-Agent-Friendly Platform (Envoy MCP server and agent-operable API)

#### 17.2.0 Implementation status (updated 2026-11-25)

**Built and tested: the tenant MCP server (read and build tools), scoped API tokens, and the safety model, both transports.**
- **API tokens:** `ApiToken` (`envoy_sk_…`), created by the workspace owner with a chosen set of scopes and an expiry (30 days to 1 year); only the SHA-256 is stored and the secret is shown once. A token acts as the user who made it, with that user's current role and feature flags, so deleting or demoting the user narrows or ends it. It is checked by the same `JwtAuthGuard` every route already uses, so tenant scope, roles, feature flags and the billing lock apply to tokens exactly as to people. Per-token rate limit (120 requests a minute). Revocation and expiry are immediate; a bad, expired, revoked or unknown token all get the identical 401.
- **Scopes (8, all read-or-build):** `agents:read|write`, `conversations:read`, `forms:read|write`, `models:read`, `billing:read`, `integrations:read`. There is no write scope for models, billing or integrations, so those cannot be granted at all.
- **Closed to tokens, whatever the scopes:** accounts, the operator console, auth, other tokens, webhooks; approving or rejecting an AI-drafted improvement; restoring a version (a snapshot can carry different hard rules). Even with `agents:write` a token cannot set hard rules, publish an agent live, or newly enable the CRM/calendar tools on an agent (creating an agent always yields a draft). One pure, tested function (`decideTokenAccess`) holds this policy.
- **Audit:** every change a token makes is written to the audit log with the token's name, method, path and status, including changes the policy refused; reads are not logged, and bodies, queries and secrets never are.
- **MCP server (`apps/mcp`):** 30 tools, each one explicit API call: agents (list, get, create as draft, edit with merged spec and a version note, pause, embed snippet, versions), conversations, run traces, leads, the sandbox playground, scenarios (create, run, compare models, status, run detail), improvement (metrics, diagnose, findings, draft a fix, list and test proposals), model status and usage, subscription and billing usage, forms. Plus the `envoy://reference/vocabulary` and `envoy://agents/{id}` resources and three prompts (`build_lead_qualifier`, `diagnose_agent`, `weekly_leads_digest`). Read tools are marked read-only so clients can auto-approve them. Tools that return visitor-written text put an explicit "untrusted data" notice in front of it. Errors come back as readable tool errors with no stack traces or addresses.
- **Transports:** stdio for local apps (Claude Desktop and similar) and stateless Streamable HTTP for remote clients, where each request carries the caller's own token, forwarded to the API; the HTTP server stores nothing.
- **Portal:** a new *API & MCP* page (owner only): create a token from presets or individual scopes, copy the secret and a ready-to-paste MCP configuration once, see each token's scopes, last use and expiry, and revoke.
- **Tests:** access-policy table tests, 15 API token end-to-end tests (storage and one-time secret, scoping, closed routes, agent-edit restrictions, revocation, expiry, lock, rate limit, audit), 27 MCP server and transport tests, and 7 end-to-end tests where a real MCP client drives the real server against the real API (build and test an agent, refusals, scope handling, untrusted marking, diagnosis and drafting, audit).

**Built since (2026-11-25): human approval for the things an assistant may not do.** An assistant can now *ask*. Five request tools (`request_publish_agent`, `request_hard_rules_change`, `request_enable_tools`, `request_version_restore`, `request_proposal_approval`) plus `get_approval_request` and `list_approval_requests`; there is deliberately no tool that decides. A request stores one allow-listed action with exact parameters (a fingerprint is re-checked at execution), and the owner reviews it in the portal's *Approvals* inbox (with a pending count in the sidebar). The reviewer sees a summary **the server builds from the agent's real state** (for hard rules, exactly what is added, changed and removed; for publishing, scenario status, rules and tools; for CRM/calendar access, what is connected), plus warnings, and the requester's own explanation clearly separated as an unverified quote, so a manipulated assistant cannot write its own approval text. Only the signed-in owner can approve (the token policy refuses it for any token, and the role guard refuses everyone else: two independent locks), the action then runs once, as the owner, and is audited as theirs. A request expires after 24 hours, is void ("out of date") if the agent changed after it was asked, is deduplicated, a token may have at most 5 open, and a request that could not do anything (already live, same rules, unknown version) is refused up front. New token scopes `approvals:read` and `approvals:write`.
- **Tests:** policy table tests, 18 end-to-end API tests (token asks but cannot decide, by either route; staff and other workspaces refused; single use under concurrent approval; dedupe and cap; stale; expiry; a tampered request refuses to run; each of the five kinds executes correctly and fails safely; scoping; audit), MCP tool tests, 2 end-to-end tests through a real MCP client against the real API (ask → owner approves → assistant sees the answer; an assistant cannot approve its own request), and portal tests for the inbox.

**Not built yet:** OAuth 2.1 with PKCE for remote clients (API tokens are the only credential); email or push notification of a new request (the portal shows a count only); an operator-side MCP server; writing forms, hard rules and integrations through MCP; webhooks, an OpenAPI spec, a CLI and `llms.txt` (17.2.5); per-token spend limits and a global kill switch beyond revoking. The MCP server has been tested with the official client over in-memory and HTTP transports, not yet inside a third-party AI app.

**Problem.** Envoy is operated today only by humans through the portal and admin console. Increasingly, businesses run their operations through their own AI assistants and automation agents (Claude, ChatGPT, Cursor, custom agents). If Envoy can only be driven by clicking, those agents cannot create an agent, read new leads, adjust a script, or check billing for the user.

**Idea.** Make Envoy a **first-class citizen in the AI-agent ecosystem**: expose the whole platform as a **Model Context Protocol (MCP) server**, so any MCP-capable AI agent can connect and operate a tenant's Envoy workspace with the same permissions, limits and audit trail as a human user. Note the two directions: 17.1.3 plans Envoy agents *consuming* MCP tools; this section is Envoy *being* an MCP server that outside agents consume.

**Example things an outside agent could do**
- "Create a support agent for my clinic from the appointment-booker template, publish it and give me the embed snippet."
- "Show me yesterday's leads with budget above 5000 and summarise why two conversations were abandoned."
- "Our refund rule is too strict; propose a change, test it on last week's conversations and apply it if it scores better."
- "Connect HubSpot, map the `phone` field, and re-push all failed leads."
- (Operator side) "List tenants that are past due, pause the ones locked for 30 days, and show the audit trail."

#### 17.2.1 Architecture

- **New app `apps/mcp`** (or `packages/mcp`): a standalone MCP server written with the official TypeScript MCP SDK. It contains *no business logic of its own*. It calls the existing API through `@envoy/sdk`, so every rule (tenant isolation, feature flags, tenant lock, audit logging, validation) is enforced in exactly one place.
- **Transports:** Streamable HTTP for hosted/remote use (the default for SaaS), and stdio for local use by desktop clients and for development.
- **Two surfaces, strictly separated:** a **tenant server** (portal-equivalent operations) and an **operator server** (admin-equivalent operations, `platform_admin` only), mirroring the portal/admin split and the separate session scopes.
- **Single source of truth:** tool input schemas are generated from the shared Zod contracts in `@envoy/types`, so MCP, REST, portal and tests can never drift apart.

#### 17.2.2 What the MCP server exposes

**Tools (actions)**

| Area | Tools |
|---|---|
| Agents | `list_agents`, `get_agent`, `create_agent`, `update_agent`, `publish_agent`, `pause_agent`, `get_embed_snippet`, (later) `list_agent_versions`, `rollback_agent` |
| Conversations and leads | `list_conversations`, `get_conversation`, `search_leads`, `get_lead_stats`, `export_leads`, `retry_push` |
| Forms | `list_forms`, `get_form`, `create_form`, `update_form`, `list_submissions` |
| CRM and integrations | `get_crm_connection`, `set_field_mapping`, `connect_integration`, `update_integration`, `push_lead` |
| Billing and usage | `get_subscription`, `get_usage`, `create_checkout_link`, `create_billing_portal_link` |
| Testing and quality | `simulate_conversation` (run a draft agent against a scripted visitor), `run_scenarios`, `get_run_trace`, `get_performance` |
| Improvement (17.4) | `list_insights`, `list_proposals`, `test_proposal`, `approve_proposal` |
| Workflows (17.3) | `list_workflows`, `create_workflow`, `activate_workflow`, `get_workflow_runs` |
| Operator (separate server) | `list_tenants`, `get_tenant`, `pause_tenant`, `resume_tenant`, `set_pricing`, `set_feature_access`, `get_audit_log`, `list_failed_jobs`, `retry_job` |

**Resources (read-only context an agent can load):** agent specs, conversation transcripts and summaries, form schemas, the field-type and feature-key vocabularies, pricing config, the platform's own documentation and the API reference.

**Prompts (reusable playbooks):** "set up a lead-qualification agent", "audit my agent's rules", "weekly leads digest", "diagnose abandoned conversations", "onboard a new tenant".

#### 17.2.3 Authentication and authorisation

- **OAuth 2.1 authorization-code flow with PKCE** for remote clients (the MCP standard for hosted servers), so a user signs in once in the browser and approves what the AI client may do. Tokens are short-lived and refreshable.
- **Scoped personal access / API keys** as the simple alternative for scripts and CI (`envoy_sk_...`, shown once, stored only as a hash, revocable, with expiry), the same hashing approach already used for refresh tokens.
- **Scopes** such as `agents:read`, `agents:write`, `leads:read`, `billing:read`, `forms:write`, `crm:write`, `admin:*`. A token can be narrower than its user; it can never be broader.
- **Inherited limits:** the token acts as the user, so existing per-user `FeatureAccess` flags, role checks, tenant lock (423) and tenant scoping all apply automatically. A locked tenant's agent client gets a clear "tenant locked" tool error.
- **Operator access** requires a separate admin-scope grant and is off by default.

#### 17.2.4 Safety for agent-driven operation

Letting an AI operate a business system needs more care than a human UI:
- **Read-only by default;** write tools need an explicit scope.
- **Risk tiers per tool:** low (read), medium (reversible writes: edit script, create form), high (publishing a live agent, changing rules, billing links, pricing, deleting). High-risk tools can require **human confirmation** (an approval link or portal prompt) before they execute.
- **Dry-run / preview mode** on write tools that returns the diff without applying it.
- **Idempotency keys** on mutating calls so retries never duplicate work.
- **Rate limits and quotas per token,** plus a global kill switch per tenant and per token.
- **Hard rules cannot be weakened through MCP** without the same approval the portal requires; the harness invariant from 17.4 holds for outside agents too.
- **Prompt-injection awareness:** captured visitor text returned by tools is marked as untrusted data, so a malicious visitor message cannot instruct the operator's AI client to take actions.
- **Data minimisation:** responses return only the fields requested, with PII redaction options.
- **Full audit:** every MCP call is logged with token ID, client name, tool, arguments (redacted), result status and the human on whose behalf it ran. This extends the existing `AuditLog` (currently admin-only) to tenant actions.

#### 17.2.5 Making the whole platform agent-friendly (beyond MCP)

- **Complete, versioned OpenAPI spec** generated from the Zod contracts, published at `/openapi.json`, with consistent error shapes and machine-readable error codes.
- **`llms.txt` and agent-readable docs** on the landing and docs site, describing what Envoy is and how to operate it.
- **Webhooks and event stream** (`lead.created`, `conversation.completed`, `agent.published`, `billing.locked`) so outside agents can react instead of poll, signed with HMAC.
- **Pagination, filtering and stable IDs** on every list endpoint, with cursors for the leads feed.
- **Idempotent, declarative endpoints** (e.g. `PUT` an agent spec) that suit automation.
- **CLI** (`envoy`) built on `@envoy/sdk` for terminals and CI.
- **Sandbox / test tenant** with mock providers (already supported), so agents can be developed and evaluated without touching real data or spending money.
- **Agent-friendly onboarding:** an agent can register a workspace and receive credentials through a single approved flow.

#### 17.2.6 Proposed data model additions

`ApiToken` (hash, scopes, expiry, lastUsedAt, revokedAt, createdByUserId), `OAuthClient` and `OAuthGrant` (for MCP clients), `WebhookEndpoint` and `WebhookDelivery`, `PendingApproval` (high-risk tool calls awaiting human confirmation), and an extended `AuditLog` that records the actor type (`human`, `mcp_client`, `api_token`) and client name.

#### 17.2.7 Suggested phases

1. **Read-only MCP (stdio):** tenant tools for agents, conversations, leads and usage, built on `@envoy/sdk`; API tokens with scopes; audit entries for MCP calls.
2. **Write tools and safety:** create/update/publish agent and form, dry-run, idempotency keys, risk tiers and human approval flow.
3. **Remote MCP with OAuth 2.1:** Streamable HTTP, consent screen in the portal, token management page (list, revoke, scopes, last used).
4. **Quality loop over MCP:** `simulate_conversation`, scenario runs, traces, insights and proposals (depends on 17.1 and 17.4).
5. **Operator MCP server:** admin tools behind a separate scope, with stricter approvals.
6. **Ecosystem:** OpenAPI, webhooks, CLI, `llms.txt`, templates gallery.

#### 17.2.8 Suggested functional requirements (for the SRS)

- **FR-MCP-1** The platform provides an MCP server exposing tenant operations as tools, resources and prompts.
- **FR-MCP-2** Remote clients authenticate with OAuth 2.1 (PKCE); scripts can use scoped, revocable API tokens.
- **FR-MCP-3** Every MCP call runs with the acting user's permissions, feature flags, tenant lock and tenant isolation; a token can never exceed its user.
- **FR-MCP-4** Tools are classified by risk; high-risk tools require human approval before execution.
- **FR-MCP-5** Write tools support dry-run and idempotency keys.
- **FR-MCP-6** All MCP actions are audited with actor type, client, tool and outcome.
- **FR-MCP-7** Tenants can view, scope, revoke and monitor tokens and connected AI clients.
- **FR-MCP-8** Operator tools are exposed only on a separate server and scope.
- **FR-MCP-9** Rate limits and a kill switch apply per token and per tenant.
- **FR-MCP-10** The platform publishes an OpenAPI spec and signed webhooks for events.
- **FR-MCP-11** Visitor-originated content in tool results is marked untrusted.

#### 17.2.9 Risks and mitigations

| Risk | Mitigation |
|---|---|
| An AI client takes a destructive or costly action | Scopes, risk tiers, human approval, dry-run, kill switch, audit. |
| Prompt injection from visitor text into the operator's AI | Untrusted-content marking, no auto-execution of high-risk tools, approval gate. |
| Token leakage | Hash-only storage, short expiry, scopes, per-token rate limits, one-click revoke. |
| Schema drift between REST, MCP and UI | All generated from the shared Zod contracts. |
| MCP spec still evolving | Thin server over `@envoy/sdk`; transport and auth isolated in one package. |
| Cost from runaway automation | Per-token quotas and the existing usage metering. |

#### 17.2.10 How to evaluate this for the FYP report

Demonstrate an external agent completing end-to-end tasks purely through MCP (create and publish an agent, run a simulated conversation, read the resulting lead, adjust a rule) and measure task success rate, number of tool calls, and time compared with doing the same in the portal. Security evaluation: show that a token with narrow scopes, a locked tenant, a missing feature flag, and a cross-tenant ID are each correctly refused, and that every call appears in the audit log. Also include a prompt-injection test where a visitor message tries to make the operator's AI take a harmful action.

### 17.3 Planned feature: Lead Follow-up Workflow System

#### 17.3.0 Implementation status (updated 2026-11-25)

**Built and tested: the first usable version (phases 1 and 2 of the plan below), plus conditional steps and early exit (see below).**
- **Workflows:** a trigger (a finished conversation, optionally from one agent, or a form submission, optionally from one form), optional conditions (all/any over captured fields and the conversation outcome, using the same operators as form logic), and up to 12 ordered steps: send email, send text message, wait (minutes, hours, days; at most 60 days in total). An email step goes to the lead or, as a plain notification, to your own team. Messages use `{{field}}` personalisation. A workflow is a draft until the **owner** switches it live; it cannot be edited while live (leads in flight read its steps by position), and pausing it stops the leads currently in it.
- **Enrolment:** hooked into the existing lead routing, so a lead is enrolled at the same moment it is pushed to the CRM. A lead enters a given workflow at most once (database-unique), and enrolment can never break completing a conversation.
- **Execution:** one lead's progress is stored after every step, so a restart resumes exactly where it stopped. Waits are delayed queue jobs; a per-lead lock stops two workers advancing the same lead; a sweeper wakes any run whose job was lost (a Redis flush); a retried delivery never re-sends a recorded step. A transient send failure is retried by the queue and, on the last attempt, recorded as failed so the sequence moves on; a permanent one is recorded straight away.
- **The gate every message passes:** a valid address (phone numbers must be written internationally, `+44…`; a bare local number is not guessed at); no opt-out on that channel; SMS consent when the workflow names a consent field; SMS held during quiet hours (default 21:00 to 08:00 in the lead's configured time zone, DST- and half-hour-zone-safe); a daily cap per workspace and at most 5 messages per contact per day across all workflows; nothing sent while the workspace is locked. Anything that fails the gate is skipped with the reason written in the lead's history, or held until it can go.
- **Compliance:** every email to a lead carries the business name and a signed unsubscribe link plus `List-Unsubscribe` one-click headers; the link's GET only asks for confirmation (so mail scanners can't unsubscribe people) and the POST does it. Every SMS says "Reply STOP to opt out." Inbound texts (Twilio webhook, signature-verified, refused unsigned outside local dev) handle STOP and its synonyms (opts the person out for every workspace that texted them), START (undoes only a STOP, never a business's own entry), and any other reply (ends sequences that asked to stop on reply). A provider reporting a carrier-level opt-out is recorded as one. A business can add people to its do-not-contact list but cannot remove anyone who chose to opt out. Recipients are stored in logs masked, and as a hash for matching.
- **Providers:** email via Resend (idempotency key per step), SMS via Twilio or a mock, both behind interfaces and replaceable in tests. Twilio is code-complete and its request-signature check is verified against Twilio's documented example, but nothing has been sent through real Twilio or Resend from here.
- **Preview:** plays a workflow against a sample lead with the real gate and shows what each step would do, when, rendered, and which `{{fields}}` the lead has no value for. Nothing is sent and nobody is enrolled.
- **Access:** gated by the new `workflows` feature (off by default; the operator enables it per user), closed to API tokens and MCP.
- **Portal:** a *Follow-ups* page (list with live counts, the do-not-contact list), an editor (trigger, conditions, ordered steps with variable chips, sending rules, a sample-lead preview) and an *Activity* tab showing every lead's step-by-step history with a cancel button.
- **Tests:** pure rules (conditions, phone/email normalisation, consent, STOP keywords, quiet hours including DST), contact helpers and signed links, 31 end-to-end tests (feature gating, validation, lifecycle, enrolment and idempotency, sending with all compliance extras, waits, the full conversation-to-email path, forms, every skip reason, quiet hours, caps, locked workspaces, team notifications, permanent and transient failures, carrier opt-outs, deleted leads, the sweeper, unsubscribe including tampered links, inbound SMS including signatures, STOP, START, replies, opt-out management, runs, cancel, preview), and portal tests for the helpers, editor and both pages.

**Built since (2026-11-25): branching.** Any step can carry an *only if…* condition (the same condition language as the workflow's entry conditions, including the conversation outcome). It is checked when the step is reached, against the lead's data at that moment, and a step that doesn't apply is skipped and logged with the reason in plain words ("Condition not met: budget is more than 5000"). Two steps with opposite conditions make an if/else. A new **End here** step stops the sequence for leads who meet its condition (the run completes with reason `ended_early`); it cannot be saved without a condition, since it would otherwise cut the sequence short for everyone. Steps stay a single straight list, deliberately rather than a tree, so run state (one step pointer), logs and previews stay simple. The preview shows which branch a sample lead takes and where it ends, and the editor reuses one condition component for entry and step conditions. *Tests:* contract tests, 6 end-to-end tests (if/else per lead, conditions read at the moment the step is reached, end-here for matching leads only, a skipped wait doesn't wait, end-here validation, branch preview), editor and helper tests.

**Not built yet:** nested branches (a branch with its own sub-sequence; today each step carries its own condition); exit conditions beyond an SMS reply (a booking, a won deal; email replies are not detected, which needs inbound email parsing); per-tenant SMS numbers and sender registration (all texts leave from one shared number, so STOP applies across workspaces that texted the same person; real US 10DLC/toll-free registration is a prerequisite for production SMS); WhatsApp; metering and billing messages sent through `PriceConfig`; A/B testing of messages; AI-written follow-ups; inbound-email unsubscribe handling beyond the link; scheduled sends at a chosen time of day (waits are durations); and region rules (TCPA, GDPR, CAN-SPAM) beyond the safeguards above — consent and legal basis remain the business's responsibility, and the editor warns when SMS has no consent field. Not live-tested against Twilio or Resend. Sequences are at-least-once per step: a crash in the instant between a text being accepted and recorded could repeat it (email is protected by an idempotency key; SMS has no equivalent).

**Problem.** Today Envoy captures a lead and pushes it to a CRM, calendar, email or webhook, and then stops. Follow-up is manual, and most leads go cold because nobody contacts them quickly or consistently. Tenants need the platform to keep working the lead after the conversation ends.

**Idea.** A visual, no-code **workflow builder** in the portal where a tenant defines *"when a lead meets certain conditions, send these SMS and emails, at these times"*. Workflows run automatically on every new lead from a conversation or a form submission.

**Core concepts**

| Concept | Meaning |
|---|---|
| **Trigger** | What starts a workflow: conversation completed, form submitted, lead data updated, lead idle for N hours/days, or a manual start. |
| **Conditions** | Rules over the lead's captured data, evaluated with an AND/ANY model. They reuse the existing form-condition operators (`equals`, `not_equals`, `contains`, `gt`, `lt`, `is_empty`, `is_not_empty`) plus conversation/lead attributes (outcome type, source agent or form, channel, time of day, whether the lead replied). |
| **Actions** | Send email, send SMS, wait/delay, push to CRM, fire a webhook, create a calendar event, tag/assign, end workflow. |
| **Delays and schedules** | "Wait 1 hour", "wait until 9 am the next business day", with quiet hours and the lead's time zone. |
| **Branching** | If/else steps, e.g. high-value lead → SMS in 5 minutes; low-value lead → email next day. |
| **Exit conditions** | Stop the sequence if the lead replies, books a meeting, unsubscribes, or is marked won/lost. |
| **Templates** | Message bodies with variables such as `{{name}}`, `{{email}}`, `{{agentName}}` and any captured field key, in the same style as the form builder's `{{fieldKey}}` placeholders. |

**Example workflows**
1. *Hot lead:* conversation completed AND `budget > 5000` → send SMS in 5 minutes ("Thanks, {{name}}, we'll call you shortly") → email the sales team → wait 1 day → if no reply, send a follow-up email.
2. *Demo reminder:* outcome = `demo_booking` → email confirmation now → SMS reminder 1 hour before the slot.
3. *Incomplete lead:* conversation abandoned with an email captured → wait 2 hours → send a "pick up where you left off" email.
4. *Complaint:* outcome = `complaint` → immediately notify the support webhook and email the tenant owner.

**Proposed design (fits the current architecture)**

- **Data model (new tables):** `Workflow` (tenantId, name, status draft/live/paused, trigger, `definition` JSON as a validated graph of steps), `WorkflowRun` (one per lead per workflow: status, current step, next-run time), `WorkflowStepLog` (what was sent or skipped, with errors), `MessageTemplate`, `Contact`/`OptOut` (unsubscribe and consent), `MessageDelivery` (provider message id, delivered/failed/replied).
- **Schema in `@envoy/types`:** a Zod `WorkflowDefinition`, validated identically in the builder UI and on the server, as with `FormSchema`.
- **Trigger hook:** `CaptureRoutingService` already fans captured data out on conversation completion and form submission. Workflow triggering is added as one more destination there, so the visitor path is untouched.
- **Execution:** BullMQ delayed jobs, one per step, running on a dedicated queue and worker. Each run is resumable and idempotent (a step is never sent twice). Retries with backoff, and failures visible in the existing admin failed-jobs page.
- **Providers (same abstraction pattern as LLM/CRM):** `EmailProvider` (reuse Resend) and a new `SmsProvider` (Twilio, plus a `mock` default so the feature is demoable with no credentials). Selected by env var, e.g. `SMS_PROVIDER=mock|twilio`.
- **Inbound handling:** webhook endpoints for delivery status and SMS replies, so a reply can stop a sequence.
- **Portal UI:** a *Workflows* page with a node/step builder (extending `packages/builder`), template editor with variable picker, a test-send button, run history per lead, and per-workflow stats (sent, delivered, replied, converted).
- **Access and billing:** new feature key `workflows` in `FeatureAccess` (off by default, toggled by the admin); SMS and email sends metered per message and added to `PriceConfig` (e.g. `addOns.sms`, `smsPerMessageCents`), billed through the existing usage and overage logic.

**Compliance and safety requirements (must-haves)**
- Explicit consent capture and a stored opt-out list; every SMS honours `STOP` and every email carries an unsubscribe link.
- Quiet hours and per-lead time zone, and rate limits per tenant and per lead to prevent spam loops.
- Region rules (e.g. TCPA/GDPR/CAN-SPAM) surfaced as warnings in the builder.
- Tenant-isolated runs, plus an audit trail of every message sent on a tenant's behalf.
- Workflow-level cap on the number of messages per lead.

**Suggested phases**
1. *MVP:* trigger on conversation completed / form submitted, one condition group, actions = email, SMS and delay, a linear step list (no branching), mock providers, run history.
2. *Real providers and compliance:* Resend + Twilio, opt-out handling, quiet hours, delivery webhooks, stop-on-reply.
3. *Visual builder:* branching, templates with variables, exit conditions, per-workflow analytics.
4. *Advanced:* idle/time-based triggers, WhatsApp channel, A/B testing of messages, AI-written follow-ups using the conversation summary.

**Suggested functional requirements (for the SRS)**
- **FR-FLOW-1** Tenants can create, edit, publish, pause and delete workflows.
- **FR-FLOW-2** A workflow starts on a defined trigger for a lead from a conversation or form.
- **FR-FLOW-3** Steps run only when the lead's data satisfies the workflow's conditions.
- **FR-FLOW-4** Supported actions include email, SMS, delay, webhook and CRM push.
- **FR-FLOW-5** Messages support variable substitution from captured data.
- **FR-FLOW-6** Runs stop on reply, booking, unsubscribe or manual cancel.
- **FR-FLOW-7** Opt-outs are enforced across all workflows for a tenant.
- **FR-FLOW-8** Every send, skip and failure is logged and visible per lead.
- **FR-FLOW-9** Access is gated by the `workflows` feature flag, and SMS/email usage is metered and billed.

### 17.4 Planned feature: Agent Improvement Harness (agents that get better with every run)

#### 17.4.0 Implementation status (updated 2026-11-24)

**Built and tested: the observe → diagnose → propose → test → approve loop, deterministic and human-gated.**
- **Observe:** abandoned conversations now keep what the visitor said and what was captured (previously an empty row), plus a turn count on every finished conversation. Visitors who leave without saying anything are recorded as bounces and excluded from every rate. Per-version metrics: engaged, completed, left part-way, completion rate, average messages to finish, handoffs, rule-blocked replies, tool errors.
- **Diagnose:** pure, tested detectors turn real conversations into findings with evidence (counts and example conversations): *visitors leave at a specific required field*, *low completion*, *high handoff rate*, *a hard rule blocking many replies*, *a tool failing often*, *completion dropped since the previous version*. Every one needs a minimum sample (8 engaged conversations; 5 tool calls) so a handful of chats never raises an alarm. Findings are keyed per version, so re-analysing refreshes them in place; a dismissal sticks while the problem lasts, and a finding whose problem has gone away is dropped.
- **Propose:** the tenant's own model (BYOK) drafts the smallest fix for a finding, shown real transcripts as untrusted data. A proposal can change only the script, the persona, per-field hints, and **add** hard rules. It cannot remove or edit a hard rule, or touch fields, tools, goals or limits (the schema cannot express it, `applyChanges` rejects id collisions, and approval re-checks `preservesHardRules`). Unusable model output is retried once, then discarded rather than invented.
- **Test bench:** a proposal runs every scenario on the current configuration and on the proposed one (nothing is saved), and replays the real visitors from the conversations that exposed the problem on both. A scenario that passes today and fails with the change is a regression: the proposal is marked unsafe and cannot be approved.
- **Approve:** only the workspace owner, only after a test, only if the agent hasn't changed since the draft (otherwise it is "out of date"), and, for an agent with no scenarios, only with an explicit acknowledgement that nothing checked it. Approval writes a normal new agent version labelled "Improvement: …" (reversible from version history). Reject is final.
- **Access:** gated by the new `improvement` feature, off by default, because analysis and testing spend the tenant's model usage. The admin console lists it automatically. The portal's *Improve* page shows performance by version, findings with evidence, the proposed change as a diff against what's live, test results, and the approve/reject controls.
- **Tests:** detector and metric unit tests, proposer robustness tests, 16 end-to-end tests (feature gating, tenant scoping, diagnosis, idempotent re-analysis, proposals, the test bench including a deliberate regression, approval rules, owner-only decisions, and abandonment recording through a real WebSocket), plus component tests for the diff, the proposal card and the page.

**Built: the measured "improves with every run" experiment** (`pnpm --filter @envoy/api experiment`).
- **Design:** a seeded population of simulated visitors (open, reluctant, hardline), the *same* visitors in every round, meets the agent; the real detectors diagnose what went wrong; the real proposer drafts a fix; the product's own regression guard (cooperative visitors must still complete, hard rules untouched) decides whether it is adopted; and the next round measures again. In the product a person approves each change; in the experiment the guard stands in, which is the one difference.
- **Statistics:** Wilson intervals for completion; a paired design (identical visitors across versions) judged with an exact McNemar test, which only counts visitors whose outcome flipped; Newcombe intervals for the change; seeded bootstrap intervals for messages-to-finish and field capture; and a verdict that says "improved" only when both the interval excludes zero and the test agrees, otherwise "no clear difference". The distribution functions are checked against published values.
- **Visitors:** a deterministic rule-based visitor (reproducible, free, tests the harness) and a language-model-played visitor for live evaluation; both are seeded personas with facts, a temperament and a patience.
- **Report:** Markdown with per-round completion and intervals, whether each change was real, what was found and adopted (the actual change and its safety check), why it stopped, limits, and the exact command to reproduce.
- **Safety:** nothing is saved or sent (it uses the same sandbox as the playground); it makes no workspace usage records; and it **refuses to run against any real model without `EXPERIMENT_CONFIRM_COST=yes`**, after printing roughly how many model calls it will make.
- **What the shipped result means:** `docs/experiments/improvement-loop-mock-rule.md` (200 visitors per round, mock model, rule visitors) shows completion 58% → 90% (+31.5 points, 95% CI +23.2 to +39.3, p < 0.001, 63 visitors improved and 0 worsened). Because the model and visitors are scripted and the world was built around exactly this problem, this proves the **measurement and improvement loop works**; it is **not evidence about real models or real people**, and the report says so at the top. The same command with a real model and `EXPERIMENT_VISITOR=llm` produces the evidence; that run has not been done.
- **Tests:** statistics against known values, visitors, report content (including that a non-significant change is never called an improvement and that a synthetic run is always labelled), and 18 end-to-end tests of the real engine, agent, detectors and proposer under the runner (reproducibility from a seed, paired comparison sees a real effect and sees none when nothing changed, the loop adopts a fix and measures it, a harmful change is rejected, a proposer failure is handled, and more turns than the product's daily simulation limit are allowed).

**Not built yet:** per-conversation LLM-judge scoring and visitor/tenant feedback controls (thumbs up/down); scheduled or automatic analysis (it runs when asked); live A/B rollout of a proposal to a share of traffic with automatic promotion; per-agent lesson memory and opt-in cross-tenant templates; proposals that change fields, tools or goals (deliberately out of scope for an AI-drafted, unreviewed change); running that experiment with a real model and language-model visitors (the harness for it is built, see below; only the live run is not done). Analysis reads up to the 5,000 most recent finished conversations in the window.

**Problem.** An agent's script, field prompts and hard rules are written once by the tenant and then stay static. Real conversations expose problems the tenant never anticipated: visitors abandon at a certain question, the agent misreads a field, a hard rule fires constantly, or the summary misses key details. Today nobody systematically learns from those runs.

**Idea.** A **harness** around every agent that records each run, scores it, finds recurring failure patterns, proposes concrete improvements, tests them against past conversations, and rolls out the winners. The loop is: **run → record → evaluate → diagnose → propose → test → approve → deploy → measure.**

**What the harness captures per run (most of it already exists in the schema)**

| Signal | Source today |
|---|---|
| Completion vs. abandonment, and where the visitor dropped off | `Conversation.status`, transcript |
| Fields captured vs. fields required, and validation failures | `capturedData`, field validators |
| Rule violations the judge blocked | `ruleViolationsBlocked` |
| Outcome reached (demo booked, order, complaint, appointment) | `outcomeType` |
| Turn count, latency, token cost | to be recorded |
| Downstream result: lead pushed to CRM, replied to follow-up, converted | CRM/integration status, future workflow runs |
| Visitor feedback (thumbs up/down, optional) | new widget control |
| Tenant feedback on a lead (good/bad lead, corrected field values) | new portal control |

**Components**

1. **Run recorder.** Stores a structured trace of every conversation: each prompt, candidate reply, judge verdict, extraction result and timing. This is the raw material for everything below.
2. **Evaluator.** Scores each run automatically using cheap deterministic metrics (completion, fields captured, turns, violations) plus an LLM-as-judge pass for quality (tone, helpfulness, accuracy against the script). Scores are stored per conversation and aggregated per agent.
3. **Diagnoser.** Clusters low-scoring runs and names recurring problems, for example "42% of visitors leave when asked for a phone number" or "the agent keeps asking for a field already given."
4. **Proposer.** An LLM drafts targeted changes to the agent configuration: a revised script paragraph, a better field `prompt` hint, a reordered question, a new hard rule, or new quick replies. Each proposal carries the evidence (the conversations that motivated it).
5. **Offline test bench (replay).** Candidate configs are replayed against a saved set of past conversations (the visitor messages are reused, the agent's replies are regenerated) and compared with the current version on the same metrics, before any visitor sees the change.
6. **Versioning.** Agent config becomes versioned (`AgentVersion`), so every change is diffable and one-click reversible.
7. **Controlled rollout.** The winner can be served to a small share of traffic (A/B) and promoted only if live metrics confirm the offline result.
8. **Memory of lessons.** Approved lessons are stored per agent (and optionally as anonymised, opt-in templates across the platform) and fed into the stable prompt prefix, so improvements accumulate.

**Design on the current architecture**
- **Data model (new):** `AgentVersion` (agentId, config snapshot, parent, status, createdBy human/AI), `RunTrace`, `RunScore`, `Insight` (diagnosed issue plus evidence), `Proposal` (diff, rationale, test results, status pending/approved/rejected/live), `Experiment` (variants, traffic split, results).
- **Hook points:** the conversation engine already produces every signal; the harness adds a trace write at the end of each turn and an evaluation job enqueued from the same completion path as the transcript/summary pipeline, on its own BullMQ queue.
- **Provider reuse:** evaluation and proposal calls use the existing `LlmProvider` abstraction, so the mock provider keeps the feature demoable offline and a stronger model can be used for judging than for chatting.
- **Safety: the harness never edits a live agent on its own.** Proposals are shown in the portal as a diff with evidence and test results, and a tenant owner approves them. Hard rules can be added by the harness but never removed or weakened automatically. Judge and proposer prompts treat visitor text as untrusted data to resist prompt injection.
- **Privacy:** traces inherit the tenant's retention policy and deletion/export rules; cross-tenant learning is opt-in only and uses anonymised, aggregated patterns, never raw conversations.
- **Access and billing:** new `improvement` feature flag (off by default); evaluation and replay LLM usage is metered and priced through `PriceConfig`, since replay runs cost real model calls.
- **Admin:** operator view of harness activity per tenant, cost, and a kill switch.

**Portal UI**
- *Performance* tab per agent: completion rate, average fields captured, drop-off by question, violations over time, score trend across versions.
- *Insights* feed: plain-language findings with links to example conversations.
- *Suggestions* queue: proposed changes with side-by-side diff, test-bench results ("completion +9%, violations 0"), and Approve / Edit / Reject.
- *Version history* with compare and rollback, and an experiments view.

**Suggested phases**
1. *Observe:* run recorder, deterministic metrics, and the Performance dashboard. No AI changes yet.
2. *Evaluate and diagnose:* LLM-as-judge scoring, clustered insights, and visitor/tenant feedback controls.
3. *Propose and test:* proposer, `AgentVersion`, replay test bench, and the human approval flow.
4. *Optimise:* A/B rollout with automatic promotion, per-agent lesson memory, and opt-in cross-tenant templates.

**Suggested functional requirements (for the SRS)**
- **FR-IMP-1** The system records a structured trace and metrics for every conversation.
- **FR-IMP-2** Each conversation is scored automatically; scores aggregate per agent and per version.
- **FR-IMP-3** The system identifies recurring failure patterns and presents them with example conversations.
- **FR-IMP-4** The system proposes configuration changes with supporting evidence.
- **FR-IMP-5** Proposals are tested by replaying past conversations before approval, with a comparison to the current version.
- **FR-IMP-6** Agent configurations are versioned, comparable and reversible.
- **FR-IMP-7** No change goes live without explicit tenant approval; hard rules are never removed or weakened automatically.
- **FR-IMP-8** Tenants can run an A/B experiment between two versions and promote the winner.
- **FR-IMP-9** Harness usage is gated by the `improvement` flag and metered for billing.
- **FR-IMP-10** Harness data follows the tenant's retention, export and deletion policy.

**Evaluation of the feature itself (useful for the FYP report)**
Measure the harness by running a fixed set of simulated visitors (scripted personas) against an agent's version 1 and its harness-improved version N, and compare completion rate, fields captured, turns to completion, rule violations and judge score. A positive, repeatable lift across versions is the project's evidence that "agents improve with every run." Also report the failure cases (changes that did not help or were rejected) honestly.

**Risks to discuss**
- Overfitting to a few conversations, mitigated by minimum sample sizes and replay on a held-out set.
- LLM-judge bias or error, mitigated by deterministic metrics alongside it and by human approval.
- Cost of replay and evaluation, mitigated by sampling, caching and metering.
- Prompt injection through visitor messages reaching the proposer, mitigated by treating transcripts as data and by the approval gate.

### 17.5 Planned feature: Bring Your Own Model Keys (BYOK), recommended for best performance

#### 17.5.0 Implementation status (updated 2026-11-24)

**Built and tested (phases 1 and 2, LLM only):**
- **Keys:** `ModelCredential` per tenant. Providers: Anthropic, OpenAI, Google Gemini, Groq, and any OpenAI-compatible endpoint (custom base URL, SSRF-guarded). Keys are AES-256-GCM encrypted at rest, write-only (only the last 4 characters are ever returned), never logged or placed in traces, and verified with a real test call before saving (a failed test stores nothing and never echoes the key). Max 10 per workspace; all key changes are audited without the key.
- **Routing:** the `LLM_PROVIDER` that every call site already injects is now a router. A per-run context (async local storage) names the tenant, so replies, rule checks, data extraction and the post-conversation summary all use the tenant's key and model for that role, with no call-site changes. Resolution order: the agent's own override, then the workspace's per-role choice, then the workspace default, then the shared platform model. A credential id belonging to another tenant resolves to nothing, even if written into an agent spec.
- **Roles and presets:** `chat`, `judge`, `extract`, `summarize`, each with its own key and model; presets (Best quality, Balanced, Lowest cost) fill them from a per-provider catalog; any model id can be typed.
- **Resilience:** on a rejected key (401/403) the credential is marked invalid; on rejection, quota/rate limit, provider outage or network error the call is answered from the shared model when the tenant allows it (default), otherwise the failure surfaces. A malformed request (400) is never retried on another model.
- **Usage:** every call records provider, model, role, key source, tokens (when the provider reports them), latency and success; `GET /models/usage` summarises it. Agent run traces now show which key and model answered each step.
- **Recommendation (decision recorded in 17.5.2):** the shared default stays the zero-setup default. The portal shows a persistent banner on every dashboard page until a working key serves the workspace, a "Running on" badge on each agent with an extra warning for agentic agents, a dedicated *AI models* page, and a per-agent model override in the behavior editor.
- **Access:** anyone in the workspace can see which model is serving them; only the owner can add, test, remove or reassign keys.
- **Tests:** routing, resolver, OpenAI-compatible and Anthropic wire format, key-safe error messages, 14 end-to-end tests (storage and encryption, rejected keys, SSRF, owner-only, tenant scoping, serving on the tenant's key, per-agent override, failover and invalid flagging, fallback disabled, cross-tenant key in an agent spec, summaries on the tenant's key, deletion, re-test, audit), banner and editor component tests.

**Not built yet:** voice (STT/TTS) BYOK; per-key monthly spend/token caps and per-conversation budgets; a circuit breaker; encryption key versioning and rotation; enforcing the tighter limits on the shared model that 17.5.2 allows (the gap is currently communicated, not enforced); a side-by-side model comparison in a simulator; a capability registry that blocks a model unsuited to tool calling; Azure/Bedrock/Vertex native adapters (reachable only through an OpenAI-compatible gateway). Anthropic, OpenAI and Gemini adapters are covered by wire-format unit tests but have not been run against the live providers.

**Not built yet.** Today the LLM, STT and TTS providers are single process-wide instances chosen by env vars (`LLM_PROVIDER`, `STT_PROVIDER`, `TTS_PROVIDER`) and use the platform's own keys; the default is the mock. Every tenant therefore gets the same model, and the platform pays for all inference.

**Idea.** Let each tenant (and optionally each agent) connect **their own API keys** for the model providers they pay for, and choose the models, so agents run on the best available paid model. The portal **recommends** this setup and guides the tenant through it, because agent quality (instruction following, tool use, rule compliance, voice naturalness) depends heavily on the model.

**Why it matters**
- **Better performance:** the agentic runtime (17.1) with tool calling, goals and a judge benefits most from strong models; free or small default models are the weakest link.
- **Cost transparency and control:** inference is billed by the provider to the tenant's own account, so the platform does not carry or resell model cost; Envoy's usage pricing can focus on platform value.
- **Choice and compliance:** tenants pick the provider and region that fit their data policies, or an enterprise endpoint (Azure OpenAI, Bedrock, Vertex, self-hosted).
- **Scalability:** tenant keys come with their own rate limits, so one busy tenant does not exhaust a shared platform key.

#### 17.5.1 What a tenant can configure

| Setting | Detail |
|---|---|
| **Provider connections** | Add keys for Anthropic, OpenAI, Google Gemini, Groq, Azure OpenAI, AWS Bedrock/Vertex, Mistral/other OpenAI-compatible endpoints (custom base URL), and for voice: Whisper/Deepgram (STT), ElevenLabs/OpenAI/Gemini (TTS). |
| **Model per role** | Separate model for `chat`, `planner`, `extractor`, `judge`, `summarizer`, `proposer` (17.4), `stt`, `tts`. Strong model for chat and judge, cheaper model for extraction and summaries. |
| **Scope** | Workspace default, with optional per-agent override. |
| **Fallback** | An ordered fallback list (e.g. tenant's Anthropic key, then platform default) used on rate-limit or outage, with a clear setting for whether fallback to the platform's models is allowed. |
| **Limits** | Optional monthly spend or token cap per key, and a per-conversation budget, enforced by the harness. |
| **Parameters** | Temperature, max tokens, reasoning/thinking effort, where the provider supports them. |
| **Health** | "Test connection" button, key status (valid, rate-limited, quota exhausted, revoked), last-used time. |

#### 17.5.2 Recommendation experience (the "should be recommended" requirement)

- During onboarding and on the agent page, a **"Recommended: connect your own model key"** card explains the benefit in plain language and shows a **model-quality indicator** for the current setup (e.g. "Platform default model: basic. Your own key unlocks tool use and higher accuracy").
- **Recommended presets** per use case, e.g. *Best quality*, *Balanced*, *Lowest cost*, *Voice-first*, each mapping roles to concrete models.
- The agent **simulator and scenario suite (17.1.7)** can show a side-by-side comparison of the same scenarios on the default versus the tenant's chosen model (completion rate, rule violations, cost), so the recommendation is backed by evidence.
- **Capability gating with guidance:** features that need strong tool calling or long context (some tools, multi-step loops, the improvement harness) warn when the selected model is too weak and suggest an upgrade instead of failing silently.
- **Decision (current phase): the platform's default model stays the default for every new tenant, and BYOK is very strongly recommended.** A tenant can start with zero setup, but the product consistently pushes them to connect their own key for good results (the mock still exists for demos and tests). Concretely:
  - A persistent, prominent banner on the dashboard and agent page until a key is connected ("You're on the shared default model. Results will be noticeably weaker. Connect your own key.").
  - A mandatory-looking but skippable step in onboarding, and a checklist item on the getting-started panel.
  - A visible "Running on: shared default model" badge in the simulator, trace viewer and agent settings, with a one-click path to connect a key.
  - Honest in-product quality warnings (e.g. weaker tool use, lower rule-compliance and extraction accuracy) wherever the default model limits a feature.
  - The platform default may have tighter limits (smaller context, lower rate limits, fewer steps per turn, advanced features such as the improvement harness limited or in preview) so the gap is real and explained, not hidden.
  - Revisit later: if inference cost becomes a problem, move to requiring a tenant key for premium agentic features, or sell platform-managed premium models as a paid add-on.

#### 17.5.3 Architecture

- **From singleton to per-request resolution.** Replace the single `LLM_PROVIDER` injection with a `ModelRouter` that resolves, for each call, `(tenant, agent, role)` to a provider instance plus model and credentials. The existing `LlmProvider`, `SttProvider` and `TtsProvider` interfaces stay as they are; new adapters implement them (Anthropic, OpenAI, OpenAI-compatible).
- **Capability registry:** each model declares what it supports (tool calling, JSON mode, streaming, context window, vision, audio) so the harness picks a compatible loop and warns when a feature is unsupported.
- **Secret handling:** keys are encrypted at rest with the same AES-256-GCM scheme already used for CRM tokens (`token-crypto.ts`), with a key-versioning field to allow rotation. Keys are **write-only in the UI** (only the last 4 characters shown), never returned by any API, never logged, never sent to the browser, never placed in prompts, traces or the MCP server (17.2) output. Decrypted in memory only for the duration of a call.
- **Validation:** keys are verified with a cheap provider call when saved; custom base URLs go through the existing `safe-fetch` SSRF protection so a tenant cannot point the platform at internal addresses.
- **Resilience:** per-key circuit breaker, retry with backoff, and fallback chain; provider errors are translated into clear tenant-facing messages ("your key is out of quota").
- **Metering:** token usage and estimated cost are recorded per call and per key whether the tenant's key or the platform's key was used. Platform-key usage feeds billing (`PriceConfig`); BYOK usage is shown for the tenant's information and spend caps, not billed by Envoy.
- **Enforcement points:** the conversation engine, field extractor, rule judge, summary pipeline, voice pipeline, improvement harness and simulator all obtain their provider through the router, so BYOK applies uniformly.

#### 17.5.4 Proposed data model additions

`ModelCredential` (tenantId, provider, label, encrypted key, key version, base URL?, status, last4, lastUsedAt, spendCap, createdBy), `ModelProfile` (tenantId, optional agentId, role to credential and model mapping, parameters, fallback order), `ModelUsage` (tenantId, agentId, conversationId, role, provider, model, tokens in/out, estimated cost, latency, keySource `tenant`|`platform`), and an audit entry for every credential create, rotate and delete.

#### 17.5.5 Security and privacy considerations

- Key theft risk is the main concern: encryption at rest, write-only UI, role restriction (only `owner` can add or view status), audit on every change, rotation support, and one-click revoke.
- Do not let platform admins read tenant keys; the operator console shows only status and last4.
- Tenant data is sent to the provider the tenant chose; the tenant is told this clearly, and data-processing notes are shown per provider.
- Leaked-key blast radius is limited by spend caps and per-key rate limits.
- Prompt and trace storage must exclude secrets.

#### 17.5.6 Suggested phases

1. **Single-provider BYOK:** `ModelCredential` and encrypted storage, `ModelRouter` with workspace-level default, support for the providers already in the code (Groq, Gemini) plus one new adapter (Anthropic or OpenAI), "test connection", and usage logging.
2. **Roles and recommendations:** per-role model mapping, presets, the recommendation cards, capability registry with warnings.
3. **Per-agent overrides and resilience:** agent-level profiles, fallback chains, circuit breaker, spend caps.
4. **Voice and custom endpoints:** STT/TTS BYOK, OpenAI-compatible and enterprise endpoints, evidence-based model comparison in the simulator.

#### 17.5.7 Suggested functional requirements (for the SRS)

- **FR-BYOK-1** A tenant owner can add, test, rotate and delete model-provider API keys for LLM, STT and TTS.
- **FR-BYOK-2** Keys are encrypted at rest, write-only in the UI, and never exposed through any API, log, trace, prompt or MCP output.
- **FR-BYOK-3** A tenant can choose the model per role at workspace level and override it per agent.
- **FR-BYOK-4** The system resolves the provider and credentials per call for every AI function (chat, extraction, judge, summary, voice, harness).
- **FR-BYOK-5** The tenant can define a fallback order and whether fallback to the platform's models is permitted.
- **FR-BYOK-6** The portal very strongly recommends connecting an own key (persistent banner, onboarding step, checklist, "running on shared default" badges) and offers recommended model presets, while keeping the platform default model as the zero-setup default; it shows capability warnings for unsuitable models.
- **FR-BYOK-11** The platform default model applies documented limits (context, rate, steps per turn, advanced-feature availability) that are disclosed to the tenant in the product.
- **FR-BYOK-7** Tenant can set spend or token caps; the harness enforces them and surfaces provider errors clearly.
- **FR-BYOK-8** Usage and estimated cost are recorded per call with the key source; only platform-key usage is billed by Envoy.
- **FR-BYOK-9** Custom provider base URLs are validated and fetched through SSRF protection.
- **FR-BYOK-10** All credential changes are audited; platform admins cannot view key values.

#### 17.5.8 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stored key leaks | AES-256-GCM, key versioning, write-only UI, owner-only access, no key in logs/traces, spend caps, revoke. |
| Weak or incompatible model degrades behaviour | Capability registry, warnings, presets, simulator comparison, safe fallback. |
| Provider outage or quota exhaustion mid-conversation | Circuit breaker, fallback chain, clear visitor-facing fallback message. |
| Inconsistent behaviour across providers | Provider adapters behind one interface, scenario regression suite per model profile, mock for tests. |
| Cost surprises for the tenant | Spend caps, per-call usage display, per-conversation budgets. |
| SSRF via custom base URL | Reuse `safe-fetch`, block private ranges. |

#### 17.5.9 How to evaluate this for the FYP report

Run the same scripted-visitor scenarios on the platform default model and on one or more tenant-supplied stronger models, and compare goal completion, field accuracy, rule violations reaching the visitor (target zero), tool-call success, latency and cost per conversation. This gives measured evidence for the "recommended" guidance. Also test that keys never appear in any API response, log, trace or MCP output, and that a revoked or exhausted key degrades gracefully to the configured fallback.

### 17.6 Other planned enhancements

- **Mobile app (Expo):** tenant owners get push notifications for new leads and can read conversations on the go.
- **Real-time voice:** streaming/chunked audio, hold-to-talk, Web Speech fallback, and recording voice conversations with `channel = "voice"`.
- **More CRM providers:** Salesforce, Zoho, Pipedrive.
- **Analytics dashboards:** conversion by outcome type, funnel drop-off, per-agent performance; A/B testing of agent scripts.
- **Shared `@envoy/ui` component library** to replace per-app components.
- **Multi-language agents** and automatic language detection.
- **Additional channels:** WhatsApp, Facebook Messenger, SMS-inbound conversations with the same agent engine.
- **Human handoff:** live-agent takeover when a rule with `escalate` fires, with an inbox for staff.
- **Knowledge base (RAG):** let agents answer from tenant documents and website content.
- **Test infrastructure:** per-test-file queue names for full isolation.

---

## 18. Suggested Mapping to Other FYP Documents

| Document | Pull from sections |
|---|---|
| **Project proposal** | 1, 2, 3, 4, 5, 17.1 to 17.6 |
| **SRS** | 6, 8, 9, 11, 12 |
| **SDD / architecture** | 7, 10, 11, 12, 13 |
| **Final report** | all; chapters: Introduction (1–5), Design (7, 10), Implementation (8, 11–13), Testing (14), Challenges (16), Conclusion (17) |
| **Test plan / report** | 9, 14 |
| **User manual** | 12, 13, 15 |
| **Presentation / poster** | 2, 3, 7.3, 12.3, 16 |
| **Diagrams to draw** | Use-case (6, 8), architecture (7.3), ERD (10), sequence (12.3, 12.5), state machine (billing: active → past_due → locked → active) |

---

## 19. Items for You to Fill In **[Verify]**
Student names and IDs, supervisor, university, department, course code, submission dates, project title wording, literature review and competitor comparison (e.g. Intercom, Drift, Tidio), user-evaluation results, screenshots, and the final deployment URL.
