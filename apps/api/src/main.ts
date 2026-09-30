import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Server as HttpServer } from "node:http";
import { AppModule } from "./app.module.js";
import { AgentGateway } from "./modules/agent/gateway/agent.gateway.js";

async function bootstrap() {
  // rawBody: true — required for Stripe webhook signature verification
  // (stripe.webhooks.constructEvent needs the exact bytes, not the
  // JSON-parsed body). Nest populates req.rawBody alongside normal parsing.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Behind a load balancer/reverse proxy, req.ip is the proxy's address
  // unless Express is told which hop(s) to trust — without this, every
  // visitor collapses onto one IP for rate-limiting purposes. TRUST_PROXY
  // is the hop count (e.g. "1" for a single LB in front); unset by default
  // since trusting it blindly with no proxy in front lets a client spoof
  // X-Forwarded-For to dodge per-IP limits entirely.
  if (process.env.TRUST_PROXY) {
    app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  }
  // Default express body limit (100kb) is too small for a form's "file"
  // field, which transports the upload as a base64 data URL inside the JSON
  // body — see FormField.fileMaxSizeKb (capped at 1.5MB raw, ~2MB base64).
  app.useBodyParser("json", { limit: "3mb" });
  // The portal/admin origins may send credentials (the refresh cookie). Every
  // other origin — the widget and public forms are embedded on customer
  // sites — still gets CORS, but never credentials, so a third-party page
  // can't ride a signed-in user's session.
  const trusted = new Set(
    (process.env.CORS_ORIGINS ?? "http://localhost:3001,http://localhost:3002").split(",").map((o) => o.trim()),
  );
  // enableCors(fn) calls fn as (req, callback) — this is the "options
  // delegate" form of the `cors` package (distinct from its `origin` SUB-key
  // being a function, which instead gets called as (origin, callback); easy
  // to mix up, and mixing it up silently drops Access-Control-Allow-Credentials
  // for every origin with no visible error).
  app.enableCors((req: { headers: { origin?: string } }, cb: (err: Error | null, options: object) => void) => {
    const origin = req.headers.origin;
    cb(null, origin && trusted.has(origin) ? { origin, credentials: true } : { origin: true, credentials: false });
  });

  // Explicit wiring, not a lifecycle hook — see AgentGateway.attach() for why.
  app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`envoy api listening on :${port}`);
}

bootstrap();
