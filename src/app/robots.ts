import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/** robots.txt: public pages may be indexed; the staff portal, API and sign-in links may not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/api/', '/auth/', '/monitoring'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
