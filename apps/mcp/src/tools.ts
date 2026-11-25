import { z } from "zod";
import { AgentSpec, HardRuleDef, OPT_IN_TOOL_NAMES, RequiredFieldsSpec, ScenarioDef, ScenarioSandbox, WidgetConfig } from "@envoy/types";
import type { EnvoyApi } from "./api.js";

export type Access = "read" | "write";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  /** Becomes the MCP readOnlyHint, so clients can auto-approve reads and ask before writes. */
  access: Access;
  /** The result contains text written by website visitors, which must be treated as data, never as instructions. */
  untrusted?: boolean;
  run(api: EnvoyApi, args: any): Promise<unknown>;
}

const agentId = z.string().min(1).describe("The agent's id, from list_agents.");
const days = z.number().int().min(1).max(90).optional().describe("How many days back to look (default 30).");
const limit = (max: number) => z.number().int().min(1).max(max).optional();

const q = (path: string) => `/agents/${path}`;

/**
 * The tool catalogue. Each tool is one explicit API call (or a short read-modify-write), so what an AI can do is
 * readable here. Left out on purpose, because they need a person: publishing an agent, changing hard rules,
 * approving or rejecting an AI-drafted improvement, restoring a version, enabling CRM/calendar tools, and anything
 * touching billing, API keys, accounts or the operator console. The API refuses those for tokens too.
 */
