import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // `server-only` throws outside the Next.js server build; tests run in plain Node.
      'server-only': path.resolve(import.meta.dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,mjs}'],
    environment: 'node',
    // Dummy credentials: unit tests never reach Supabase.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      QR_SIGNING_SECRET: 'test-qr-secret',
    },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
