import React, { useEffect, useState } from 'react';
import { calculatePartyTotal, getPartySlots, PartyDetails } from '@/lib/parties';
import { PACKAGE_GROUPS } from '@/lib/pricing';
import { CheckIcon } from '@/components/icons';

const PARTY_INCLUDES = [
  'Unlimited waterslides (September–April)',
  'Rock pool',
  'Bath pool',
  'Kiddy splash pad',
  'Fantasy Village',
  'Kingdom Village',
  'A party hut',
];

export const PACKAGES = PACKAGE_GROUPS;

interface PackageSelectionProps {
  selectedDate: string;
  selections: Record<string, number>;
  party: PartyDetails;
  onPartyChange: (party: PartyDetails) => void;
  onUpdateSelection: (id: string, quantity: number) => void;
  onNext: () => void;
  onBack: () => void;
}

export function PackageSelection({ selectedDate, selections, party, onPartyChange, onUpdateSelection, onNext, onBack }: PackageSelectionProps) {
  const [partyAvailability, setPartyAvailability] = useState<{ slots: string[]; availableSlots: string[]; nextAvailableDate: string | null } | null>(null);
  const [partyError, setPartyError] = useState('');
  const [selectionError, setSelectionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Resetting error state before async fetch
    setPartyError('');
    fetch(`/api/party-availability?date=${encodeURIComponent(selectedDate)}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Availability unavailable')))
      .then(data => { if (!cancelled) setPartyAvailability(data); })
      .catch(() => { if (!cancelled) setPartyError('Party availability could not be checked. Please try again.'); });
    return () => { cancelled = true; };
  }, [selectedDate]);

  const calculateTotal = () => {
    let total = 0;
    PACKAGES.forEach(group => {
      group.items.forEach(item => {
        total += (selections[item.id] || 0) * item.price;
      });
    });
    return total;
  };

  const groupSize = Object.entries(selections).reduce((sum, [id, quantity]) => sum + (id.includes('child') || id.includes('adult') || id.includes('pensioner') || id.includes('infant') || id.includes('toddler') ? Number(quantity || 0) : 0), 0) + (party.enabled ? party.children + party.adults + party.additionalChildren : 0);
  const maxHuts = groupSize >= 12 ? 2 : groupSize >= 6 ? 1 : 0;
  const maxTables = Math.max(1, Math.ceil(groupSize / 6));
  const paidHuts = Number(selections['hut-covered'] || 0);

  const continueToDetails = () => {
    const selectedPackageCount = Object.values(selections).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
    const adultCount = Object.entries(selections).reduce((sum, [id, quantity]) => sum + (id.includes('adult') || id.includes('pensioner') ? Number(quantity || 0) : 0), 0) + (party.enabled ? party.adults : 0);
    const childCount = Object.entries(selections).reduce((sum, [id, quantity]) => sum + (id.includes('child') || id.includes('toddler') || id.includes('infant') ? Number(quantity || 0) : 0), 0) + (party.enabled ? party.children + party.additionalChildren : 0);
    if (adultCount + childCount === 0) {
      setSelectionError('Please select at least one entrance package before continuing.');
      return;
    }
    if (childCount > 0 && adultCount === 0) {
      setSelectionError('A child pass must be booked with at least one adult or pensioner entrance.');
      return;
    }
    if (selectedPackageCount === 0 && !party.enabled) {
      setSelectionError('Please select at least one package before continuing.');
      return;
    }
    setSelectionError('');
    onNext();
  };

  return (
    <div style={{ maxWidth: '1180px', margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: '1.5rem', alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 700px', maxWidth: 'none', margin: 0 }}>
        <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Step 2: Select Packages</h2>

        {PACKAGES.map((group, i) => (
          <div key={i} style={{ marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--primary)', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
              {group.category}
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {group.items.map(item => (
                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{item.name}</div>
                    <div style={{ color: 'var(--text-muted)' }}>R {item.price}</div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <button
                      onClick={() => onUpdateSelection(item.id, Math.max(0, (selections[item.id] || 0) - 1))}
                      style={{ width: '30px', height: '30px', borderRadius: '50%', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >-</button>
                    <span style={{ width: '20px', textAlign: 'center' }}>{selections[item.id] || 0}</span>
                    <button
                      onClick={() => onUpdateSelection(item.id, (selections[item.id] || 0) + 1)}
                      disabled={(item.id === 'hut-covered' && paidHuts + (party.enabled ? 1 : 0) >= maxHuts) || (item.id === 'hut-shaded' && (selections['hut-shaded'] || 0) >= maxTables)}
                      style={{ width: '30px', height: '30px', borderRadius: '50%', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >+</button>
                  </div>
                </div>
              ))}
              {group.category === 'DAY VISITOR HUTS' && <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Any group can book a shaded table (seating for 6). Covered huts require a minimum of 6 people; groups of 12 or more may select 2 huts. Birthday parties include one selectable hut. <strong>Please note: tables/huts may become available at any time during the day due to parties.</strong></p>}
            </div>
          </div>
        ))}

        <section className="party-section">
          <div className="party-section-header">
            <h3>Birthday parties</h3>
          </div>
          <p className="party-subtitle">Kiddy parties are two-hour parties hosted Tuesday to Sunday. A free party hut is included for summer outdoor parties.</p>

          <ul className="party-checklist">
            {PARTY_INCLUDES.map(item => (
              <li key={item}><CheckIcon /> {item}</li>
            ))}
          </ul>

          {partyAvailability && partyAvailability.availableSlots.length === 0 && (
            <div className="callout callout-warning">
              <p><strong>Birthdays not available on this day.</strong>{partyAvailability.nextAvailableDate && <span> The next available party date is <strong>{partyAvailability.nextAvailableDate}</strong>.</span>}</p>
            </div>
          )}
          {partyError && <div className="callout callout-danger"><p>{partyError}</p></div>}

          <label className={`party-toggle-row${party.enabled ? ' active' : ''}`}>
            <input type="checkbox" checked={party.enabled} onChange={event => onPartyChange({ ...party, enabled: event.target.checked })} />
            <span>I want to book a birthday party</span>
          </label>

          {party.enabled && <div className="party-fieldset">
            <div>
              <p className="field-label">Party package</p>
              <div className="party-option-cards">
                <label className={`party-option-card${party.option === 'option-1' ? ' selected' : ''}`}>
                  <input type="radio" checked={party.option === 'option-1'} onChange={() => onPartyChange({ ...party, option: 'option-1' })} />
                  <div>
                    <p className="party-option-title">Option 1</p>
                    <p className="party-option-desc">R200 per child (minimum 10 children)</p>
                  </div>
                </label>
                <label className={`party-option-card${party.option === 'option-2' ? ' selected' : ''}`}>
                  <input type="radio" checked={party.option === 'option-2'} onChange={() => onPartyChange({ ...party, option: 'option-2' })} />
                  <div>
                    <p className="party-option-title">Option 2</p>
                    <p className="party-option-desc">R225 per child, including a hotdog (minimum 10 children)</p>
                  </div>
                </label>
              </div>
            </div>

            <div className="party-grid-2">
              <label>
                <span className="field-label">Party children (minimum 10)</span>
                <input type="number" min="10" className="field-input" value={party.children} onChange={event => onPartyChange({ ...party, children: Math.max(10, Number(event.target.value) || 10) })} />
              </label>
              <label>
                <span className="field-label">Adults</span>
                <input type="number" min="0" className="field-input" value={party.adults} onChange={event => { const count = Math.max(0, Number(event.target.value) || 0); onPartyChange({ ...party, adults: count, adultsWater: party.adultsWater.slice(0, count) }); }} />
              </label>
            </div>

            {party.adults > 0 && <div>
              <p className="field-label">Adult entrance type</p>
              <div className="party-entry-list">
                {Array.from({ length: party.adults }, (_, index) => (
                  <label key={index} className="party-entry-row">
                    <input type="checkbox" checked={party.adultsWater[index] === true} onChange={event => { const water = [...party.adultsWater]; water[index] = event.target.checked; onPartyChange({ ...party, adultsWater: water }); }} />
                    Adult {index + 1}: swimming and waterslides (R180)
                  </label>
                ))}
              </div>
              <small style={{ color: 'var(--text-muted)' }}>Leave unchecked for non-swimming entrance (R80).</small>
            </div>}

            <label>
              <span className="field-label">Additional children</span>
              <input type="number" min="0" className="field-input" value={party.additionalChildren} onChange={event => { const count = Math.max(0, Number(event.target.value) || 0); onPartyChange({ ...party, additionalChildren: count, additionalChildrenWater: party.additionalChildrenWater.slice(0, count) }); }} />
            </label>

            {party.additionalChildren > 0 && <div>
              <p className="field-label">Additional child entrance type</p>
              <div className="party-entry-list">
                {Array.from({ length: party.additionalChildren }, (_, index) => (
                  <label key={index} className="party-entry-row">
                    <input type="checkbox" checked={party.additionalChildrenWater[index] === true} onChange={event => { const water = [...party.additionalChildrenWater]; water[index] = event.target.checked; onPartyChange({ ...party, additionalChildrenWater: water }); }} />
                    Child {index + 1}: swimming and waterslides (R200)
                  </label>
                ))}
              </div>
              <small style={{ color: 'var(--text-muted)' }}>Leave unchecked for non-swimming entrance (R100).</small>
            </div>}

            <label>
              <span className="field-label">Optional party packs (R50 each)</span>
              <input type="number" min="0" className="field-input" value={party.partyPacks} onChange={event => onPartyChange({ ...party, partyPacks: Math.max(0, Number(event.target.value) || 0) })} />
            </label>

            <label>
              <span className="field-label">Party time slot</span>
              <select value={party.slot} onChange={event => onPartyChange({ ...party, slot: event.target.value })} className="field-input">
                <option value="">Select a time slot</option>
                {(partyAvailability?.slots || getPartySlots(selectedDate)).map(slot => {
                  const isAvailable = partyAvailability ? partyAvailability.availableSlots.includes(slot) : true;
                  return <option key={slot} value={slot} disabled={!isAvailable}>{slot}{!isAvailable ? ' (Fully Booked)' : ''}</option>;
                })}
              </select>
            </label>

            <div className="callout callout-info">
              <p>As we only have 30 minute gaps between party slots to clean up and set up the party huts, it would be appreciated if you would please only arrive 10 minutes before the party.</p>
            </div>

            {party.enabled && party.children < 10 && <p style={{ color: 'var(--danger)' }}>A party requires at least 10 children.</p>}
            {party.enabled && !party.slot && <p style={{ color: 'var(--danger)' }}>Select one of the available party time slots.</p>}

            <div className="party-total">
              <span>Birthday party total</span>
              <span>R {calculatePartyTotal(party)}</span>
            </div>
          </div>}
        </section>

        <div style={{ padding: '1.5rem', backgroundColor: '#f1f5f9', borderRadius: '0.5rem', marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 'bold', fontSize: '1.25rem' }}>
          <span>Total:</span>
          <span>R {calculateTotal()}</span>
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <button className="btn" style={{ border: '1px solid var(--border-color)', flex: 1 }} onClick={onBack}>Back</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={continueToDetails} disabled={party.enabled && (!party.slot || party.children < 10 || !partyAvailability?.availableSlots.includes(party.slot))}>Continue to Details</button>
        </div>
        {selectionError && <p role="alert" style={{ color: 'var(--danger)', marginTop: '1rem', textAlign: 'center' }}>{selectionError}</p>}
      </div>
      <aside style={{ flex: '1 1 240px', backgroundColor: '#fff7ed', color: '#431407', border: '2px solid #f97316', borderRadius: '0.75rem', padding: '1.25rem', boxShadow: '0 8px 20px rgba(194, 65, 12, 0.12)' }}>
        <h3 style={{ marginBottom: '0.75rem' }}>Lifejackets for hire</h3>
        <p style={{ marginBottom: '0.75rem' }}>Lifejackets are available to hire for <strong>R50 per day</strong>.</p>
        <p style={{ marginBottom: '0.75rem' }}>A surety item must be handed in at the kiosk, such as car keys, an ID or a driver&apos;s licence.</p>
        <p style={{ marginBottom: '0.75rem' }}><strong>Hire only — not for sale.</strong></p>
        <p style={{ margin: 0 }}><strong>Return all hired lifejackets by 16:30.</strong></p>
      </aside>
    </div>
  );
}
