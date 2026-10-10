'use client';

import { PageHeader } from '@/components/admin/AdminShell';
import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm } from '@/components/ConfirmDialog';
import { BOOKABLE_ITEMS } from '@/lib/pricing';
import type { Special, SpecialItemDef, SpecialPricing, SpecialType } from '@/lib/specials';

const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';

const WEEKDAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 0, label: 'Sun' }
];

const inputStyle = { padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 8, width: '100%', fontSize: '0.9rem' } as const;
const labelStyle = { display: 'grid', gap: 4, fontSize: '0.85rem', fontWeight: 600, flex: 1 };
const rowStyle = { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: '1rem' } as const;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Please try again.');

/** Replace one line of a list without changing the original (the saved special stays untouched until Save). */
const updateAt = <T,>(list: T[] | undefined, index: number, change: Partial<T>) => (list || []).map((item, i) => (i === index ? { ...item, ...change } : item));

const headerStyle = { fontSize: '1rem', color: 'var(--primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, marginBottom: 12, marginTop: '1.5rem' };

export default function SpecialsAdminPage() {
  const { confirm, dialog } = useConfirm();
  const [specials, setSpecials] = useState<Special[]>([]);
  const [mealName, setMealName] = useState('Free Meal');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // Form state
  const [editing, setEditing] = useState<Partial<Special> | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [spRes, mealRes] = await Promise.all([
        fetch('/api/admin/specials', { headers: { Authorization: `Bearer ${await token()}` } }),
        fetch('/api/admin/settings/meals', { headers: { Authorization: `Bearer ${await token()}` } })
      ]);
      const [spData, mealData] = await Promise.all([spRes.json(), mealRes.json()]);
      if (!spRes.ok) throw new Error(spData.error || 'Failed to load specials');
      if (!mealRes.ok) throw new Error(mealData.error || 'Failed to load settings');
      setSpecials(spData.specials || []);
      setMealName(mealData.settings?.meal_name || 'Free Meal');
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load; state is set after the requests finish
  useEffect(() => { loadData(); }, [loadData]);

  const saveMealSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings/meals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ meal_name: mealName })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessage({ tone: 'ok', text: 'Meal name updated.' });
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const saveSpecial = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(editing?.id ? `/api/admin/specials/${editing.id}` : '/api/admin/specials', {
        method: editing?.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify(editing)
      });
      if (!res.ok) {
         const data = await res.json();
         throw new Error(data.error);
      }
      setMessage({ tone: 'ok', text: editing?.id ? 'Special updated.' : 'Special created.' });
      setEditing(null);
      loadData();
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const archiveSpecial = async (id: string) => {
    const answer = await confirm({ title: 'Archive special', message: 'Archive this special? It will no longer be bookable. Existing bookings keep it.', confirmLabel: 'Archive', tone: 'danger' });
    if (!answer.confirmed) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/specials/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await token()}` }
      });
      if (!res.ok) {
         const data = await res.json();
         throw new Error(data.error);
      }
      setMessage({ tone: 'ok', text: 'Special archived.' });
      loadData();
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const defaultSpecial: Partial<Special> = {
    title: '', description: '', badge_text: '', type: 'discount',
    paid_tickets: [{ itemId: 'day-water-adult', quantity: 1 }], free_tickets: [],
    pricing: { type: 'percentage', discount: 10 }, free_meals: 0, included_meals: [],
    valid_from: null, valid_to: null, valid_weekdays: [], stock_limit: null, max_per_booking: null, active: true
  };

  if (loading) return <main className="container" style={{ padding: '2rem 1rem' }}>Loading...</main>;

  const messageStyle = (tone: 'ok' | 'error') => ({ marginBottom: '1.5rem', color: tone === 'ok' ? 'var(--success-text)' : 'var(--danger)', padding: '1rem', background: tone === 'ok' ? 'var(--success-bg)' : 'var(--danger-bg)', borderRadius: 8, border: `1px solid ${tone === 'ok' ? 'var(--success-border)' : 'var(--danger-border)'}` });

  return (
    <main className="container" style={{ padding: '2rem 1rem' }}>
      <PageHeader 
        title="Specials & Packages" 
        actions={
          !editing ? (
            <button onClick={() => { setEditing(defaultSpecial); setMessage(null); }} className="btn btn-primary">
              Create special
            </button>
          ) : undefined
        } 
      />
      
      {dialog}

      {message && <div style={messageStyle(message.tone)}>{message.text}</div>}

      {!editing && (
        <section className="card" style={{ marginBottom: '1.5rem' }}>
          <h2>Meal Vouchers</h2>
          <p style={{ color: 'var(--text-muted)', marginTop: 4, marginBottom: '1rem' }}>Customize how meal vouchers appear on PDFs and emails.</p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={labelStyle}>
              Meal Name displayed on vouchers
              <input type="text" value={mealName} onChange={e => setMealName(e.target.value)} style={inputStyle} />
            </label>
            <button onClick={saveMealSettings} disabled={saving} className="btn btn-primary" style={{ height: 'fit-content', padding: '0.6rem 1rem' }}>
              Save Settings
            </button>
          </div>
        </section>
      )}

      {editing ? (
        <section className="card">
          <h2>{editing.id ? 'Edit Special' : 'New Special'}</h2>
          <form onSubmit={saveSpecial} style={{ marginTop: '1.5rem' }}>
            
            <div style={rowStyle}>
              <label style={labelStyle}>
                Title
                <input required type="text" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                Badge Text (Optional)
                <input type="text" value={editing.badge_text || ''} onChange={e => setEditing({ ...editing, badge_text: e.target.value })} placeholder="e.g. POPULAR, 20% OFF" style={inputStyle} />
              </label>
            </div>

            <div style={{ marginBottom: '1rem' }}>
               <label style={labelStyle}>
                 Description
                 <textarea value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} />
               </label>
            </div>

            <div style={rowStyle}>
              <label style={labelStyle}>
                Special Type
                <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value as SpecialType })} style={inputStyle}>
                  <option value="discount">Bundle Discount</option>
                  <option value="buy_x_get_y">Buy X Get Y Free</option>
                  <option value="tickets_and_meals">Tickets + Meals</option>
                </select>
              </label>
              <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', marginTop: '1.2rem' }}>
                 <input type="checkbox" checked={editing.active !== false} onChange={e => setEditing({ ...editing, active: e.target.checked })} style={{ width: 18, height: 18 }} />
                 Active on booking site
              </label>
            </div>

            <h3 style={headerStyle}>Paid Tickets in Bundle</h3>
            {editing.paid_tickets?.map((t, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                <select value={t.itemId} onChange={e => setEditing({ ...editing, paid_tickets: updateAt<SpecialItemDef>(editing.paid_tickets, i, { itemId: e.target.value }) })} style={{ ...inputStyle, flex: 1 }}>
                  {Object.entries(BOOKABLE_ITEMS).map(([id, info]) => <option key={id} value={id}>{info.name}</option>)}
                </select>
                <input type="number" min="1" value={t.quantity} onChange={e => setEditing({ ...editing, paid_tickets: updateAt<SpecialItemDef>(editing.paid_tickets, i, { quantity: Number(e.target.value) }) })} style={{ ...inputStyle, width: 80 }} />
                <button type="button" onClick={() => setEditing({ ...editing, paid_tickets: editing.paid_tickets?.filter((_, idx) => idx !== i) })} className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => setEditing({ ...editing, paid_tickets: [...(editing.paid_tickets || []), { itemId: 'day-water-adult', quantity: 1 }] })} style={{ background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer', padding: '0.5rem 0' }}>+ Add ticket type</button>

            {(editing.type === 'buy_x_get_y' || (editing.free_tickets?.length ?? 0) > 0) && (
              <>
                <h3 style={headerStyle}>Free Tickets in Bundle</h3>
                {editing.free_tickets?.map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                    <select value={t.itemId} onChange={e => setEditing({ ...editing, free_tickets: updateAt<SpecialItemDef>(editing.free_tickets, i, { itemId: e.target.value }) })} style={{ ...inputStyle, flex: 1 }}>
                      {Object.entries(BOOKABLE_ITEMS).map(([id, info]) => <option key={id} value={id}>{info.name}</option>)}
                    </select>
                    <input type="number" min="1" value={t.quantity} onChange={e => setEditing({ ...editing, free_tickets: updateAt<SpecialItemDef>(editing.free_tickets, i, { quantity: Number(e.target.value) }) })} style={{ ...inputStyle, width: 80 }} />
                    <button type="button" onClick={() => setEditing({ ...editing, free_tickets: editing.free_tickets?.filter((_, idx) => idx !== i) })} className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>Remove</button>
                  </div>
                ))}
                <button type="button" onClick={() => setEditing({ ...editing, free_tickets: [...(editing.free_tickets || []), { itemId: 'day-water-adult', quantity: 1 }] })} style={{ background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer', padding: '0.5rem 0' }}>+ Add free ticket type</button>
              </>
            )}

            <div style={rowStyle}>
               <div style={{ flex: 1 }}>
                  <h3 style={headerStyle}>Pricing Override</h3>
                  <div style={{ display: 'flex', gap: 12 }}>
                     <select value={editing.pricing?.type} onChange={e => {
                        const type = e.target.value as SpecialPricing['type'];
                        if (type === 'percentage') setEditing({ ...editing, pricing: { type, discount: 10 } });
                        if (type === 'fixed-off') setEditing({ ...editing, pricing: { type, discount: 50 } });
                        if (type === 'fixed-price') setEditing({ ...editing, pricing: { type, price: 500 } });
                     }} style={inputStyle}>
                        <option value="percentage">% Off</option>
                        <option value="fixed-off">Rand Off</option>
                        <option value="fixed-price">Fixed Price</option>
                     </select>
                     <input type="number" min="0" value={
                        editing.pricing?.type === 'percentage' ? editing.pricing.discount :
                        editing.pricing?.type === 'fixed-off' ? editing.pricing.discount :
                        editing.pricing?.type === 'fixed-price' ? editing.pricing.price : 0
                     } onChange={e => {
                        const val = Number(e.target.value);
                        if (editing.pricing?.type === 'percentage') setEditing({ ...editing, pricing: { type: 'percentage', discount: val } });
                        if (editing.pricing?.type === 'fixed-off') setEditing({ ...editing, pricing: { type: 'fixed-off', discount: val } });
                        if (editing.pricing?.type === 'fixed-price') setEditing({ ...editing, pricing: { type: 'fixed-price', price: val } });
                     }} style={inputStyle} placeholder="Amount" />
                  </div>
               </div>
               <div style={{ flex: 1, minWidth: 300 }}>
                  <h3 style={headerStyle}>Included Meal Vouchers</h3>
                  {editing.included_meals?.map((m, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'center' }}>
                      <input type="text" value={m.name} onChange={e => setEditing({ ...editing, included_meals: updateAt(editing.included_meals, i, { name: e.target.value }) })} style={{ ...inputStyle, flex: 1 }} placeholder="Voucher Name (e.g. Free Hotdog)" />
                      <input type="number" min="1" value={m.quantity} onChange={e => setEditing({ ...editing, included_meals: updateAt(editing.included_meals, i, { quantity: Number(e.target.value) }) })} style={{ ...inputStyle, width: 80 }} />
                      <button type="button" onClick={() => setEditing({ ...editing, included_meals: editing.included_meals?.filter((_, idx) => idx !== i) })} className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setEditing({ ...editing, included_meals: [...(editing.included_meals || []), { name: 'Special Meal', quantity: 1 }] })} style={{ background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer', padding: '0.5rem 0' }}>+ Add Meal Voucher</button>
               </div>
            </div>

            <h3 style={headerStyle}>Restrictions (Optional)</h3>
            <div style={rowStyle}>
              <label style={labelStyle}>
                Valid From
                <input type="date" value={editing.valid_from || ''} onChange={e => setEditing({ ...editing, valid_from: e.target.value || null })} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                Valid To
                <input type="date" value={editing.valid_to || ''} onChange={e => setEditing({ ...editing, valid_to: e.target.value || null })} style={inputStyle} />
              </label>
            </div>

            <div style={{ marginBottom: '1rem' }}>
               <label style={{ ...labelStyle, marginBottom: 8 }}>Valid Weekdays (Select none for all days)</label>
               <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {WEEKDAYS.map(day => (
                     <label key={day.value} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-color)', padding: '0.4rem 0.8rem', borderRadius: 20, border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: '0.85rem' }}>
                        <input type="checkbox" checked={editing.valid_weekdays?.includes(day.value) || false} onChange={e => {
                           const current = editing.valid_weekdays || [];
                           const updated = e.target.checked ? [...current, day.value] : current.filter(v => v !== day.value);
                           setEditing({ ...editing, valid_weekdays: updated });
                        }} style={{ width: 16, height: 16 }} />
                        {day.label}
                     </label>
                  ))}
               </div>
            </div>

            <div style={rowStyle}>
              <label style={labelStyle}>
                Daily Stock Limit
                <input type="number" min="1" value={editing.stock_limit || ''} onChange={e => setEditing({ ...editing, stock_limit: e.target.value ? Number(e.target.value) : null })} placeholder="Unlimited" style={inputStyle} />
              </label>
              <label style={labelStyle}>
                Max per booking
                <input type="number" min="1" value={editing.max_per_booking || ''} onChange={e => setEditing({ ...editing, max_per_booking: e.target.value ? Number(e.target.value) : null })} placeholder="Unlimited" style={inputStyle} />
              </label>
            </div>

            <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-color)' }}>
              <label style={labelStyle}>
                Give this special free to online bookings over (R)
                <input type="number" min="0" step="0.01" value={editing.auto_apply_min_spend ?? ''} onChange={e => setEditing({ ...editing, auto_apply_min_spend: e.target.value === '' ? null : Number(e.target.value) })} placeholder="Off (e.g. 660)" style={{ ...inputStyle, maxWidth: 220 }} />
              </label>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 6 }}>When a customer&apos;s cart is over this amount on a date this special is valid, their booking also gets this special&apos;s free tickets and meal vouchers at no charge. Their own tickets stay at the normal price. If more than one special qualifies, they get only the one worth the most. Leave empty to switch this off.</p>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: '2rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
              <button type="button" onClick={() => setEditing(null)} className="btn">Cancel</button>
              <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving...' : 'Save Special'}</button>
            </div>
          </form>
        </section>
      ) : (
        <section className="card">
          <h2>Active Specials</h2>
          <div style={{ marginTop: '1.5rem' }}>
            {specials.filter(s => !s.archived_at).length === 0 && <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>No specials found. Click &quot;Create special&quot; to add one.</p>}
            {specials.filter(s => !s.archived_at).map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem', borderBottom: '1px solid var(--border-color)', gap: 16, flexWrap: 'wrap' }}>
                 <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                       <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{s.title}</h3>
                       {!s.active && <span style={{ background: 'var(--bg-color)', color: 'var(--text-muted)', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>Draft</span>}
                       {s.badge_text && <span style={{ background: 'var(--warning-bg)', color: 'var(--warning-text)', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 12, fontWeight: 600, border: '1px solid var(--warning-border)' }}>{s.badge_text}</span>}
                    </div>
                    <p style={{ color: 'var(--text-muted)', margin: '0 0 6px 0', fontSize: '0.9rem' }}>{s.description}</p>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', gap: 12 }}>
                       <span><strong>Type:</strong> {s.type.replace(/_/g, ' ')}</span>
                       {s.stock_limit && <span><strong>Limit:</strong> {s.stock_limit}/day</span>}
                       {s.auto_apply_min_spend !== null && s.auto_apply_min_spend !== undefined && <span><strong>Free over:</strong> R {Number(s.auto_apply_min_spend).toFixed(2)}</span>}
                    </div>
                 </div>
                 <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => { setEditing(s); setMessage(null); }} className="btn">Edit</button>
                    <button onClick={() => archiveSpecial(s.id)} className="btn" style={{ color: 'var(--danger)', borderColor: 'var(--danger-border)' }}>Archive</button>
                 </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
