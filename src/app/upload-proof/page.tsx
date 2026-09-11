'use client';
import { useState, useEffect } from 'react';
import { SupportContact } from '@/components/SupportContact';

export default function UploadProof() {
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    // Auto-fill reference from URL if they click the link in the email
    const params = new URLSearchParams(window.location.search);
    const refParam = params.get('ref');
    if (refParam) setReference(refParam);
  }, []);

  const handleUpload = async () => {
    if (!reference || !file) return alert("Please provide both your booking reference and a file.");
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !['pdf', 'jpg', 'jpeg', 'png'].includes(extension)) return alert('Only PDF, JPG, and PNG files are allowed.');
    if (file.size > 10 * 1024 * 1024) return alert('The file must be 10 MB or smaller.');
    
    setStatus('Uploading...');
    const formData = new FormData();
    formData.append('reference', reference);
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload-proof', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        setStatus('Success! Your proof of payment has been uploaded and is pending review by our team.');
      } else {
        setStatus(`Error: ${data.error}`);
      }
    } catch (e) {
      setStatus('Failed to upload file. Please try again.');
    }
  };

  return (
    <div className="container" style={{ padding: '4rem 1rem' }}>
      <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--primary)' }}>Upload Proof of Payment</h1>
        
        <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>
          Please upload your proof of payment (PDF, JPG, or PNG) to confirm your manual EFT booking.
        </p>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Booking Reference</label>
          <input 
            type="text" 
            value={reference} 
            onChange={e => setReference(e.target.value)}
            placeholder="e.g. BK-2026-123456"
            style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}
          />
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Select File</label>
          <input 
            type="file" 
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            onChange={e => setFile(e.target.files ? e.target.files[0] : null)}
            style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}
          />
        </div>

        <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleUpload}>
          Submit Proof
        </button>

        {status && (
          <div style={{ 
            marginTop: '1.5rem', 
            padding: '1rem', 
            borderRadius: '0.5rem', 
            backgroundColor: status.includes('Error') || status.includes('Failed') ? '#fef2f2' : '#ecfdf5',
            color: status.includes('Error') || status.includes('Failed') ? 'var(--danger)' : 'var(--success)' 
          }}>
            <strong>{status}</strong>
          </div>
        )}
        <SupportContact compact />
      </div>
    </div>
  );
}
