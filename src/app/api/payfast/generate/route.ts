import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { customerError } from '@/lib/public-errors';
import { supabase } from '@/lib/supabase';
import { requireEnv } from '@/lib/env';

export async function POST(request: Request) {
  try {
    const { reference, name_first, name_last, email_address } = await request.json();
    if (typeof reference !== 'string' || !reference.trim()) return NextResponse.json({ success: false, error: 'Booking reference is required' }, { status: 400 });
    const { data: booking, error: bookingError } = await supabase.from('bookings').select('status,total_amount,amount_due,customers(first_name,last_name,email)').eq('reference', reference.trim()).maybeSingle();
    if (bookingError || !booking) return NextResponse.json({ success: false, error: 'Booking could not be found' }, { status: 404 });
    if (!['UNPAID', 'PAYMENT_PENDING'].includes(booking.status)) return NextResponse.json({ success: false, error: 'This booking is no longer awaiting payment' }, { status: 400 });
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const payableAmount = Number(booking.amount_due ?? booking.total_amount);
    if (!Number.isFinite(payableAmount) || payableAmount <= 0) return NextResponse.json({ success: false, error: 'This booking has no amount due' }, { status: 400 });
    
    const merchant_id = requireEnv('PAYFAST_MERCHANT_ID');
    const merchant_key = requireEnv('PAYFAST_MERCHANT_KEY');
    const passphrase = requireEnv('PAYFAST_PASSPHRASE');
    const payfast_url = requireEnv('PAYFAST_URL', 'https://sandbox.payfast.co.za/eng/process');
    
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
    if (!payfast_url.startsWith('https://')) throw new Error('PAYFAST_URL must use HTTPS');



    const fields: Record<string, string> = {
      merchant_id: merchant_id.trim(),
      merchant_key: merchant_key.trim(),
      // PayFast's return happens in the customer's browser and can arrive
      // before the server-to-server ITN webhook. The client will poll for the
      // confirmed booking status before showing the success page.
      return_url: `${appUrl}?status=processing&reference=${encodeURIComponent(reference.trim())}`,
      cancel_url: `${appUrl}?status=cancel&reference=${encodeURIComponent(reference.trim())}`,
      notify_url: `${appUrl}/api/webhooks/payfast`,
      name_first: customer?.first_name || String(name_first || '').trim(),
      name_last: customer?.last_name || String(name_last || '').trim(),
      email_address: customer?.email || String(email_address || '').trim(),
      m_payment_id: reference.trim(),
      amount: payableAmount.toFixed(2),
      item_name: 'Graceland Venues Booking',
    };

    // Construct signature string according to PayFast rules
    let signatureString = '';
    
    for (const key in fields) {
      if (fields[key] !== '') {
        signatureString += `${key}=${encodeURIComponent(fields[key]).replace(/%20/g, '+')}&`;
      }
    }
    
    if (passphrase) {
      signatureString += `passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    } else {
      signatureString = signatureString.slice(0, -1); // remove trailing &
    }

    const signature = crypto.createHash('md5').update(signatureString).digest('hex');
    fields['signature'] = signature;

    return NextResponse.json({ success: true, fields, url: payfast_url });
  } catch (error: unknown) {
    console.error('PayFast setup failed', error);
    return NextResponse.json({ success: false, error: customerError(error, 'Online payment is temporarily unavailable. Please try again or contact support.') }, { status: 500 });
  }
}
