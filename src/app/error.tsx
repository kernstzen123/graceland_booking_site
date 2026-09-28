'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';
import Link from 'next/link';
import * as Sentry from '@sentry/nextjs';
import { SupportContact } from '@/components/SupportContact';

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="container" style={{ padding: '4rem 1rem' }}>
      <div className="card" style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ color: 'var(--primary)', marginBottom: '0.75rem' }}>Something went wrong</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
          Sorry, this page could not be loaded. Please try again. If you were making a booking or payment, check your email before trying again so you do not pay twice.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => retry()}>Try again</button>
          <Link className="btn btn-secondary" href="/">Back to bookings</Link>
        </div>
        {error.digest && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '1rem' }}>Error reference: {error.digest}</p>}
        <SupportContact compact />
      </div>
    </main>
  );
}
