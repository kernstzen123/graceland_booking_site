import { NextResponse } from 'next/server';
import { getBusinessSettings } from '@/lib/business-settings';

/** GET — the public support contact (email and phone) for the "Need help?" box. */
export async function GET() {
  try {
    const { supportEmail, supportPhone } = await getBusinessSettings();
    return NextResponse.json({ supportEmail, supportPhone }, { headers: { 'Cache-Control': 'public, max-age=300' } });
  } catch (error) {
    console.error('Business info error', error);
    return NextResponse.json({ error: 'Contact details are temporarily unavailable.' }, { status: 500 });
  }
}
