import React, { useState } from 'react';

interface CustomerFormProps {
  customerDetails: { firstName: string; lastName: string; email: string; phone: string };
  onChange: (details: { firstName: string; lastName: string; email: string; phone: string }) => void;
  onNext: () => void;
  onBack: () => void;
}

export function CustomerForm({ customerDetails, onChange, onNext, onBack }: CustomerFormProps) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setTouched({ ...touched, [e.target.name]: true });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...customerDetails, [e.target.name]: e.target.value });
  };

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneClean = (customerDetails.phone || '').replace(/[\s-]/g, '');
  // SA phone format: 0 followed by 9 digits, or +27 followed by 9 digits
  const isValidPhone = /^(\+27|0)[1-9][0-9]{8}$/.test(phoneClean);
  const isValidEmail = emailRegex.test(customerDetails.email || '');
  const isValidFirstName = (customerDetails.firstName || '').trim().length >= 2;
  const isValidLastName = (customerDetails.lastName || '').trim().length >= 2;

  const isComplete = isValidFirstName && isValidLastName && isValidEmail && isValidPhone;

  return (
    <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Step 4: Your Details</h2>
      
      <div style={{ display: 'grid', gap: '1rem', marginBottom: '2rem' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>First Name *</label>
          <input type="text" name="firstName" value={customerDetails.firstName || ''} onChange={handleChange} onBlur={handleBlur} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: `1px solid ${touched.firstName && !isValidFirstName ? 'var(--danger)' : 'var(--border-color)'}` }} />
          {touched.firstName && !isValidFirstName && <span style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.25rem', display: 'block' }}>First name must be at least 2 characters.</span>}
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Last Name *</label>
          <input type="text" name="lastName" value={customerDetails.lastName || ''} onChange={handleChange} onBlur={handleBlur} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: `1px solid ${touched.lastName && !isValidLastName ? 'var(--danger)' : 'var(--border-color)'}` }} />
          {touched.lastName && !isValidLastName && <span style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.25rem', display: 'block' }}>Last name must be at least 2 characters.</span>}
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Email Address *</label>
          <input type="email" name="email" value={customerDetails.email || ''} onChange={handleChange} onBlur={handleBlur} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: `1px solid ${touched.email && !isValidEmail ? 'var(--danger)' : 'var(--border-color)'}` }} />
          {touched.email && !isValidEmail && <span style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.25rem', display: 'block' }}>Please enter a valid email address.</span>}
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Phone Number *</label>
          <input type="tel" name="phone" value={customerDetails.phone || ''} onChange={handleChange} onBlur={handleBlur} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: `1px solid ${touched.phone && !isValidPhone ? 'var(--danger)' : 'var(--border-color)'}` }} placeholder="e.g. 082 123 4567" />
          {touched.phone && !isValidPhone && <span style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.25rem', display: 'block' }}>Please enter a valid South African phone number.</span>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1rem' }}>
        <button className="btn" style={{ border: '1px solid var(--border-color)', flex: 1 }} onClick={onBack}>Back</button>
        <button className="btn btn-primary" style={{ flex: 2, opacity: !isComplete ? 0.5 : 1 }} onClick={onNext} disabled={!isComplete}>Continue to Summary</button>
      </div>
    </div>
  );
}
