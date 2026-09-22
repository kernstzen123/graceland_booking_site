import React from 'react';
import { PACKAGES } from './PackageSelection';

export type AttendeeName = {
  firstName: string;
  lastName: string;
  ticketType: string;
  itemId: string;
};

interface AttendeeNamesProps {
  selections: Record<string, number>;
  attendeeNames: AttendeeName[];
  onChange: (names: AttendeeName[]) => void;
  onNext: () => void;
  onBack: () => void;
}

/** Build the initial (empty) attendee name list from the current package selections. */
export function buildInitialAttendeeNames(selections: Record<string, number>): AttendeeName[] {
  const names: AttendeeName[] = [];
  PACKAGES.forEach(group => {
    group.items.forEach(item => {
      const qty = selections[item.id] || 0;
      // Only person-type items (not huts / tables)
      if (qty > 0 && (item.id.includes('child') || item.id.includes('adult') || item.id.includes('pensioner') || item.id.includes('infant') || item.id.includes('toddler'))) {
        for (let i = 0; i < qty; i++) {
          names.push({ firstName: '', lastName: '', ticketType: `${group.category} — ${item.name}`, itemId: item.id });
        }
      }
    });
  });
  return names;
}

export function AttendeeNames({ selections, attendeeNames, onChange, onNext, onBack }: AttendeeNamesProps) {
  // Group attendees by ticket type for display
  const groups: { ticketType: string; itemId: string; startIndex: number; count: number }[] = [];
  let idx = 0;
  PACKAGES.forEach(group => {
    group.items.forEach(item => {
      const qty = selections[item.id] || 0;
      if (qty > 0 && (item.id.includes('child') || item.id.includes('adult') || item.id.includes('pensioner') || item.id.includes('infant') || item.id.includes('toddler'))) {
        groups.push({ ticketType: `${group.category} — ${item.name}`, itemId: item.id, startIndex: idx, count: qty });
        idx += qty;
      }
    });
  });

  const handleChange = (index: number, field: 'firstName' | 'lastName', value: string) => {
    const updated = [...attendeeNames];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  const allComplete = attendeeNames.length > 0 && attendeeNames.every(a => a.firstName.trim().length >= 2 && a.lastName.trim().length >= 2);

  // Friendly label that extracts the item name and water-activity context
  const friendlyLabel = (ticketType: string) => {
    const parts = ticketType.split('—').map(s => s.trim());
    // The item name is always the last segment (e.g. "Children 3–17")
    const name = parts[parts.length - 1] || ticketType;
    const lower = ticketType.toLowerCase();
    if (lower.includes('excluding water')) return `${name} (excl. water activities)`;
    if (lower.includes('including water')) return `${name} (incl. water activities)`;
    return name;
  };

  return (
    <div className="card" style={{ maxWidth: '700px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Step 3: Attendee Names</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
        Please enter the name and surname for each person. These names will appear on the individual tickets.
      </p>

      {groups.map((group, gi) => (
        <div key={gi} style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.05rem', color: 'var(--primary)', marginBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.4rem' }}>
            {friendlyLabel(group.ticketType)} × {group.count}
          </h3>

          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {Array.from({ length: group.count }, (_, i) => {
              const attendeeIndex = group.startIndex + i;
              const attendee = attendeeNames[attendeeIndex];
              if (!attendee) return null;
              return (
                <div key={attendeeIndex} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ minWidth: '90px', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.95rem' }}>
                    Person {i + 1}
                  </span>
                  <input
                    type="text"
                    placeholder="First name *"
                    value={attendee.firstName}
                    onChange={e => handleChange(attendeeIndex, 'firstName', e.target.value)}
                    style={{ flex: 1, minWidth: '140px', padding: '0.6rem 0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}
                  />
                  <input
                    type="text"
                    placeholder="Surname *"
                    value={attendee.lastName}
                    onChange={e => handleChange(attendeeIndex, 'lastName', e.target.value)}
                    style={{ flex: 1, minWidth: '140px', padding: '0.6rem 0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!allComplete && (
        <p style={{ color: 'var(--danger)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Please fill in the name and surname for every attendee before continuing.
        </p>
      )}

      <div style={{ display: 'flex', gap: '1rem' }}>
        <button className="btn" style={{ border: '1px solid var(--border-color)', flex: 1 }} onClick={onBack}>Back</button>
        <button className="btn btn-primary" style={{ flex: 2, opacity: !allComplete ? 0.5 : 1 }} onClick={onNext} disabled={!allComplete}>Continue to Details</button>
      </div>
    </div>
  );
}
