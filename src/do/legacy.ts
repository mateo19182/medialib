import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

// Kept only because the deployed Worker previously registered this class.
// The active application no longer binds to or calls Durable Objects.
export class Library extends DurableObject<Env> {}
