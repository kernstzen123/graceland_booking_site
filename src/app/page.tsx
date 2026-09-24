'use client';
import { useState, useEffect, useRef } from 'react';
import { Calendar } from '../components/Calendar';
import { PackageSelection } from '../components/PackageSelection';
import { AttendeeNames, buildInitialAttendeeNames } from '../components/AttendeeNames';
import type { AttendeeName } from '../components/AttendeeNames';
import { CustomerForm } from '../components/CustomerForm';
import { BookingSummary } from '../components/BookingSummary';
import { PaymentSelection } from '../components/PaymentSelection';
import { SeatingMap } from '../components/SeatingMap';
import { calculatePartyTotal, PartyDetails } from '@/lib/parties';
import { buildPackageGroups, DEFAULT_PRICES, type PriceList } from '@/lib/pricing';
import { SupportContact } from '@/components/SupportContact';

export default function Home() {
  useEffect(() => {
    // Supabase may return invite/recovery tokens to the site root when the
    // redirect URL is not yet in its allow-list. Preserve the hash and send
    // the user to the password setup screen instead of showing the booking UI.
    const hash = window.location.hash;
    if (!hash) return;
    const hashParams = new URLSearchParams(hash.slice(1));
    const tokenType = hashParams.get('type');
    if (hashParams.has('access_token') && (tokenType === 'invite' || tokenType === 'recovery')) {
      window.location.replace(`/admin/set-password${hash}`);
    }
  }, []);

  const [step, setStep] = useState(1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [party, setParty] = useState<PartyDetails>({ enabled: false, option: 'option-1', children: 10, adults: 0, adultsWater: [], additionalChildren: 0, additionalChildrenWater: [], partyPacks: 0, slot: '' });
  const [customerDetails, setCustomerDetails] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [attendeeNames, setAttendeeNames] = useState<AttendeeName[]>([]);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);

  const [reference, setReference] = useState<string>('');
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paymentFailure, setPaymentFailure] = useState<{ expired: boolean; message: string } | null>(null);
  const [appliedVoucher, setAppliedVoucher] = useState<{ code: string; amountUsed: number; amountDue: number; remainingBalance: number } | null>(null);
  const [voucherRemainingBalance, setVoucherRemainingBalance] = useState<number | null>(null);
  const [selectedSpotIds, setSelectedSpotIds] = useState<string[]>([]);
  const [seatingDone, setSeatingDone] = useState(false);
  const [serverAmountDue, setServerAmountDue] = useState<number | null>(null);
  const [prices, setPrices] = useState<PriceList>(DEFAULT_PRICES);
  const paymentPollingActive = useRef(false);
  const idempotencyKey = useRef('');

  useEffect(() => {
    // Admins can change prices; load the live list so the basket matches what the server charges.
    let cancelled = false;
    fetch('/api/prices', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Prices unavailable')))
      .then(data => { if (!cancelled && data.prices) setPrices(data.prices); })
      .catch(() => { /* keep the default prices; the server rejects a stale total with a refresh prompt */ });
    return () => { cancelled = true; };
  }, []);

  const startNewBooking = () => {
    paymentPollingActive.current = false;
    window.history.replaceState({}, '', '/');
    setStep(1);
    setSelectedDate(null);
    setSelections({});
    setParty({ enabled: false, option: 'option-1', children: 10, adults: 0, adultsWater: [], additionalChildren: 0, additionalChildrenWater: [], partyPacks: 0, slot: '' });
    setCustomerDetails({ firstName: '', lastName: '', email: '', phone: '' });
    setAttendeeNames([]);
    setReference('');
    setTermsAccepted(false);
    setPrivacyAccepted(false);
    setBookingSubmitting(false);
    setPaying(false);
    setPaymentFailure(null);
    setAppliedVoucher(null);
    setServerAmountDue(null);
    setVoucherRemainingBalance(null);
    setSelectedSpotIds([]);
    setSeatingDone(false);
    idempotencyKey.current = '';
    window.sessionStorage.removeItem('graceland-booking-idempotency');
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const statusParam = params.get('status');
    const returnedReference = params.get('reference');
    if ((statusParam === 'processing' || statusParam === 'success') && returnedReference) {
      let cancelled = false;
      paymentPollingActive.current = true;
      const controller = new AbortController();
      const renderConfirmationState = window.setTimeout(() => {
        if (!cancelled) {
          setReference(returnedReference);
          setStep(9);
        }
      }, 0);
      // Restore customer details from sessionStorage (persisted before the PayFast redirect)
      // so the retry flow works without the status API exposing PII.
      const restoreFromSession = () => {
        try {
          const saved = window.sessionStorage.getItem('graceland-booking-context');
          if (saved) {
            const ctx = JSON.parse(saved);
            if (ctx.customerDetails) setCustomerDetails(ctx.customerDetails);
            if (ctx.selectedDate) setSelectedDate(ctx.selectedDate);
            if (ctx.amountDue && Number(ctx.amountDue) > 0) setServerAmountDue(Number(ctx.amountDue));
          }
        } catch { /* sessionStorage may be unavailable */ }
      };
      const checkStatus = async () => {
        if (!paymentPollingActive.current) return;
        try {
          const response = await fetch(`/api/bookings/status?reference=${encodeURIComponent(returnedReference)}`, {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!response.ok) return;
          const data = await response.json();
          if (!cancelled && (data.paymentState === 'FAILED' || data.paymentState === 'EXPIRED')) {
            paymentPollingActive.current = false;
            setPaymentFailure({ expired: data.paymentState === 'EXPIRED', message: data.paymentState === 'EXPIRED' ? 'The payment window expired before PayFast confirmed your payment.' : 'PayFast reported that the payment did not complete.' });
            if (data.amountDue && Number(data.amountDue) > 0) setServerAmountDue(Number(data.amountDue));
            if (data.visitDate) setSelectedDate(data.visitDate);
            restoreFromSession();
            setStep(10);
            return;
          }
          if (!cancelled && data.ready) {
            paymentPollingActive.current = false;
            setStep(8);
          }
        } catch (error) {
          // The dev server or network can restart while PayFast confirmation
          // is pending. Keep polling quietly until the component is gone.
          if (!cancelled && error instanceof DOMException && error.name !== 'AbortError') return;
        }
      };
      checkStatus();
      const interval = window.setInterval(checkStatus, 2500);
      const timeout = window.setTimeout(() => {
        if (!cancelled) {
          paymentPollingActive.current = false;
          setPaymentFailure({ expired: false, message: 'We could not confirm the payment within five minutes.' });
          restoreFromSession();
          setStep(10);
        }
      }, 5 * 60 * 1000);
      return () => {
        cancelled = true;
        paymentPollingActive.current = false;
        controller.abort();
        window.clearTimeout(renderConfirmationState);
        window.clearInterval(interval);
        window.clearTimeout(timeout);
      };
    } else if (statusParam === 'cancel') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Initializing from URL params on page load after PayFast redirect; this is not derived state.
      if (returnedReference) setReference(returnedReference);
      setPaymentFailure({ expired: false, message: 'The PayFast payment was cancelled before it was completed.' });
      setStep(10);
      // Restore booking context from sessionStorage (persisted before redirect)
      try {
        const saved = window.sessionStorage.getItem('graceland-booking-context');
        if (saved) {
          const ctx = JSON.parse(saved);
          if (ctx.amountDue && Number(ctx.amountDue) > 0) setServerAmountDue(Number(ctx.amountDue));
          if (ctx.customerDetails) setCustomerDetails(ctx.customerDetails);
          if (ctx.selectedDate) setSelectedDate(ctx.selectedDate);
        }
      } catch { /* sessionStorage may be unavailable */ }
    }
  }, []);

  const handleUpdateSelection = (id: string, qty: number) => {
    setSelections(prev => ({ ...prev, [id]: qty }));
  };

  const calculateTotal = () => {
    let total = 0;
    buildPackageGroups(prices).forEach(group => {
      group.items.forEach(item => {
        total += (selections[item.id] || 0) * item.price;
      });
    });
    return total + calculatePartyTotal(party, prices);
  };

  const totalAmount = calculateTotal();

  const requiredTables = Number(selections['hut-shaded'] || 0);
  const requiredHuts = Number(selections['hut-covered'] || 0) + (party.enabled ? 1 : 0);
  const requiresSeating = requiredTables > 0 || requiredHuts > 0;

  const handleConfirmBooking = async () => {
    if (bookingSubmitting) return;
    setBookingSubmitting(true);
    idempotencyKey.current = idempotencyKey.current || window.sessionStorage.getItem('graceland-booking-idempotency') || crypto.randomUUID();
    window.sessionStorage.setItem('graceland-booking-idempotency', idempotencyKey.current);
    // Call the API to reserve capacity
    try {
      const bookingRequest = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedDate, selections, party, customerDetails, totalAmount, spotIds: selectedSpotIds, voucherCode: appliedVoucher?.code || null, idempotencyKey: idempotencyKey.current, termsAccepted, privacyAccepted, attendeeNames: party.enabled ? [] : attendeeNames }) };
      let res = await fetch('/api/bookings', bookingRequest);
      // A transient connection failure can happen after the server has
      // reserved the booking. Retry once with the same idempotency key so the
      // server returns the existing booking instead of creating another one.
      if (!res.ok) {
        await new Promise(resolve => window.setTimeout(resolve, 500));
        res = await fetch('/api/bookings', bookingRequest);
      }
      const data = await res.json();
      if (data.success) {
        setReference(data.reference);
        if (data.voucherAmountUsed) setVoucherRemainingBalance(Number(data.voucherRemainingBalance ?? appliedVoucher?.remainingBalance ?? 0));
        setStep(6);
      } else {
        alert("Error: " + data.error);
      }
    } catch {
      alert("Failed to reserve booking");
    } finally {
      setBookingSubmitting(false);
    }
  };

  const handlePayFast = async () => {
    if (paying) return;
    setPaying(true);
    // Persist booking context to sessionStorage before redirecting to PayFast.
    // On return, page.tsx restores from here instead of fetching PII from the
    // status API (which no longer exposes customer details).
    try {
      window.sessionStorage.setItem('graceland-booking-context', JSON.stringify({
        customerDetails,
        selectedDate,
        amountDue: appliedVoucher?.amountDue ?? serverAmountDue ?? totalAmount,
      }));
    } catch { /* sessionStorage may be unavailable */ }
    try {
      const res = await fetch('/api/payfast/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference,
          name_first: customerDetails.firstName,
          name_last: customerDetails.lastName,
          email_address: customerDetails.email
        })
      });
      const data = await res.json();
      if (!data.success) {
        alert("Failed to setup PayFast: " + data.error);
        setPaying(false);
        return;
      }

      // Generate PayFast HTML form and submit
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = data.url;

      Object.keys(data.fields).forEach(key => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = data.fields[key];
        form.appendChild(input);
      });

      document.body.appendChild(form);
      form.submit();
    } catch {
      console.error("Error setting up PayFast");
      alert("Error contacting secure payment server.");
      setPaying(false);
    }
  };

  const handleManualEFT = async () => {
    // Trigger the automated email with EFT instructions.
    // Only send the reference — the server looks up the customer email from the DB.
    try {
      const response = await fetch('/api/send-eft-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        alert(`We could not send the EFT instructions email: ${data.error || 'Please try again.'}`);
      }
    } catch {
      console.error("Failed to send EFT email");
    }
    setStep(7);
  };

  return (
    <main className="container" style={{ padding: '4rem 1rem' }}>
      <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
        <h1 style={{ fontSize: '2.5rem', fontWeight: 800, color: 'var(--primary)' }}>Graceland Venues</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem' }}>Online Booking Portal</p>
      </div>

      {step === 1 && (
        <Calendar 
          selectedDate={selectedDate} 
          onSelectDate={setSelectedDate} 
          onNext={() => setStep(2)} 
        />
      )}
      
      {step === 2 && (
        <PackageSelection 
          selections={selections} 
          selectedDate={selectedDate || ''}
          prices={prices}
          party={party}
          onPartyChange={setParty}
          onUpdateSelection={handleUpdateSelection}
          onNext={() => {
            setSeatingDone(false);
            if (party.enabled) {
              // Party bookings skip attendee names step
              setStep(4);
            } else {
              // Build initial attendee list from selections, preserving any
              // names already entered if the user navigated back
              const fresh = buildInitialAttendeeNames(selections);
              // Keep existing names when the list shape hasn't changed
              if (attendeeNames.length === fresh.length && attendeeNames.every((a, i) => a.itemId === fresh[i].itemId)) {
                setStep(3);
              } else {
                setAttendeeNames(fresh);
                setStep(3);
              }
            }
          }}
          onBack={() => setStep(1)}
        />
      )}

      {step === 3 && !party.enabled && (
        <AttendeeNames
          selections={selections}
          attendeeNames={attendeeNames}
          onChange={setAttendeeNames}
          onNext={() => { setSeatingDone(false); setStep(4); }}
          onBack={() => setStep(2)}
        />
      )}

      {step === 4 && requiresSeating && !seatingDone && selectedDate && (
        <SeatingMap party={party} selectedDate={selectedDate} requiredTables={requiredTables} requiredHuts={requiredHuts} selectedSpotIds={selectedSpotIds} onChange={setSelectedSpotIds} onNext={() => setSeatingDone(true)} onBack={() => { setSelectedSpotIds([]); setSeatingDone(false); setStep(party.enabled ? 2 : 3); }} />
      )}

      {step === 4 && (!requiresSeating || seatingDone) && (
        <CustomerForm 
          customerDetails={customerDetails}
          onChange={setCustomerDetails}
          onNext={() => setStep(5)}
          onBack={() => { setSeatingDone(false); setStep(party.enabled ? 2 : 3); }}
        />
      )}

      {step === 5 && selectedDate && (
        <BookingSummary 
          selectedDate={selectedDate}
          selections={selections}
          party={party}
          prices={prices}
          customerDetails={customerDetails}
          onBack={() => setStep(4)}
          onConfirm={handleConfirmBooking}
          submitting={bookingSubmitting}
          termsAccepted={termsAccepted}
          privacyAccepted={privacyAccepted}
          onTermsChange={setTermsAccepted}
          onPrivacyChange={setPrivacyAccepted}
          onVoucherApplied={setAppliedVoucher}
        />
      )}

      {step === 6 && (
        <PaymentSelection 
          reference={reference}
          total={appliedVoucher?.amountDue ?? serverAmountDue ?? totalAmount}
          onPayFast={handlePayFast}
          onManualEFT={handleManualEFT}
          onVoucherComplete={() => setStep(8)}
          disabled={paying}
        />
      )}

      {step === 7 && (
        <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '1.5rem', color: 'var(--primary)' }}>Manual EFT Instructions</h2>
          <div style={{ backgroundColor: '#eff6ff', color: '#1e40af', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
            <strong>Your payment instructions will also be sent to your email address.</strong>
            <p style={{ marginTop: '0.5rem' }}>After making payment, use the upload link in that email to submit your proof of payment. Your tickets will only be emailed after our team approves the proof.</p>
          </div>
          <p style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>Your booking reference is: <strong>{reference}</strong></p>
          <p style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>Please transfer <strong>R {appliedVoucher?.amountDue ?? serverAmountDue ?? totalAmount}</strong> to the following account:</p>
          
          <div style={{ backgroundColor: '#f8fafc', padding: '1.5rem', borderRadius: '0.5rem', marginBottom: '1.5rem', border: '1px solid var(--border-color)', fontSize: '1.1rem' }}>
            <p style={{ marginBottom: '0.5rem' }}><strong>Bank:</strong> Nedbank LTD</p>
            <p style={{ marginBottom: '0.5rem' }}><strong>Account Name:</strong> ACE contractors</p>
            <p style={{ marginBottom: '0.5rem' }}><strong>Account Number:</strong> 1039028861</p>
            <p style={{ marginBottom: '0.5rem' }}><strong>Branch Code:</strong> 103910</p>
            <p><strong>Payment Reference:</strong> {reference}</p>
          </div>
          
          <div style={{ backgroundColor: '#fef2f2', color: 'var(--danger)', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
            <strong>Important:</strong> You must use the exact reference (<strong>{reference}</strong>) so we can allocate your payment. Your booking is not confirmed until proof of payment is uploaded and verified. Please note that verification of proof of payment can take up to 48 hours.
          </div>
          
          <button className="btn btn-primary" style={{ width: '100%', fontSize: '1.1rem', padding: '1rem' }} onClick={() => window.location.reload()}>
            Finish & Return Home
          </button>
        </div>
      )}

      {step === 8 && (
        <div className="card" style={{ maxWidth: '600px', margin: '0 auto', textAlign: 'center', padding: '3rem 2rem' }}>
          <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--success)' }}>Payment Successful!</h2>
          <p style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>
            Thank you for your booking. Your payment has been securely received via PayFast.
          </p>
          <div style={{ backgroundColor: '#ecfdf5', padding: '1.5rem', borderRadius: '0.5rem', marginBottom: '2rem', border: '1px solid #a7f3d0' }}>
            <p style={{ fontSize: '1.1rem', color: '#065f46' }}>
              <strong>Your payment is confirmed. Your individual QR-code tickets will be emailed to the address provided during booking.</strong>
            </p>
            <p style={{ marginTop: '0.5rem', color: '#065f46' }}>
              Please check your inbox and spam folder. If you purchased any tables or huts, they have been assigned directly to your adult entrance tickets.
            </p>
            {voucherRemainingBalance !== null && <p style={{ marginTop: '0.75rem', color: '#065f46' }}>Voucher balance remaining: <strong>R {voucherRemainingBalance.toFixed(2)}</strong></p>}
          </div>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={startNewBooking}>
              Start New Booking
            </button>
          </div>
        </div>
      )}

      {step === 9 && (
        <div className="card" style={{ maxWidth: '600px', margin: '0 auto', textAlign: 'center', padding: '3rem 2rem' }}>
          <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--primary)' }}>Confirming your payment…</h2>
          <p style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>
            PayFast has returned you to Graceland Venues. We are waiting for the secure payment confirmation and preparing your QR-code tickets.
          </p>
          <p style={{ color: 'var(--text-muted)' }}>This page will continue automatically. Booking reference: <strong>{reference}</strong></p>
        </div>
      )}

      {step === 10 && paymentFailure && (
        <div className="card" style={{ maxWidth: '600px', margin: '0 auto', textAlign: 'center', padding: '3rem 2rem' }}>
          <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--danger)' }}>Payment not completed</h2>
          <p style={{ marginBottom: '1rem' }}>{paymentFailure.message}</p>
          <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>You can retry if the booking is still active. If money was deducted, do not pay again—contact support with booking reference <strong>{reference}</strong> so we can investigate.</p>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            {!paymentFailure.expired && <button className="btn btn-primary" onClick={() => { setPaymentFailure(null); setStep(6); }}>Retry PayFast payment</button>}
            <button className="btn" onClick={startNewBooking}>Start a new booking</button>
          </div>
          <SupportContact compact />
        </div>
      )}
      <SupportContact compact />
    </main>
  );
}
