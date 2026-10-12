-- ---------------------------------------------------------------------------
-- 0035 - list keyset indexes for kasuwa_app under FORCE RLS
-- (T-0084, Agent 3; D-P33, D-L112, D-L68, D-L80, D-L65, ADR-0014).
--
-- The contacts, leads and accounts lists page by keyset: ORDER BY <key>, id
-- in one direction, seeking with `(<key>, id) < | > (cursor row)`. Before this
-- file every non-default order was sorted in memory over the whole scope, and
-- a session reaching two programmes (a BPO supervisor, the common case) was
-- sorted under every order: 0001's and 0026's indexes are led by
-- (tenant_id, programme_id), which cannot give one order across two
-- programmes.
--
-- This file adds six plain-column B-tree indexes, one per list order, each
-- led by tenant_id alone and matching the repositories' ORDER BY exactly
-- (packages/domain/core/src/contact/contact.repository.ts and
-- account/account.repository.ts, SORT_SPECS). A B-tree is read in either
-- direction, so one index serves a sort and its reverse:
--   contact (tenant_id, created_at, id)     -createdAt, createdAt
--   contact (tenant_id, updated_at, id)     -updatedAt, updatedAt
--   contact (tenant_id, display_name, id)   displayName, -displayName
--   account (tenant_id, created_at, id)     -createdAt, createdAt
--   account (tenant_id, updated_at, id)     -updatedAt, updatedAt
--   account (tenant_id, name, id)           name, -name
-- The leads list is a status view of contact (status = ANY(...)), so the
-- contact indexes serve it too.
--
-- WHY PLAIN COLUMNS ONLY (D-P33). Under FORCE RLS, Postgres uses a predicate
-- as an index condition ahead of the policy quals only when every function
-- in it is LEAKPROOF. The B-tree operators of uuid, timestamptz and text are;
-- lower(), left(), normalize(), the trigram operators and the jsonb
-- containment operators are not. So:
--   - no expression index: the contacts name sort is now display_name itself,
--     not left(display_name, 200), whose keyset predicate could never be an
--     index condition (D-L112 ruling 8);
--   - no GIN, GiST or trigram index and no extension: search text (`q`) keeps
--     today's behaviour, and its speed waits for the LEAKPROOF review and its
--     ADR (D-P33's second step).
-- This file never marks anything LEAKPROOF. Marking a builtin is a superuser
-- act that needs a review of each function. The self-check below only READS
-- pg_proc.proleakproof and fails the migration if an operator these indexes
-- serve is not leak-proof.
--
-- No table, column, policy, grant or function is created or changed. No data
-- is changed. The older programme-led indexes (contact_keyset_idx,
-- account_keyset_idx, account_name_keyset_idx) are left alone: none is a
-- prefix of a new one, and dropping them is a contract step of its own.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT AND COST (D-L65)
-- ---------------------------------------------------------------------------
--   - Each CREATE INDEX takes SHARE on its table until COMMIT, which blocks
--     writes to contact and account (not reads) while the six indexes build,
--     a scan of every row per index. Accepted inside one transaction because
--     no populated cell exists (D-L65).
--   - On a populated cell, build the indexes first in a SEPARATE migration
--     file ordered before this one, whose first line is exactly
--     `-- kasuwa:no-transaction` (the runner's non-transactional mode, T-0044;
--     it admits only CONCURRENTLY index statements and VALIDATE CONSTRAINT),
--     holding only:
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_tenant_created_keyset_idx
--           ON contact (tenant_id, created_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_tenant_updated_keyset_idx
--           ON contact (tenant_id, updated_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_tenant_display_name_keyset_idx
--           ON contact (tenant_id, display_name, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_tenant_created_keyset_idx
--           ON account (tenant_id, created_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_tenant_updated_keyset_idx
--           ON account (tenant_id, updated_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_tenant_name_keyset_idx
--           ON account (tenant_id, name, id);
--     and this file's statements stay CREATE INDEX IF NOT EXISTS (they
--     already are), so that it only runs the self-check. A failed concurrent
--     build leaves an INVALID index: DROP INDEX CONCURRENTLY it and run the
--     file again. The self-check refuses an invalid index.
--   - lock_timeout = 5s: fail fast instead of queueing behind a long
--     transaction.
-- Steady-state cost: three more B-tree entries per contact write and three
-- per account write. Pages read at most limit + 1 rows of the index for a
-- one-programme session, and about twice that for a session reaching half of
-- a tenant's programmes; the list-indexes acceptance suite pins it.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS contact_tenant_created_keyset_idx
  ON contact (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS contact_tenant_updated_keyset_idx
  ON contact (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS contact_tenant_display_name_keyset_idx
  ON contact (tenant_id, display_name, id);

CREATE INDEX IF NOT EXISTS account_tenant_created_keyset_idx
  ON account (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS account_tenant_updated_keyset_idx
  ON account (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS account_tenant_name_keyset_idx
  ON account (tenant_id, name, id);

-- ---------------------------------------------------------------------------
-- Self-check. It reads the catalogue and raises; it changes nothing.
--   1. Each index exists on its table with exactly its columns, in order, and
--      is a valid, ready, non-partial, expression-free B-tree.
--   2. Every operator each key column's operator family serves for its type
--      (<, <=, =, >=, >) is implemented by a function whose proleakproof is
--      true, so kasuwa_app can use the index under FORCE RLS (D-P33).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ARRAY['contact_tenant_created_keyset_idx', 'contact', 'tenant_id,created_at,id'],
    ARRAY['contact_tenant_updated_keyset_idx', 'contact', 'tenant_id,updated_at,id'],
    ARRAY['contact_tenant_display_name_keyset_idx', 'contact', 'tenant_id,display_name,id'],
    ARRAY['account_tenant_created_keyset_idx', 'account', 'tenant_id,created_at,id'],
    ARRAY['account_tenant_updated_keyset_idx', 'account', 'tenant_id,updated_at,id'],
    ARRAY['account_tenant_name_keyset_idx', 'account', 'tenant_id,name,id']
  ];
  entry int;
  found_columns text;
  leaky text;
BEGIN
  FOR entry IN 1 .. array_length(expected, 1) LOOP
    SELECT string_agg(a.attname, ',' ORDER BY k.ord)
      INTO found_columns
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      JOIN pg_am am ON am.oid = ic.relam
      CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE n.nspname = 'public'
       AND ic.relname = expected[entry][1]
       AND i.indrelid = format('public.%I', expected[entry][2])::regclass
       AND am.amname = 'btree'
       AND i.indisvalid
       AND i.indisready
       AND i.indexprs IS NULL
       AND i.indpred IS NULL;
    IF found_columns IS DISTINCT FROM expected[entry][3] THEN
      RAISE EXCEPTION '0035: index % on % is missing, invalid, partial, an expression index, not a B-tree, or not on (%)',
        expected[entry][1], expected[entry][2], expected[entry][3];
    END IF;
  END LOOP;

  SELECT string_agg(DISTINCT ic.relname || ': ' || o.oprname || ' (' ||
                    format_type(oc.opcintype, NULL) || ') -> ' || p.proname, '; ')
    INTO leaky
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    CROSS JOIN LATERAL unnest(i.indclass::oid[]) AS k(opclass)
    JOIN pg_opclass oc ON oc.oid = k.opclass
    JOIN pg_amop ao ON ao.amopfamily = oc.opcfamily
                   AND ao.amoplefttype = oc.opcintype
                   AND ao.amoprighttype = oc.opcintype
    JOIN pg_operator o ON o.oid = ao.amopopr
    JOIN pg_proc p ON p.oid = o.oprcode
   WHERE n.nspname = 'public'
     AND ic.relname IN (SELECT expected[e][1] FROM generate_subscripts(expected, 1) AS e)
     AND NOT p.proleakproof;
  IF leaky IS NOT NULL THEN
    RAISE EXCEPTION '0035: kasuwa_app could not use these indexes under FORCE RLS; proleakproof is false for %', leaky;
  END IF;
END
$$;
