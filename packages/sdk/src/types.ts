import type {
  AgentStatus,
  ConversationChannel,
  ConversationStatus,
  FeatureAccess,
  HardRulesSpec,
  OutcomeType,
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
  user: { id: string; email: string; tenantId: string | null; role: UserRole };
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
  ruleViolationsBlocked: Array<{ ruleId: string; action: string; candidateText: string; timestamp: string }>;
  recordingUrl: string | null;
  crmPushedAt: string | null;
  crmExternalId: string | null;
  crmPushError: string | null;
  createdAt: string;
  completedAt: string | null;
  agent?: { name: string };
}

export interface CrmConnection {
  id: string;
  tenantId: string;
  provider: "hubspot" | "zoho";
  fieldMapping: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  tenantId: string;
  status: SubscriptionStatus;
  monthlyRate: number;
  usageRate: number;
  includedConversations: number;
  billingCycleDay: number;
  lockedAt: string | null;
  unlockedAt: string | null;
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
}

export interface AuditLogEntry {
  id: string;
  adminUserId: string;
  tenantId: string | null;
  action: string;
  meta: Record<string, unknown>;
  createdAt: string;
  adminUser: { email: string };
}
