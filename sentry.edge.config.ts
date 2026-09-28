import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "./src/lib/sentry-scrub";

// Does nothing until SENTRY_DSN is set in the environment.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  // Customer details must not end up in Sentry (see the privacy policy):
  // no user info, cookies, headers, request bodies or query strings.
  dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
  beforeSend: scrubEvent,
});
