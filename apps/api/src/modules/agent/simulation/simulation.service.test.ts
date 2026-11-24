import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ScenarioDef } from "@envoy/types";
import { SimulationService, DAILY_SIMULATED_TURNS, type SimAgent } from "./simulation.service.js";

function build(engine: { handleUserMessage: (p: any) => Promise<any> }, counter = { n: 0 }) {
  const redis = { client: { incr: async () => ++counter.n, expire: async () => 1 } };
  const store = new Map<string, unknown>();
  const sessions = {
    get: async (id: string) => store.get(id) ?? null,
    init: async (id: string) => { store.set(id, {}); },
    clear: async (id: string) => { store.delete(id); },
  };
  const svc = new SimulationService({} as never, redis as never, engine as never, sessions as never);
  const agent: SimAgent = { id: "a1", version: 3, config: { script: "", requiredFields: [], hardRules: [], spec: { persona: "", goals: [], tools: [], runtime: { mode: "classic" } as never, models: {} } as never } };
  return { svc, agent, store, counter };
}
const scenario = (over: Partial<ScenarioDef> = {}) => ScenarioDef.parse({ name: "s", turns: ["one", "two", "three"], ...over });
const turn = (over: Record<string, unknown> = {}) => ({ visibleText: "ok", isComplete: false, capturedData: {}, goalProgress: {}, ...over });

describe("sandbox services", () => {
  const { svc } = build({ handleUserMessage: async () => turn() });
  const day = "2030-01-01T";

  it("finds only the contacts the scenario defines, case-insensitively", async () => {
    const s = svc.sandboxServices({ knownContacts: [{ email: "Ada@Example.com", firstName: "Ada" }], busy: [] });
    expect(await s.lookupCrmContact("ada@example.com")).toEqual({ success: true, found: true, firstName: "Ada" });
    expect(await s.lookupCrmContact("bob@example.com")).toEqual({ success: true, found: false });
  });

  it("reports only busy intervals that overlap the requested range", async () => {
    const s = svc.sandboxServices({ knownContacts: [], busy: [{ start: `${day}10:00:00Z`, end: `${day}11:00:00Z` }] });
    const inRange = await s.getBusyIntervals(new Date(`${day}09:00:00Z`), new Date(`${day}12:00:00Z`));
    expect(inRange).toMatchObject({ success: true, busy: [{ start: `${day}10:00:00.000Z` }] });
    expect(await s.getBusyIntervals(new Date(`${day}12:00:00Z`), new Date(`${day}13:00:00Z`))).toMatchObject({ busy: [] });
  });

  it("books a free slot without touching anything real, then refuses a double booking", async () => {
    const s = svc.sandboxServices({ knownContacts: [], busy: [{ start: `${day}10:00:00Z`, end: `${day}11:00:00Z` }] });
    expect(await s.bookSlot({ start: new Date(`${day}10:30:00Z`) })).toMatchObject({ success: false });
    const free = await s.bookSlot({ start: new Date(`${day}14:00:00Z`), durationMinutes: 60 });
    expect(free).toMatchObject({ success: true, eventId: expect.stringContaining("simulated_"), end: `${day}15:00:00.000Z` });
    expect(await s.bookSlot({ start: new Date(`${day}14:30:00Z`) })).toMatchObject({ success: false });
  });
});

