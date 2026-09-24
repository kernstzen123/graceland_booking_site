'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import {
  AlertIcon, CalendarIcon, ChartIcon, CloseIcon, DashboardIcon, GiftIcon, LogoutIcon, MailWarningIcon, MenuIcon,
  MoreIcon, ReceiptIcon, ScanIcon, SearchIcon, ShieldIcon, TagIcon, TicketIcon, UsersIcon,
} from './AdminIcons';

type Role = 'ADMIN' | 'MANAGER' | 'SCANNER';
type BadgeKey = 'pendingProofs' | 'conflicts' | 'failedEmails';
type NavItem = { href: string; label: string; icon: ComponentType<{ size?: number }>; roles?: Role[]; badge?: BadgeKey; badgeTone?: 'warning' | 'danger' };
type NavSection = { title: string; items: NavItem[] };

const MANAGEMENT: Role[] = ['ADMIN', 'MANAGER'];

/** The whole staff portal menu. Each item lists the roles that may see it (all roles if omitted). */
const NAV: NavSection[] = [
  { title: '', items: [{ href: '/admin', label: 'Dashboard', icon: DashboardIcon, roles: MANAGEMENT }] },
  { title: 'Gate', items: [
    { href: '/admin/scanner', label: 'Ticket scanner', icon: ScanIcon },
    { href: '/admin/walk-ins', label: 'Walk-in sales', icon: TicketIcon },
  ] },
  { title: 'Bookings', items: [
    { href: '/admin/bookings', label: 'All bookings', icon: CalendarIcon, roles: MANAGEMENT },
    { href: '/admin/proofs', label: 'Proofs of payment', icon: ReceiptIcon, roles: MANAGEMENT, badge: 'pendingProofs', badgeTone: 'warning' },
    { href: '/admin/conflicts', label: 'Check-in alerts', icon: AlertIcon, roles: MANAGEMENT, badge: 'conflicts', badgeTone: 'danger' },
    { href: '/admin/vouchers', label: 'Vouchers', icon: GiftIcon, roles: MANAGEMENT },
  ] },
  { title: 'Insights', items: [
    { href: '/admin/reports', label: 'Reports', icon: ChartIcon, roles: MANAGEMENT },
  ] },
  { title: 'Settings', items: [
    { href: '/admin/settings', label: 'Prices & dates', icon: TagIcon, roles: MANAGEMENT },
    { href: '/admin/staff', label: 'Staff', icon: UsersIcon, roles: ['ADMIN'] },
    { href: '/admin/notifications', label: 'Email retries', icon: MailWarningIcon, roles: MANAGEMENT, badge: 'failedEmails', badgeTone: 'danger' },
    { href: '/admin/audit', label: 'Audit log', icon: ShieldIcon, roles: MANAGEMENT },
  ] },
];

/** The phone bottom bar: the most-used pages for each role, plus "More" for the full menu. */
const TABS: Record<Role, string[]> = {
  ADMIN: ['/admin', '/admin/bookings', '/admin/walk-ins', '/admin/scanner'],
  MANAGER: ['/admin', '/admin/bookings', '/admin/walk-ins', '/admin/scanner'],
  SCANNER: ['/admin/scanner', '/admin/walk-ins'],
};

const ROLE_NAMES: Record<Role, string> = { ADMIN: 'Admin', MANAGER: 'Manager', SCANNER: 'Gate staff' };
const COUNTS_REFRESH_MS = 60_000;

const isActive = (pathname: string, href: string) => (href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(`${href}/`));

