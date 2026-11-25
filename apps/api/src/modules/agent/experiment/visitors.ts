import type { LlmProvider } from "../providers/llm/types.js";
import { rng } from "./stats.js";

/**
 * Simulated website visitors. Each has facts they'll share and a temperament. Two implementations play them:
 * a rule-based visitor that is fully deterministic (so a result can be reproduced exactly and the harness itself
 * can be tested), and an LLM-played visitor for evaluating a real model with a more human range of behaviour.
 */

export type Temperament = "open" | "reluctant" | "hardline";

export interface Persona {
  id: string;
  temperament: Temperament;
  /** What this visitor will say if asked, by field key. */
  facts: Record<string, string>;
  /** Fields they hesitate to give. A reluctant visitor shares them once a reason is given; a hardline one never does. */
  reluctantFields: string[];
  /** How many replies without any progress they tolerate before leaving. */
  patience: number;
}

export type VisitorAction = { type: "say"; message: string } | { type: "leave"; reason: string };

export interface Visitor {
  readonly persona: Persona;
  /** The visitor's reply to what the agent just said (or their opening line when `agentText` is null). */
  next(agentText: string | null): Promise<VisitorAction>;
}

/** Which keywords in an agent's message mean it is asking for each field. */
const KEYWORDS: Record<string, RegExp> = {
  name: /\bname\b/i,
  email: /\be-?mail\b/i,
  phone: /\b(phone|mobile|number|call you)\b/i,
  budget: /\bbudget\b/i,
  company: /\b(company|organi[sz]ation|business)\b/i,
};

/** What counts as the agent giving a reason for asking — the thing a reluctant visitor is waiting for. */
const JUSTIFICATION = /\b(because|so we can|so that|so i can|only need|only use|used to|in case|to confirm|to send|to reach)\b/i;

const FIRST = ["Ada", "Grace", "Alan", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Radia", "Tim"];
const LAST = ["Lovelace", "Hopper", "Turing", "Torvalds", "Hamilton", "Ritchie", "Liskov", "Thompson", "Perlman", "Berners"];

export interface PopulationMix {
  open: number;
  reluctant: number;
  hardline: number;
}
export const DEFAULT_MIX: PopulationMix = { open: 0.55, reluctant: 0.35, hardline: 0.1 };

/** Draws one visitor. Seeded, so trial i is the same person in every run and in every arm of an experiment. */
export function samplePersona(seed: number, mix: PopulationMix = DEFAULT_MIX, reluctantField = "phone"): Persona {
  const random = rng(seed);
  const roll = random() * (mix.open + mix.reluctant + mix.hardline);
  const temperament: Temperament = roll < mix.open ? "open" : roll < mix.open + mix.reluctant ? "reluctant" : "hardline";
  const first = FIRST[Math.floor(random() * FIRST.length)]!;
  const last = LAST[Math.floor(random() * LAST.length)]!;
  const n = Math.floor(random() * 9000) + 1000;
  return {
    id: `visitor-${seed}`,
    temperament,
    facts: {
      name: `${first} ${last}`,
      email: `${first}.${last}${n}@example.com`.toLowerCase(),
      phone: `+4477009${String(n).padStart(5, "0")}`,
      budget: String(Math.floor(random() * 20) * 500 + 1000),
      company: `${last} Ltd`,
    },
    reluctantFields: temperament === "open" ? [] : [reluctantField],
    patience: 2 + Math.floor(random() * 3),
  };
}

/** The agent's most recent ask that this visitor hasn't answered yet, by field key. */
function askedFor(agentText: string, persona: Persona, given: Set<string>): string | undefined {
  return Object.keys(persona.facts).find((key) => !given.has(key) && KEYWORDS[key]?.test(agentText));
}

/** Deterministic: no model, no randomness beyond the persona itself. */
export class RuleVisitor implements Visitor {
  private given = new Set<string>();
  private refused = new Set<string>();
  private idle = 0;

  constructor(readonly persona: Persona) {}

  async next(agentText: string | null): Promise<VisitorAction> {
    if (agentText === null) return { type: "say", message: "Hi, I'd like some help." };
    const key = askedFor(agentText, this.persona, this.given);
    if (!key) {
      // Nothing they can answer. Patience runs out if the agent keeps talking without getting anywhere.
      if (++this.idle > this.persona.patience) return { type: "leave", reason: "lost patience" };
      return { type: "say", message: "Okay." };
    }
    this.idle = 0;

    if (this.persona.reluctantFields.includes(key)) {
      const justified = JUSTIFICATION.test(agentText);
      if (this.persona.temperament === "hardline") {
        if (this.refused.has(key)) return { type: "leave", reason: `refused to share ${key}` };
        this.refused.add(key);
        return { type: "say", message: "I'd rather not share that." };
      }
      if (!justified) {
        if (this.refused.has(key)) return { type: "leave", reason: `wasn't told why ${key} was needed` };
        this.refused.add(key);
        return { type: "say", message: "Why do you need that?" };
      }
    }
    this.given.add(key);
    return { type: "say", message: `My ${key} is ${this.persona.facts[key]}` };
  }
}

export const LEAVE_MARKER = "[LEAVE]";

/** Plays a persona with a language model, for a more human spread of behaviour than the rules give. */
export class LlmVisitor implements Visitor {
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(
    readonly persona: Persona,
    private readonly llm: Pick<LlmProvider, "complete">,
  ) {}

  private system(): string {
    const p = this.persona;
    const facts = Object.entries(p.facts).map(([k, v]) => `- ${k}: ${v}`).join("\n");
    const temperament = {
      open: "You are friendly and happy to share your details when asked.",
      reluctant: `You are wary about sharing ${p.reluctantFields.join(" and ")}. You only share ${p.reluctantFields.join(" or ")} if the assistant first gives a clear reason for needing it; if it just asks, you ask why, and if it still doesn't explain you leave.`,
      hardline: `You will not share your ${p.reluctantFields.join(" or ")} under any circumstances. If pressed twice, you leave.`,
    }[p.temperament];
    return [
      "You are role-playing a person visiting a business's website and chatting with its assistant. Stay in character and reply with ONLY what you would type, in one or two short sentences.",
      `Your details (share only what you're asked for, never volunteer the rest):\n${facts}`,
      temperament,
      `You lose patience and leave if the conversation goes ${p.patience} replies without getting anywhere. To leave, reply with exactly ${LEAVE_MARKER}.`,
    ].join("\n\n");
  }

  async next(agentText: string | null): Promise<VisitorAction> {
    if (agentText === null) {
      this.history.push({ role: "assistant", content: "Hi, I'd like some help." });
      return { type: "say", message: "Hi, I'd like some help." };
    }
    // From the visitor model's point of view the agent is the other party ("user") and the visitor is itself ("assistant").
    this.history.push({ role: "user", content: agentText });
    const { text } = await this.llm.complete({ purpose: "chat", maxTokens: 120, messages: [{ role: "system", content: this.system() }, ...this.history] });
    const reply = text.trim();
    if (!reply || reply.includes(LEAVE_MARKER)) return { type: "leave", reason: "left (model chose to leave)" };
    this.history.push({ role: "assistant", content: reply });
    return { type: "say", message: reply.slice(0, 600) };
  }
}
