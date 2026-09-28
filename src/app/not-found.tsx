import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found · Graceland Venues' };

export default function NotFound() {
  return (
    <main className="container" style={{ padding: '4rem 1rem' }}>
      <div className="card" style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ color: 'var(--primary)', marginBottom: '0.75rem' }}>Page not found</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>The page you were looking for does not exist or has moved.</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link className="btn btn-primary" href="/">Make a booking</Link>
          <Link className="btn btn-secondary" href="/upload-proof">Upload proof of payment</Link>
        </div>
      </div>
    </main>
  );
}