export const TOOLS: ToolDef[] = [
  // ── agents ──────────────────────────────────────────────
  {
    name: "list_agents",
    title: "List agents",
    description: "List the workspace's agents with their status, version and mode.",
    input: {},
    access: "read",
    run: async (api) =>
      (await api.get<Array<{ id: string; name: string; status: string; version: number; spec: { runtime: { mode: string } }; updatedAt: string }>>("/agents")).map((a) => ({
        id: a.id, name: a.name, status: a.status, version: a.version, mode: a.spec.runtime.mode, updatedAt: a.updatedAt,
      })),
  },
  {
    name: "get_agent",
    title: "Get an agent",
    description: "The full configuration of one agent: script, required fields, hard rules, widget settings, and its goals/tools/limits (spec).",
    input: { agentId },
    access: "read",
    run: (api, { agentId }) => api.get(q(agentId)),
  },
  {
    name: "create_agent",
    title: "Create an agent",
    description:
      "Create a new agent as a DRAFT. It is not shown to visitors until a person publishes it in the portal. You cannot set hard rules or publish; ask the user to add rules and publish.",
    input: {
      name: z.string().min(1).max(100),
      script: z.string().max(10_000).optional().describe("The agent's instructions: what it does and how it should behave."),
      requiredFields: RequiredFieldsSpec.optional().describe("Information the agent must collect from visitors."),
      widgetConfig: WidgetConfig.partial().optional(),
      spec: AgentSpec.optional().describe("Goals, persona, tool permissions and runtime mode ('classic' or 'agentic')."),
    },
    access: "write",
    run: (api, args) => api.post("/agents", args),
  },
  {
    name: "update_agent",
    title: "Edit an agent",
    description:
      "Change an agent's name, script, required fields, widget settings or spec. Only the fields you pass change. 'spec' is merged at its top level (passing goals replaces goals; persona, tools, runtime and models are kept unless you pass them). " +
      "Every edit becomes a new version and can be undone by a person. If the agent is live, the change affects real visitors immediately. Cannot change hard rules, publish, or enable CRM/calendar tools.",
    input: {
      agentId,
      name: z.string().min(1).max(100).optional(),
      script: z.string().max(10_000).optional(),
      requiredFields: RequiredFieldsSpec.optional(),
      widgetConfig: WidgetConfig.partial().optional(),
      spec: AgentSpec.innerType().partial().optional().describe("Parts of the spec to change; validated after merging."),
      note: z.string().max(200).optional().describe("A short label for the version this edit creates, e.g. 'Shorter greeting'."),
    },
    access: "write",
    run: async (api, { agentId, spec, ...rest }) => {
      const body: Record<string, unknown> = { ...rest };
      if (spec) {
        const current = await api.get<{ spec: Record<string, unknown> }>(q(agentId));
        body.spec = { ...current.spec, ...spec };
      }
      return api.patch(q(agentId), body);
    },
  },
  {
    name: "pause_agent",
    title: "Pause an agent",
    description: "Stop an agent from taking new conversations. Safe and reversible. (Publishing it again needs a person.)",
    input: { agentId },
    access: "write",
    run: (api, { agentId }) => api.patch(q(agentId), { status: "paused" }),
  },
  {
    name: "get_embed_snippet",
    title: "Get the embed snippet",
    description: "The <script> tag that puts this agent on a website. The agent only answers visitors once a person has published it.",
    input: { agentId },
    access: "read",
    run: async (api, { agentId }) => {
      const a = await api.get<{ publicToken: string; status: string }>(q(agentId));
      const origin = process.env.ENVOY_WIDGET_ORIGIN ?? "http://localhost:5173";
      return { status: a.status, snippet: `<script src="${origin}/loader.js" data-agent="${a.publicToken}"></script>`, note: a.status === "live" ? "Live." : "Not live yet: a person must publish it in the portal." };
    },
  },
  {
    name: "list_agent_versions",
    title: "List an agent's versions",
    description: "The history of configuration changes: version number, when, and the note. (Restoring a version needs a person.)",
    input: { agentId },
    access: "read",
    run: async (api, { agentId }) =>
      (await api.get<Array<{ version: number; note: string | null; createdAt: string }>>(q(`${agentId}/versions`))).map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt })),
  },

  // ── conversations and leads (contain visitor-written text) ──
  {
    name: "list_conversations",
    title: "List conversations",
    description: "Recent conversations, newest first, optionally for one agent. Includes what visitors captured.",
    input: { agentId: agentId.optional(), limit: limit(100) },
    access: "read",
    untrusted: true,
    run: async (api, { agentId, limit }) => (await api.get<{ rows: unknown[] }>("/conversations", { agentId, take: limit ?? 25 })).rows,
  },
  {
    name: "get_conversation",
    title: "Get a conversation",
    description: "One conversation: captured data, transcript, AI summary, blocked replies, goal progress and handoff.",
    input: { conversationId: z.string().min(1) },
    access: "read",
    untrusted: true,
    run: (api, { conversationId }) => api.get(`/conversations/${conversationId}`),
  },
  {
    name: "get_conversation_trace",
    title: "Get a conversation's run trace",
    description: "What an agentic agent did on each visitor message: model calls, tool calls and results, rule checks.",
    input: { conversationId: z.string().min(1) },
    access: "read",
    untrusted: true,
    run: (api, { conversationId }) => api.get(`/conversations/${conversationId}/trace`),
  },
  {
    name: "list_leads",
    title: "List leads",
    description: "Leads from completed conversations and form submissions, newest first.",
    input: { limit: limit(200) },
    access: "read",
    untrusted: true,
    run: (api, { limit }) => api.get("/leads", { limit: limit ?? 50 }),
  },
  {
    name: "get_lead_stats",
    title: "Lead statistics",
    description: "Lead counts by source.",
    input: {},
    access: "read",
    run: (api) => api.get("/leads/stats"),
  },

  // ── test an agent without real visitors ──
  {
    name: "simulate_conversation",
    title: "Simulate a conversation",
    description:
      "Send one visitor message to an agent in a sandbox and get its reply, what it did, and what it captured. Nothing real is created: no conversation, lead, CRM push or booking. " +
      "Omit sessionId to start a new simulated conversation; pass the returned sessionId to continue it. Works on draft agents and uses the saved version.",
    input: { agentId, message: z.string().min(1).max(4000), sessionId: z.string().optional(), sandbox: ScenarioSandbox.partial().optional().describe("Pretend CRM contacts and busy calendar times.") },
    access: "write",
    run: (api, { agentId, ...body }) => api.post(q(`${agentId}/simulate`), body),
  },
  {
    name: "list_scenarios",
    title: "List scenarios",
    description: "An agent's saved test scenarios, with whether each passed on the agent's current version.",
    input: { agentId },
    access: "read",
    run: (api, { agentId }) => api.get(q(`${agentId}/scenarios`)),
  },
  {
    name: "create_scenario",
    title: "Create a scenario",
    description: "Save a scripted visitor (a list of messages) plus what must be true afterwards. Run it later to catch regressions.",
    input: { agentId, scenario: ScenarioDef },
    access: "write",
    run: (api, { agentId, scenario }) => api.post(q(`${agentId}/scenarios`), scenario),
  },
  {
    name: "run_scenarios",
    title: "Run scenarios",
    description:
      "Run an agent's scenarios (all, or the ids given) and get pass/fail with each failed expectation explained. Pass several 'variants' to compare the suite across models, e.g. [{label:'Current'}, {label:'Opus', models:{default:{credentialId, model}}}]. Takes a while; uses the workspace's AI model.",
    input: {
      agentId,
      scenarioIds: z.array(z.string()).max(20).optional(),
      variants: z.array(z.object({ label: z.string().min(1).max(60), models: z.record(z.string(), z.unknown()).optional() })).max(3).optional(),
    },
    access: "write",
    run: (api, { agentId, ...body }) => api.post(q(`${agentId}/scenarios/run`), body, { timeoutMs: 600_000 }),
  },
  {
    name: "get_scenario_status",
    title: "Scenario status",
    description: "How many scenarios pass, fail or haven't been run on the agent's current version.",
    input: { agentId },
    access: "read",
    run: (api, { agentId }) => api.get(q(`${agentId}/scenarios/status`)),
  },
  {
    name: "get_scenario_run",
    title: "Get a scenario run",
    description: "The full record of one scenario run: transcript, checks and the steps the agent took.",
    input: { agentId, runId: z.string().min(1) },
    access: "read",
    run: (api, { agentId, runId }) => api.get(q(`${agentId}/scenarios/runs/${runId}`)),
  },

  // ── improvement (needs the 'improvement' feature on the account) ──
  {
    name: "get_agent_metrics",
    title: "Agent performance",
    description: "Per-version performance from real conversations: completion rate, drop-off, handoffs, blocked replies, tool errors. Requires the improvement feature.",
    input: { agentId, days },
    access: "read",
    run: (api, { agentId, days }) => api.get(q(`${agentId}/improvement/metrics`), { days }),
  },
  {
    name: "analyze_agent",
    title: "Diagnose an agent",
    description: "Analyse real conversations and list what is going wrong (e.g. visitors leaving at a particular question), each with evidence. Requires the improvement feature.",
    input: { agentId, days },
    access: "write",
    run: (api, { agentId, days }) => api.post(q(`${agentId}/improvement/analyze${days ? `?days=${days}` : ""}`)),
  },
  {
    name: "list_insights",
    title: "List findings",
    description: "The current findings for an agent's version. Requires the improvement feature.",
    input: { agentId },
    access: "read",
    run: (api, { agentId }) => api.get(q(`${agentId}/improvement/insights`)),
  },
  {
    name: "propose_fix",
    title: "Draft a fix",
    description: "Ask for a drafted change that addresses one finding. It changes nothing: it's a proposal that must be tested and then approved by a person in the portal.",
    input: { agentId, insightId: z.string().min(1) },
    access: "write",
    run: (api, { agentId, insightId }) => api.post(q(`${agentId}/improvement/insights/${insightId}/propose`)),
  },
  {
    name: "list_proposals",
    title: "List proposed fixes",
    description: "Drafted fixes with their test results. Approving or rejecting one is a person's decision, made in the portal.",
    input: { agentId },
    access: "read",
    run: (api, { agentId }) => api.get(q(`${agentId}/improvement/proposals`)),
  },
  {
    name: "test_proposal",
    title: "Test a proposed fix",
    description: "Run the agent's scenarios on the current agent and on the proposal, and replay real visitors who hit the problem. Reports regressions. Takes a while.",
    input: { agentId, proposalId: z.string().min(1) },
    access: "write",
    run: (api, { agentId, proposalId }) => api.post(q(`${agentId}/improvement/proposals/${proposalId}/test`), {}, { timeoutMs: 600_000 }),
  },

  // ── ask a person (these REQUEST; they never do. Only the owner, in the portal, can say yes) ──
  ...(
    [
      ["request_publish_agent", "Ask to publish an agent", "Ask the user to publish an agent so visitors can talk to it.", { agentId }, ({ agentId }: { agentId: string }) => ({ agentId, params: { kind: "publish_agent" } })],
      [
        "request_hard_rules_change",
        "Ask to change hard rules",
        "Ask the user to set an agent's hard rules (the things it must never say). Pass the COMPLETE list you want it to have; the user sees exactly what is added, changed and removed.",
        { agentId, hardRules: z.array(HardRuleDef).max(50) },
        ({ agentId, hardRules }: { agentId: string; hardRules: unknown[] }) => ({ agentId, params: { kind: "set_hard_rules", hardRules } }),
      ],
      [
        "request_enable_tools",
        "Ask to give an agent CRM or calendar access",
        "Ask the user to let an agent look up CRM contacts, check calendar availability or book meetings. Only the tools you name.",
        { agentId, tools: z.array(z.enum(OPT_IN_TOOL_NAMES as unknown as [string, ...string[]])).min(1) },
        ({ agentId, tools }: { agentId: string; tools: string[] }) => ({ agentId, params: { kind: "enable_tools", tools } }),
      ],
      [
        "request_version_restore",
        "Ask to restore an earlier version",
        "Ask the user to roll an agent back to an earlier version (see list_agent_versions). It becomes a new version.",
        { agentId, version: z.number().int().min(1) },
        ({ agentId, version }: { agentId: string; version: number }) => ({ agentId, params: { kind: "restore_version", version } }),
      ],
      [
        "request_proposal_approval",
        "Ask to apply a proposed improvement",
        "Ask the user to apply a drafted improvement that has been tested (see list_proposals, test_proposal).",
        { agentId, proposalId: z.string().min(1), acknowledgeUntested: z.boolean().optional() },
        ({ agentId, proposalId, acknowledgeUntested }: { agentId: string; proposalId: string; acknowledgeUntested?: boolean }) => ({ agentId, params: { kind: "approve_proposal", proposalId, acknowledgeUntested } }),
      ],
    ] as const
  ).map(
    ([name, title, what, shape, build]): ToolDef => ({
      name,
      title,
      description:
        `${what} This only SENDS A REQUEST: nothing changes until the user reviews it and approves it themselves in the portal (Approvals). It expires after 24 hours and is void if the agent changes first. ` +
        "Include a short reason; the user sees it as your words, next to a summary the system builds from the real data.",
      input: { ...shape, reason: z.string().max(500).optional().describe("Why you're asking, in a sentence. Shown to the user as coming from you.") } as z.ZodRawShape,
      access: "write",
      run: async (api, args: { reason?: string }) => {
        const { agentId, params } = (build as (a: unknown) => { agentId: string; params: unknown })(args);
        const request = await api.post<{ id: string }>("/approvals", { agentId, params, reason: args.reason });
        return { ...request, nextStep: "Tell the user to open Approvals in the portal and review this request. Nothing has changed yet. Check back with get_approval_request." };
      },
    }),
  ),
  {
    name: "get_approval_request",
    title: "Check an approval request",
    description: "The state of a request you made: pending, approved, rejected, expired, stale (the agent changed first) or failed, with the result once it was carried out.",
    input: { approvalId: z.string().min(1) },
    access: "read",
    run: (api, { approvalId }) => api.get(`/approvals/${approvalId}`),
  },
  {
    name: "list_approval_requests",
    title: "List approval requests",
    description: "Recent requests for the user's approval, optionally by status.",
    input: { status: z.enum(["pending", "approved", "rejected", "expired", "stale", "failed"]).optional() },
    access: "read",
    run: (api, { status }) => api.get("/approvals", { status }),
  },

  // ── workspace facts ──
  {
    name: "get_model_status",
    title: "Which AI model is serving the workspace",
    description: "Whether agents run on the shared default model or the workspace's own key, per job (replies, rule checks, data capture, summaries).",
    input: {},
    access: "read",
    run: (api) => api.get("/models/status"),
  },
  {
    name: "get_model_usage",
    title: "AI model usage",
    description: "Model calls and tokens by model and job over a period.",
    input: { days },
    access: "read",
    run: (api, { days }) => api.get("/models/usage", { days }),
  },
  {
    name: "get_subscription",
    title: "Subscription",
    description: "The workspace's plan and billing status.",
    input: {},
    access: "read",
    run: (api) => api.get("/billing/subscription"),
  },
  {
    name: "get_billing_usage",
    title: "Billing usage",
    description: "Conversations used in the current billing cycle against the plan.",
    input: {},
    access: "read",
    run: (api) => api.get("/billing/usage"),
  },
  {
    name: "list_forms",
    title: "List lead forms",
    description: "The workspace's lead forms (requires the forms feature).",
    input: {},
    access: "read",
    run: (api) => api.get("/forms"),
  },
  {
    name: "list_form_submissions",
    title: "List form submissions",
    description: "Recent submissions of one lead form.",
    input: { formId: z.string().min(1), limit: limit(200) },
    access: "read",
    untrusted: true,
    run: (api, { formId, limit }) => api.get(`/forms/${formId}/submissions`, { take: limit ?? 50 }),
  },
];
