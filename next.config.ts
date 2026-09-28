import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  // Do not advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  // Pin the project root: a stray package-lock.json in a parent folder must not
  // be mistaken for the workspace root.
  turbopack: {
    root: path.join(__dirname),
  },
  // If you need to test via an ngrok tunnel on mobile during development,
  // set NGROK_HOST in .env.local (e.g. "your-subdomain.ngrok-free.dev").
  // This is only used in development; production builds ignore it.
  ...(process.env.NODE_ENV !== 'production' && process.env.NGROK_HOST
    ? { allowedDevOrigins: [process.env.NGROK_HOST] }
    : {}),
};

// Sentry only reports errors once SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN are set.
// Source maps are uploaded when SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are set.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  // Browser error reports go through this site, so they are not blocked by ad
  // blockers and the Content-Security-Policy can stay limited to our own domain.
  tunnelRoute: "/monitoring",
});
