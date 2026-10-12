-- ---------------------------------------------------------------------------
-- 0035 - list keyset indexes for kasuwa_app under FORCE RLS
-- (T-0084, Agent 3; D-P33, D-L112, D-L68, D-L80, D-L65, ADR-0014).
--
-- The contacts, leads and accounts lists page by keyset: ORDER BY <key>, id
-- in one direction, seeking with `(<key>, id) < | > (cursor row)`. Before this
-- file every non-default order was sorted in memory over the whole scope, and
-- a session reaching two programmes (a BPO supervisor, the common case) was
-- sorted under every order: 0001's and 0026's indexes are led by
-- (tenant_id, programme_id), and Postgres 16 cannot take one order from them
-- across `programme_id = ANY(...)`.
--
-- This file adds nine plain-column B-tree indexes matching the repositories'
-- ORDER BY exactly (packages/domain/core/src/contact/contact.repository.ts and
-- account/account.repository.ts, SORT_SPECS; the scope predicate is
-- list-scope.ts). A B-tree is read in either direction, so one index serves a
-- sort and its reverse.
--
-- TENANT-LED, for a session reaching several programmes (`programme_id =
-- ANY($p)`, filtered while the index gives the order):
--   contact (tenant_id, created_at, id)                 -createdAt, createdAt
--   contact (tenant_id, updated_at, id)                 -updatedAt, updatedAt
--   contact (tenant_id, display_name, id)               displayName, -displayName
--   account (tenant_id, created_at, id)                 -createdAt, createdAt
--   account (tenant_id, updated_at, id)                 -updatedAt, updatedAt
--   account (tenant_id, name, id)                       name, -name
-- PROGRAMME-LED, for a session reaching exactly one programme, which the
-- repositories send as scalar `programme_id = $p` (migration review M1): with
-- equality on both leading columns PG16 takes the order from the index and
-- reads only that programme's rows:
--   contact (tenant_id, programme_id, updated_at, id)   new here
--   contact (tenant_id, programme_id, display_name, id) new here
--   account (tenant_id, programme_id, updated_at, id)   new here
--   contact_keyset_idx      (tenant_id, programme_id, created_at DESC, id DESC), 0001
--   account_keyset_idx      (tenant_id, programme_id, created_at DESC, id DESC), 0019
--   account_name_keyset_idx (tenant_id, programme_id, name, id), 0026
-- The last three already exist and are kept and used (review M2).
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
-- is changed. No index is dropped.
--
-- ---------------------------------------------------------------------------
-- WHAT A PAGE READS (rows of the index examined per page of `limit`)
-- ---------------------------------------------------------------------------
--   - One-programme session: about limit + 1, from the programme-led index,
--     whatever the programme's share of the tenant.
--   - Session reaching several programmes: the tenant-led index, filtered on
--     programme. About (limit + 1) / share, where `share` is the fraction of
--     the tenant's rows the session reaches: a supervisor reaching every
--     programme reads limit + 1; one reaching half reads about twice that; one
--     reaching two small programmes of a large tenant reads many more. That
--     skewed multi-programme case is what a per-programme MergeAppend (one
--     ordered scan of the programme-led index per programme, merged) would
--     fix. It is a later item, only if measured.
--   - The list-indexes acceptance suite pins the 50/50 case for an agent (one
--     programme) and a supervisor (two).
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT AND COST (D-L65)
-- ---------------------------------------------------------------------------
--   - Each CREATE INDEX takes SHARE on its table until COMMIT, which blocks
--     writes to contact and account (not reads) while the nine indexes build,
--     a scan of every row per index. Accepted inside one transaction because
--     no populated cell exists (D-L65).
--   - On a populated cell, build the indexes first in a SEPARATE migration
--     file that sorts before this one,
--         packages/db/migrations/0034a_list_keyset_indexes_concurrently.sql
--     whose first line is exactly `-- kasuwa:no-transaction` (the runner's
--     non-transactional mode, T-0044; it admits only CONCURRENTLY index
--     statements and VALIDATE CONSTRAINT, so no SET), holding only:
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_tenant_created_keyset_idx
--           ON contact (tenant_id, created_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_tenant_updated_keyset_idx
--           ON contact (tenant_id, updated_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_tenant_display_name_keyset_idx
--           ON contact (tenant_id, display_name, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_programme_updated_keyset_idx
--           ON contact (tenant_id, programme_id, updated_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_programme_display_name_keyset_idx
--           ON contact (tenant_id, programme_id, display_name, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_tenant_created_keyset_idx
--           ON account (tenant_id, created_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_tenant_updated_keyset_idx
--           ON account (tenant_id, updated_at, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_tenant_name_keyset_idx
--           ON account (tenant_id, name, id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_programme_updated_keyset_idx
--           ON account (tenant_id, programme_id, updated_at, id);
--     ('0034a_' sorts after '0034_' and before '0035_'.) This file's
--     statements are already CREATE INDEX IF NOT EXISTS, so it then only runs
--     the self-check. A failed concurrent build leaves an INVALID index: DROP
--     INDEX CONCURRENTLY it and run the file again. The self-check refuses an
--     invalid index.
--   - lock_timeout = 5s: fail fast instead of queueing behind a long
--     transaction.
-- Steady-state cost: five more B-tree entries per contact write and four per
-- account write.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS contact_tenant_created_keyset_idx
  ON contact (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS contact_tenant_updated_keyset_idx
  ON contact (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS contact_tenant_display_name_keyset_idx
  ON contact (tenant_id, display_name, id);
CREATE INDEX IF NOT EXISTS contact_programme_updated_keyset_idx
  ON contact (tenant_id, programme_id, updated_at, id);
CREATE INDEX IF NOT EXISTS contact_programme_display_name_keyset_idx
  ON contact (tenant_id, programme_id, display_name, id);

CREATE INDEX IF NOT EXISTS account_tenant_created_keyset_idx
  ON account (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS account_tenant_updated_keyset_idx
  ON account (tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS account_tenant_name_keyset_idx
  ON account (tenant_id, name, id);
CREATE INDEX IF NOT EXISTS account_programme_updated_keyset_idx
  ON account (tenant_id, programme_id, updated_at, id);

-- ---------------------------------------------------------------------------
-- Self-check. It reads the catalogue and raises; it changes nothing.
--   1. Each index exists on its table with exactly its key columns, in order,
--      and is a valid, ready, non-partial, expression-free B-tree, so a
--      same-named index built some other way (the IF NOT EXISTS above would
--      keep it) fails here. Per key column, it also compares:
--        - indcollation: the database default collation for a collatable
--          column (display_name, name), none for the others, so a
--          same-named index with another collation, which the queries'
--          ORDER BY could not use, fails;
--        - indoption: 0, ascending with NULLS LAST, as written above.
--   2. Every operator each key column's operator family serves for its type
--      (<, <=, =, >=, >) is implemented by a function whose proleakproof is
--      true, so kasuwa_app can use the index under FORCE RLS (D-P33).
--      SAME-TYPE OPERATORS ONLY (amoplefttype = amoprighttype = the opclass
--      input type). Cross-type members of the family (timestamptz against
--      date or timestamp, for example) are not checked: the list queries
--      compare each column with a value of its own type (the cursor row's own
--      column), so those are the only operators the seek uses.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ARRAY['contact_tenant_created_keyset_idx', 'contact',
          'tenant_id:-:0,created_at:-:0,id:-:0'],
    ARRAY['contact_tenant_updated_keyset_idx', 'contact',
          'tenant_id:-:0,updated_at:-:0,id:-:0'],
    ARRAY['contact_tenant_display_name_keyset_idx', 'contact',
          'tenant_id:-:0,display_name:default:0,id:-:0'],
    ARRAY['contact_programme_updated_keyset_idx', 'contact',
          'tenant_id:-:0,programme_id:-:0,updated_at:-:0,id:-:0'],
    ARRAY['contact_programme_display_name_keyset_idx', 'contact',
          'tenant_id:-:0,programme_id:-:0,display_name:default:0,id:-:0'],
    ARRAY['account_tenant_created_keyset_idx', 'account',
          'tenant_id:-:0,created_at:-:0,id:-:0'],
    ARRAY['account_tenant_updated_keyset_idx', 'account',
          'tenant_id:-:0,updated_at:-:0,id:-:0'],
    ARRAY['account_tenant_name_keyset_idx', 'account',
          'tenant_id:-:0,name:default:0,id:-:0'],
    ARRAY['account_programme_updated_keyset_idx', 'account',
          'tenant_id:-:0,programme_id:-:0,updated_at:-:0,id:-:0']
  ];
  entry int;
  found_columns text;
  leaky text;
BEGIN
  FOR entry IN 1 .. array_length(expected, 1) LOOP
    -- One `column:collation:option` per key column, in key order; `-` is no
    -- collation (a non-collatable type).
    SELECT string_agg(a.attname || ':' || coalesce(coll.collname, '-') || ':' || k.key_option,
                      ',' ORDER BY k.ord)
      INTO found_columns
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      JOIN pg_am am ON am.oid = ic.relam
      CROSS JOIN LATERAL (
        SELECT kk.attnum, kk.ord, kc.coll_oid, ko.key_option
          FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS kk(attnum, ord)
          JOIN unnest(i.indcollation::oid[]) WITH ORDINALITY AS kc(coll_oid, ord)
            ON kc.ord = kk.ord
          JOIN unnest(i.indoption::int2[]) WITH ORDINALITY AS ko(key_option, ord)
            ON ko.ord = kk.ord
      ) AS k
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      LEFT JOIN pg_collation coll ON coll.oid = k.coll_oid
     WHERE n.nspname = 'public'
       AND ic.relname = expected[entry][1]
       AND i.indrelid = format('public.%I', expected[entry][2])::regclass
       AND am.amname = 'btree'
       AND i.indisvalid
       AND i.indisready
       AND i.indexprs IS NULL
       AND i.indpred IS NULL
       AND i.indnkeyatts = i.indnatts;
    IF found_columns IS DISTINCT FROM expected[entry][3] THEN
      RAISE EXCEPTION '0035: index % on % is missing, invalid, partial, an expression index, not a B-tree, or not exactly (%) (column:collation:option); found (%)',
        expected[entry][1], expected[entry][2], expected[entry][3], coalesce(found_columns, 'nothing');
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
