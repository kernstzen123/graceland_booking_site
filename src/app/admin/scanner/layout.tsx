import type { Metadata } from 'next';

/** The gate scanner installs as its own app ("Graceland Scanner") on staff phones. */
export const metadata: Metadata = {
  title: 'Ticket scanner',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Graceland Scanner',
  },
  icons: { apple: '/scanner-icon-192.png' },
  robots: { index: false, follow: false },
};

export default function ScannerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
