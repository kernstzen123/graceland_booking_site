import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { PRIVACY_VERSION, TERMS_VERSION } from '@/lib/legal';

/** sitemap.xml: the public pages Google should list. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/terms-and-conditions`, lastModified: new Date(`${TERMS_VERSION}T00:00:00Z`), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/privacy-policy`, lastModified: new Date(`${PRIVACY_VERSION}T00:00:00Z`), changeFrequency: 'yearly', priority: 0.3 },
  ];
}
