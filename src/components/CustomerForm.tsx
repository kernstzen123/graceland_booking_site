import React from 'react';

interface CustomerFormProps {
  customerDetails: { firstName: string; lastName: string; email: string; phone: string };
  onChange: (details: { firstName: string; lastName: string; email: string; phone: string }) => void;
  onNext: () => void;
  onBack: () => void;
}

export function CustomerForm({ customerDetails, onChange, onNext, onBack }: CustomerFormProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...customerDetails, [e.target.name]: e.target.value });
  };

  const isComplete = customerDetails.firstName && customerDetails.lastName && customerDetails.email && customerDetails.phone;

  return (
    <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Step 3: Your Details</h2>
      
      <div style={{ display: 'grid', gap: '1rem', marginBottom: '2rem' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>First Name *</label>
          <input type="text" name="firstName" value={customerDetails.firstName || ''} onChange={handleChange} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }} />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Last Name *</label>
          <input type="text" name="lastName" value={customerDetails.lastName || ''} onChange={handleChange} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }} />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Email Address *</label>
          <input type="email" name="email" value={customerDetails.email || ''} onChange={handleChange} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }} />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Phone Number *</label>
          <input type="tel" name="phone" value={customerDetails.phone || ''} onChange={handleChange} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1rem' }}>
        <button className="btn" style={{ border: '1px solid var(--border-color)', flex: 1 }} onClick={onBack}>Back</button>
        <button className="btn btn-primary" style={{ flex: 2, opacity: !isComplete ? 0.5 : 1 }} onClick={onNext} disabled={!isComplete}>Continue to Summary</button>
      </div>
    </div>
  );
}
