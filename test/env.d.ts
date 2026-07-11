import type { Env } from "../src/types";

// Make `env` from "cloudflare:test" carry our real bindings (DB, MEDIA, secrets).
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
