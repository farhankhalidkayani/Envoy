/**
 * Removes what the e2e suites leave behind in the database they ran against, which happens when a run is
 * interrupted before its own clean-up (a sleeping laptop, Docker stopping). DRY RUN by default: it only reports.
 *
 *   pnpm --filter @envoy/api cleanup:test-data          # report what would be removed
 *   pnpm --filter @envoy/api cleanup:test-data --yes    # remove it
 *
 * Test data is recognised by the address every suite uses, `…@test.dev` (the seed uses `@envoy.dev`):
 *   - workspaces whose users ALL have @test.dev addresses (a workspace with any other user is never touched;
 *     one with no users at all is reported but never removed, since nothing says it came from a test);
 *   - platform admins with @test.dev addresses;
 *   - OAuth apps that registered more than a day ago and never connected (no code issued, no token).
 */
import { prisma } from "@envoy/db";

const TEST_EMAIL = "@test.dev";
const apply = process.argv.includes("--yes");

const testTenants = await prisma.tenant.findMany({
  where: { users: { some: {}, every: { email: { endsWith: TEST_EMAIL } } } },
  select: { id: true, name: true },
});
const emptyTenants = await prisma.tenant.count({ where: { users: { none: {} } } });
const testAdmins = await prisma.user.findMany({ where: { tenantId: null, role: "platform_admin", email: { endsWith: TEST_EMAIL } }, select: { id: true, email: true } });
const staleClients = await prisma.oAuthClient.findMany({
  where: { createdAt: { lt: new Date(Date.now() - 86_400_000) }, codes: { none: {} }, tokens: { none: {} } },
  select: { id: true, name: true },
});

console.log(`Test workspaces (all users @test.dev): ${testTenants.length}`);
for (const t of testTenants.slice(0, 20)) console.log(`  - ${t.name}`);
if (testTenants.length > 20) console.log(`  … and ${testTenants.length - 20} more`);
console.log(`Test platform admins (@test.dev):      ${testAdmins.length}`);
console.log(`OAuth apps that never connected (>1d): ${staleClients.length}`);
if (emptyTenants) console.log(`(Not touched: ${emptyTenants} workspace(s) with no users — check those by hand.)`);

if (!apply) {
  console.log("\nDry run: nothing was removed. Re-run with --yes to remove the above.");
} else {
  // Deleting a workspace removes everything in it (users, agents, conversations…) by cascade.
  const tenants = await prisma.tenant.deleteMany({ where: { id: { in: testTenants.map((t) => t.id) } } });
  const admins = await prisma.user.deleteMany({ where: { id: { in: testAdmins.map((a) => a.id) } } });
  const clients = await prisma.oAuthClient.deleteMany({ where: { id: { in: staleClients.map((c) => c.id) } } });
  console.log(`\nRemoved ${tenants.count} workspace(s), ${admins.count} admin(s), ${clients.count} OAuth app(s).`);
}
await prisma.$disconnect();
