import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Server as HttpServer } from "node:http";
import { AppModule } from "./app.module.js";
import { AgentGateway } from "./modules/agent/gateway/agent.gateway.js";

async function bootstrap() {
  // rawBody: true — required for Stripe webhook signature verification
  // (stripe.webhooks.constructEvent needs the exact bytes, not the
  // JSON-parsed body). Nest populates req.rawBody alongside normal parsing.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors();

  // Explicit wiring, not a lifecycle hook — see AgentGateway.attach() for why.
  app.get(AgentGateway).attach(app.getHttpServer() as HttpServer);

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`envoy api listening on :${port}`);
}

bootstrap();
