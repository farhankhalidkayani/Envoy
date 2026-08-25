import { existsSync } from "node:fs";

// Load apps/api/.env into process.env for tests (Node 20.6+ built-in).
if (existsSync(new URL("./.env", import.meta.url))) {
  process.loadEnvFile(new URL("./.env", import.meta.url));
}
