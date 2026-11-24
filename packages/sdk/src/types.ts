import type {
  AgentSpec,
  OutcomeType as OutcomeTypeName,
  ScenarioCheck,
  ScenarioDef,
  ScenarioOutcome,
  ModelConfig,
  ModelProviderKind,
  ModelRole,
  CatalogModel,
  AgentStatus,
  GoalProgressMap,
  RunStepKind,
  ConversationChannel,
  ConversationStatus,
  FeatureAccess,
  FormSchema,
  HardRulesSpec,
  OutcomeType,
  PublicFormSchema,
  RequiredFieldsSpec,
  SubscriptionStatus,
  UserRole,
  WidgetConfig,
} from "@envoy/types";

/**
 * Response shapes as the API actually returns them (JSON — Dates are ISO
 * strings, Prisma's JSON columns are already-parsed objects). Deliberately
 * separate from @envoy/db's Prisma types: those are Node/server-only and
 * carry Date objects, Decimal, etc. that don't survive a fetch() round trip
 * unchanged.
 */

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; tenantId: string | null; role: UserRole; emailVerified: boolean };
}

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  status: AgentStatus;
  script: string;
  requiredFields: RequiredFieldsSpec;
  hardRules: HardRulesSpec;
  widgetConfig: WidgetConfig;
  spec: AgentSpec;
  version: number;
  leadFormId: string | null;
  publicToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  agentId: string;
  tenantId: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  outcomeType: OutcomeType | null;
  capturedData: Record<string, unknown>;
  transcriptText: string | null;
  aiSummary: string | null;
  aiSummaryError: string | null;
  ruleViolationsBlocked: Array<{ ruleId: string; action: string; candidateText: string; timestamp: string }>;
  recordingUrl: string | null;
  agentVersion: number | null;
  goalProgress: GoalProgressMap;
  handoffReason: string | null;
  crmPushedAt: string | null;
  crmExternalId: string | null;
  crmPushError: string | null;
  integrationStatus: Partial<Record<IntegrationType, { pushedAt?: string; error?: string }>>;
  createdAt: string;
  completedAt: string | null;
  agent?: { name: string };
}

