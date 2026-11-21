-- ============================================================================
-- Migration Phase 2 (Hardened, Non-Destructive RLS Lockdown):
-- Lock direct table access on public.quiz_submissions
-- File: supabase/migration_quiz_submissions_rls_lock.sql
--
-- MANDATORY PREREQUISITES (DO NOT EXECUTE BEFORE COMPLETING ALL 3):
--   1. Phase 1 (supabase/migration_quiz_submissions_rpcs.sql) has been applied.
--   2. Updated frontend (Netlify) and Cloudflare Worker are LIVE in production.
--   3. Live end-to-end functional verification of BOTH student and teacher
--      exam workflows has already passed on the deployed site.
--
-- IMPORTANT NOTE:
--   The pre-flight assertions below verify structural database prerequisites
--   (RPC existence, exact signatures, SECURITY DEFINER, fixed search_path,
--   owner privilege, and EXECUTE grants). Passing these structural checks does
--   NOT by itself prove live application compatibility — live smoke testing
--   must still be performed before AND after running Phase 2.
--
-- NON-DESTRUCTIVE GUARANTEES:
--   - Does NOT delete, truncate, reset, or modify any rows in quiz_submissions.
--   - Preserves table owner (e.g. postgres) and service_role administrative
--     privileges (uses ENABLE ROW LEVEL SECURITY without FORCE).
--   - Runs inside an atomic transaction (BEGIN ... COMMIT): any failed check
--     rolls back completely with zero partial state changes.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Pre-flight verification of all 4 required RPCs:
--    - Exact signature existence
--    - SECURITY DEFINER enabled (prosecdef = true)
--    - Fixed search_path configured (proconfig contains search_path=...)
--    - Function owner is privileged (table owner, superuser, or BYPASSRLS)
--    - PUBLIC does NOT have EXECUTE
--    - Required roles (anon, authenticated, service_role) DO have EXECUTE
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_required_sigs CONSTANT text[] := ARRAY[
    'public.teacher_list_quiz_submissions(text)',
    'public.teacher_upsert_quiz_submission(text,uuid,uuid,jsonb,numeric)',
    'public.student_list_my_quiz_submissions(uuid,text,uuid)',
    'public.student_upsert_quiz_submission(uuid,text,uuid,jsonb,numeric,timestamptz)'
  ];
  v_sig text;
  v_oid oid;
  v_proc record;
  v_table_owner oid;
  v_has_public_exec boolean;
  v_role text;
