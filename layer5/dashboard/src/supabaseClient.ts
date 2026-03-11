import { createClient } from '@supabase/supabase-js';

// Dashboard uses the anon key (public-safe reads).
// ALL queries respect RLS — customer admins only see their own data.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
