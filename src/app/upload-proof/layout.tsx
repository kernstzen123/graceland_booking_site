import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Upload proof of payment',
  description: 'Upload your EFT proof of payment for your Graceland Venues booking.',
  alternates: { canonical: '/upload-proof' },
  // A customer utility page, not something to show in search results.
  robots: { index: false, follow: true },
};

export default function UploadProofLayout({ children }: { children: React.ReactNode }) {
  return children;
}
