import { BUSINESS_NAME, DEFAULT_SUPPORT_EMAIL, DEFAULT_SUPPORT_PHONE } from '@/lib/business-details';

/**
 * Public details used for search engines and link previews (page titles,
 * descriptions, sitemap, robots.txt and the structured data Google reads).
 */

/** The public web address, e.g. https://www.gracelandvenuespaarl.co.za (no trailing slash). */
export const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.gracelandvenuespaarl.co.za').replace(/\/$/, '');

export const SITE_NAME = BUSINESS_NAME;
export const SITE_TITLE = 'Graceland Venues Paarl | Waterpark, Huts & Birthday Parties';
export const SITE_DESCRIPTION = 'Book tickets online for Graceland Venues, a family waterpark and event venue in Paarl, Western Cape. Water slides, pools, covered huts, shaded tables and kids’ birthday parties.';

export const ADDRESS = {
  street: 'Lustigan Road',
  locality: 'Paarl',
  area: 'Southern Paarl',
  region: 'Western Cape',
  postalCode: '7620',
  country: 'ZA',
} as const;

/** +27 international form of the support number, for tel: links and structured data. */
export const SUPPORT_PHONE_INTERNATIONAL = `+27${DEFAULT_SUPPORT_PHONE.replace(/\D/g, '').replace(/^0/, '')}`;

/** schema.org description of the business, for Google's rich results and local search. */
export function businessJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'AmusementPark',
    '@id': `${SITE_URL}/#business`,
    name: SITE_NAME,
    alternateName: 'Graceland Venues Paarl',
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    logo: `${SITE_URL}/icon.jpg`,
    image: `${SITE_URL}/opengraph-image.jpg`,
    telephone: SUPPORT_PHONE_INTERNATIONAL,
    email: DEFAULT_SUPPORT_EMAIL,
    priceRange: 'R',
    currenciesAccepted: 'ZAR',
    paymentAccepted: 'Card, EFT, Cash',
    address: {
      '@type': 'PostalAddress',
      streetAddress: ADDRESS.street,
      addressLocality: ADDRESS.locality,
      addressRegion: ADDRESS.region,
      postalCode: ADDRESS.postalCode,
      addressCountry: ADDRESS.country,
    },
    areaServed: ['Paarl', 'Wellington', 'Stellenbosch', 'Cape Winelands', 'Cape Town'],
    potentialAction: {
      '@type': 'ReserveAction',
      target: SITE_URL,
      name: 'Book tickets online',
    },
  };
}

/** Safe to place inside a <script type="application/ld+json"> tag. */
export function jsonLdScript(data: unknown) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
