DO $$ 
DECLARE
  u RECORD;
  new_customer_id UUID;
BEGIN
  FOR u IN 
    SELECT id, email, raw_user_meta_data 
    FROM auth.users 
    WHERE id NOT IN (SELECT id FROM public.user_profiles)
  LOOP
    -- Insert fallback dim_customer
    INSERT INTO public.dim_customers (
      company_name, tier, api_key_hash, created_at
    ) VALUES (
      COALESCE(u.email, 'unknown'),
      'starter',
      encode(extensions.gen_random_bytes(32), 'hex'),
      NOW()
    )
    RETURNING customer_id INTO new_customer_id;

    -- Insert user_profile
    INSERT INTO public.user_profiles (id, customer_id, role, access_status, created_at)
    VALUES (u.id, new_customer_id, 'admin', 'pending', NOW())
    ON CONFLICT DO NOTHING;

    -- Insert dim_agent
    INSERT INTO public.dim_agents (
      agent_name, agent_type, customer_id, is_active, created_at
    ) VALUES (
      'default-agent', 'api-key', new_customer_id, true, NOW()
    )
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
