'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';

interface CalendarProps {
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  onNext: () => void;
}

type DateInfo = { date: string; open: boolean; hours?: { open: string; close: string; poolsClose: string } };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Returns today's date as YYYY-MM-DD in the Africa/Johannesburg timezone. */
function johannesburgTodayClient(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Days in the given 1-based month. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 (Sun) - 6 (Sat) weekday of the 1st of the given 1-based month. */
function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

function formatButtonLabel(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(date.getTime())) return dateStr;
  return `${WEEKDAY_NAMES_SHORT[date.getUTCDay()]}, ${d} ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
}

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 3v4M16 3v4M3 10h18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' | 'down' }) {
  const rotation = direction === 'left' ? 0 : direction === 'right' ? 180 : -90;
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ transform: `rotate(${rotation}deg)` }} aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Calendar({ selectedDate, onSelectDate, onNext }: CalendarProps) {
  const [dateMap, setDateMap] = useState<Map<string, DateInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [closedMessage, setClosedMessage] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const today = johannesburgTodayClient();

  const initialView = (() => {
    const base = selectedDate && selectedDate >= today ? selectedDate : today;
    const [y, m] = base.split('-').map(Number);
    return { year: y, month: m };
  })();
  const [viewYear, setViewYear] = useState(initialView.year);
  const [viewMonth, setViewMonth] = useState(initialView.month);

  const wrapperRef = useRef<HTMLDivElement>(null);

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

  // Ensure the currently viewed month (and the next one) has opening data
  useEffect(() => {
    const firstOfMonth = toDateStr(viewYear, viewMonth, 1);
    if (dateMap.has(firstOfMonth)) return;
    fetchOpeningInfo(`${viewYear}-${String(viewMonth).padStart(2, '0')}`, 2);
  }, [viewYear, viewMonth, dateMap, fetchOpeningInfo]);

  // Close the panel on outside click / Escape
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const selectDay = (dateStr: string) => {
    setClosedMessage('');

    if (dateStr < today) {
      setClosedMessage('The selected visit date has already passed. Please choose a future date.');
      return;
    }

    const info = dateMap.get(dateStr);
    if (info && !info.open) {
      setClosedMessage('Graceland is closed on this date. Please choose another date.');
      return;
    }

    onSelectDate(dateStr);
    setIsOpen(false);
  };

  const goToMonth = (direction: -1 | 1) => {
    let y = viewYear;
    let m = viewMonth + direction;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setViewYear(y);
    setViewMonth(m);
  };

  const [todayYear, todayMonthNum] = today.split('-').map(Number);
  const isViewingCurrentMonth = viewYear === todayYear && viewMonth === todayMonthNum;

  const selectedInfo = selectedDate ? dateMap.get(selectedDate) : null;

  const leadingBlanks = firstWeekdayOfMonth(viewYear, viewMonth);
  const totalDays = daysInMonth(viewYear, viewMonth);
  const cells: Array<number | null> = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Step 1: Select Visit Date</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
        Please choose the date you would like to visit Graceland Venues.
      </p>

      <div ref={wrapperRef} style={{ position: 'relative', marginBottom: closedMessage ? '0.5rem' : '1rem' }}>
        <button
          type="button"
          onClick={() => setIsOpen(o => !o)}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            padding: '0.85rem 1rem',
            fontSize: '1.05rem',
            fontWeight: selectedDate ? 600 : 400,
            color: selectedDate ? 'var(--text-main)' : 'var(--text-muted)',
            background: 'var(--white)',
            borderRadius: '0.65rem',
            border: `1.5px solid ${closedMessage ? 'var(--danger)' : isOpen ? 'var(--primary)' : 'var(--border-color)'}`,
            boxShadow: isOpen ? '0 0 0 3px rgba(14,165,233,0.15)' : 'none',
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          }}
        >
          <span style={{ color: 'var(--primary)', display: 'flex' }}><CalendarIcon /></span>
          <span style={{ flex: 1, textAlign: 'left' }}>
            {selectedDate ? formatButtonLabel(selectedDate) : 'Select a date'}
          </span>
          <span style={{ color: 'var(--text-muted)', display: 'flex' }}><ChevronIcon direction="down" /></span>
        </button>

        {isOpen && (
          <div
            role="dialog"
            aria-label="Choose a visit date"
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              left: 0,
              right: 0,
              zIndex: 30,
              background: 'var(--white)',
              borderRadius: '0.75rem',
              border: '1px solid var(--border-color)',
              boxShadow: '0 12px 28px -8px rgb(0 0 0 / 0.22), 0 4px 10px -4px rgb(0 0 0 / 0.1)',
              padding: '1rem',
              animation: 'fadeInUp 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <button
                type="button"
                onClick={() => goToMonth(-1)}
                disabled={isViewingCurrentMonth}
                aria-label="Previous month"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: '32px', height: '32px', borderRadius: '999px',
                  color: isViewingCurrentMonth ? 'var(--border-color)' : 'var(--text-main)',
                  cursor: isViewingCurrentMonth ? 'not-allowed' : 'pointer',
                  background: 'transparent',
                }}
                onMouseEnter={(e) => { if (!isViewingCurrentMonth) e.currentTarget.style.background = 'var(--bg-color)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <ChevronIcon direction="left" />
              </button>

              <p style={{ fontWeight: 700, fontSize: '1rem' }}>{MONTH_NAMES[viewMonth - 1]} {viewYear}</p>

              <button
                type="button"
                onClick={() => goToMonth(1)}
                aria-label="Next month"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: '32px', height: '32px', borderRadius: '999px',
                  color: 'var(--text-main)', cursor: 'pointer', background: 'transparent',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-color)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <ChevronIcon direction="right" />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
              {WEEKDAYS.map(day => (
                <div key={day} style={{ textAlign: 'center', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', padding: '4px 0' }}>
                  {day}
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
              {cells.map((day, index) => {
                if (day === null) return <div key={`blank-${index}`} />;

                const dateStr = toDateStr(viewYear, viewMonth, day);
                const isPast = dateStr < today;
                const info = dateMap.get(dateStr);
                const isClosed = info ? !info.open : false;
                const isDisabled = isPast || isClosed;
                const isSelected = dateStr === selectedDate;
                const isToday = dateStr === today;

                let background = 'transparent';
                let color = 'var(--text-main)';
                let fontWeight = 500;
                let textDecoration = 'none';
                let border = '1.5px solid transparent';

                if (isSelected) {
                  background = 'var(--primary)';
                  color = 'var(--white)';
                  fontWeight = 700;
                } else if (isPast) {
                  color = '#cbd5e1';
                } else if (isClosed) {
                  color = 'var(--danger)';
                  textDecoration = 'line-through';
                  background = '#fef2f2';
                } else if (isToday) {
                  border = '1.5px solid var(--primary)';
                  color = 'var(--primary)';
                  fontWeight = 700;
                }

                return (
                  <button
                    key={dateStr}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => selectDay(dateStr)}
                    aria-label={`${dateStr}${isClosed ? ' (closed)' : ''}${isPast ? ' (past)' : ''}`}
                    aria-current={isToday ? 'date' : undefined}
                    style={{
                      aspectRatio: '1',
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '999px',
                      fontSize: '0.9rem',
                      background,
                      color,
                      fontWeight,
                      textDecoration,
                      border,
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      transition: 'background 0.12s ease, transform 0.08s ease',
                    }}
                    onMouseEnter={(e) => { if (!isDisabled && !isSelected) e.currentTarget.style.background = '#e0f2fe'; }}
                    onMouseLeave={(e) => { if (!isDisabled && !isSelected) e.currentTarget.style.background = background; }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: '14px', marginTop: '0.9rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ width: 10, height: 10, borderRadius: '999px', border: '1.5px solid var(--primary)', display: 'inline-block' }} /> Today
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{ width: 10, height: 10, borderRadius: '999px', background: '#fef2f2', border: '1.5px solid var(--danger)', display: 'inline-block' }} /> Closed
              </span>
              {loading && <span>Loading availability…</span>}
            </div>
          </div>
        )}
      </div>

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
