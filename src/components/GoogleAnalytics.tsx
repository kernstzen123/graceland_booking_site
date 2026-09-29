'use client';

import Link from 'next/link';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { GA_MEASUREMENT_ID, SITE_URL } from '@/lib/site';

/**
 * Google Analytics, loaded only after the visitor accepts analytics cookies
 * (POPIA). It runs only on the live domain (not on localhost or Vercel
 * previews) and never on the staff portal. Page views are sent by hand with
 * the query string removed, so booking references (?reference=…, ?ref=…)
 * never reach Google; only campaign parameters (utm_*, gclid) are kept.
 */

type Consent = 'granted' | 'denied';
const STORAGE_KEY = 'graceland-analytics-consent';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

// ---- The visitor's choice, kept in localStorage (or in memory when storage is blocked).

let memoryConsent: Consent | null = null;
const listeners = new Set<() => void>();

function readConsent(): Consent | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'granted' || stored === 'denied') return stored;
  } catch { /* storage blocked: fall back to this visit's choice */ }
  return memoryConsent;
}

function writeConsent(value: Consent | null) {
  memoryConsent = value;
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** 'pending' while rendering on the server, 'unset' until the visitor chooses. */
function useConsent() {
  return useSyncExternalStore(subscribe, () => readConsent() ?? 'unset', () => 'pending');
}

const noSubscription = () => () => {};
function isLiveSite() {
  try { return window.location.hostname === new URL(SITE_URL).hostname; } catch { return false; }
}

// ---- Helpers

const isStaffPage = (pathname: string) => /^\/(admin|auth)(\/|$)/.test(pathname);

function pageUrlWithoutPersonalData() {
  const url = new URL(window.location.href);
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('utm_') || key === 'gclid') kept.set(key, value);
  }
  const query = kept.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

function removeAnalyticsCookies() {
  const parts = window.location.hostname.split('.');
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (!name.startsWith('_ga')) continue;
    document.cookie = `${name}=; Max-Age=0; path=/`;
    for (let i = 0; i < parts.length - 1; i++) {
      document.cookie = `${name}=; Max-Age=0; path=/; domain=.${parts.slice(i).join('.')}`;
    }
  }
}

/** Title of the last page view sent, to notice when the next page's title is ready. */
let lastSentTitle: string | null = null;

function setAnalyticsDisabled(disabled: boolean) {
  (window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`] = disabled;
}

/** Re-opens the cookie banner so the visitor can change their choice. */
export function CookieSettingsButton({ label = 'Cookie settings' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => writeConsent(null)}
      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
    >
      {label}
    </button>
  );
}

export function GoogleAnalytics() {
  const pathname = usePathname();
  const consent = useConsent();
  const liveSite = useSyncExternalStore(noSubscription, isLiveSite, () => false);
  const staffPage = isStaffPage(pathname);
  const enabled = consent === 'granted' && liveSite && !staffPage;

  useEffect(() => {
    setAnalyticsDisabled(!enabled);
    if (!enabled) {
      if (consent === 'denied') removeAnalyticsCookies();
      return;
    }
    if (!window.gtag) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function gtag() {
        // gtag.js expects the arguments object itself, not an array.
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer!.push(arguments);
      };
      window.gtag('js', new Date());
      window.gtag('config', GA_MEASUREMENT_ID, {
        send_page_view: false, // sent below, without the query string
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      });
    }
    // After an in-site navigation, Next.js updates the page title a little
    // after this effect runs: wait for it to change (at most a second).
    const previousTitle = lastSentTitle;
    const started = Date.now();
    let timer = 0;
    const sendWhenTitleReady = () => {
      if (!document.title || (document.title === previousTitle && Date.now() - started < 1000)) {
        timer = window.setTimeout(sendWhenTitleReady, 50);
        return;
      }
      lastSentTitle = document.title;
      window.gtag?.('event', 'page_view', { page_location: pageUrlWithoutPersonalData(), page_title: document.title });
    };
    sendWhenTitleReady();
    return () => window.clearTimeout(timer);
  }, [enabled, consent, pathname]);

  return (
    <>
      {enabled && <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} strategy="afterInteractive" />}
      {consent === 'unset' && !staffPage && (
        <section
          aria-label="Cookie choice"
          style={{
            position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 1000, maxWidth: 560, margin: '0 auto',
            background: '#fff', border: '1px solid var(--border-color)', borderRadius: 12, padding: '1rem 1.1rem',
            boxShadow: '0 10px 30px rgba(15, 23, 42, 0.18)', color: 'var(--text-main)', fontSize: '0.9rem', lineHeight: 1.5,
          }}
        >
          <p style={{ margin: 0 }}>
            May we use Google Analytics cookies to see how visitors use this website, so we can improve it? No cookies are set unless you accept.{' '}
            <Link href="/privacy-policy#cookies" style={{ textDecoration: 'underline' }}>Privacy Policy</Link>
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            <button type="button" className="btn btn-secondary" onClick={() => writeConsent('denied')}>No thanks</button>
            <button type="button" className="btn btn-primary" onClick={() => writeConsent('granted')}>Accept</button>
          </div>
        </section>
      )}
    </>
  );
}
