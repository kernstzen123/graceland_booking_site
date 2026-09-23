'use client';

import React, { useEffect, useState, useCallback } from 'react';

interface CalendarProps {
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  onNext: () => void;
}

type DateInfo = { date: string; open: boolean; hours?: { open: string; close: string; poolsClose: string } };

/** Returns today's date as YYYY-MM-DD in the Africa/Johannesburg timezone. */
function johannesburgTodayClient(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
}

export function Calendar({ selectedDate, onSelectDate, onNext }: CalendarProps) {
  const [dateMap, setDateMap] = useState<Map<string, DateInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [closedMessage, setClosedMessage] = useState('');
  const today = johannesburgTodayClient();

  const fetchOpeningInfo = useCallback(async (fromMonth: string, months: number) => {
    try {
      const response = await fetch(`/api/opening-info?from=${fromMonth}&months=${months}`);
      if (!response.ok) return;
      const data = await response.json();
      setDateMap(prev => {
        const next = new Map(prev);
        for (const entry of data.dates as DateInfo[]) {
          next.set(entry.date, entry);
        }
        return next;
      });
    } catch {
      // Fail silently — calendar still works, just without closed-date hints
    } finally {
      setLoading(false);
    }
  }, []);

  // Load 4 months of opening info on mount
  useEffect(() => {
    const [y, m] = today.split('-').map(Number);
    const fromMonth = `${y}-${String(m).padStart(2, '0')}`;
    fetchOpeningInfo(fromMonth, 4);
  }, [today, fetchOpeningInfo]);

  const handleDateChange = (value: string) => {
    setClosedMessage('');
    if (!value) { onSelectDate(''); return; }

    // Check if the date is in the past
    if (value < today) {
      setClosedMessage('The selected visit date has already passed. Please choose a future date.');
      return;
    }

    // Check against fetched opening data
    const info = dateMap.get(value);
    if (info && !info.open) {
      setClosedMessage('Graceland is closed on this date. Please choose another date.');
      return;
    }

    // If we don't have data for this month yet, fetch it
    if (!info) {
      const [y, m] = value.split('-').map(Number);
      const fromMonth = `${y}-${String(m).padStart(2, '0')}`;
      fetchOpeningInfo(fromMonth, 2);
    }

    onSelectDate(value);
  };

  const selectedInfo = selectedDate ? dateMap.get(selectedDate) : null;

  return (
    <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Step 1: Select Visit Date</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
        Please choose the date you would like to visit Graceland Venues.
      </p>
      
      <input 
        type="date" 
        value={selectedDate || ''} 
        onChange={(e) => handleDateChange(e.target.value)}
        style={{ 
          width: '100%', 
          padding: '0.75rem', 
          fontSize: '1.1rem', 
          borderRadius: '0.5rem', 
          border: `1px solid ${closedMessage ? 'var(--danger)' : 'var(--border-color)'}`,
          marginBottom: closedMessage ? '0.5rem' : '1rem',
        }}
        min={today}
      />

      {closedMessage && (
        <p style={{ color: 'var(--danger)', fontSize: '0.9rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          ⚠ {closedMessage}
        </p>
      )}

      {selectedDate && selectedInfo?.open && selectedInfo.hours && (
        <div style={{
          background: '#f0f9ff',
          border: '1px solid #bae6fd',
          borderRadius: '0.5rem',
          padding: '0.75rem 1rem',
          marginBottom: '1rem',
          fontSize: '0.9rem',
        }}>
          <p style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: 4 }}>
            🕐 Open {selectedInfo.hours.open} – {selectedInfo.hours.close}
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Pools close 15 minutes before closing time ({selectedInfo.hours.poolsClose}).
          </p>
        </div>
      )}

      {loading && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem' }}>
          Loading availability…
        </p>
      )}

      <button 
        className="btn btn-primary" 
        style={{ width: '100%', opacity: !selectedDate || !!closedMessage ? 0.5 : 1 }}
        onClick={onNext}
        disabled={!selectedDate || !!closedMessage}
      >
        Continue to Packages
      </button>
    </div>
  );
}
