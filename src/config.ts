const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it as an environment variable (locally: copy .env.example to .env).`,
    );
  }
  return value;
};

const number = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${value}".`);
  }
  return parsed;
};

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  adminApiKey: required('ADMIN_API_KEY'),
  port: number('PORT', 4000),
  /** How long a login lasts before the app must refresh or log in again. */
  tokenTtl: '30d',
  /** Most database connections this server opens at once. */
  dbPoolMax: number('DB_POOL_MAX', 10),
  /**
   * How many proxies sit in front of the server. Needed to see each caller's
   * real IP address (used for rate limits). Railway has one; locally none.
   */
  trustProxy: number('TRUST_PROXY', process.env.RAILWAY_ENVIRONMENT ? 1 : 0),
  /** Most requests one IP address may make per minute. */
  rateLimitPerMinute: number('RATE_LIMIT_PER_MINUTE', 300),
  /** One log line per request; set LOG_REQUESTS=false to switch off. */
  logRequests: process.env.LOG_REQUESTS !== 'false',
} as const;
