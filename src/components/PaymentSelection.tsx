import React from 'react';

interface PaymentSelectionProps {
  reference: string;
  total: number;
  onPayFast: () => void;
  onManualEFT: () => void;
  onVoucherComplete?: () => void;
  disabled?: boolean;
}

export function PaymentSelection({ total, onPayFast, onManualEFT, onVoucherComplete, disabled = false }: PaymentSelectionProps) {
  const voucherCovered = total <= 0;
  return <div className="card" style={{ maxWidth: '600px', margin: '0 auto', textAlign: 'center' }}><h2 style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>Step 6: Payment Method</h2><p style={{ marginBottom: '1.5rem', fontSize: '1.1rem' }}>Total to pay: <strong>R {Number(total).toFixed(2)}</strong></p>{voucherCovered ? <div style={{ display: 'grid', gap: '1rem' }}><div style={{ background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0', borderRadius: 8, padding: '1rem' }}>Your voucher covers the full booking amount. No payment is required.</div><button className="btn btn-primary" style={{ padding: '1rem', fontSize: '1.1rem' }} onClick={onVoucherComplete} disabled={disabled}>{disabled ? 'Issuing tickets...' : 'Confirm and issue tickets now'}</button></div> : <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}><button className="btn btn-primary" style={{ padding: '1rem', fontSize: '1.1rem' }} onClick={onPayFast} disabled={disabled}>{disabled ? 'Opening PayFast...' : 'Pay Online securely via PayFast'}</button><button className="btn" style={{ border: '1px solid var(--border-color)', padding: '1rem', fontSize: '1.1rem' }} onClick={onManualEFT} disabled={disabled}>Manual EFT (Upload Proof Later)</button></div>}</div>;
}
