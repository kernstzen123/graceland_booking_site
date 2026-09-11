-- Schema for Graceland Venues Booking System

-- Enable uuid extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Business Settings
CREATE TABLE business_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_name TEXT NOT NULL,
    daily_capacity INTEGER NOT NULL DEFAULT 500,
    buffer_capacity INTEGER NOT NULL DEFAULT 5,
    water_activities_start_month INTEGER NOT NULL DEFAULT 9, -- September
    water_activities_end_month INTEGER NOT NULL DEFAULT 4, -- April
    bank_name TEXT,
    account_holder TEXT,
    account_number TEXT,
    branch_code TEXT,
    account_type TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Customers
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    id_number TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Packages
CREATE TABLE packages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    price_zar DECIMAL(10, 2) NOT NULL,
    age_category TEXT NOT NULL, -- e.g., 'Adult', 'Child 3-17'
    includes_water_activities BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Huts
CREATE TABLE huts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'Covered Hut' or 'Shaded Table'
    capacity INTEGER NOT NULL,
    price_zar DECIMAL(10, 2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Bookings
CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reference TEXT UNIQUE NOT NULL, -- BK-YYYY-XXXXXX
    customer_id UUID REFERENCES customers(id) NOT NULL,
    visit_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNPAID', -- UNPAID, PAYMENT_PENDING, PAID, CONFIRMED, CANCELLED, REFUNDED
    payment_method TEXT, -- PAYFAST, MANUAL_EFT
    total_amount DECIMAL(10, 2) NOT NULL,
    people_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    notes TEXT
);

-- Booking Items
CREATE TABLE booking_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
    package_id UUID REFERENCES packages(id),
    hut_id UUID REFERENCES huts(id),
    quantity INTEGER NOT NULL,
    price_per_unit DECIMAL(10, 2) NOT NULL,
    subtotal DECIMAL(10, 2) NOT NULL,
    metadata JSONB -- useful for extra details like "party pack quantity"
);

-- Payments
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    provider_reference TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Payment Proofs
CREATE TABLE payment_proofs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
    admin_notes TEXT,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    verified_at TIMESTAMP WITH TIME ZONE,
    verified_by UUID -- auth.users
);

-- Tickets
CREATE TABLE tickets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_uid TEXT UNIQUE NOT NULL, -- TKT-XXXXXX
    booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
    package_id UUID REFERENCES packages(id),
    customer_id UUID REFERENCES customers(id),
    visit_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'VALID', -- VALID, USED, CANCELLED
    qr_token TEXT UNIQUE NOT NULL,
    issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ticket Scans
CREATE TABLE ticket_scans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    scanned_by UUID, -- auth.users
    result_status TEXT NOT NULL -- APPROVED, DENIED_USED, DENIED_DATE
);

-- Admin Roles
CREATE TABLE admin_roles (
    id UUID PRIMARY KEY, -- references auth.users
    role TEXT NOT NULL DEFAULT 'SCANNER' -- SUPER_ADMIN, ADMIN, SCANNER
);

-- RPC for Atomic Capacity Reservation
CREATE OR REPLACE FUNCTION reserve_capacity(
  p_visit_date DATE,
  p_people_count INTEGER,
  p_customer JSONB,
  p_reference TEXT,
  p_total_amount DECIMAL
) RETURNS UUID AS $$
DECLARE
  v_customer_id UUID;
  v_booking_id UUID;
  v_current_count INTEGER;
  v_max_capacity INTEGER;
BEGIN
  -- 1. Check current capacity for the date
  SELECT COALESCE(SUM(people_count), 0) INTO v_current_count
  FROM bookings
  WHERE visit_date = p_visit_date
  AND status IN ('CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID')
  AND (status != 'UNPAID' OR expires_at > NOW());

  SELECT daily_capacity INTO v_max_capacity FROM business_settings LIMIT 1;
  IF v_max_capacity IS NULL THEN v_max_capacity := 500; END IF;

  IF (v_current_count + p_people_count) > v_max_capacity THEN
    RAISE EXCEPTION 'Capacity exceeded. Only % spots left.', (v_max_capacity - v_current_count);
  END IF;

  -- 2. Insert or get customer
  INSERT INTO customers (first_name, last_name, email, phone)
  VALUES (p_customer->>'firstName', p_customer->>'lastName', p_customer->>'email', p_customer->>'phone')
  RETURNING id INTO v_customer_id;

  -- 3. Insert Booking (Lock capacity)
  INSERT INTO bookings (reference, customer_id, visit_date, status, total_amount, people_count, expires_at)
  VALUES (p_reference, v_customer_id, p_visit_date, 'UNPAID', p_total_amount, p_people_count, NOW() + INTERVAL '15 minutes')
  RETURNING id INTO v_booking_id;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql;
