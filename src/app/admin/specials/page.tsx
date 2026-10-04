'use client';

import { PageHeader } from '@/components/admin/AdminShell';
import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm } from '@/components/ConfirmDialog';
import { BOOKABLE_ITEMS } from '@/lib/pricing';
import type { Special } from '@/lib/specials';

const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';

const WEEKDAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 0, label: 'Sun' }
];

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
    } catch (e: any) {
      setMessage({ tone: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
    } catch (e: any) {
      setMessage({ tone: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const saveSpecial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      const isNew = !editing.id;
      const url = isNew ? '/api/admin/specials' : `/api/admin/specials/${editing.id}`;
      const method = isNew ? 'POST' : 'PUT';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify(editing)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessage({ tone: 'ok', text: isNew ? 'Special created.' : 'Special updated.' });
      setEditing(null);
      loadData();
    } catch (e: any) {
      setMessage({ tone: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const archiveSpecial = async (id: string) => {
    if (!await confirm({ title: 'Archive Special', message: 'Are you sure you want to archive this special? It will no longer be bookable.' })) return;
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
    } catch (e: any) {
      setMessage({ tone: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const defaultSpecial: Partial<Special> = {
    title: '', description: '', badge_text: '', type: 'discount',
    paid_tickets: [{ itemId: 'day-water-adult', quantity: 1 }], free_tickets: [],
    pricing: { type: 'percentage', discount: 10 }, free_meals: 0,
    valid_from: null, valid_to: null, valid_weekdays: [], stock_limit: null, max_per_booking: null, active: true
  };

  if (loading) return <div className="p-4">Loading...</div>;

  return (
    <div>
      <PageHeader title="Specials & Packages" actions={
        <button onClick={() => { setEditing(defaultSpecial); setMessage(null); }} className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700">
          Create special
        </button>
      } />
      
      {dialog}

      <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">
        {message && (
          <div className={`p-4 rounded-md ${message.tone === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {message.text}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Meal Vouchers</h2>
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700 mb-1">Meal Name displayed on vouchers</label>
              <input type="text" value={mealName} onChange={e => setMealName(e.target.value)} className="w-full p-2 border border-slate-300 rounded-md" />
            </div>
            <button onClick={saveMealSettings} disabled={saving} className="px-4 py-2 bg-slate-800 text-white rounded-md text-sm hover:bg-slate-700">
              Save Settings
            </button>
          </div>
        </div>

        {editing ? (
          <form onSubmit={saveSpecial} className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6">
            <h2 className="text-lg font-semibold text-slate-800">{editing.id ? 'Edit Special' : 'New Special'}</h2>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                <input required type="text" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} className="w-full p-2 border border-slate-300 rounded-md" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Badge Text (Optional)</label>
                <input type="text" value={editing.badge_text || ''} onChange={e => setEditing({ ...editing, badge_text: e.target.value })} placeholder="e.g. POPULAR, 20% OFF" className="w-full p-2 border border-slate-300 rounded-md" />
              </div>
            </div>

            <div>
               <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
               <textarea value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} className="w-full p-2 border border-slate-300 rounded-md" rows={3} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Special Type</label>
                <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value as any })} className="w-full p-2 border border-slate-300 rounded-md">
                  <option value="discount">Bundle Discount</option>
                  <option value="buy_x_get_y">Buy X Get Y Free</option>
                  <option value="tickets_and_meals">Tickets + Meals</option>
                </select>
              </div>
              <div className="flex items-center pt-6">
                 <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
                   <input type="checkbox" checked={editing.active !== false} onChange={e => setEditing({ ...editing, active: e.target.checked })} className="w-4 h-4 rounded border-slate-300" />
                   Active on booking site
                 </label>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-800 mb-3">Paid Tickets in Bundle</h3>
              {editing.paid_tickets?.map((t, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <select value={t.itemId} onChange={e => {
                    const newTickets = [...(editing.paid_tickets || [])];
                    newTickets[i].itemId = e.target.value;
                    setEditing({ ...editing, paid_tickets: newTickets });
                  }} className="flex-1 p-2 border border-slate-300 rounded-md">
                    {Object.entries(BOOKABLE_ITEMS).map(([id, info]) => <option key={id} value={id}>{info.name}</option>)}
                  </select>
                  <input type="number" min="1" value={t.quantity} onChange={e => {
                    const newTickets = [...(editing.paid_tickets || [])];
                    newTickets[i].quantity = Number(e.target.value);
                    setEditing({ ...editing, paid_tickets: newTickets });
                  }} className="w-20 p-2 border border-slate-300 rounded-md" />
                  <button type="button" onClick={() => setEditing({ ...editing, paid_tickets: editing.paid_tickets?.filter((_, idx) => idx !== i) })} className="px-3 py-2 text-red-600 border border-slate-300 rounded-md">X</button>
                </div>
              ))}
              <button type="button" onClick={() => setEditing({ ...editing, paid_tickets: [...(editing.paid_tickets || []), { itemId: 'day-water-adult', quantity: 1 }] })} className="text-sm text-blue-600 font-medium hover:underline">+ Add ticket type</button>
            </div>

            {(editing.type === 'buy_x_get_y' || editing.free_tickets?.length! > 0) && (
              <div className="border-t border-slate-200 pt-4">
                <h3 className="text-sm font-semibold text-slate-800 mb-3">Free Tickets in Bundle</h3>
                {editing.free_tickets?.map((t, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <select value={t.itemId} onChange={e => {
                      const newTickets = [...(editing.free_tickets || [])];
                      newTickets[i].itemId = e.target.value;
                      setEditing({ ...editing, free_tickets: newTickets });
                    }} className="flex-1 p-2 border border-slate-300 rounded-md">
                      {Object.entries(BOOKABLE_ITEMS).map(([id, info]) => <option key={id} value={id}>{info.name}</option>)}
                    </select>
                    <input type="number" min="1" value={t.quantity} onChange={e => {
                      const newTickets = [...(editing.free_tickets || [])];
                      newTickets[i].quantity = Number(e.target.value);
                      setEditing({ ...editing, free_tickets: newTickets });
                    }} className="w-20 p-2 border border-slate-300 rounded-md" />
                    <button type="button" onClick={() => setEditing({ ...editing, free_tickets: editing.free_tickets?.filter((_, idx) => idx !== i) })} className="px-3 py-2 text-red-600 border border-slate-300 rounded-md">X</button>
                  </div>
                ))}
                <button type="button" onClick={() => setEditing({ ...editing, free_tickets: [...(editing.free_tickets || []), { itemId: 'day-water-adult', quantity: 1 }] })} className="text-sm text-blue-600 font-medium hover:underline">+ Add free ticket type</button>
              </div>
            )}

            <div className="border-t border-slate-200 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
               <div>
                  <h3 className="text-sm font-semibold text-slate-800 mb-3">Pricing Override</h3>
                  <div className="flex gap-2 mb-2">
                     <select value={editing.pricing?.type} onChange={e => {
                        const type = e.target.value as any;
                        if (type === 'percentage') setEditing({ ...editing, pricing: { type, discount: 10 } });
                        if (type === 'fixed-off') setEditing({ ...editing, pricing: { type, discount: 50 } });
                        if (type === 'fixed-price') setEditing({ ...editing, pricing: { type, price: 500 } });
                     }} className="w-1/2 p-2 border border-slate-300 rounded-md">
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
                     }} className="w-1/2 p-2 border border-slate-300 rounded-md" placeholder="Amount" />
                  </div>
               </div>
               <div>
                  <h3 className="text-sm font-semibold text-slate-800 mb-3">Free Meals</h3>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Vouchers per bundle</label>
                  <input type="number" min="0" value={editing.free_meals || 0} onChange={e => setEditing({ ...editing, free_meals: Number(e.target.value) })} className="w-full p-2 border border-slate-300 rounded-md" />
               </div>
            </div>

            <div className="border-t border-slate-200 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Valid From (Optional)</label>
                <input type="date" value={editing.valid_from || ''} onChange={e => setEditing({ ...editing, valid_from: e.target.value || null })} className="w-full p-2 border border-slate-300 rounded-md" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Valid To (Optional)</label>
                <input type="date" value={editing.valid_to || ''} onChange={e => setEditing({ ...editing, valid_to: e.target.value || null })} className="w-full p-2 border border-slate-300 rounded-md" />
              </div>
            </div>

            <div>
               <label className="block text-sm font-medium text-slate-700 mb-2">Valid Weekdays (Select none for all days)</label>
               <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map(day => (
                     <label key={day.value} className="flex items-center gap-1 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200 text-sm cursor-pointer hover:bg-slate-100">
                        <input type="checkbox" checked={editing.valid_weekdays?.includes(day.value) || false} onChange={e => {
                           const current = editing.valid_weekdays || [];
                           const updated = e.target.checked ? [...current, day.value] : current.filter(v => v !== day.value);
                           setEditing({ ...editing, valid_weekdays: updated });
                        }} className="rounded border-slate-300 text-blue-600" />
                        {day.label}
                     </label>
                  ))}
               </div>
            </div>

            <div className="border-t border-slate-200 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Daily Stock Limit (Optional)</label>
                <input type="number" min="1" value={editing.stock_limit || ''} onChange={e => setEditing({ ...editing, stock_limit: e.target.value ? Number(e.target.value) : null })} placeholder="Unlimited" className="w-full p-2 border border-slate-300 rounded-md" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Max per booking (Optional)</label>
                <input type="number" min="1" value={editing.max_per_booking || ''} onChange={e => setEditing({ ...editing, max_per_booking: e.target.value ? Number(e.target.value) : null })} placeholder="Unlimited" className="w-full p-2 border border-slate-300 rounded-md" />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 text-slate-600 hover:text-slate-900 font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="px-6 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700">{saving ? 'Saving...' : 'Save Special'}</button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            {specials.filter(s => !s.archived_at).length === 0 && <p className="text-slate-500 text-center py-8">No specials found.</p>}
            {specials.filter(s => !s.archived_at).map(s => (
              <div key={s.id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex items-center justify-between">
                 <div>
                    <div className="flex items-center gap-2 mb-1">
                       <h3 className="font-semibold text-slate-900">{s.title}</h3>
                       {!s.active && <span className="bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded-full font-medium">Draft/Inactive</span>}
                       {s.badge_text && <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded-full font-medium">{s.badge_text}</span>}
                    </div>
                    <p className="text-sm text-slate-500 mb-2">{s.description}</p>
                    <div className="text-xs text-slate-400 space-x-3">
                       <span>{s.type.replace(/_/g, ' ')}</span>
                       {s.stock_limit && <span>• Limit: {s.stock_limit}/day</span>}
                    </div>
                 </div>
                 <div className="flex items-center gap-2">
                    <button onClick={() => { setEditing(s); setMessage(null); }} className="px-3 py-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md text-sm font-medium">Edit</button>
                    <button onClick={() => archiveSpecial(s.id)} className="px-3 py-1.5 text-red-600 bg-red-50 hover:bg-red-100 rounded-md text-sm font-medium">Archive</button>
                 </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
