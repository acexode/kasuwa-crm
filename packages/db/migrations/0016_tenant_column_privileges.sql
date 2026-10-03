-- 0016 - the application role may no longer change a tenant's region, slug,
--        status or identity (T-0015; D-P2, D-L54).
--
-- tenant.region_cell is where the tenant's data lives, set once by the
-- operator. kasuwa_app held table-level UPDATE on tenant and tenant_isolation
-- admits any write to the session's own tenant row, so any code under a tenant
-- session could move the recorded region. RLS answers "which rows", not
-- "which columns"; a column privilege is the tool.
--
-- Re-granted: name, locale_default, currency_default (tenant settings),
-- role_hierarchy_version (roles.service.ts bumps it; its SELECT ... FOR NO KEY
-- UPDATE needs UPDATE on at least one column), updated_at.
-- Not granted: region_cell (residency), slug (public, permanent), status
-- (commercial state), id, created_at. FAIL CLOSED: a future tenant column is
-- not app-writable until a migration grants it.

SET LOCAL lock_timeout = '5s';

REVOKE UPDATE ON tenant FROM kasuwa_app;
GRANT UPDATE (name, locale_default, currency_default, role_hierarchy_version, updated_at)
  ON tenant TO kasuwa_app;

DO $$
BEGIN
  IF has_column_privilege('kasuwa_app', 'public.tenant', 'region_cell', 'UPDATE') THEN
    RAISE EXCEPTION 'kasuwa_app can still UPDATE tenant.region_cell after 0016';
  END IF;
  IF has_column_privilege('kasuwa_app', 'public.tenant', 'slug', 'UPDATE') THEN
    RAISE EXCEPTION 'kasuwa_app can still UPDATE tenant.slug after 0016';
  END IF;
END
$$;
