/**
 * Environment variable helpers that fail closed in production.
 *
 * In production (`NODE_ENV === 'production'`), a missing required env var
 * throws immediately so the route returns a 500 rather than silently falling
 * back to sandbox/dev defaults.
 *
 * In development, `devDefault` is returned if the real var is absent, so
 * local devs can run without configuring every secret up-front.
 *
 * These checks are intentionally lazy (called at request time, not at import
 * time) so that `next build` with dummy env vars still succeeds.
 */

const isProd = () => process.env.NODE_ENV === 'production';

/**
 * Return the value of `process.env[name]`, or throw in production if missing.
 * In development, falls back to `devDefault` when the var is unset.
 */
export function requireEnv(name: string, devDefault?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;

  if (isProd()) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `This must be set in production to avoid silent fallbacks.`
    );
  }

  if (devDefault !== undefined) return devDefault;

  throw new Error(
    `Environment variable ${name} is not set. ` +
    `Add it to .env.local or provide a devDefault for local development.`
  );
}
