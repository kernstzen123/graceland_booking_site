import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { getBusinessSettings, updateBusinessSettings } from '@/lib/business-settings';
import { isValidEmail } from '@/lib/request-security';

/** GET — daily capacity and the support contact shown to customers. */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    return NextResponse.json({ success: true, settings: await getBusinessSettings({ fresh: true }) });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Business settings error', error);
    return NextResponse.json({ success: false, error: 'Could not load business settings' }, { status: 500 });
  }
}

/**
 * PUT { dailyCapacity?, supportEmail?, supportPhone? } — admins only.
 * Bank details are deliberately not editable here (see src/lib/business-details.ts).
 */
export async function PUT(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const body = await request.json();
    const changes: { dailyCapacity?: number; supportEmail?: string; supportPhone?: string } = {};
    if (body?.dailyCapacity !== undefined) {
      const capacity = Number(body.dailyCapacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000) return NextResponse.json({ success: false, error: 'Daily capacity must be a whole number from 1 to 5000.' }, { status: 400 });
      changes.dailyCapacity = capacity;
    }
    if (body?.supportEmail !== undefined) {
      const email = String(body.supportEmail).trim().toLowerCase();
      if (!isValidEmail(email)) return NextResponse.json({ success: false, error: 'Enter a valid support email address.' }, { status: 400 });
      changes.supportEmail = email;
    }
    if (body?.supportPhone !== undefined) {
      const phone = String(body.supportPhone).replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!/^[+\d][\d ()-]{6,19}$/.test(phone)) return NextResponse.json({ success: false, error: 'Enter a valid support phone number.' }, { status: 400 });
      changes.supportPhone = phone;
    }
    if (!Object.keys(changes).length) return NextResponse.json({ success: false, error: 'No changes were provided.' }, { status: 400 });

    const before = await getBusinessSettings({ fresh: true });
    const settings = await updateBusinessSettings(changes, user.id);
    await writeAudit(user.id, 'UPDATE_BUSINESS_SETTINGS', 'business_settings', 'settings', {
      changes: Object.keys(changes).map(key => ({ key, from: before[key as keyof typeof before], to: settings[key as keyof typeof settings] })),
    });
    return NextResponse.json({ success: true, settings, message: 'Business details saved.' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Business settings update error', error);
    return NextResponse.json({ success: false, error: 'Could not save business settings. Check that the latest database migration has been applied.' }, { status: 500 });
  }
}
