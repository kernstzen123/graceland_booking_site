-- Checkin conflicts table for detecting duplicate offline scans
-- When the same ticket is scanned on two different offline devices,
-- the first sync wins and subsequent syncs create a conflict record
-- for admin review.

CREATE TABLE IF NOT EXISTS checkin_conflicts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
    ticket_uid TEXT NOT NULL,
    first_scan_at TIMESTAMPTZ NOT NULL,
    first_device_id TEXT NOT NULL,
    first_scanned_by UUID,
    conflict_scan_at TIMESTAMPTZ NOT NULL,
    conflict_device_id TEXT NOT NULL,
    conflict_scanned_by UUID,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick dashboard queries
CREATE INDEX IF NOT EXISTS idx_checkin_conflicts_resolved
  ON checkin_conflicts (resolved, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_checkin_conflicts_ticket
  ON checkin_conflicts (ticket_uid);

-- Add device_id column to ticket_scans for offline attribution
ALTER TABLE ticket_scans
  ADD COLUMN IF NOT EXISTS device_id TEXT;
