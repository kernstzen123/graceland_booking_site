'use client';

import { useEffect, useMemo, useState } from 'react';

type Spot = { id: string; number: string; type: 'table' | 'hut'; capacity: number; x_percent: number; y_percent: number; available: boolean };

interface SeatingMapProps {
  selectedDate: string;
  requiredTables: number;
  requiredHuts: number;
  selectedSpotIds: string[];
  onChange: (spotIds: string[]) => void;
  onNext: () => void;
  onBack: () => void;
}

export function SeatingMap({ selectedDate, requiredTables, requiredHuts, selectedSpotIds, onChange, onNext, onBack }: SeatingMapProps) {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selected = useMemo(() => spots.filter(spot => selectedSpotIds.includes(spot.id)), [spots, selectedSpotIds]);
  const selectedTables = selected.filter(spot => spot.type === 'table').length;
  const selectedHuts = selected.filter(spot => spot.type === 'hut').length;
  const complete = selectedTables === requiredTables && selectedHuts === requiredHuts && selected.every(spot => spot.available);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    fetch(`/api/seating/availability?date=${encodeURIComponent(selectedDate)}`, { cache: 'no-store' })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Seating availability could not be loaded.'); return data; })
      .then(data => { if (!cancelled) setSpots(data.spots || []); })
      .catch(loadError => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Seating availability could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedDate]);

  const toggleSpot = (spot: Spot) => {
    if (!spot.available) return;
    const isSelected = selectedSpotIds.includes(spot.id);
    if (isSelected) return onChange(selectedSpotIds.filter(id => id !== spot.id));
    const countForType = spot.type === 'table' ? selectedTables : selectedHuts;
    const requiredForType = spot.type === 'table' ? requiredTables : requiredHuts;
    if (countForType >= requiredForType) return;
    onChange([...selectedSpotIds, spot.id]);
  };

  return <div className="card" style={{ maxWidth: 980, margin: '0 auto' }}>
    <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Step 3: Choose your seating</h2>
    <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>Select {requiredTables > 0 ? `${requiredTables} table${requiredTables === 1 ? '' : 's'}` : ''}{requiredTables > 0 && requiredHuts > 0 ? ' and ' : ''}{requiredHuts > 0 ? `${requiredHuts} hut${requiredHuts === 1 ? '' : 's'}` : ''} for {selectedDate}. <strong>Please note: tables/huts may become available at any time during the day due to parties.</strong></p>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: '1rem', fontSize: 14 }}>
      <span><i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#16a34a', marginRight: 5 }} />Available</span>
      <span><i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#2563eb', marginRight: 5 }} />Selected</span>
      <span><i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#94a3b8', marginRight: 5 }} />Unavailable</span>
    </div>
    {loading && <p style={{ color: 'var(--text-muted)' }}>Loading seating availability...</p>}
    {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
    {!loading && !error && <>
      <div aria-label="Scrollable venue seating map" style={{ overflowX: 'auto', overflowY: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain', touchAction: 'pan-x pinch-zoom', borderRadius: 10, border: '1px solid var(--border-color)', background: '#e2e8f0' }}>
        <div style={{ position: 'relative', width: 900, minWidth: 900, lineHeight: 0, touchAction: 'pan-x pinch-zoom' }}>
          <img src="/venue-seating-map.jpeg" alt="Venue seating map" draggable={false} style={{ display: 'block', width: '100%', height: 'auto', userSelect: 'none' }} />
          {spots.map(spot => {
            const isSelected = selectedSpotIds.includes(spot.id);
            const typeNeeded = spot.type === 'table' ? requiredTables > 0 : requiredHuts > 0;
            const typeFull = (spot.type === 'table' ? selectedTables >= requiredTables : selectedHuts >= requiredHuts) && !isSelected;
            const disabled = !spot.available || !typeNeeded || typeFull;
            return <button key={spot.id} type="button" title={`${spot.type === 'table' ? 'Table with umbrella' : 'Covered hut'} ${spot.number} - seats ${spot.capacity}`} aria-label={`${spot.type === 'table' ? 'Table with umbrella' : 'Covered hut'} ${spot.number}, capacity ${spot.capacity}${spot.available ? '' : ', unavailable'}`} disabled={disabled} onClick={() => toggleSpot(spot)} style={{ position: 'absolute', left: `${spot.x_percent}%`, top: `${spot.y_percent}%`, transform: 'translate(-50%, -50%)', width: 38, height: 38, borderRadius: '50%', border: isSelected ? '3px solid white' : '2px solid white', background: isSelected ? '#2563eb' : disabled ? '#94a3b8' : '#16a34a', color: 'white', fontWeight: 800, lineHeight: 1, cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: isSelected ? '0 0 0 3px #2563eb' : '0 2px 5px rgba(0,0,0,.35)', opacity: disabled && !isSelected ? 0.72 : 1 }}>{spot.number}</button>;
          })}
        </div>
      </div>
      <p style={{ margin: '0.5rem 0 0', color: 'var(--text-muted)', fontSize: 13 }}>On mobile, swipe left or right across the map to view all seating spots.</p>
    </>}
    <div style={{ marginTop: '1rem', padding: '0.9rem', background: complete ? '#ecfdf5' : '#fff7ed', borderRadius: 8, color: complete ? '#065f46' : '#9a3412' }}>{complete ? `Selected: ${selected.map(spot => `${spot.type === 'table' ? 'Table' : 'Hut'} ${spot.number}`).join(', ')}` : `Selected ${selectedTables}/${requiredTables} table(s) and ${selectedHuts}/${requiredHuts} hut(s).`}</div>
    <div style={{ display: 'flex', gap: '1rem', marginTop: '1.25rem' }}><button className="btn" style={{ flex: 1, border: '1px solid var(--border-color)' }} onClick={onBack}>Back</button><button className="btn btn-primary" style={{ flex: 2 }} disabled={!complete || loading} onClick={onNext}>Continue to Details</button></div>
  </div>;
}
