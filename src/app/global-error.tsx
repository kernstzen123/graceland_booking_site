'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { DEFAULT_SUPPORT_EMAIL } from '@/lib/business-details';

/** Shown when the root layout itself fails; it replaces the whole document, so styles are inline. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', background: '#f1f5f9', color: '#0f172a' }}>
        <title>Something went wrong · Graceland Venues</title>
        <main style={{ maxWidth: 520, margin: '4rem auto', padding: '2rem', background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', textAlign: 'center' }}>
          <h1 style={{ color: '#0EA5E9', fontSize: '1.5rem', margin: '0 0 0.75rem' }}>Something went wrong</h1>
          <p style={{ color: '#475569', margin: '0 0 1.5rem' }}>Sorry, the site could not be loaded. Please try again in a moment.</p>
          <button onClick={() => retry()} style={{ background: '#0EA5E9', color: '#fff', border: 0, borderRadius: 8, padding: '0.75rem 1.25rem', fontWeight: 600, cursor: 'pointer' }}>Try again</button>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: '1.5rem' }}>Need help? Email <a href={`mailto:${DEFAULT_SUPPORT_EMAIL}`}>{DEFAULT_SUPPORT_EMAIL}</a>{error.digest ? ` and quote reference ${error.digest}` : ''}.</p>
        </main>
      </body>
    </html>
  );
}
