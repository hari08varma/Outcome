import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: './.env' }); // layer5/dashboard/.env might not have variables, might be in layer5/api/.env

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://tnyfssapntxlywrypldd.supabase.co'; // wait I dont know the URL. I will check the .env
