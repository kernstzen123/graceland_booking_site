'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_SUPPORT_EMAIL, DEFAULT_SUPPORT_PHONE } from '@/lib/business-details';

type Contact = { supportEmail: string; supportPhone: string };

// One request per page load, shared by every contact box on the page.
let contactRequest: Promise<Contact | null> | null = null;
const loadContact = () => {
  contactRequest ??= fetch('/api/business-info').then(response => (response.ok ? response.json() : null)).catch(() => null);
  return contactRequest;
};

/** "Need help?" box with the support contact admins set under Prices & dates → Business details. */
export function SupportContact({ compact = false }: { compact?: boolean }) {
  const [contact, setContact] = useState<Contact>({ supportEmail: DEFAULT_SUPPORT_EMAIL, supportPhone: DEFAULT_SUPPORT_PHONE });
  useEffect(() => {
    let active = true;
    loadContact().then(loaded => { if (active && loaded?.supportEmail) setContact(loaded); });
    return () => { active = false; };
  }, []);
  return <div style={{ marginTop: compact ? '1rem' : '2rem', padding: compact ? '0.8rem' : '1rem', border: '1px solid #bfdbfe', borderRadius: 10, background: '#eff6ff', color: '#1e3a8a', textAlign: compact ? 'left' : 'center' }}>
    <strong>Need help?</strong>{' '}Contact support at <a href={`mailto:${contact.supportEmail}`} style={{ textDecoration: 'underline', fontWeight: 700 }}>{contact.supportEmail}</a>{contact.supportPhone ? <> or call <a href={`tel:${contact.supportPhone.replace(/[^\d+]/g, '')}`} style={{ fontWeight: 700 }}>{contact.supportPhone}</a></> : null}. Include your booking reference if you have one.
  </div>;
}
