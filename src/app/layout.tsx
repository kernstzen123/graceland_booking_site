import './globals.css'
import type { Metadata, Viewport } from 'next'
import { Analytics } from "@vercel/analytics/next"
import { SpeedInsights } from "@vercel/speed-insights/next"

export const metadata: Metadata = {
  title: 'Graceland Venues Booking',
  description: 'Book your tickets and packages at Graceland Venues',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Graceland Scanner',
  },
}

export const viewport: Viewport = {
  themeColor: '#0EA5E9',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/scanner-icon-192.png" />
      </head>
      <body suppressHydrationWarning>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').catch(function(err) {
                    console.warn('SW registration failed:', err);
                  });
                });
              }
            `,
          }}
        />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}
