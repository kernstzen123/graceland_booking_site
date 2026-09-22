import React from 'react';
import { PACKAGES } from './PackageSelection';
import { calculatePartyTotal, PartyDetails } from '@/lib/parties';

interface BookingSummaryProps {
  selectedDate: string;
  selections: Record<string, number>;
  party: PartyDetails;
  customerDetails: { firstName: string; lastName: string; email: string; phone: string };
  onBack: () => void;
  onConfirm: () => void;
  submitting?: boolean;
  termsAccepted: boolean;
  privacyAccepted: boolean;
  onTermsChange: (accepted: boolean) => void;
  onPrivacyChange: (accepted: boolean) => void;
  onVoucherApplied: (voucher: { code: string; amountUsed: number; amountDue: number; remainingBalance: number } | null) => void;
}

export function BookingSummary({ selectedDate, selections, party, customerDetails, onBack, onConfirm, submitting = false, termsAccepted, privacyAccepted, onTermsChange, onPrivacyChange, onVoucherApplied }: BookingSummaryProps) {
  let total = 0;
  const items: Array<{ id: string; name: string; price: number; type?: string; qty: number }> = [];
  
  PACKAGES.forEach(group => {
    group.items.forEach(item => {
      const qty = selections[item.id] || 0;
      if (qty > 0) {
        total += qty * item.price;
        items.push({ ...item, qty });
      }
    });
  });

  const partyTotal = calculatePartyTotal(party);
  const bookingTotal = total + partyTotal;
  const [voucherInput, setVoucherInput] = React.useState('');
  const [voucher, setVoucher] = React.useState<{ code: string; amountUsed: number; amountDue: number; remainingBalance: number } | null>(null);
  const [voucherMessage, setVoucherMessage] = React.useState('');
  const [checkingVoucher, setCheckingVoucher] = React.useState(false);
  const applyVoucher = async () => {
    setCheckingVoucher(true); setVoucherMessage('');
    try {
      const response = await fetch('/api/vouchers/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: voucherInput, total: bookingTotal }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Voucher could not be applied');
      const applied = { code: data.code, amountUsed: data.amountUsed, amountDue: data.amountDue, remainingBalance: data.remainingBalance - data.amountUsed };
      setVoucher(applied); onVoucherApplied(applied); setVoucherMessage(`Voucher applied. Remaining balance after this booking: R ${applied.remainingBalance.toFixed(2)}`);
    } catch (error) { setVoucher(null); onVoucherApplied(null); setVoucherMessage(error instanceof Error ? error.message : 'Voucher could not be applied'); }
    finally { setCheckingVoucher(false); }
  };
  const removeVoucher = () => { setVoucher(null); setVoucherInput(''); setVoucherMessage(''); onVoucherApplied(null); };
  return (
    <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>Step 5: Booking Summary</h2>
      
      <div style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1.1rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Visit Date</h3>
        <p style={{ fontWeight: 600 }}>{selectedDate}</p>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1.1rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Customer Details</h3>
        <p>{customerDetails.firstName} {customerDetails.lastName}</p>
        <p>{customerDetails.email}</p>
        <p>{customerDetails.phone}</p>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1.1rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Packages</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {items.map(item => (
            <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{item.qty}x {item.name}</span>
              <span>R {item.qty * item.price}</span>
            </div>
          ))}
          {party.enabled && <>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{party.children}x Birthday party children ({party.option === 'option-2' ? 'with hotdog' : 'Option 1'})</span><span>R {party.children * (party.option === 'option-2' ? 220 : 195)}</span></div>
            {party.adults > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{party.adults}x Party adults ({party.adultsWater.filter(Boolean).length} swimming)</span><span>R {party.adultsWater.filter(Boolean).length * 175 + (party.adults - party.adultsWater.filter(Boolean).length) * 75}</span></div>}
            {party.additionalChildren > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{party.additionalChildren}x Additional children ({party.additionalChildrenWater.filter(Boolean).length} swimming)</span><span>R {party.additionalChildrenWater.filter(Boolean).length * 195 + (party.additionalChildren - party.additionalChildrenWater.filter(Boolean).length) * 95}</span></div>}
            {party.partyPacks > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{party.partyPacks}x Party packs</span><span>R {party.partyPacks * 50}</span></div>}
            <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>Party slot: {party.slot}</p>
          </>}
        </div>
      </div>

      <div style={{ padding: '1rem', border: '1px solid #93c5fd', background: '#eff6ff', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
        <strong>Have a voucher code?</strong>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}><input value={voucherInput} disabled={Boolean(voucher) || checkingVoucher} onChange={event => setVoucherInput(event.target.value.toUpperCase())} placeholder="GRC-XXXXXXXX" style={{ flex: 1, minWidth: 180, padding: '0.7rem', border: '1px solid var(--border-color)', borderRadius: 8 }} /><button type="button" className="btn" disabled={!voucherInput.trim() || Boolean(voucher) || checkingVoucher} onClick={applyVoucher}>{checkingVoucher ? 'Checking…' : 'Apply voucher'}</button>{voucher && <button type="button" className="btn" onClick={removeVoucher}>Remove</button>}</div>
        {voucherMessage && <p style={{ marginTop: 8, color: voucher ? 'var(--success)' : 'var(--danger)' }}>{voucherMessage}</p>}
      </div>

      <div style={{ padding: '1.5rem', backgroundColor: '#f1f5f9', borderRadius: '0.5rem', marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 'bold', fontSize: '1.25rem' }}>
        <span>Total Due:</span>
        <span>R {voucher ? voucher.amountDue.toFixed(2) : bookingTotal.toFixed(2)}</span>
      </div>

      <div style={{ display: 'grid', gap: '0.65rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
      <label style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start' }}>
        <input type="checkbox" checked={termsAccepted} onChange={event => onTermsChange(event.target.checked)} style={{ marginTop: 4 }} />
        <span>I have read and agree to the <a className="legal-link" href="/terms-and-conditions" target="_blank" rel="noreferrer">Terms and Conditions</a>.</span>
      </label>
      <label style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start' }}>
        <input type="checkbox" checked={privacyAccepted} onChange={event => onPrivacyChange(event.target.checked)} style={{ marginTop: 4 }} />
        <span>I have read and agree to the <a className="legal-link" href="/privacy-policy" target="_blank" rel="noreferrer">Privacy Policy</a>.</span>
      </label>
      </div>

      <div style={{ display: 'flex', gap: '1rem' }}>
        <button className="btn" style={{ border: '1px solid var(--border-color)', flex: 1 }} onClick={onBack}>Back</button>
        <button className="btn btn-primary" style={{ flex: 2, backgroundColor: 'var(--success)' }} onClick={onConfirm} disabled={submitting || !termsAccepted || !privacyAccepted}>{submitting ? 'Creating booking…' : 'Proceed to Payment'}</button>
      </div>
    </div>
  );
}
