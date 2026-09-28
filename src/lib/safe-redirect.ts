export const DEFAULT_STAFF_REDIRECT = '/admin/set-password';

/**
 * Where to send a staff member after signing in. The value comes from the link
 * (?next=), so it could point anywhere; only paths inside the staff portal on
 * this site are allowed. Anything else ("//evil.com", "https://…", "/\evil.com",
 * "javascript:…") falls back to the set-password page.
 */
export function safeNextPath(value: string | null | undefined, origin: string, fallback = DEFAULT_STAFF_REDIRECT) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !(url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