export interface CrmConnection {
  id: string;
  tenantId: string;
  provider: "hubspot";
  fieldMapping: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type IntegrationType = "calendar" | "email" | "webhook";

export interface Integration {
  id: string;
  tenantId: string;
  type: IntegrationType;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookIntegrationConfig {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  payloadTemplate?: string;
}

export interface EmailIntegrationConfig {
  to: string;
  subject: string;
  bodyTemplate: string;
}

export interface CalendarIntegrationConfig {
  calendarId?: string;
  titleTemplate: string;
  descriptionTemplate?: string;
  startField: string;
  durationMinutes?: number;
}

export interface Subscription {
  id: string;
  tenantId: string;
  status: SubscriptionStatus;
  monthlyRate: number;
  usageRate: number;
  includedConversations: number;
  billingCycleDay: number;
  stripeCustomerId: string | null;
  lockedAt: string | null;
  unlockedAt: string | null;
}

export interface BillingUsage {
  cycleStart: string;
  cycleEnd: string;
  includedConversations: number;
  usedConversations: number;
  overageConversations: number;
  overageAmountCents: number;
}

export interface AdminTenant {
  id: string;
  name: string;
  industry: string | null;
  subscriptionStatus: SubscriptionStatus;
  priceConfig: Record<string, unknown>;
  createdAt: string;
  subscription: Subscription | null;
  _count: { agents: number; users: number; conversations: number };
}

export interface AdminTenantDetail extends AdminTenant {
  users: Array<{ id: string; email: string; role: UserRole; featureAccess: FeatureAccess }>;
  crmConnections: Array<{ provider: "hubspot"; createdAt: string; updatedAt: string }>;
  integrations: Array<{ id: string; type: IntegrationType; enabled: boolean; createdAt: string; updatedAt: string }>;
  forms: Array<{
    id: string;
    name: string;
    status: "draft" | "live";
    updatedAt: string;
    _count: { submissions: number };
  }>;
}

export interface AuditLogEntry {
  id: string;
  adminUserId: string;
  tenantId: string | null;
  action: string;
  meta: Record<string, unknown>;
  createdAt: string;
  adminUser: { email: string; role: UserRole };
}

export interface Form {
  id: string;
  tenantId: string;
  name: string;
  status: "draft" | "live";
  schema: FormSchema;
  publicToken: string;
  createdAt: string;
  updatedAt: string;
  _count?: { submissions: number };
}

export interface FormSubmission {
  id: string;
  formId: string;
  data: Record<string, unknown>;
  crmPushedAt: string | null;
  crmPushError: string | null;
  integrationStatus: Partial<Record<IntegrationType, { pushedAt?: string; error?: string }>>;
  createdAt: string;
}

export interface Lead {
  id: string;
  source: "conversation" | "form";
  sourceLabel: string;
  data: Record<string, unknown>;
  createdAt: string;
  crmPushedAt: string | null;
  crmPushError: string | null;
  integrationStatus: Partial<Record<IntegrationType, { pushedAt?: string; error?: string }>>;
}

export interface PublicForm {
  name: string;
  schema: PublicFormSchema;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  note: string | null;
  createdAt: string;
  snapshot: {
    script: string;
    requiredFields: RequiredFieldsSpec;
    hardRules: HardRulesSpec;
    widgetConfig: WidgetConfig;
    spec: AgentSpec;
  };
}

/** One step of an agent run (model call, tool execution, judge verdict…) — the run trace. */
export interface RunStep {
  id: string;
  conversationId: string;
  turn: number;
  seq: number;
  kind: RunStepKind;
  name: string;
  input: unknown;
  output: unknown;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
}

/** A stored provider API key as the API shows it — the key itself is never returned, only its last four characters. */
export interface ModelCredential {
  id: string;
  provider: ModelProviderKind;
  label: string;
  last4: string;
  baseUrl: string | null;
  status: "active" | "invalid";
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ModelStatus {
  /** True until at least one role is actually served by the tenant's own working key. */
  usingPlatformDefault: boolean;
  hasInvalidCredential: boolean;
  credentialCount: number;
  roles: Record<ModelRole, { source: "tenant" | "platform"; provider?: ModelProviderKind; model?: string }>;
  config: ModelConfig;
}

export interface ModelCatalog {
  providers: Array<{ id: ModelProviderKind; label: string; models: CatalogModel[] }>;
}

export interface ModelUsageSummary {
  days: number;
  rows: Array<{
    keySource: "tenant" | "platform";
    provider: string;
    model: string;
    role: string;
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
  }>;
}

/** One visitor message into the playground, and what the agent did about it. */
export interface SimulationTurn {
  sessionId: string;
  agentVersion: number;
  reply: string;
  isComplete: boolean;
  outcomeType?: OutcomeTypeName;
  handoffReason?: string;
  capturedData: Record<string, unknown>;
  goalProgress: GoalProgressMap;
  blockedViolations: number;
  steps: Array<{ turn: number; seq: number; kind: RunStepKind; name: string; input?: unknown; output?: unknown; error?: string; latencyMs?: number }>;
}

export interface Scenario extends ScenarioDef {
  id: string;
  createdAt: string;
  /** Latest run of this scenario on the agent as currently configured ("current" variant). */
  lastRun: { id: string; passed: boolean; error: string | null; agentVersion: number; createdAt: string; onCurrentVersion: boolean } | null;
}

export interface ScenarioStatus {
  agentVersion: number;
  total: number;
  passing: number;
  failing: number;
  notRun: number;
}

export interface ScenarioRunResult {
  variant: string;
  scenarioId: string;
  name: string;
  runId: string;
  passed: boolean;
  error?: string;
  checks: ScenarioCheck[];
  tokens: { calls: number; inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface ScenarioRunReport {
  agentVersion: number;
  variants: Array<{ label: string; passed: number; total: number; inputTokens: number; outputTokens: number; avgLatencyMs: number }>;
  results: ScenarioRunResult[];
}

export interface ScenarioRunRecord {
  id: string;
  scenarioId: string | null;
  agentVersion: number;
  variant: string;
  passed: boolean;
  error: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  result: {
    name: string;
    transcript: Array<{ role: "visitor" | "agent"; text: string }>;
    checks: ScenarioCheck[];
    outcome: ScenarioOutcome;
    steps: SimulationTurn["steps"];
    route: { provider: string; model: string; keySource: "tenant" | "platform"; failedOver?: boolean } | null;
  };
}
