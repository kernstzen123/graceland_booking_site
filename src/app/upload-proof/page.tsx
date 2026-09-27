'use client';
import { useState, useEffect } from 'react';
import { SupportContact } from '@/components/SupportContact';
import { supabaseBrowser } from '@/lib/supabase-browser';

const MAX_PROOF_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'];

type Status = { type: 'info' | 'success' | 'warning' | 'error'; text: string };

async function uploadStep(body: Record<string, unknown>) {
  const response = await fetch('/api/upload-proof', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.error || 'We could not upload your proof. Please try again or contact support.');
  return data;
}

export default function UploadProof() {
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    // Auto-fill reference from URL if they click the link in the email
    const params = new URLSearchParams(window.location.search);
    const refParam = params.get('ref');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initializing from URL param on mount; not derived state.
    if (refParam) setReference(refParam);
  }, []);

  const handleUpload = async () => {
    if (uploading) return;
    if (!reference.trim() || !file) return setStatus({ type: 'error', text: 'Please provide both your booking reference and a file.' });
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !ALLOWED_EXTENSIONS.includes(extension)) return setStatus({ type: 'error', text: 'Only PDF, JPG, and PNG files are allowed.' });
    if (file.size > MAX_PROOF_SIZE) return setStatus({ type: 'error', text: 'The file must be 10 MB or smaller.' });

    setUploading(true);
    setStatus({ type: 'info', text: 'Uploading…' });
    try {
      // The file goes straight to secure storage; our server then checks it and records it.
      const upload = await uploadStep({ action: 'start', reference: reference.trim(), fileName: file.name, fileSize: file.size });
      const { error } = await supabaseBrowser.storage.from('payment-proofs').uploadToSignedUrl(upload.path, upload.token, await file.arrayBuffer(), { contentType: upload.contentType, upsert: false });
      if (error) throw new Error('The file could not be uploaded. Please check your connection and try again.');
      const result = await uploadStep({ action: 'complete', reference: reference.trim(), path: upload.path });
      setStatus(result.reviewNeeded
        ? { type: 'warning', text: result.message }
        : { type: 'success', text: 'Success! Your proof of payment has been uploaded and is pending review by our team. Once approved, tickets will automatically be sent to your email. Make sure to check your spam folder.' });
      setFile(null);
    } catch (error) {
      setStatus({ type: 'error', text: error instanceof Error ? error.message : 'Failed to upload file. Please try again.' });
    } finally {
      setUploading(false);
    }
  };

  const tone = status?.type === 'error'
    ? { background: '#fef2f2', color: 'var(--danger)' }
    : status?.type === 'warning'
      ? { background: '#fffbeb', color: '#b45309' }
      : status?.type === 'success'
        ? { background: '#ecfdf5', color: 'var(--success)' }
        : { background: 'var(--bg-color)', color: 'var(--text-muted)' };

  return (
    <div className="container" style={{ padding: '4rem 1rem' }}>
      <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--primary)' }}>Upload Proof of Payment</h1>

        <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>
          Please upload your proof of payment (PDF, JPG, or PNG, up to 10 MB) to confirm your manual EFT booking.
        </p>

        <div style={{ marginBottom: '1.5rem' }}>
          <label htmlFor="proof-reference" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Booking Reference</label>
          <input
            id="proof-reference"
            type="text"
            value={reference}
            onChange={e => setReference(e.target.value)}
            placeholder="e.g. BK-2026-A7F3K2M9"
            style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}
          />
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label htmlFor="proof-file" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Select File</label>
          <input
            id="proof-file"
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            onChange={e => setFile(e.target.files ? e.target.files[0] : null)}
            style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}
          />
        </div>

        <button className="btn btn-primary" style={{ width: '100%', opacity: uploading ? 0.7 : 1 }} onClick={handleUpload} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Submit Proof'}
        </button>

        {status && (
          <div role={status.type === 'error' ? 'alert' : 'status'} style={{
            marginTop: '1.5rem',
            padding: '1rem',
            borderRadius: '0.5rem',
            backgroundColor: tone.background,
            color: tone.color,
          }}>
            <strong>{status.text}</strong>
          </div>
        )}
        <SupportContact compact />
      </div>
    </div>
  );
}
