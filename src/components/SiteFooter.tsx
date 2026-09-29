import Link from 'next/link';
import { CookieSettingsButton } from '@/components/GoogleAnalytics';
import { BUSINESS_NAME, DEFAULT_SUPPORT_EMAIL, DEFAULT_SUPPORT_PHONE } from '@/lib/business-details';
import { ADDRESS, SUPPORT_PHONE_INTERNATIONAL } from '@/lib/site';

/** Address, contact and legal links: useful to customers and to search engines (local search). */
export function SiteFooter() {
  return (
    <footer style={{ marginTop: '3rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.8 }}>
      <p style={{ fontWeight: 700, color: 'var(--text-main)' }}>{BUSINESS_NAME}</p>
      <address style={{ fontStyle: 'normal' }}>
        {ADDRESS.street}, {ADDRESS.area}, {ADDRESS.postalCode}, {ADDRESS.region}
        <br />
        <a href={`tel:${SUPPORT_PHONE_INTERNATIONAL}`}>{DEFAULT_SUPPORT_PHONE}</a>
        {' · '}
        <a href={`mailto:${DEFAULT_SUPPORT_EMAIL}`}>{DEFAULT_SUPPORT_EMAIL}</a>
      </address>
      <nav aria-label="Site links" style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <Link href="/terms-and-conditions">Terms and Conditions</Link>
        <Link href="/privacy-policy">Privacy Policy</Link>
        <Link href="/upload-proof">Upload proof of payment</Link>
        <CookieSettingsButton />
      </nav>
      <p style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>© {new Date().getFullYear()} {BUSINESS_NAME}</p>
    </footer>
  );
}
