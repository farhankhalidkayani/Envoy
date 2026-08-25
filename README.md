# Envoy

Multi-tenant SaaS for deploying branded, rule-governed AI chat/voice agents on client websites. See the build plan artifact for full architecture; this file covers local setup only.

## Prerequisites

- Node 22+
- pnpm 10+ (`corepack enable` or `npm i -g pnpm`)
- Docker (for local Postgres + Redis)

## First-time setup

```bash
cp packages/db/.env.example packages/db/.env
cp apps/api/.env.example apps/api/.env

docker compose up -d          # Postgres :5432, Redis :6379

pnpm install
pnpm db:migrate                # applies prisma/migrations, generates the client
```

## Everyday commands

```bash
pnpm dev          # runs every app/package's dev task via Turborepo
pnpm build        # builds everything
pnpm typecheck     # tsc --noEmit across the workspace
pnpm test          # vitest across the workspace (needs Postgres + Redis running)
pnpm db:studio     # Prisma Studio GUI
```

Ports once `pnpm dev` is running: `api` on `:4000`, `widget` (Vite) on `:5173`, `portal` on `:3001`,
`admin` on `:3002`. (Portal defaults to 3001, not 3000 — a common local dev collision with other
projects; change it in `apps/portal/package.json` if you'd rather free up 3000.)

## Try it locally

### Business portal — the primary path

With `pnpm dev` running, open `http://localhost:3001/register`, create a workspace, then create and
publish an agent — the detail page shows a copy-pasteable embed snippet with a real `publicToken`.
Open `http://localhost:5173/demo.html?token=<publicToken>` in another tab to try the widget as a
visitor would see it; the conversation shows up in the portal's Conversations tab once it completes,
transcript and AI summary included (generated async — refresh after a moment).

With `LLM_PROVIDER=mock` (the default), the agent deterministically asks for each `requiredFields`
entry in order, then completes.

### Operator console

The admin app (`http://localhost:3002`) requires a `platform_admin` account, which has no signup UI —
mint one via the bootstrap endpoint (gated by `ADMIN_BOOTSTRAP_SECRET` in `apps/api/.env`):

```bash
curl -s -X POST http://localhost:4000/auth/register-admin -H "Content-Type: application/json" \
  -d '{"email":"you@envoy.test","password":"hunter22","bootstrapSecret":"dev-only-bootstrap-secret"}'
```

Sign in at `/login` with those credentials to see the tenant list, pause/resume/revoke, per-user
feature-access toggles, custom pricing, and the audit log.

### Simulating billing state changes

No real Stripe account is wired up (see below) — simulate webhook-driven lock/unlock directly:

```bash
curl -s -X POST http://localhost:4000/webhooks/stripe -H "Content-Type: application/json" \
  -d '{"type":"invoice.payment_failed","data":{"object":{"customer":"local_<tenantId>"}}}'
# first call → past_due (grace period); a second call → locked
curl -s -X POST http://localhost:4000/webhooks/stripe -H "Content-Type: application/json" \
  -d '{"type":"invoice.paid","data":{"object":{"customer":"local_<tenantId>"}}}'
# → active again, instantly
```

Every tenant gets a `local_<tenantId>` stand-in Stripe customer ID at signup specifically so this
works without a live Stripe integration — see `BillingService.ensureSubscription`.

### Raw API walkthrough (if you'd rather skip the UI)

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/auth/register -H "Content-Type: application/json" \
  -d '{"tenantName":"Acme Co","email":"you@acme.test","password":"hunter22"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

AGENT=$(curl -s -X POST http://localhost:4000/agents -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -d '{
    "name": "Support Bot",
    "requiredFields": [{"key":"email","label":"Email","type":"email","required":true}],
    "hardRules": [{"id":"no-guarantees","text":"Never promise guaranteed refunds","action":"block","severity":"high"}]
  }')
AGENT_ID=$(echo "$AGENT" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

curl -s -X PATCH http://localhost:4000/agents/$AGENT_ID -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -d '{"status":"live"}'
```

## Repo layout

```
apps/
  api/      NestJS backend — REST + WebSocket + BullMQ workers
  portal/   client business web portal (Next.js) — register, configure agents, view conversations, billing
  admin/    platform operator console (Next.js) — tenants, access control, pricing, audit log
  widget/   embeddable chat widget (Vite/Preact), iframe-isolated + a vanilla-JS loader
  mobile/   Expo app — not yet scaffolded
packages/
  db/       Prisma schema + generated client, imported as @envoy/db
  types/    Zod contracts shared by every surface, imported as @envoy/types
  sdk/      typed fetch client shared by portal + admin, imported as @envoy/sdk
  ui/       shared components — not yet built (portal/admin use plain inline styles for now)
  config/   shared tsconfig
```

## What's built so far

### Phase 0 — foundations

- Full Prisma schema (Tenant, User, Agent, Conversation, CrmConnection, Subscription, AuditLog)
- `@envoy/types`: Zod contracts for required-fields (with a dynamic validator builder), hard rules,
  feature access, widget config, price config, and the widget↔engine WebSocket protocol
- `@envoy/api` core: JWT auth (register/login), `JwtAuthGuard`, `TenantScopeGuard`, `RolesGuard`,
  `FeatureGuard`
- **The load-bearing test**: `apps/api/src/modules/agent/agents.service.isolation.test.ts` — tenant A
  can never read, list, or mutate tenant B's rows, verified against a real Postgres instance

### Phase 1 — the vertical slice (agent engine + widget)

- **LLM provider layer** (`apps/api/src/modules/agent/providers/llm/`) — a shared `LlmProvider`
  interface with three implementations: `MockLlmProvider` (deterministic, zero external
  dependencies — the default, so everything below is testable and demoable with no API key),
  `GroqLlmProvider`, `GeminiLlmProvider` (real HTTP calls, gated behind `GROQ_API_KEY`/
  `GEMINI_API_KEY`, code-complete but not live-tested here). Selected via `LLM_PROVIDER` env var.
- **Prompt assembly** (`prompt/system-prompt.builder.ts`) — split into a stable prefix (agent
  script + required fields + hard rules — identical across a given agent's conversations, the
  cacheable part) and a volatile suffix (captured-data-so-far).
- **Two-layer rule enforcement** (`rules/rule-enforcer.service.ts`) — layer 1 is prompt
  instructions; layer 2 is a post-generation judge call that runs *before* anything reaches the
  visitor. A `block` violation gets one regeneration attempt with explicit feedback, falling back
  to a generic safe reply if the retry also violates; every violation is logged to
  `Conversation.ruleViolationsBlocked` regardless. The engine is deliberately non-streaming to the
  client for this reason — there's no way to retract a token that already violated a hard rule.
- **Structured capture** (`capture/field-extractor.service.ts`) — a separate extraction pass per
  turn, validating each extracted value against its own field-type schema
  (`@envoy/types`'s `validateFieldValue`) before merging into `capturedData`.
- **Conversation engine** (`conversation/`) — Redis-backed live session state
  (`ConversationSessionStore`), turn orchestration (`ConversationEngineService`), and Postgres
  persistence (`ConversationsService`). Completion detection via a model-emitted marker, parsed
  and stripped before the reply is shown.
- **WebSocket gateway** (`gateway/agent.gateway.ts`) — a raw `ws` server attached directly to the
  HTTP server's `upgrade` event at `/ws/agent/:agentId`, implementing the `ClientMessage`/
  `ServerMessage` protocol from `@envoy/types` exactly (NestJS's `@WebSocketGateway` is
  socket.io-shaped and doesn't map cleanly onto a raw path-parameterized route).
- **Async pipeline** (`apps/api/src/modules/pipeline/`) — BullMQ queue + worker, on its own Redis
  connection (kept separate from session-state Redis to avoid BullMQ's blocking-connection
  footgun). Assembles the transcript and generates the AI summary *after* the completion request
  returns, never blocking it.
- **The engine's load-bearing test**: `apps/api/src/modules/agent/agent-engine.e2e.test.ts` —
  boots the real Nest app, drives two real WebSocket conversations against the mock provider: one
  proving full field collection → completion → async transcript/summary persistence, one proving a
  hard-rule violation is caught, blocked, and never reaches the visitor while still being logged.
- **Widget** (`apps/widget/`) — a Preact chat app (the iframe's document), a dependency-free
  vanilla-JS loader (`public/loader.js`, what a client site actually embeds), and a demo "client
  site" (`public/demo.html`) that embeds it the same way a real tenant would. Verified end-to-end
  in a real headless Chrome session: custom `widgetConfig` (color, greeting) rendering correctly,
  a full conversation driven by actual clicks/typing, and the completion banner disabling input.

### Phase 2 — the operator layer (billing/lock engine, portal, admin console)

- **Billing/lock engine** (`apps/api/src/modules/billing/`) — `BillingService` is the state
  machine: `invoice.payment_failed` moves an active tenant to `past_due` (grace period), a second
  failure while already `past_due` locks it; `invoice.paid` restores `active` instantly. The lock
  only ever flips `Tenant.subscriptionStatus` — no Agent rows are mutated — because enforcement is
  centralized in two places instead of scattered: `TenantLockGuard` (423 on ordinary tenant API
  routes; billing and admin routes are deliberately exempt) and the WS gateway's existing
  session-start check (in-flight conversations finish; new ones see `{type: "locked"}`).
- **Stripe webhook receiver** (`stripe-webhook.controller.ts`) — real signature verification via
  `stripe.webhooks.constructEvent()` when `STRIPE_WEBHOOK_SECRET` is set (needs `rawBody: true` on
  `NestFactory.create`, wired in `main.ts`); trusts the raw JSON payload unverified when unset —
  the same "code-complete, not live-tested" posture as the Groq/Gemini providers (no Stripe test
  account available here). Every tenant gets a `local_<tenantId>` stand-in Stripe customer ID at
  signup (`BillingService.ensureSubscription`) specifically so the whole lock/unlock chain is
  testable by POSTing plain webhook-shaped JSON — see "Simulating billing state changes" above.
- **Admin API** (`apps/api/src/modules/admin/`) — tenant list/detail, pause/resume/revoke (a
  soft-cancel — the row is never deleted), per-user feature-access editing, custom pricing, and an
  audit log. Every mutating action writes an `AuditLog` row with the acting admin's ID — this is
  the graded per-feature-access-control differentiator, so it needs to be attributable, not just
  effective. `POST /auth/register-admin` (gated by `ADMIN_BOOTSTRAP_SECRET`) is the deliberately
  narrow door for minting the first `platform_admin` — there's no open signup flow for operators.
- **`@envoy/sdk`** — a typed fetch client shared by both Next.js apps (auth, agents, conversations,
  billing, admin), so portal and admin call the exact same methods rather than each hand-rolling
  fetch calls.
- **Portal** (`apps/portal/`) — register/login, agent CRUD with a dynamic required-fields/hard-rules
  builder, the embed snippet with a real `publicToken`, a conversation dashboard (list + detail with
  captured data / transcript / AI summary), and a billing page. A locked-tenant banner renders
  globally in the dashboard layout once `GET /billing/subscription` reports `locked`.
- **Admin console** (`apps/admin/`) — a visually distinct operator surface (separate app, separate
  port, different accent color) requiring `platform_admin`: tenant list with pause/resume/revoke,
  a pricing editor (falls back to the subscription's current rate when no custom override has been
  set yet — `Tenant.priceConfig` starts as `{}`), per-user feature-access toggles, and the audit log.
- **The load-bearing test**: `apps/api/src/modules/billing/billing-and-admin.e2e.test.ts` — 12
  assertions covering the full lock/unlock chain (including a live WS check that a locked tenant's
  agent rejects new sessions) and the full admin surface (list, pause/resume, feature access,
  pricing, revoke, audit log, and that a non-admin gets 403).
- **Verified in real browsers**, not just against the API: registering through the portal,
  building an agent with the dynamic field/rule UI, publishing it, driving a real conversation
  through the widget in a second tab, and confirming it appears correctly back in the portal
  dashboard (captured data, transcript, AI summary) — the full product loop, closed. Separately,
  the entire admin console: login, pause (with a live 423 check against the tenant owner's real
  token), resume, pricing edits, feature-access toggles, and the audit log recording all of it.

### Phase 3a — CRM integration (`apps/api/src/modules/crm/`)

- **Provider abstraction** — same pattern as the LLM providers: a `CrmProvider` interface
  (`pushRecord`) with `MockCrmProvider` (deterministic; fails on demand via a
  `FORCE_CRM_FAILURE` field-value sentinel, for exercising the failure path in tests) and a
  code-complete `HubspotCrmProvider` (real Contacts API), selected via `CRM_PROVIDER` env var
  (defaults to mock — no live HubSpot account was available here, same "code-complete, not
  live-tested" posture as Stripe and Groq/Gemini).
- **Mock-mode connect** — `CrmService.initiateConnect` skips the OAuth redirect entirely and
  connects immediately when `HUBSPOT_CLIENT_ID` is unset, storing an encrypted placeholder
  token. This is what lets the full connect → map fields → push flow be exercised end-to-end in
  dev and tests without a live HubSpot app registration; the real OAuth authorize/callback code
  path is written and correct against HubSpot's documented shape but untested live.
- **Token encryption** — `CrmConnection.oauthTokens` is AES-256-GCM encrypted at rest
  (`token-crypto.ts`, `CRM_TOKEN_ENCRYPTION_KEY`), format `iv:authTag:ciphertext`.
- **Async, off the request path** — conversation completion enqueues a CRM push onto its own
  BullMQ queue (`CrmQueueService`/`CrmPushProcessor`), mirroring the existing transcript/summary
  pipeline queue. A completed conversation never waits on a third-party API call; `crmPushedAt`/
  `crmExternalId`/`crmPushError` on `Conversation` record the outcome for the portal to show, and
  a failed push can be retried manually from the conversation detail page.
- **Field mapping** — tenants map their agent's required-field keys to CRM property names
  (`CrmConnection.fieldMapping`); unmapped fields push through under their original key.
- **Portal UI** — a new CRM settings page (connect/disconnect, dynamic field-mapping editor) and
  a CRM status card on the conversation detail page (pushed/failed/not-connected pill + a
  manual re-push button), both gated behind the `crm` feature flag (off by default —
  `DEFAULT_FEATURE_ACCESS`) with a clear "ask your admin" message when not granted.
- **Verified end-to-end in a real headless Chrome session**: registered a tenant, granted the
  `crm` feature via the admin API, connected CRM in mock mode through the portal UI, saved a
  field mapping, drove a real conversation to completion over the raw WS protocol, confirmed the
  conversation detail page rendered the "pushed" status with the captured field automatically
  (no manual trigger), and confirmed the manual re-push button works too.
- **The load-bearing test**: `apps/api/src/modules/crm/crm.e2e.test.ts` — 6 assertions covering
  not-connected-by-default, mock-mode connect, field-mapping updates, auto-push on conversation
  completion, manual re-push after a forced failure, and 403 for a tenant without the feature.
- **Known test-infra limitation, not fixed**: e2e test files that boot their own Nest app each
  run their own BullMQ worker against the same shared dev Redis/queue names; under concurrent
  test-file runs a stray retry from one file can occasionally log a (harmless) Prisma error for a
  row a different file's cleanup already deleted. Confirmed via repeated full-suite runs this
  never fails a test — full isolation would need per-test-file queue names, not worth the added
  complexity given the suite is otherwise stable.

### Phase 3b — voice (STT/TTS)

- **Single-shot utterance, not streaming** — the widget records one full utterance client-side
  (`MediaRecorder`, tap-to-start/tap-to-stop), sends it as one base64 blob over the existing WS
  connection, and gets back one transcript + one synthesized reply blob. No chunked/streaming
  audio protocol was built — Groq Whisper and Gemini TTS are fast-but-chunked, not
  word-streaming, so this matches what's actually achievable without a much larger real-time
  audio pipeline.
- **`ConversationEngineService.handleUserMessage` is reused unchanged** — it was already
  channel-agnostic (text in, text out), so the voice pipeline is just STT → the same engine call
  → TTS, wrapped around a `respondToText` helper extracted from the gateway's existing
  `onUserMessage` (`apps/api/src/modules/agent/gateway/agent.gateway.ts`). Voice turns produce
  normal text history entries, so the transcript/AI-summary pipeline and the portal's
  conversation-detail view needed zero changes to support them.
- **New `transcript` WS message** — sent right after STT completes, before the engine call, so
  the widget can show "what was heard" the same way a typed message would appear (otherwise a
  voice turn looks silent until the reply arrives).
- **Provider abstraction** (`apps/api/src/modules/agent/providers/voice/`) — the same interface
  pattern as the LLM providers: `SttProvider`/`TtsProvider` with `MockSttProvider` (decodes the
  base64 payload as UTF-8 — clean and assertable for a deliberately-plaintext test fixture, and
  harmless-but-garbled for genuine microphone binary, either way never throws) and
  `MockTtsProvider` (always returns the same short, valid, silent WAV — this exercises the
  widget's real `<audio>` playback path, not just a text stand-in). Real
  `GroqWhisperProvider`/`GeminiTtsProvider` are code-complete against the documented API shapes
  (multipart transcription endpoint; `generateContent` with `responseModalities: ["AUDIO"]`) but
  untested live — no `GROQ_API_KEY`/`GEMINI_API_KEY` available in this environment, same posture
  as every other real provider in this project. Gemini returns raw headerless 24kHz/16-bit/mono
  PCM, which is wrapped in a WAV header server-side (`voice/wav.ts`) so the widget never needs to
  know the difference between mock and real audio. Selected via `STT_PROVIDER`/`TTS_PROVIDER` env
  vars, default `mock`.
- **Gating reuses `Tenant.priceConfig.addOns.voice`, not `FeatureAccess`** — `FeatureAccess` is
  per-*User* (portal RBAC) and unreachable from an anonymous widget visitor. `PriceConfig` already
  had a `voice` paid-add-on flag with no consumer; `PublicAgentsController` now reads it and
  returns `voiceEnabled`, and the widget only renders the mic button when true. A small checkbox
  was added to the admin pricing editor (`apps/admin/app/(console)/tenants/[id]/page.tsx`) so this
  is actually operable end-to-end, not just settable via raw API call.
- **A real bug caught proactively, before ever running a browser**: the widget's embed iframe
  (`apps/widget/public/loader.js`) had no `allow="microphone"` attribute. Permissions-Policy's
  default microphone allowlist is `"self"`, which does **not** propagate into a nested iframe
  without explicit delegation — even same-origin — so `getUserMedia()` would have thrown
  `NotAllowedError` inside the widget in any real embed. Fixed before the first browser test ran.
- **Verified end-to-end in a real headless Chrome session**, launched with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (synthetic mic input, no
  permission prompt): confirmed the mic button is absent while the tenant's voice add-on is off,
  toggled it on through the admin console UI (not just the API) and confirmed it persists across
  reload, confirmed the mic button then appears in the widget, recorded a fake-device utterance,
  and confirmed both a transcript bubble and a genuinely playable `<audio src>` reply (real WAV
  bytes, not a placeholder) arrive.
- **The load-bearing test**: `apps/api/src/modules/agent/voice.e2e.test.ts` — boots a real Nest
  app, sends a `user.audio` message with a deliberately plaintext-as-base64 payload, and asserts
  the `transcript`, `agent.message`, and `agent.audio` (`mimeType: "audio/wav"`, non-empty) replies
  all arrive correctly.
- **Deferred, not built this round**: real streaming/chunked audio, hold-to-talk (tap-to-toggle
  was used instead — simpler, equally functional, easier to verify headlessly), the Web Speech
  API zero-cost browser fallback from the original architecture notes, and setting
  `Conversation.channel = "voice"` (the field exists and defaults to `"chat"`; voice conversations
  currently still record as `"chat"` — cosmetic, not blocking, since nothing branches on it yet).

Mobile is still open from the Phase 3+ build plan — deprioritized per explicit instruction, not
started this round.

### Notes on tooling gotchas hit along the way

- **`apps/api`'s dev/build scripts run through real `tsc` (watch mode) + `node --watch`, not
  `tsx`/esbuild.** NestJS's DI resolves constructor-injected providers via TypeScript's
  `emitDecoratorMetadata`, which esbuild does not implement — using `tsx` (or vitest's default
  esbuild transform) silently resolves injected providers to `undefined` at runtime, with no build
  error. `apps/api/vitest.config.ts` uses `unplugin-swc` (see `apps/api/.swcrc`) for the same
  reason — any test that bootstraps real Nest DI (`Test.createTestingModule`) needs it; tests that
  `new` services by hand (like the isolation test) don't hit this.
- **`AgentGateway` wires itself via an explicit `attach(httpServer)` call from `main.ts`**, not an
  `OnModuleInit`/`OnApplicationBootstrap` lifecycle hook — `HttpAdapterHost.httpAdapter` isn't
  reliably populated by the time either hook fires, especially under `Test.createTestingModule()`.
- **NestJS's `@UsePipes` at the method level applies to every decorated parameter**, not just
  `@Body()` — putting it on a handler with both `@CurrentUser()` and `@Body()` validated the
  *JWT payload* against the body's Zod schema and failed with a confusing "name is required"
  error. Fix: put the pipe on the `@Body(pipe)` parameter itself, everywhere.
- **A void-returning Nest handler sends HTTP 200 with an empty body, not 204.** `@envoy/sdk`'s
  fetch wrapper originally called `res.json()` unconditionally, which throws a `SyntaxError` on an
  empty body — this silently broke every admin mutation (pause/resume/pricing/access) that doesn't
  return a payload, since the thrown error was swallowed by the calling page's `catch` block and
  just looked like "the button didn't do anything." Fixed by reading the response as text first
  and only parsing if there's content. Caught by real browser testing, not by typecheck or the
  API's own test suite (which reads Prisma directly rather than round-tripping through the SDK).
- **Next.js's App Router validates `layout.tsx` exports strictly under `next build`** (not
  `next dev`, not `tsc --noEmit`) — only `default`, `metadata`, `generateMetadata`, etc. are
  allowed. A `layout.tsx` that also exports an unrelated helper function compiles and runs fine in
  dev, then fails production builds with "X is not a valid Layout export field." Shared helpers
  belong in their own file (`lib/errors.ts`), never co-located in a layout.
- **Workspace TS packages need extensionless relative imports for Next.js/Vite, but `.js`-suffixed
  ones for `apps/api`.** `apps/api` uses `"module": "NodeNext"`, where a relative import must end in
  `.js` (mapping to the sibling `.ts` source) or `tsc`/`node` won't resolve it. Next.js and Vite use
  bundler-style resolution instead, where a `.js`-suffixed relative import is looked up literally
  and fails with "Module not found" (there's no compiled `.js` file sitting next to the `.ts`
  source). `packages/sdk` and the two Next.js apps use extensionless imports throughout; only
  `apps/api` and `packages/db`/`packages/types` (also NodeNext) use the `.js` convention.
