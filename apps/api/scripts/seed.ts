import * as bcrypt from "bcrypt";
import { prisma } from "@envoy/db";

const BCRYPT_ROUNDS = 10;
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number, hour = 10): Date {
  const d = new Date(Date.now() - n * DAY);
  d.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
  return d;
}

async function ensureUser(email: string, password: string, role: "owner" | "platform_admin", tenantId?: string) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  return prisma.user.upsert({
    where: { email },
    update: { tenantId },
    create: { email, passwordHash, role, tenantId },
  });
}

async function main() {
  console.log("Seeding demo data…");

  // ── Tenant 1: Harbor & Co. — the tenant owner@envoy.dev logs into ──
  const harbor = await prisma.tenant.upsert({
    where: { id: "seed_harbor_co" },
    update: { name: "Harbor & Co.", industry: "Home & Local Services", subscriptionStatus: "active" },
    create: {
      id: "seed_harbor_co",
      name: "Harbor & Co.",
      industry: "Home & Local Services",
      subscriptionStatus: "active",
    },
  });

  await ensureUser("owner@envoy.dev", "password123", "owner", harbor.id);

  // Clean up the placeholder tenant created before this seed script existed
  // (owner@envoy.dev used to point at it) — it's now orphaned and empty.
  await prisma.tenant.deleteMany({ where: { id: "cmt7mgeks0000uomygvsrzorq", users: { none: {} } } });

  await prisma.subscription.upsert({
    where: { tenantId: harbor.id },
    update: {},
    create: {
      tenantId: harbor.id,
      status: "active",
      monthlyRate: 4900,
      usageRate: 50,
      includedConversations: 300,
      billingCycleDay: 1,
      stripeCustomerId: `local_${harbor.id}`,
    },
  });

  const bookingAgent = await prisma.agent.upsert({
    where: { id: "seed_agent_booking" },
    update: { status: "live" },
    create: {
      id: "seed_agent_booking",
      tenantId: harbor.id,
      name: "Booking Assistant",
      status: "live",
      script: "You help visitors book an in-home consultation and collect their contact details.",
      requiredFields: [
        { key: "name", label: "Full name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "phone", label: "Phone", type: "phone", required: false },
        { key: "preferredDate", label: "Preferred date", type: "date", required: false },
      ],
      hardRules: [
        { id: "rule_1", text: "Never promise a specific arrival time.", action: "block", severity: "high" },
        { id: "rule_2", text: "Never discuss competitor pricing.", action: "escalate", severity: "medium" },
      ],
      widgetConfig: { greeting: "Hi! Want to book a free consultation?", primaryColor: "#3a6df0" },
    },
  });

  const supportAgent = await prisma.agent.upsert({
    where: { id: "seed_agent_support" },
    update: { status: "draft" },
    create: {
      id: "seed_agent_support",
      tenantId: harbor.id,
      name: "Support Bot",
      status: "draft",
      script: "You answer common questions about existing orders and service plans.",
      requiredFields: [{ key: "orderNumber", label: "Order number", type: "text", required: true }],
      hardRules: [{ id: "rule_3", text: "Never issue refunds directly.", action: "block", severity: "high" }],
      widgetConfig: { greeting: "Hi! How can I help with your order?", primaryColor: "#3a6df0" },
    },
  });

  const concierge = await prisma.agent.upsert({
    where: { id: "seed_agent_concierge" },
    update: { status: "paused" },
    create: {
      id: "seed_agent_concierge",
      tenantId: harbor.id,
      name: "After-hours Concierge",
      status: "paused",
      script: "You take basic messages outside business hours and offer to schedule a callback.",
      requiredFields: [{ key: "name", label: "Full name", type: "text", required: true }],
      hardRules: [],
      widgetConfig: { greeting: "We're closed right now — leave a message?", primaryColor: "#3a6df0" },
    },
  });

  // ── Conversations for Harbor & Co., spread over the last 21 days ──
  const outcomes: Array<{
    status: "completed" | "in_progress" | "abandoned";
    outcomeType?: "demo_booking" | "order" | "appointment" | "complaint";
    hasViolation?: boolean;
    hasSummary?: boolean;
  }> = [
    { status: "completed", outcomeType: "demo_booking", hasSummary: true },
    { status: "completed", outcomeType: "appointment", hasSummary: true },
    { status: "completed", outcomeType: "demo_booking", hasSummary: true },
    { status: "completed", outcomeType: "demo_booking", hasViolation: true, hasSummary: true },
    { status: "in_progress" },
    { status: "in_progress" },
    { status: "abandoned" },
    { status: "completed", outcomeType: "appointment", hasSummary: true },
    { status: "abandoned" },
    { status: "completed", outcomeType: "demo_booking", hasSummary: true },
    { status: "completed", outcomeType: "complaint", hasViolation: true, hasSummary: true },
    { status: "completed", outcomeType: "demo_booking", hasSummary: true },
  ];

  const names = ["Jordan Lee", "Priya Patel", "Marcus Webb", "Sofia Alvarez", "Kenji Tanaka", "Aisha Bello"];

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    const createdAt = daysAgo(21 - i * 1.7);
    const person = names[i % names.length];
    const agent = i % 5 === 0 ? concierge : bookingAgent;

    await prisma.conversation.upsert({
      where: { id: `seed_convo_${i}` },
      update: {},
      create: {
        id: `seed_convo_${i}`,
        agentId: agent.id,
        tenantId: harbor.id,
        channel: "chat",
        status: o.status,
        outcomeType: o.outcomeType,
        capturedData:
          o.status === "completed"
            ? { name: person, email: `${person.toLowerCase().replace(" ", ".")}@example.com` }
            : {},
        transcriptText:
          o.status !== "in_progress"
            ? `Visitor: Hi, I'd like to book a consultation.\nAgent: Happy to help! Can I get your name and email?\nVisitor: ${person}, sure.\nAgent: Great, you're booked in — we'll follow up shortly.`
            : null,
        aiSummary: o.hasSummary ? `${person} requested a consultation and was successfully booked.` : null,
        ruleViolationsBlocked: o.hasViolation
          ? [{ ruleId: "rule_1", candidateText: "We can be there by 3pm sharp", action: "block" }]
          : [],
        crmPushedAt: o.status === "completed" && i % 3 === 0 ? createdAt : null,
        createdAt,
        completedAt: o.status === "completed" ? new Date(createdAt.getTime() + 6 * 60 * 1000) : null,
      },
    });
  }

  // ── Tenant 2: Nimbus Fitness — active, healthy usage ──
  const nimbus = await prisma.tenant.upsert({
    where: { id: "seed_nimbus_fitness" },
    update: { name: "Nimbus Fitness", industry: "Health & Wellness", subscriptionStatus: "active" },
    create: {
      id: "seed_nimbus_fitness",
      name: "Nimbus Fitness",
      industry: "Health & Wellness",
      subscriptionStatus: "active",
    },
  });
  await prisma.subscription.upsert({
    where: { tenantId: nimbus.id },
    update: {},
    create: {
      tenantId: nimbus.id,
      status: "active",
      monthlyRate: 9900,
      usageRate: 40,
      includedConversations: 800,
      stripeCustomerId: `local_${nimbus.id}`,
    },
  });
  await prisma.agent.upsert({
    where: { id: "seed_agent_nimbus_1" },
    update: {},
    create: {
      id: "seed_agent_nimbus_1",
      tenantId: nimbus.id,
      name: "Membership Assistant",
      status: "live",
      script: "You help visitors pick a membership plan and book a tour.",
      requiredFields: [{ key: "email", label: "Email", type: "email", required: true }],
      hardRules: [],
      widgetConfig: { greeting: "Looking to join Nimbus?", primaryColor: "#22a06b" },
    },
  });
  await prisma.agent.upsert({
    where: { id: "seed_agent_nimbus_2" },
    update: {},
    create: {
      id: "seed_agent_nimbus_2",
      tenantId: nimbus.id,
      name: "Class Booking Bot",
      status: "live",
      script: "You help members book classes.",
      requiredFields: [],
      hardRules: [],
      widgetConfig: { greeting: "Book your next class!", primaryColor: "#22a06b" },
    },
  });

  // ── Tenant 3: Bright Path Legal — past_due, cautionary tale for admin view ──
  const brightPath = await prisma.tenant.upsert({
    where: { id: "seed_bright_path" },
    update: { name: "Bright Path Legal", industry: "Professional Services", subscriptionStatus: "past_due" },
    create: {
      id: "seed_bright_path",
      name: "Bright Path Legal",
      industry: "Professional Services",
      subscriptionStatus: "past_due",
    },
  });
  await prisma.subscription.upsert({
    where: { tenantId: brightPath.id },
    update: { status: "past_due" },
    create: {
      tenantId: brightPath.id,
      status: "past_due",
      monthlyRate: 14900,
      usageRate: 60,
      includedConversations: 200,
      stripeCustomerId: `local_${brightPath.id}`,
    },
  });
  await prisma.agent.upsert({
    where: { id: "seed_agent_legal" },
    update: {},
    create: {
      id: "seed_agent_legal",
      tenantId: brightPath.id,
      name: "Intake Assistant",
      status: "live",
      script: "You screen prospective clients for an initial consultation.",
      requiredFields: [{ key: "name", label: "Full name", type: "text", required: true }],
      hardRules: [{ id: "rule_legal_1", text: "Never give legal advice directly.", action: "block", severity: "high" }],
      widgetConfig: { greeting: "Tell us about your case.", primaryColor: "#8a5cf6" },
    },
  });

  // ── Admin audit trail so the console isn't empty either ──
  const admin = await ensureUser("admin@envoy.dev", "password123", "platform_admin");
  const auditEntries: Array<{ action: string; tenantId?: string; meta?: object; daysBack: number }> = [
    { action: "tenant.pricing.updated", tenantId: nimbus.id, meta: { baseMonthlyCents: 9900 }, daysBack: 6 },
    { action: "tenant.feature.updated", tenantId: harbor.id, meta: { feature: "crm", enabled: true }, daysBack: 4 },
    { action: "tenant.paused", tenantId: brightPath.id, meta: { reason: "payment_failed" }, daysBack: 2 },
  ];
  for (const [i, entry] of auditEntries.entries()) {
    await prisma.auditLog.upsert({
      where: { id: `seed_audit_${i}` },
      update: {},
      create: {
        id: `seed_audit_${i}`,
        adminUserId: admin.id,
        tenantId: entry.tenantId,
        action: entry.action,
        meta: entry.meta ?? {},
        createdAt: daysAgo(entry.daysBack),
      },
    });
  }

  console.log("Seed complete:");
  console.log(`  Tenants: Harbor & Co. (${harbor.id}), Nimbus Fitness (${nimbus.id}), Bright Path Legal (${brightPath.id})`);
  console.log(`  ${outcomes.length} conversations on Harbor & Co.`);
  console.log("  Login: owner@envoy.dev / password123  ·  admin@envoy.dev / password123");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
