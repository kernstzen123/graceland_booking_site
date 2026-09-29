import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const isProduction = process.env.NODE_ENV === 'production';

function supabaseOrigin() {
  try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '').origin; } catch { return ''; }
}

/**
 * Content-Security-Policy: what the pages may load and where they may send data.
 * - scripts: this site only ('unsafe-inline' for Next.js's inline bootstrap
 *   scripts; nonces would force every page to render dynamically), plus
 *   WebAssembly for the ticket scanner, Vercel's analytics script in dev and
 *   Google Analytics (loaded only after the visitor accepts cookies).
 * - connections: this site (including Sentry via /monitoring), Supabase (staff
 *   sign-in, proof uploads), Vercel analytics and Google Analytics.
 * - forms: this site and PayFast (the payment redirect).
 * - frame-ancestors 'none': no other site may embed these pages (clickjacking).
 */
function contentSecurityPolicy() {
  const supabase = supabaseOrigin();
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://va.vercel-scripts.com https://www.googletagmanager.com${isProduction ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabase} https://*.google-analytics.com https://*.googletagmanager.com`.replace(/\s+/g, ' '),
    "font-src 'self' data:",
    `connect-src 'self' ${supabase} https://va.vercel-scripts.com https://vitals.vercel-insights.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com`.replace(/\s+/g, ' '),
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.payfast.co.za https://*.payfast.io",
    "frame-ancestors 'none'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

const CSP = contentSecurityPolicy();

/** The real domain's host name, or '' while NEXT_PUBLIC_APP_URL is still a vercel.app address. */
function canonicalHostname() {
  try {
    const host = new URL(process.env.NEXT_PUBLIC_APP_URL || '').hostname;
    return host && !host.endsWith('.vercel.app') ? host : '';
  } catch { return ''; }
}

export function proxy(request: NextRequest) {
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const protocol = forwardedProtocol || request.nextUrl.protocol.replace(':', '');
  const isLocal = request.nextUrl.hostname === 'localhost' || request.nextUrl.hostname === '127.0.0.1';
  if (isProduction && protocol !== 'https' && !isLocal) {
    const httpsUrl = request.nextUrl.clone();
    httpsUrl.protocol = 'https:';
    return NextResponse.redirect(httpsUrl, 308);
  }

  // One address for Google and customers: on the live deployment, send the
  // old *.vercel.app address to the real domain (NEXT_PUBLIC_APP_URL).
  // Preview deployments keep working on their own addresses. The PayFast
  // webhook is never redirected (PayFast does not follow redirects).
  const canonicalHost = canonicalHostname();
  if (process.env.VERCEL_ENV === 'production' && canonicalHost && request.nextUrl.hostname.endsWith('.vercel.app')
      && request.nextUrl.hostname !== canonicalHost && !request.nextUrl.pathname.startsWith('/api/')) {
    const target = request.nextUrl.clone();
    target.protocol = 'https:';
    target.hostname = canonicalHost;
    target.port = '';
    return NextResponse.redirect(target, 308);
  }

  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  response.headers.set('Content-Security-Policy', CSP);
  // Older browsers that ignore frame-ancestors.
  response.headers.set('X-Frame-Options', 'DENY');
  if (isProduction) response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // Keep the staff portal, sign-in links and API out of search results.
  if (/^\/(admin|auth|api)(\/|$)/.test(request.nextUrl.pathname)) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
