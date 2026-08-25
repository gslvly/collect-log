import { z } from 'zod';

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const origins = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .refine((value) => value.length > 0, 'must contain at least one origin');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_INGEST_USER: z.string().min(1),
  CLICKHOUSE_INGEST_PASSWORD: z.string().min(1),
  CLICKHOUSE_META_USER: z.string().min(1),
  CLICKHOUSE_META_PASSWORD: z.string().min(1),
  CLICKHOUSE_READONLY_USER: z.string().min(1),
  CLICKHOUSE_READONLY_PASSWORD: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  BOOTSTRAP_ADMIN_USERNAME: optionalString,
  BOOTSTRAP_ADMIN_PASSWORD: optionalString,
  INGEST_ALLOWED_ORIGINS: origins,
  CONSOLE_ALLOWED_ORIGINS: origins,
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `- ${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

export const env = parseEnv(process.env);