export function AdminShell({ role, email, offlineMode, onSignOut, children }: { role: Role; email: string; offlineMode: boolean; onSignOut: () => void; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<BadgeKey, number>>>({});
  const [search, setSearch] = useState('');

  const sections = NAV.map(section => ({ ...section, items: section.items.filter(item => !item.roles || item.roles.includes(role)) })).filter(section => section.items.length);
  const allItems = sections.flatMap(section => section.items);
  const current = allItems.find(item => isActive(pathname, item.href));
  const tabs = TABS[role].map(href => allItems.find(item => item.href === href)).filter((item): item is NavItem => Boolean(item));
  const canManage = role !== 'SCANNER';

  const loadCounts = useCallback(async () => {
    if (!canManage || offlineMode) return;
    try {
      const token = (await supabaseBrowser.auth.getSession()).data.session?.access_token;
      if (!token) return;
      const response = await fetch('/api/admin/nav-counts', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (response.ok) setCounts(await response.json());
    } catch { /* badges are a convenience; ignore network errors */ }
  }, [canManage, offlineMode]);

  // Refresh the badges on each page change and every minute.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState happens after the request
    loadCounts();
    const timer = window.setInterval(loadCounts, COUNTS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadCounts, pathname]);

  // Close the phone menu after navigating, and with Escape.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- closing the drawer is a response to the route change
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const findBooking = (event: FormEvent) => {
    event.preventDefault();
    const query = search.trim();
    if (!query) return;
    router.push(`/admin/bookings?q=${encodeURIComponent(query)}`);
    setSearch('');
  };

  const badgeFor = (item: NavItem) => {
    const value = item.badge ? counts[item.badge] || 0 : 0;
    return value > 0 ? <span className={`admin-badge ${item.badgeTone || 'warning'}`} aria-label={`${value} waiting`}>{value > 99 ? '99+' : value}</span> : null;
  };

  const navigation = <nav aria-label="Staff portal">
    {canManage && <form className="admin-search" onSubmit={findBooking} role="search">
      <SearchIcon size={16} />
      <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find booking or ticket" aria-label="Find a booking by reference, name, email or ticket" />
    </form>}
    {sections.map(section => <div key={section.title || 'main'} className="admin-nav-section">
      {section.title && <p className="admin-nav-heading">{section.title}</p>}
      {section.items.map(item => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        return <Link key={item.href} href={item.href} className={`admin-nav-link${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
          <Icon size={18} /><span>{item.label}</span>{badgeFor(item)}
        </Link>;
      })}
    </div>)}
  </nav>;

  const account = <div className="admin-account">
    <div style={{ minWidth: 0 }}>
      <p className="admin-account-email" title={email}>{email || 'Signed in'}</p>
      <p className="admin-account-role">{ROLE_NAMES[role]}</p>
    </div>
    <button type="button" className="admin-icon-button" onClick={onSignOut} aria-label="Log out" title="Log out"><LogoutIcon size={18} /></button>
  </div>;

  const totalWaiting = (counts.pendingProofs || 0) + (counts.conflicts || 0) + (counts.failedEmails || 0);

  return <div className="admin-shell">
    {/* Desktop sidebar */}
    <aside className="admin-sidebar no-print">
      <Link href={canManage ? '/admin' : '/admin/scanner'} className="admin-brand"><span className="admin-brand-mark">G</span><span>Graceland<small>Staff portal</small></span></Link>
      <div className="admin-sidebar-scroll">{navigation}</div>
      {account}
    </aside>

    {/* Phone / tablet top bar */}
    <header className="admin-topbar no-print">
      <button type="button" className="admin-icon-button" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen}>
        <MenuIcon />{totalWaiting > 0 && <span className="admin-dot" aria-hidden="true" />}
      </button>
      <p className="admin-topbar-title">{current?.label || 'Staff portal'}</p>
      <span style={{ width: 40 }} />
    </header>

    {menuOpen && <div className="admin-drawer-overlay no-print" onClick={() => setMenuOpen(false)}>
      <div className="admin-drawer" role="dialog" aria-modal="true" aria-label="Menu" onClick={event => event.stopPropagation()}>
        <div className="admin-drawer-header">
          <span className="admin-brand"><span className="admin-brand-mark">G</span><span>Graceland<small>Staff portal</small></span></span>
          <button type="button" className="admin-icon-button" onClick={() => setMenuOpen(false)} aria-label="Close menu"><CloseIcon /></button>
        </div>
        <div className="admin-sidebar-scroll">{navigation}</div>
        {account}
      </div>
    </div>}

    <div className="admin-main">
      {offlineMode && <div className="admin-offline-banner">⚡ Offline mode — using cached credentials</div>}
      <div className="admin-content-pad">{children}</div>
    </div>

    {/* Phone bottom tabs */}
    <nav className="admin-tabbar no-print" aria-label="Quick navigation">
      {tabs.map(item => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        return <Link key={item.href} href={item.href} className={`admin-tab${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
          <Icon size={22} /><span>{item.label.replace('Ticket scanner', 'Scanner').replace('All bookings', 'Bookings').replace('Walk-in sales', 'Walk-ins')}</span>
        </Link>;
      })}
      <button type="button" className="admin-tab" onClick={() => setMenuOpen(true)}>
        <MoreIcon size={22} /><span>More</span>{totalWaiting > 0 && <span className="admin-dot" aria-hidden="true" />}
      </button>
    </nav>
  </div>;
}

/** Consistent page title block. `actions` holds the page's own buttons (not navigation). */
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return <div className="admin-page-header">
    <div style={{ minWidth: 0 }}>
      {eyebrow && <p className="admin-eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p className="admin-page-description">{description}</p>}
    </div>
    {actions && <div className="admin-page-actions">{actions}</div>}
  </div>;
}
