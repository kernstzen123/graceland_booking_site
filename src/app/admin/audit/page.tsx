'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Entry = { id: string; actor_id: string; actor_email: string | null; action: string; entity_type: string; entity_id: string; details: Record<string, unknown>; created_at: string };

export default function AuditLog() {
  const [entries, setEntries] = useState<Entry[]>([]); const [query, setQuery] = useState(''); const [message, setMessage] = useState('Loading audit log…');
  useEffect(() => { supabaseBrowser.auth.getSession().then(async ({ data }) => { if (!data.session) throw new Error('Staff session has expired'); const response = await fetch('/api/admin/audit', { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store' }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setEntries(body.entries); setMessage(''); }).catch(error => setMessage(error instanceof Error ? error.message : 'Could not load audit log')); }, []);
  const filtered = entries.filter(entry => !query || [entry.actor_email, entry.action, entry.entity_type, entry.entity_id, JSON.stringify(entry.details)].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase()));
  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <div className="admin-header"><div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>ACCOUNTABILITY</p><h1>Audit log</h1></div><a className="btn" href="/admin" style={{ border: '1px solid var(--border-color)' }}>Dashboard</a></div>
    <div className="card" style={{ marginBottom: '1rem' }}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by staff, action, booking, or ticket" style={{ width: '100%', padding: '0.8rem', border: '1px solid var(--border-color)', borderRadius: 8 }} /></div>
    {message && <p style={{ color: 'var(--text-muted)' }}>{message}</p>}
    <div className="card admin-table-wrap"><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}><thead><tr>{['When', 'Staff', 'Action', 'Entity', 'Details'].map(header => <th key={header} style={{ textAlign: 'left', padding: '0.75rem', borderBottom: '2px solid var(--border-color)' }}>{header}</th>)}</tr></thead><tbody>{filtered.map(entry => <tr key={entry.id}><td style={{ padding: '0.75rem', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap', fontSize: '0.85rem' }}>{new Date(entry.created_at).toLocaleString()}</td><td style={{ padding: '0.75rem', borderBottom: '1px solid var(--border-color)', wordBreak: 'break-all', fontSize: '0.85rem' }}>{entry.actor_email || entry.actor_id}</td><td style={{ padding: '0.75rem', borderBottom: '1px solid var(--border-color)', fontWeight: 700, fontSize: '0.85rem' }}>{entry.action}</td><td style={{ padding: '0.75rem', borderBottom: '1px solid var(--border-color)', fontSize: '0.85rem' }}>{entry.entity_type}<br /><small style={{ wordBreak: 'break-all' }}>{entry.entity_id}</small></td><td style={{ padding: '0.75rem', borderBottom: '1px solid var(--border-color)', maxWidth: 250, wordBreak: 'break-word', fontSize: '0.8rem' }}>{JSON.stringify(entry.details)}</td></tr>)}</tbody></table>{!filtered.length && <p style={{ padding: '1rem', color: 'var(--text-muted)' }}>No matching audit entries.</p>}</div>
  </main>;
}
