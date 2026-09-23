'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm } from '@/components/ConfirmDialog';

type Staff = { id: string; name: string; email: string; role: 'ADMIN' | 'MANAGER' | 'SCANNER'; active: boolean; created_at: string; last_login: string | null };
type Activity = { id: string; action: string; entity_type: string; entity_id: string; created_at: string };
const roleName = (role: Staff['role']) => role === 'SCANNER' ? 'Gate Staff' : role[0] + role.slice(1).toLowerCase();

export default function StaffManagement() {
  const [staff, setStaff] = useState<Staff[]>([]); const [selected, setSelected] = useState<Staff | null>(null); const [query, setQuery] = useState(''); const [roleFilter, setRoleFilter] = useState(''); const [message, setMessage] = useState('Loading staff…'); const [activity, setActivity] = useState<Activity[]>([]); const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [role, setRole] = useState<Staff['role']>('SCANNER'); const [editName, setEditName] = useState(''); const [editEmail, setEditEmail] = useState('');
  const { confirm, dialog } = useConfirm();
  const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
  const load = async () => { const response = await fetch(`/api/admin/staff?q=${encodeURIComponent(query)}&role=${roleFilter}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setStaff(data.staff); setMessage(data.staff.length ? '' : 'No staff members found.'); };
  const loadActivity = async (member: Staff) => { setSelected(member); setEditName(member.name); setEditEmail(member.email); const response = await fetch(`/api/admin/audit?userId=${member.id}&limit=100`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' }); const data = await response.json(); if (response.ok) setActivity(data.entries); };
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- Initial data fetch on mount; setState is asynchronous
  useEffect(() => { load().catch(error => setMessage(error.message)); }, [roleFilter]);
  const invite = async (event: React.FormEvent) => { event.preventDefault(); const response = await fetch('/api/admin/staff', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, role }) }); const data = await response.json(); setMessage(data.message || data.error); if (response.ok) { setName(''); setEmail(''); await load(); } };
  const update = async (changes: Record<string, unknown>) => {
    if (!selected) return;
    if (changes.active === false) {
      const result = await confirm({ title: 'Deactivate staff member', message: `Deactivate ${selected.name}? Their active sessions will be revoked.`, confirmLabel: 'Deactivate', tone: 'danger' });
      if (!result.confirmed) return;
    }
    const response = await fetch('/api/admin/staff', { method: 'PATCH', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: selected.id, ...changes }) }); const data = await response.json(); setMessage(data.message || data.error); if (response.ok) { await load(); const refreshed = staff.find(member => member.id === selected.id); if (refreshed) loadActivity({ ...refreshed, ...changes } as Staff); }
  };
  const resend = async () => { if (!selected) return; const response = await fetch('/api/admin/staff', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resend_invite', userId: selected.id }) }); const data = await response.json(); setMessage(data.message || data.error); };
  const saveDetails = () => update({ name: editName, email: editEmail });
  const deleteStaff = async () => {
    if (!selected) return;
    const result = await confirm({ title: 'Delete staff member', message: `Permanently delete ${selected.name}? This removes their login and role. Historical audit entries will be retained.`, confirmLabel: 'Delete', tone: 'danger' });
    if (!result.confirmed) return;
    const response = await fetch(`/api/admin/staff?userId=${selected.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await token()}` } }); const data = await response.json(); setMessage(data.message || data.error); if (response.ok) { setSelected(null); await load(); }
  };
  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <div className="admin-header"><div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>SECURITY &amp; ACCESS</p><h1>Staff management</h1></div><a className="btn" href="/admin" style={{ border: '1px solid var(--border-color)' }}>Dashboard</a></div>
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2>Invite new staff</h2>
      <form onSubmit={invite} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}><input required value={name} onChange={event => setName(event.target.value)} placeholder="Full name" style={{ flex: '1 1 140px', padding: 10 }} /><input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="Email address" style={{ flex: '1 1 180px', padding: 10 }} /><select value={role} onChange={event => setRole(event.target.value as Staff['role'])} style={{ padding: 10 }}><option value="SCANNER">Gate Staff</option><option value="MANAGER">Manager</option><option value="ADMIN">Admin</option></select><button className="btn btn-primary">Send invite</button></form>
      <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>The staff member will receive an email with a link to set their password and activate their account.</p>
    </div>
    {message && <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{message}</p>}
    <div style={{ display: 'flex', gap: 8, marginBottom: '1rem', flexWrap: 'wrap' }}><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') load(); }} placeholder="Search name or email" style={{ flex: '1 1 180px', padding: 10 }} /><select value={roleFilter} onChange={event => setRoleFilter(event.target.value)} style={{ padding: 10 }}><option value="">All roles</option><option value="ADMIN">Admin</option><option value="MANAGER">Manager</option><option value="SCANNER">Gate Staff</option></select><button className="btn" onClick={() => load()} style={{ border: '1px solid var(--border-color)' }}>Search</button></div>
    <div className={`admin-panels${selected ? ' has-detail' : ''}`}>
      <div className="card admin-table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 550 }}><thead><tr>{['Name', 'Email', 'Role', 'Status', 'Added'].map(header => <th key={header} style={{ textAlign: 'left', padding: 10, borderBottom: '2px solid var(--border-color)' }}>{header}</th>)}</tr></thead><tbody>{staff.map(member => <tr key={member.id} onClick={() => loadActivity(member)} style={{ cursor: 'pointer', background: selected?.id === member.id ? '#e0f2fe' : undefined }}><td style={{ padding: 10 }}>{member.name}</td><td style={{ padding: 10, wordBreak: 'break-all' }}>{member.email}</td><td style={{ padding: 10 }}>{roleName(member.role)}</td><td style={{ padding: 10, color: member.active ? 'var(--success)' : 'var(--danger)' }}>{member.active ? 'Active' : 'Off'}</td><td style={{ padding: 10, whiteSpace: 'nowrap' }}>{new Date(member.created_at).toLocaleDateString()}</td></tr>)}</tbody></table>
      </div>
      {selected && <aside className="card">
        <h2>{selected.name}</h2><p style={{ color: 'var(--text-muted)', wordBreak: 'break-all' }}>{selected.email}</p>
        <label style={{ display: 'block', marginTop: 16 }}>Name<input value={editName} onChange={event => setEditName(event.target.value)} style={{ display: 'block', width: '100%', padding: 8, marginTop: 5 }} /></label>
        <label style={{ display: 'block', marginTop: 10 }}>Email<input type="email" value={editEmail} onChange={event => setEditEmail(event.target.value)} style={{ display: 'block', width: '100%', padding: 8, marginTop: 5 }} /></label>
        <button className="btn btn-primary" style={{ marginTop: 10, width: '100%' }} onClick={saveDetails}>Save details</button>
        <label style={{ display: 'block', marginTop: 16 }}>Role<select value={selected.role} onChange={event => update({ role: event.target.value })} style={{ display: 'block', width: '100%', padding: 8, marginTop: 5 }}><option value="SCANNER">Gate Staff</option><option value="MANAGER">Manager</option><option value="ADMIN">Admin</option></select></label>
        <button className="btn" style={{ marginTop: 12, width: '100%', border: '1px solid var(--border-color)' }} onClick={resend}>Resend activation link</button>
        <button className="btn" style={{ display: 'block', marginTop: 12, width: '100%', border: '1px solid var(--danger)', color: 'var(--danger)' }} onClick={() => update({ active: !selected.active })}>{selected.active ? 'Deactivate staff' : 'Reactivate staff'}</button>
        <button className="btn" style={{ display: 'block', marginTop: 12, width: '100%', border: '1px solid #7f1d1d', color: '#7f1d1d' }} onClick={deleteStaff}>Permanently delete</button>
        <h3 style={{ marginTop: 24 }}>Recent activity</h3>{activity.length ? activity.slice(0, 20).map(item => <p key={item.id} style={{ borderBottom: '1px solid var(--border-color)', padding: '8px 0', fontSize: 13 }}><strong>{item.action}</strong> · {item.entity_type} · {new Date(item.created_at).toLocaleString()}<br /><span style={{ color: 'var(--text-muted)', wordBreak: 'break-all' }}>{item.entity_id}</span></p>) : <p style={{ color: 'var(--text-muted)' }}>No recent activity.</p>}
      </aside>}
    </div>
    {dialog}
  </main>;
}
