import React from 'react';

interface CalendarProps {
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  onNext: () => void;
}

export function Calendar({ selectedDate, onSelectDate, onNext }: CalendarProps) {
  return (
    <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Step 1: Select Visit Date</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
        Please choose the date you would like to visit Graceland Venues.
      </p>
      
      <input 
        type="date" 
        value={selectedDate || ''} 
        onChange={(e) => onSelectDate(e.target.value)}
        style={{ 
          width: '100%', 
          padding: '0.75rem', 
          fontSize: '1.1rem', 
          borderRadius: '0.5rem', 
          border: '1px solid var(--border-color)',
          marginBottom: '1.5rem'
        }}
        min={new Date().toISOString().split('T')[0]}
      />

      <button 
        className="btn btn-primary" 
        style={{ width: '100%', opacity: !selectedDate ? 0.5 : 1 }}
        onClick={onNext}
        disabled={!selectedDate}
      >
        Continue to Packages
      </button>
    </div>
  );
}
