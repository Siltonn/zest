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
  /** Where uploaded images live. Mount this as a volume in a container. */
  MEDIA_DIR: z.string().default("./media"),
  DEMO_MODE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  MAIL_PROVIDER: z.enum(["resend", "smtp", "console"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  // One key, every model, and a spend cap — the easiest way to try Zest
  // without opening an account with a model vendor. Checked before the others.
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  /** Overrides the default model; on OpenRouter use a `vendor/model` slug. */
  ZEST_MODEL: z.string().optional(),
  /** Overrides the cheap tier (triage-volume work, simulated audience replies). */
  ZEST_MODEL_CHEAP: z.string().optional(),
  // Defaults point at the Mailpit container in docker-compose, so the demo
  // delivers real mail to a real inbox with nothing to configure.
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Zest <zest@localhost>"),
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
