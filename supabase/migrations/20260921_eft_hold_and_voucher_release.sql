-- Add a released column to credit_redemptions so voucher releases are idempotent
ALTER TABLE public.credit_redemptions ADD COLUMN IF NOT EXISTS released BOOLEAN NOT NULL DEFAULT FALSE;

-- Function to check capacity for a specific booking that is being approved
CREATE OR REPLACE FUNCTION public.recheck_capacity_for_approval(p_booking_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_booking RECORD;
  v_current_count INTEGER;
  v_max_capacity INTEGER;
BEGIN
  -- Get booking details
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Get business capacity
  SELECT daily_capacity INTO v_max_capacity FROM public.business_settings LIMIT 1;
  IF v_max_capacity IS NULL THEN v_max_capacity := 500; END IF;

  -- Count capacity used by OTHER bookings on the same date
  SELECT COALESCE(SUM(people_count), 0) INTO v_current_count
  FROM public.bookings
  WHERE visit_date = v_booking.visit_date
    AND id != p_booking_id
    AND status IN ('CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID')
    AND (status != 'UNPAID' OR expires_at > NOW());

  -- If this booking's people_count fits, return true
  RETURN (v_current_count + v_booking.people_count) <= v_max_capacity;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to release vouchers attached to expired UNPAID bookings
CREATE OR REPLACE FUNCTION public.release_expired_booking_vouchers()
RETURNS INTEGER AS $$
DECLARE
  v_released_count INTEGER := 0;
  v_redemption RECORD;
BEGIN
  FOR v_redemption IN
    SELECT cr.id AS redemption_id, cr.credit_id, cr.amount, cr.booking_id
    FROM public.credit_redemptions cr
    JOIN public.bookings b ON b.id = cr.booking_id
    WHERE cr.released = FALSE
      AND b.status = 'UNPAID'
      AND b.expires_at <= NOW()
  LOOP
    -- 1. Restore the balance
    UPDATE public.booking_credits
    SET remaining_balance = remaining_balance + v_redemption.amount,
        is_active = TRUE -- ensure it's usable again
    WHERE id = v_redemption.credit_id;

    -- 2. Mark redemption as released
    UPDATE public.credit_redemptions
    SET released = TRUE
    WHERE id = v_redemption.redemption_id;

    -- 3. Mark the booking as CANCELLED so it's clearly dead
    UPDATE public.bookings
    SET status = 'CANCELLED',
        notes = COALESCE(notes || CHR(10), '') || 'Voucher automatically released due to expiration.'
    WHERE id = v_redemption.booking_id;

    v_released_count := v_released_count + 1;
  END LOOP;
  
  RETURN v_released_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
