import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MIX, LEAVE_MARKER, LlmVisitor, RuleVisitor, samplePersona, type Persona } from "./visitors.js";

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: "v", temperament: "open", patience: 2, reluctantFields: [],
  facts: { name: "Ada Lovelace", email: "ada@example.com", phone: "+447700900123", budget: "5000", company: "Lovelace Ltd" }, ...over,
});

describe("samplePersona", () => {
  it("is the same person for the same seed, a different one for another", () => {
    expect(samplePersona(7)).toEqual(samplePersona(7));
    expect(samplePersona(7)).not.toEqual(samplePersona(8));
  });
  it("draws the intended mix of temperaments", () => {
    const counts = { open: 0, reluctant: 0, hardline: 0 };
    for (let i = 0; i < 4000; i++) counts[samplePersona(i).temperament]++;
    expect(counts.open / 4000).toBeGreaterThan(DEFAULT_MIX.open - 0.04);
    expect(counts.open / 4000).toBeLessThan(DEFAULT_MIX.open + 0.04);
    expect(counts.reluctant / 4000).toBeGreaterThan(DEFAULT_MIX.reluctant - 0.04);
    expect(counts.hardline / 4000).toBeLessThan(DEFAULT_MIX.hardline + 0.03);
  });
  it("gives only the wary ones a sensitive field, and always usable facts", () => {
    for (let i = 0; i < 200; i++) {
      const p = samplePersona(i);
      expect(p.reluctantFields).toEqual(p.temperament === "open" ? [] : ["phone"]);
      expect(p.facts.phone).toMatch(/^\+\d{10,15}$/);
      expect(p.facts.email).toMatch(/^[^@\s]+@example\.com$/);
      expect(p.patience).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("RuleVisitor", () => {
  const say = async (v: RuleVisitor, text: string | null) => v.next(text);

  it("opens the conversation, then answers what it is asked, once", async () => {
    const v = new RuleVisitor(persona());
    expect(await say(v, null)).toEqual({ type: "say", message: "Hi, I'd like some help." });
    expect(await say(v, "Could you share your email?")).toEqual({ type: "say", message: "My email is ada@example.com" });
    // Asked again after it was given: nothing new to answer, so it is just patient.
    expect(await say(v, "Could you share your email?")).toEqual({ type: "say", message: "Okay." });
  });

  it("leaves when the agent talks without getting anywhere for longer than its patience", async () => {
    const v = new RuleVisitor(persona({ patience: 2 }));
    expect((await say(v, "Tell me more!")).type).toBe("say");
    expect((await say(v, "Anything else?")).type).toBe("say");
    expect(await say(v, "Hello?")).toEqual({ type: "leave", reason: "lost patience" });
  });

  it("resets its patience whenever it is asked something it can answer", async () => {
    const v = new RuleVisitor(persona({ patience: 1 }));
    await say(v, "Welcome!");
    await say(v, "What's your name?");
    expect((await say(v, "Great.")).type).toBe("say"); // would have left without the reset
  });

  describe("a reluctant visitor", () => {
    const wary = () => new RuleVisitor(persona({ temperament: "reluctant", reluctantFields: ["phone"], patience: 5 }));

    it("shares the field straight away when the agent says why it's needed", async () => {
      const r = await say(wary(), "Could you share your phone? I only need it so we can confirm your booking.");
      expect(r).toEqual({ type: "say", message: "My phone is +447700900123" });
    });
    it("asks why when just asked, and leaves if it is asked again without a reason", async () => {
      const v = wary();
      expect(await say(v, "Could you share your phone?")).toEqual({ type: "say", message: "Why do you need that?" });
      expect(await say(v, "Could you share your phone?")).toEqual({ type: "leave", reason: "wasn't told why phone was needed" });
    });
    it("shares after asking why, if the second ask comes with a reason", async () => {
      const v = wary();
      await say(v, "Could you share your phone?");
      expect((await say(v, "Sure — it's only used to send your confirmation. Your phone?")).type).toBe("say");
      expect(await say(v, "And your email?")).toEqual({ type: "say", message: "My email is ada@example.com" }); // other fields are never an issue
    });
  });

  it("a hardline visitor never shares the field, even when given a reason, and leaves on the second ask", async () => {
    const v = new RuleVisitor(persona({ temperament: "hardline", reluctantFields: ["phone"], patience: 9 }));
    expect(await say(v, "Your phone? I only need it so we can confirm.")).toEqual({ type: "say", message: "I'd rather not share that." });
    expect(await say(v, "Your phone? It's only used to confirm.")).toEqual({ type: "leave", reason: "refused to share phone" });
  });

  it("recognises how an agent asks for each field", async () => {
    for (const [ask, key] of [["What's your name?", "name"], ["Your e-mail address?", "email"], ["Best number to call you on?", "phone"], ["What's your budget?", "budget"], ["Which company are you with?", "company"]] as const) {
      const r = await new RuleVisitor(persona()).next(ask);
      expect(r, ask).toEqual({ type: "say", message: expect.stringContaining(`My ${key} is`) });
    }
  });
});

describe("LlmVisitor", () => {
  const llm = (replies: string[]) => ({ complete: vi.fn(async () => ({ text: replies.shift() ?? "" })) });

  it("briefs the model with the persona's facts and temperament, and plays the agent's lines as the other party", async () => {
    const model = llm(["My email is ada@example.com"]);
    const v = new LlmVisitor(persona({ temperament: "reluctant", reluctantFields: ["phone"], patience: 3 }), model);
    await v.next(null);
    expect(await v.next("Could you share your email?")).toEqual({ type: "say", message: "My email is ada@example.com" });
    const { messages } = (model.complete.mock.calls[0] as unknown as [{ messages: Array<{ role: string; content: string }> }])[0];
    expect(messages[0]!.content).toContain("email: ada@example.com");
    expect(messages[0]!.content).toContain("wary about sharing phone");
    expect(messages[0]!.content).toContain(LEAVE_MARKER);
    expect(messages.slice(1)).toEqual([{ role: "assistant", content: "Hi, I'd like some help." }, { role: "user", content: "Could you share your email?" }]);
  });

  it("leaves when the model says so, or says nothing", async () => {
    expect(await new LlmVisitor(persona(), llm([`Nope. ${LEAVE_MARKER}`])).next("Hello?")).toMatchObject({ type: "leave" });
    expect(await new LlmVisitor(persona(), llm([""])).next("Hello?")).toMatchObject({ type: "leave" });
  });

  it("caps what a rambling model can send", async () => {
    const r = await new LlmVisitor(persona(), llm(["x".repeat(5000)])).next("Hi");
    expect(r.type === "say" && r.message.length).toBe(600);
  });
});
