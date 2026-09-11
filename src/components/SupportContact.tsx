export function SupportContact({ compact = false }: { compact?: boolean }) {
  const email = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'ernstzenkhalid6@gmail.com';
  return <div style={{ marginTop: compact ? '1rem' : '2rem', padding: compact ? '0.8rem' : '1rem', border: '1px solid #bfdbfe', borderRadius: 10, background: '#eff6ff', color: '#1e3a8a', textAlign: compact ? 'left' : 'center' }}>
    <strong>Need help?</strong>{' '}Contact support at <a href={`mailto:${email}`} style={{ textDecoration: 'underline', fontWeight: 700 }}>{email}</a>. Include your booking reference if you have one.
  </div>;
}
