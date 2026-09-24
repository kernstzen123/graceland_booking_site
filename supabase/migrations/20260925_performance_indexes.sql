-- Indexes for the joins and filters the admin dashboard, scanner and reports use.
--
-- Postgres does not index foreign-key columns automatically, so every
-- "booking with its items / tickets / payments / proofs" join was scanning the
-- whole child table. These tables are small today, so each index builds in
-- well under a second; the benefit grows as bookings accumulate.

-- Child rows loaded with a booking (bookings list, dashboard, reports, ticket emails).
create index if not exists tickets_booking_id_idx on public.tickets(booking_id);
create index if not exists booking_items_booking_id_idx on public.booking_items(booking_id);
create index if not exists payments_booking_id_idx on public.payments(booking_id);
create index if not exists payment_proofs_booking_id_idx on public.payment_proofs(booking_id);

-- Scanner offline sync: all VALID/USED tickets for a visit date.
create index if not exists tickets_visit_date_status_idx on public.tickets(visit_date, status);

-- Dashboard "pending EFT proofs" count.
create index if not exists payment_proofs_pending_idx on public.payment_proofs(uploaded_at) where status = 'PENDING';

-- Duplicate check-in detection looks up a ticket's approved scans in time order.
create index if not exists ticket_scans_ticket_id_idx on public.ticket_scans(ticket_id, scanned_at);

-- Audit log page: newest first, optionally for one staff member.
create index if not exists admin_audit_log_created_at_idx on public.admin_audit_log(created_at desc);
create index if not exists admin_audit_log_actor_idx on public.admin_audit_log(actor_id, created_at desc);

-- Email retries page: unresolved failures, newest first.
create index if not exists notification_failures_open_idx on public.notification_failures(created_at desc) where resolved_at is null;

-- Deleting a booking (e.g. an abandoned walk-in sale) checks this foreign key.
create index if not exists booking_credits_original_booking_idx on public.booking_credits(original_booking_id);