describe("runScenario", () => {
  it("plays each visitor message, stops once the conversation completes, and grades the outcome", async () => {
    const engine = {
      handleUserMessage: vi.fn(async ({ simulation }: any) => {
        const n = engine.handleUserMessage.mock.calls.length;
        await simulation.sink.writeSteps([{ turn: n, seq: n, kind: "tool", name: "capture_field", output: { ok: true } }]);
        return turn({ visibleText: `reply ${n}`, isComplete: n === 2, outcomeType: n === 2 ? "demo_booking" : undefined, capturedData: { email: "a@b.co" } });
      }),
    };
    const { svc, agent } = build(engine);
    const run = await svc.runScenario({
      tenantId: "t", agent,
      scenario: scenario({ expect: { completes: true, outcomeType: "demo_booking", capturedKeys: ["email"], toolsCalled: ["capture_field"], maxTurns: 2 } }),
    });
    expect(engine.handleUserMessage).toHaveBeenCalledTimes(2); // the third visitor message was never sent
    expect(run.passed).toBe(true);
    expect(run.outcome).toMatchObject({ turnsUsed: 2, completed: true, replies: ["reply 1", "reply 2"] });
    expect(run.transcript.map((t) => `${t.role}: ${t.text}`)).toEqual(["visitor: one", "agent: reply 1", "visitor: two", "agent: reply 2"]);
    expect(run.steps).toHaveLength(2);
  });

  it("reports failed expectations, naming what was wrong", async () => {
    const { svc, agent } = build({ handleUserMessage: async () => turn() });
    const run = await svc.runScenario({ tenantId: "t", agent, scenario: scenario({ expect: { completes: true } }) });
    expect(run.passed).toBe(false);
    expect(run.checks).toEqual([{ name: "Conversation completes", passed: false, detail: "it did not complete" }]);
  });

  it("turns a model failure into a failed run (with the partial transcript) instead of throwing", async () => {
    let n = 0;
    const { svc, agent } = build({ handleUserMessage: async () => { if (++n === 2) throw new Error("provider exploded"); return turn(); } });
    const run = await svc.runScenario({ tenantId: "t", agent, scenario: scenario() });
    expect(run.passed).toBe(false);
    expect(run.error).toBe("provider exploded");
    expect(run.transcript).toHaveLength(3); // visitor, agent, visitor
  });

  it("a run with no expectations passes only if it didn't error", async () => {
    const ok = build({ handleUserMessage: async () => turn() });
    expect((await ok.svc.runScenario({ tenantId: "t", agent: ok.agent, scenario: scenario() })).passed).toBe(true);
    const bad = build({ handleUserMessage: async () => { throw new Error("x"); } });
    expect((await bad.svc.runScenario({ tenantId: "t", agent: bad.agent, scenario: scenario() })).passed).toBe(false);
  });

  it("counts blocked violations and cleans up its session", async () => {
    const { svc, agent, store } = build({
      handleUserMessage: async ({ simulation }: any) => {
        await simulation.sink.appendViolations([{ ruleId: "r" }]);
        return turn();
      },
    });
    const run = await svc.runScenario({ tenantId: "t", agent, scenario: scenario({ turns: ["x"], expect: { minBlockedViolations: 1 } }) });
    expect(run.outcome.blockedViolations).toBe(1);
    expect(run.passed).toBe(true);
    expect(store.size).toBe(0);
  });

  it("applies a variant's model overrides on top of the agent's own, without mutating the agent", async () => {
    const seen: unknown[] = [];
    const { svc, agent } = build({ handleUserMessage: async ({ simulation, config }: any) => { seen.push(config.spec.models, simulation.modelContext.agentModels); return turn(); } });
    await svc.runScenario({ tenantId: "t", agent, scenario: scenario({ turns: ["x"] }), models: { chat: { credentialId: "k", model: "m" } } });
    expect(seen[0]).toEqual({ chat: { credentialId: "k", model: "m" } });
    expect(seen[1]).toEqual({ chat: { credentialId: "k", model: "m" } });
    expect(agent.config.spec!.models).toEqual({});
  });
});

describe("daily meter", () => {
  it("rejects with 429 past the daily limit, and that is not swallowed as a failed scenario", async () => {
    const { svc, agent } = build({ handleUserMessage: async () => turn() }, { n: DAILY_SIMULATED_TURNS });
    await expect(svc.turn({ tenantId: "t", agent, sessionId: "abcdef", message: "hi", sandbox: { knownContacts: [], busy: [] } })).rejects.toBeInstanceOf(HttpException);
    await expect(svc.runScenario({ tenantId: "t", agent, scenario: scenario() })).rejects.toMatchObject({ status: 429 });
  });
});
