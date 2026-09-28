import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Strip personal and secret data from Sentry error reports before they are
 * sent: request bodies, cookies and auth headers, and query strings (which can
 * hold ticket tokens and booking references). Email addresses in messages are
 * masked. Shared by the browser, server and edge configs.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const maskEmails = (text: string | undefined) => text?.replace(EMAIL, "[email]");
const stripQuery = (url: string | undefined) => url?.split("?")[0];

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    event.request.url = stripQuery(event.request.url);
    if (event.request.headers) {
      for (const header of Object.keys(event.request.headers)) {
        if (/authorization|cookie|apikey|x-forwarded-for/i.test(header)) delete event.request.headers[header];
      }
    }
  }
  delete event.user;
  event.message = maskEmails(event.message);
  for (const exception of event.exception?.values || []) exception.value = maskEmails(exception.value);
  for (const breadcrumb of event.breadcrumbs || []) {
    breadcrumb.message = maskEmails(breadcrumb.message);
    if (breadcrumb.data && typeof breadcrumb.data.url === "string") breadcrumb.data.url = stripQuery(breadcrumb.data.url);
  }
  return event;
}
