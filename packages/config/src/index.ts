import { z } from "zod";

/**
 * Single source of truth for runtime configuration.
 * Every app calls loadEnv() at startup and fails fast on missing or malformed values.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  EXTRACTION_MODEL: z.string().default("claude-sonnet-5-5"),
  CLASSIFY_MODEL: z.string().default("claude-haiku-5-5"),
  ANTHROPIC_ITPM_BUDGET: z.coerce.number().int().positive().default(400_000),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEBHOOK_SIGNING_SECRET: z.string().min(16),
  /** HMAC key for pagination cursors so clients can't forge or edit them. */
  CURSOR_SIGNING_SECRET: z.string().min(16),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat `KEY=` (empty) in .env files as unset, so optional values and defaults apply.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
