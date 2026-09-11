import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// This module must remain server-only. Never fall back to the public anon key:
// a missing service key should fail closed instead of weakening server access.
if (typeof window !== 'undefined') throw new Error('The service-role Supabase client cannot be used in browser code');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) throw new Error('Server Supabase credentials are not configured');

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
