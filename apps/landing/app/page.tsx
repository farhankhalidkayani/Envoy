import Link from "next/link";
import { CardIcon, ChatIcon, FormIcon, LogoMark, PlugIcon, ShieldIcon, SyncIcon } from "./icons";

const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3001";
const SIGNUP_URL = `${PORTAL_URL}/register`;
const LOGIN_URL = `${PORTAL_URL}/login`;

const FEATURES = [
  {
    icon: ChatIcon,
    title: "Conversational lead capture",
    text: "Your agent asks for exactly the fields you configure, in order, then hands off cleanly — no rigid forms, no dead ends.",
  },
  {
    icon: ShieldIcon,
    title: "Rule-governed by design",
    text: "Hard rules block or escalate anything off-limits before it reaches a visitor, so your agent stays on-brand and on-policy.",
  },
  {
    icon: FormIcon,
    title: "Multi-step lead forms",
    text: "A drag-and-drop builder for conditional, multi-step forms — dropdowns can even pull live options from your own API.",
  },
  {
    icon: SyncIcon,
    title: "Pushes straight to your CRM",
    text: "Every completed conversation or form submission maps to your CRM's fields and pushes automatically, with retries if it fails.",
  },
  {
    icon: PlugIcon,
    title: "Webhooks, email & calendar",
    text: "Fan captured data out to a webhook, an email notification, or a calendar booking — connect once, every source routes through it.",
  },
  {
    icon: CardIcon,
    title: "Usage-based billing built in",
    text: "Included conversations per month, metered overage, and a self-serve billing portal — you don't have to build any of it.",
  },
];

const STEPS = [
  {
    title: "Configure your agent",
    text: "Write the script, define the fields it needs to capture, and set hard rules it must never cross. Preview it live as you go.",
  },
  {
    title: "Embed it on your site",
    text: "Copy one script tag. The widget matches your brand colors and shows a lead form inline when a conversation calls for one.",
  },
  {
    title: "Leads land where you work",
    text: "Completed conversations and form submissions push to your CRM, webhook, inbox or calendar — no manual follow-up required.",
  },
];

export default function LandingPage() {
  return (
    <>
      <header className="nav">
        <div className="container nav-row">
          <Link href="/" className="brand">
            <span className="brand-mark">
              <LogoMark />
            </span>
            Envoy
          </Link>
          <nav className="nav-links">
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="nav-actions">
            <a href={LOGIN_URL} className="btn btn-ghost">
              Log in
            </a>
            <a href={SIGNUP_URL} className="btn btn-primary">
              Get started
            </a>
          </div>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-glow" aria-hidden />
          <div className="container">
            <span className="eyebrow">AI agents for your website</span>
            <h1 className="hero-title">
              Turn website visitors into <span className="accent-text">qualified leads</span>, automatically
            </h1>
            <p className="hero-sub">
              Envoy embeds a branded, rule-governed AI chat agent on your site. It captures exactly the
              information you need, then routes it to your CRM, your inbox, or your calendar — no engineering
              required.
            </p>
            <div className="hero-actions">
              <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                Start free
              </a>
              <a href="#how-it-works" className="btn btn-lg">
                See how it works
              </a>
            </div>
            <p className="hero-note">No credit card required to start.</p>

            <div className="hero-visual" aria-hidden>
              <div className="mock-widget">
                <div className="mock-header">
                  <span className="mock-dot" />
                  Chat with us
                </div>
                <div className="mock-body">
                  <div className="bubble bubble-agent">Hi! I'd be happy to help — what's your email?</div>
                  <div className="bubble bubble-user">jane@acme.com</div>
                  <div className="bubble bubble-agent">Great, and what are you looking to book?</div>
                </div>
                <div className="mock-input">
                  <div className="mock-input-field" />
                  <div className="mock-input-send" />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="features">
          <div className="container">
            <div className="section-head">
              <span className="section-kicker">Features</span>
              <h2 className="section-title">Everything between "visitor" and "lead in your CRM"</h2>
              <p className="section-sub">
                Envoy isn't just a chat widget — it's the whole path from a visitor's first message to a
                record your team can act on.
              </p>
            </div>
            <div className="grid">
              {FEATURES.map((f) => (
                <div className="card" key={f.title}>
                  <div className="card-icon">
                    <f.icon />
                  </div>
                  <div className="card-title">{f.title}</div>
                  <p className="card-text">{f.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="how-it-works">
          <div className="container">
            <div className="section-head">
              <span className="section-kicker">How it works</span>
              <h2 className="section-title">Live in three steps</h2>
              <p className="section-sub">Most teams go from signup to a working embed in under ten minutes.</p>
            </div>
            <div className="steps">
              {STEPS.map((s, i) => (
                <div className="step" key={s.title}>
                  <div className="step-num">{i + 1}</div>
                  <div className="step-title">{s.title}</div>
                  <p className="step-text">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="pricing">
          <div className="container">
            <div className="section-head">
              <span className="section-kicker">Pricing</span>
              <h2 className="section-title">Usage-based, no surprises</h2>
              <p className="section-sub">
                Every plan includes a set number of conversations per month, with metered overage billed at a
                flat per-conversation rate. Start free and upgrade when you're ready.
              </p>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
              <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
                <div>
                  <div className="card-title" style={{ fontSize: 19 }}>
                    Talk to us about your usage
                  </div>
                  <p className="card-text">
                    Pricing scales with how many conversations you run — create a free workspace and see your
                    exact usage and rate in the billing tab before you ever enter a card.
                  </p>
                </div>
                <a href={SIGNUP_URL} className="btn btn-primary btn-lg" style={{ flexShrink: 0 }}>
                  Start free
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="container">
            <div className="cta-band">
              <h2 className="section-title">Ready to put an agent on your site?</h2>
              <p>Create a workspace, configure your first agent, and get an embed snippet in minutes.</p>
              <div className="hero-actions">
                <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                  Start free
                </a>
                <a href={LOGIN_URL} className="btn btn-lg">
                  Log in
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="container footer-row">
          <Link href="/" className="brand">
            <span className="brand-mark">
              <LogoMark />
            </span>
            Envoy
          </Link>
          <div className="footer-links">
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href={LOGIN_URL}>Log in</a>
            <a href={SIGNUP_URL}>Sign up</a>
          </div>
          <span className="footer-copy">© {new Date().getFullYear()} Envoy</span>
        </div>
      </footer>
    </>
  );
}