BEGIN
  SELECT c.relowner
  INTO v_table_owner
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'quiz_submissions'
    AND c.relkind = 'r';

  IF v_table_owner IS NULL THEN
    RAISE EXCEPTION 'ABORTED: Table public.quiz_submissions does not exist.';
  END IF;

  FOREACH v_sig IN ARRAY v_required_sigs
  LOOP
    v_oid := pg_catalog.to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'ABORTED: Required RPC % is missing. Run Phase 1 (migration_quiz_submissions_rpcs.sql) first.', v_sig;
    END IF;

    SELECT
      p.prosecdef,
      p.proowner,
      p.proconfig,
      p.proacl,
      r.rolname AS owner_name,
      r.rolsuper AS owner_is_super,
      r.rolbypassrls AS owner_bypassrls
    INTO v_proc
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_oid;

    IF NOT COALESCE(v_proc.prosecdef, false) THEN
      RAISE EXCEPTION 'ABORTED: Required RPC % is NOT configured as SECURITY DEFINER.', v_sig;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(COALESCE(v_proc.proconfig, ARRAY[]::text[])) AS cfg
      WHERE cfg LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION 'ABORTED: Required RPC % does NOT have a fixed search_path.', v_sig;
    END IF;

    IF NOT (v_proc.proowner = v_table_owner OR v_proc.owner_is_super OR v_proc.owner_bypassrls) THEN
      RAISE EXCEPTION 'ABORTED: Required RPC % owner (%) cannot bypass RLS on public.quiz_submissions.', v_sig, v_proc.owner_name;
    END IF;

    -- Verify default PUBLIC EXECUTE privilege has been revoked
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(v_proc.proacl, pg_catalog.acldefault('f', v_proc.proowner))
      ) AS acl
      WHERE acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    ) INTO v_has_public_exec;

    IF v_has_public_exec THEN
      RAISE EXCEPTION 'ABORTED: Required RPC % still grants EXECUTE to PUBLIC. Re-run hardened Phase 1 first.', v_sig;
    END IF;

    -- Verify required roles have EXECUTE (checked for each role that exists in pg_roles)
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
        IF NOT pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE') THEN
          RAISE EXCEPTION 'ABORTED: Role "%" is missing EXECUTE privilege on %.', v_role, v_sig;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Pre-flight passed: all 4 hardened SECURITY DEFINER RPCs verified.';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Audit existing table grants (including PUBLIC) before revoking
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_grant record;
BEGIN
  FOR v_grant IN
    SELECT
      COALESCE(r.rolname, 'PUBLIC') AS grantee_name,
      acl.privilege_type
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
    ) AS acl
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public'
      AND c.relname = 'quiz_submissions'
      AND (acl.grantee = 0 OR r.rolname IN ('anon', 'authenticated'))
    ORDER BY grantee_name, acl.privilege_type
  LOOP
    RAISE NOTICE 'Auditing table privilege to be revoked on public.quiz_submissions: grantee=%, privilege=%',
      v_grant.grantee_name, v_grant.privilege_type;
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Enable Row Level Security (WITHOUT FORCE so postgres/service_role remain intact)
-- ----------------------------------------------------------------------------
ALTER TABLE public.quiz_submissions ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 4. Document and drop all legacy permissive RLS policies on public.quiz_submissions
--    WHY: Any pre-existing SELECT/INSERT/UPDATE/DELETE/ALL policy targeting
--    PUBLIC, anon, or authenticated would allow direct PostgREST access that
--    bypasses server-side student access_code verification, JSON allowlist
--    filtering, server timestamp enforcement, and teacher password checks.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT
      p.policyname,
      p.permissive,
      p.cmd,
      p.roles
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'quiz_submissions'
    ORDER BY p.policyname
  LOOP
    RAISE NOTICE 'Dropping legacy RLS policy "%" (permissive=%, cmd=%, roles=%) on public.quiz_submissions so all client access is enforced exclusively via authenticated RPCs.',
      v_policy.policyname, v_policy.permissive, v_policy.cmd, v_policy.roles;
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS %I ON public.quiz_submissions;', v_policy.policyname);
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Revoke direct table privileges from PUBLIC, anon, and authenticated;
--    explicitly preserve service_role administrative access.
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.quiz_submissions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.quiz_submissions FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.quiz_submissions FROM authenticated;
  END IF;

  -- Preserve administrative access for service_role (standard Supabase backend role)
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quiz_submissions TO service_role;
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Post-lock self-verification assertions (rolls back entire transaction if any fail)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_rls_enabled boolean := false;
  v_rls_forced boolean := false;
  v_remaining_policies bigint := 0;
  v_public_table_privs boolean := false;
  v_role text;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity
  INTO v_rls_enabled, v_rls_forced
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'quiz_submissions';

  IF NOT v_rls_enabled THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: RLS is not enabled on public.quiz_submissions.';
  END IF;

  IF v_rls_forced THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: FORCE ROW LEVEL SECURITY must not be enabled (would break table owner / admin operations).';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_remaining_policies
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'quiz_submissions';

  IF v_remaining_policies <> 0 THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: % policy/policies still remain on public.quiz_submissions.', v_remaining_policies;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
    ) AS acl
    WHERE n.nspname = 'public'
      AND c.relname = 'quiz_submissions'
      AND acl.grantee = 0
  ) INTO v_public_table_privs;

  IF v_public_table_privs THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: PUBLIC still holds table privileges on public.quiz_submissions.';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      IF pg_catalog.has_table_privilege(v_role, 'public.quiz_submissions', 'SELECT')
         OR pg_catalog.has_table_privilege(v_role, 'public.quiz_submissions', 'INSERT')
         OR pg_catalog.has_table_privilege(v_role, 'public.quiz_submissions', 'UPDATE')
         OR pg_catalog.has_table_privilege(v_role, 'public.quiz_submissions', 'DELETE')
      THEN
        RAISE EXCEPTION 'POST-CHECK FAILED: Role "%" still has direct table privileges on public.quiz_submissions.', v_role;
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    IF NOT pg_catalog.has_table_privilege('service_role', 'public.quiz_submissions', 'SELECT') THEN
      RAISE EXCEPTION 'POST-CHECK FAILED: service_role lost SELECT privilege on public.quiz_submissions.';
    END IF;
  END IF;

  RAISE NOTICE 'Phase 2 RLS lockdown verified: direct PUBLIC/anon/authenticated table access is blocked; service_role and 4 authenticated RPCs remain operational.';
END;
$$;

COMMIT;
