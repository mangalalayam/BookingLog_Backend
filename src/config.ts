const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
};

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  adminApiKey: required('ADMIN_API_KEY'),
  port: Number(process.env.PORT ?? 4000),
  /** How long a login lasts before the app must refresh or log in again. */
  tokenTtl: '30d',
} as const;
