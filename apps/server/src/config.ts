import { z } from "zod";

/**
 * One backend codebase, three ways to run it. `all` keeps the demo to a single
 * container; splitting into `api` and `worker` later is a deploy change, not a
 * code change — the modules are already separated.
 */
export const SERVER_MODES = ["api", "worker", "all"] as const;
export type ServerMode = (typeof SERVER_MODES)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  MODE: z.enum(SERVER_MODES).default("all"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ZEST_ENCRYPTION_KEY: z.string().min(16),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().default("http://localhost:4000"),
  WEB_URL: z.string().default("http://localhost:3000"),
  DEMO_MODE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  MAIL_PROVIDER: z.enum(["resend", "smtp", "console"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const runsApi = (mode: ServerMode): boolean => mode === "api" || mode === "all";
export const runsWorker = (mode: ServerMode): boolean =>
  mode === "worker" || mode === "all";
