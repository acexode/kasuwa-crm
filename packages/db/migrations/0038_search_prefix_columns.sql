-- ---------------------------------------------------------------------------
-- 0038 - folded search columns and their prefix indexes (T-0086, Agent 3;
-- ADR-0014, ADR-0015's fallback, D-L128, D-L133, D-P33, D-L65, D-L68).
--
-- Global search (searchRecords, records.openapi.yaml) matches a name when the
-- field's FOLDED value starts with the folded query, as a range on a B-tree:
--
--     <field>_search >= $prefix AND <field>_search < $prefix_upper
--
-- under collation "C" (code-point order). The range uses only text_ge and
-- text_lt, which are leak-proof in the stock catalogue, so under FORCE RLS
-- Postgres can make it the Index Cond of these indexes for kasuwa_app
-- (ADR-0015's fallback; D-L128). Never LIKE: textlike is not leak-proof, and
-- this file marks nothing (that is ADR-0015's main road, not this one).
--
-- EXPAND ONLY. In this one file:
--   1. lock_timeout, and the three tables locked up front in a fixed order;
--   2. six GENERATED ALWAYS ... STORED columns, one per searched field
--      (D-L133: never one combined "search text" column, so each copy is read
--      only where its own source field is readable):
--        contact.display_name_search   contact.given_names_search
--        contact.family_name_search    contact.company_name_search
--        account.name_search           deal.name_search
--   3. one B-tree per folded column, `<table>_<column>_idx`, keyed
--      (tenant_id, programme_id, <column> COLLATE "C", id);
--   4. a self-check of what this file promises.
-- One transaction: a failure anywhere leaves no trace.
--
-- NOT HERE: no table, no function (the fold is written inline in each column,
-- R3: a stored column is never recomputed when a function it calls is
-- replaced, so a helper function could silently desynchronise every copy), no
-- trigger, no policy or row-security change, no grant or revoke, no extension,
-- no GIN/GiST/trigram index, nothing marked LEAKPROOF, no data UPDATE. The
-- SECURITY DEFINER census stays at two (CLAUDE.md 2.7). TENANT_SCOPED_TABLES
-- is unchanged: the three tables keep RLS ENABLED and FORCED and their
-- policies, which cover a new column unchanged.
--
-- ---------------------------------------------------------------------------
-- THE FOLD (records-contract-search R3, the T-0086 suite's R1 and R2)
-- ---------------------------------------------------------------------------
-- The API folds the query with exactly the same steps
-- (packages/domain/core/src/search/search-fold.ts), so both sides agree byte
-- for byte:
--   1. normalize(<source>, NFD)                     Unicode NFD;
--   2. regexp_replace(..., '[<category M>]', '', 'g') every combining mark
--      removed: the bracket is Unicode General Category M (Mn, Mc, Me), all
--      310 ranges of it, generated from Unicode 15.1 (the
--      table JavaScript's /\p{M}/u used when this file was written), so
--      Arabic harakat and Yoruba tone marks go too, not only U+0300-U+036F;
--   3. lower(... COLLATE "und-x-icu")                the locale-independent
--      Unicode default lower-casing (ICU root), so `Ø` becomes `ø` and
--      Cyrillic is lowered; `lower(x COLLATE "C")` lowers ASCII only, and the
--      database's libc locale is an operating-system accident;
--   4. translate(..., <ECMAScript whitespace>, <as many spaces>) then
--      regexp_replace(..., ' {2,}', ' ', 'g')       each run of whitespace one
--      space, where whitespace is JavaScript's \s (tab, line feed, a pasted
--      no-break space, U+2000-U+200A, U+3000, U+FEFF ...), which neither
--      btrim() nor a libc \s covers;
--   5. btrim(..., ' ')                               leading and trailing.
-- AN ASCII FAST PATH, the same result: when octet_length = char_length the
-- value is ASCII, NFD changes nothing and there is no mark, so steps 1-2 are
-- skipped, step 3 is lower(x COLLATE "C"), exact for ASCII (and the same as
-- the ICU lowering there), and step 4 is one small bracket of the ASCII
-- whitespace (tab to carriage return, and space). Measured on the pinned
-- image, the full path costs about 2 s per 100,000 values (normalize, the
-- mark bracket and the whitespace step dominate), the fast path a fraction of
-- that. Most names in a contact table are ASCII, and every contact write
-- folds four of them.
--
-- normalize() is IMMUTABLE on the pinned image (asserted by the suite), so the
-- condition under which T-0086 allowed a writer-maintained copy does not hold,
-- and the database keeps every copy in step on every write path: the API, an
-- import, the seed, a direct UPDATE, and a future NDPA erasure job (D-P27: a
-- copy is personal data, erased and redacted with its source). A NULL source
-- gives a NULL copy. Nobody can write a copy (SQLSTATE 428C9).
--
-- Unicode drift: Postgres's NFD and ICU's case tables move with the image.
-- A stored copy is computed once; after an upgrade that changes either, the
-- copies are refreshed by rewriting each source field onto itself (a data
-- migration, reviewed then), exactly as an index on an ICU collation is
-- rebuilt after an ICU upgrade.
--
-- Each copy is `text COLLATE "C"`: the range compares code points, which is
-- what "starts with" means for a prefix and the order the API computes
-- $prefix_upper in (the least string greater than every string starting with
-- the prefix: its last code point plus one).
--
-- ---------------------------------------------------------------------------
-- THE INDEXES (the T-0086 suite's R5 and R6)
-- ---------------------------------------------------------------------------
--   contact_display_name_search_idx  contact (tenant_id, programme_id, display_name_search, id)
--   contact_given_names_search_idx   contact (tenant_id, programme_id, given_names_search, id)
--   contact_family_name_search_idx   contact (tenant_id, programme_id, family_name_search, id)
--   contact_company_name_search_idx  contact (tenant_id, programme_id, company_name_search, id)
--   account_name_search_idx          account (tenant_id, programme_id, name_search, id)
--   deal_name_search_idx             deal    (tenant_id, programme_id, name_search, id)
-- The API sends one range per (field, programme the field is readable in),
-- each with scalar `tenant_id = $t AND programme_id = $p`, ORDER BY
-- <column>, id LIMIT 3: equality on both leading keys, so the range is the
-- Index Cond and the order comes from the index, and each scan stops after
-- three rows whatever share of the tenant matches. The trailing `id` makes
-- that order total, so the same data and query give the same answer.
-- The leads view (status = ANY(lead statuses)) uses the contact indexes.
-- The exact lookups (lookupRecords) are not served here: `phones @>` cannot be
-- an index condition under FORCE RLS until jsonb_contains is reviewed for
-- LEAKPROOF (ADR-0015, D-L128 Q3); they read the session's scope.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT AND COST (D-L65)
-- ---------------------------------------------------------------------------
--   - ADD COLUMN ... GENERATED ALWAYS ... STORED REWRITES THE TABLE under
--     ACCESS EXCLUSIVE: no read or write of contact, account or deal until
--     COMMIT, for a full rewrite of each (the four contact columns are one
--     ALTER TABLE, so contact is rewritten once). Then each CREATE INDEX scans
--     its table. Acceptable ONLY while no cell is populated (D-L65): today
--     there is none. This file must not be applied as written to a populated
--     cell; there, the columns need their own reviewed plan (a maintenance
--     window, or a different expand), a human decision.
--   - On a populated cell the INDEXES are built without blocking writes, in a
--     separate migration file that runs after the columns exist, e.g.
--         packages/db/migrations/0038a_search_prefix_indexes_concurrently.sql
--     whose first line is exactly `-- kasuwa:no-transaction` (the runner's
--     non-transactional mode, T-0044), holding only:
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_display_name_search_idx
--           ON contact (tenant_id, programme_id, display_name_search COLLATE "C", id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_given_names_search_idx
--           ON contact (tenant_id, programme_id, given_names_search COLLATE "C", id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_family_name_search_idx
--           ON contact (tenant_id, programme_id, family_name_search COLLATE "C", id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_company_name_search_idx
--           ON contact (tenant_id, programme_id, company_name_search COLLATE "C", id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS account_name_search_idx
--           ON account (tenant_id, programme_id, name_search COLLATE "C", id);
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS deal_name_search_idx
--           ON deal (tenant_id, programme_id, name_search COLLATE "C", id);
--     with the plain CREATE INDEX statements below left out of the columns'
--     file. A failed concurrent build leaves an INVALID index: remove it
--     CONCURRENTLY and run the file again; the self-check below refuses an
--     invalid index.
--   - lock_timeout = 5s: fail fast instead of queueing behind a long
--     transaction.
-- Steady-state cost: on every contact write the fold of four fields and four
-- more B-tree entries; one of each on an account or deal write. The copies
-- roughly double the stored size of the name fields.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- 1. Locks, in a fixed order (contact, account, deal), before anything changes.
LOCK TABLE contact, account, deal IN ACCESS EXCLUSIVE MODE;

-- 2. The folded columns. Each expression folds its own source column only.
ALTER TABLE contact
  ADD COLUMN display_name_search text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN octet_length(display_name) = char_length(display_name) THEN
      btrim(regexp_replace(lower(display_name COLLATE "C"), '[\u0009-\u000d ]+', ' ', 'g'), ' ')
    ELSE
      btrim(regexp_replace(
        translate(
          lower(regexp_replace(normalize(display_name, NFD),
            '[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2'
            '\u05c4-\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc'
            '\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a'
            '\u07a6-\u07b0\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823'
            '\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0898-\u089f'
            '\u08ca-\u08e1\u08e3-\u0903\u093a-\u093c\u093e-\u094f'
            '\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09bc\u09be-\u09c4'
            '\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3\u09fe\u0a01-\u0a03'
            '\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71'
            '\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd'
            '\u0ae2-\u0ae3\u0afa-\u0aff\u0b01-\u0b03\u0b3c\u0b3e-\u0b44'
            '\u0b47-\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b62-\u0b63\u0b82'
            '\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0c00-\u0c04\u0c3c'
            '\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56'
            '\u0c62-\u0c63\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8'
            '\u0cca-\u0ccd\u0cd5-\u0cd6\u0ce2-\u0ce3\u0cf3\u0d00-\u0d03'
            '\u0d3b-\u0d3c\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57'
            '\u0d62-\u0d63\u0d81-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf'
            '\u0df2-\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0ebc'
            '\u0ec8-\u0ece\u0f18-\u0f19\u0f35\u0f37\u0f39\u0f3e-\u0f3f'
            '\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6'
            '\u102b-\u103e\u1056-\u1059\u105e-\u1060\u1062-\u1064'
            '\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f\u109a-\u109d'
            '\u135d-\u135f\u1712-\u1715\u1732-\u1734\u1752-\u1753'
            '\u1772-\u1773\u17b4-\u17d3\u17dd\u180b-\u180d\u180f\u1885-\u1886'
            '\u18a9\u1920-\u192b\u1930-\u193b\u1a17-\u1a1b\u1a55-\u1a5e'
            '\u1a60-\u1a7c\u1a7f\u1ab0-\u1ace\u1b00-\u1b04\u1b34-\u1b44'
            '\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1be6-\u1bf3'
            '\u1c24-\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf4\u1cf7-\u1cf9'
            '\u1dc0-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff'
            '\u302a-\u302f\u3099-\u309a\ua66f-\ua672\ua674-\ua67d'
            '\ua69e-\ua69f\ua6f0-\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua82c'
            '\ua880-\ua881\ua8b4-\ua8c5\ua8e0-\ua8f1\ua8ff\ua926-\ua92d'
            '\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9e5\uaa29-\uaa36\uaa43'
            '\uaa4c-\uaa4d\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7-\uaab8'
            '\uaabe-\uaabf\uaac1\uaaeb-\uaaef\uaaf5-\uaaf6\uabe3-\uabea'
            '\uabec-\uabed\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\U000101fd'
            '\U000102e0\U00010376-\U0001037a\U00010a01-\U00010a03'
            '\U00010a05-\U00010a06\U00010a0c-\U00010a0f\U00010a38-\U00010a3a'
            '\U00010a3f\U00010ae5-\U00010ae6\U00010d24-\U00010d27'
            '\U00010eab-\U00010eac\U00010efd-\U00010eff\U00010f46-\U00010f50'
            '\U00010f82-\U00010f85\U00011000-\U00011002\U00011038-\U00011046'
            '\U00011070\U00011073-\U00011074\U0001107f-\U00011082'
            '\U000110b0-\U000110ba\U000110c2\U00011100-\U00011102'
            '\U00011127-\U00011134\U00011145-\U00011146\U00011173'
            '\U00011180-\U00011182\U000111b3-\U000111c0\U000111c9-\U000111cc'
            '\U000111ce-\U000111cf\U0001122c-\U00011237\U0001123e\U00011241'
            '\U000112df-\U000112ea\U00011300-\U00011303\U0001133b-\U0001133c'
            '\U0001133e-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d'
            '\U00011357\U00011362-\U00011363\U00011366-\U0001136c'
            '\U00011370-\U00011374\U00011435-\U00011446\U0001145e'
            '\U000114b0-\U000114c3\U000115af-\U000115b5\U000115b8-\U000115c0'
            '\U000115dc-\U000115dd\U00011630-\U00011640\U000116ab-\U000116b7'
            '\U0001171d-\U0001172b\U0001182c-\U0001183a\U00011930-\U00011935'
            '\U00011937-\U00011938\U0001193b-\U0001193e\U00011940'
            '\U00011942-\U00011943\U000119d1-\U000119d7\U000119da-\U000119e0'
            '\U000119e4\U00011a01-\U00011a0a\U00011a33-\U00011a39'
            '\U00011a3b-\U00011a3e\U00011a47\U00011a51-\U00011a5b'
            '\U00011a8a-\U00011a99\U00011c2f-\U00011c36\U00011c38-\U00011c3f'
            '\U00011c92-\U00011ca7\U00011ca9-\U00011cb6\U00011d31-\U00011d36'
            '\U00011d3a\U00011d3c-\U00011d3d\U00011d3f-\U00011d45\U00011d47'
            '\U00011d8a-\U00011d8e\U00011d90-\U00011d91\U00011d93-\U00011d97'
            '\U00011ef3-\U00011ef6\U00011f00-\U00011f01\U00011f03'
            '\U00011f34-\U00011f3a\U00011f3e-\U00011f42\U00013440'
            '\U00013447-\U00013455\U00016af0-\U00016af4\U00016b30-\U00016b36'
            '\U00016f4f\U00016f51-\U00016f87\U00016f8f-\U00016f92\U00016fe4'
            '\U00016ff0-\U00016ff1\U0001bc9d-\U0001bc9e\U0001cf00-\U0001cf2d'
            '\U0001cf30-\U0001cf46\U0001d165-\U0001d169\U0001d16d-\U0001d172'
            '\U0001d17b-\U0001d182\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad'
            '\U0001d242-\U0001d244\U0001da00-\U0001da36\U0001da3b-\U0001da6c'
            '\U0001da75\U0001da84\U0001da9b-\U0001da9f\U0001daa1-\U0001daaf'
            '\U0001e000-\U0001e006\U0001e008-\U0001e018\U0001e01b-\U0001e021'
            '\U0001e023-\U0001e024\U0001e026-\U0001e02a\U0001e08f'
            '\U0001e130-\U0001e136\U0001e2ae\U0001e2ec-\U0001e2ef'
            '\U0001e4ec-\U0001e4ef\U0001e8d0-\U0001e8d6\U0001e944-\U0001e94a'
            '\U000e0100-\U000e01ef]',
            '', 'g') COLLATE "und-x-icu"),
          E'\u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
          '                        '),
        ' {2,}', ' ', 'g'), ' ') COLLATE "C"
    END
  ) STORED,
  ADD COLUMN given_names_search text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN octet_length(given_names) = char_length(given_names) THEN
      btrim(regexp_replace(lower(given_names COLLATE "C"), '[\u0009-\u000d ]+', ' ', 'g'), ' ')
    ELSE
      btrim(regexp_replace(
        translate(
          lower(regexp_replace(normalize(given_names, NFD),
            '[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2'
            '\u05c4-\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc'
            '\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a'
            '\u07a6-\u07b0\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823'
            '\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0898-\u089f'
            '\u08ca-\u08e1\u08e3-\u0903\u093a-\u093c\u093e-\u094f'
            '\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09bc\u09be-\u09c4'
            '\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3\u09fe\u0a01-\u0a03'
            '\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71'
            '\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd'
            '\u0ae2-\u0ae3\u0afa-\u0aff\u0b01-\u0b03\u0b3c\u0b3e-\u0b44'
            '\u0b47-\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b62-\u0b63\u0b82'
            '\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0c00-\u0c04\u0c3c'
            '\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56'
            '\u0c62-\u0c63\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8'
            '\u0cca-\u0ccd\u0cd5-\u0cd6\u0ce2-\u0ce3\u0cf3\u0d00-\u0d03'
            '\u0d3b-\u0d3c\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57'
            '\u0d62-\u0d63\u0d81-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf'
            '\u0df2-\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0ebc'
            '\u0ec8-\u0ece\u0f18-\u0f19\u0f35\u0f37\u0f39\u0f3e-\u0f3f'
            '\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6'
            '\u102b-\u103e\u1056-\u1059\u105e-\u1060\u1062-\u1064'
            '\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f\u109a-\u109d'
            '\u135d-\u135f\u1712-\u1715\u1732-\u1734\u1752-\u1753'
            '\u1772-\u1773\u17b4-\u17d3\u17dd\u180b-\u180d\u180f\u1885-\u1886'
            '\u18a9\u1920-\u192b\u1930-\u193b\u1a17-\u1a1b\u1a55-\u1a5e'
            '\u1a60-\u1a7c\u1a7f\u1ab0-\u1ace\u1b00-\u1b04\u1b34-\u1b44'
            '\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1be6-\u1bf3'
            '\u1c24-\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf4\u1cf7-\u1cf9'
            '\u1dc0-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff'
            '\u302a-\u302f\u3099-\u309a\ua66f-\ua672\ua674-\ua67d'
            '\ua69e-\ua69f\ua6f0-\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua82c'
            '\ua880-\ua881\ua8b4-\ua8c5\ua8e0-\ua8f1\ua8ff\ua926-\ua92d'
            '\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9e5\uaa29-\uaa36\uaa43'
            '\uaa4c-\uaa4d\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7-\uaab8'
            '\uaabe-\uaabf\uaac1\uaaeb-\uaaef\uaaf5-\uaaf6\uabe3-\uabea'
            '\uabec-\uabed\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\U000101fd'
            '\U000102e0\U00010376-\U0001037a\U00010a01-\U00010a03'
            '\U00010a05-\U00010a06\U00010a0c-\U00010a0f\U00010a38-\U00010a3a'
            '\U00010a3f\U00010ae5-\U00010ae6\U00010d24-\U00010d27'
            '\U00010eab-\U00010eac\U00010efd-\U00010eff\U00010f46-\U00010f50'
            '\U00010f82-\U00010f85\U00011000-\U00011002\U00011038-\U00011046'
            '\U00011070\U00011073-\U00011074\U0001107f-\U00011082'
            '\U000110b0-\U000110ba\U000110c2\U00011100-\U00011102'
            '\U00011127-\U00011134\U00011145-\U00011146\U00011173'
            '\U00011180-\U00011182\U000111b3-\U000111c0\U000111c9-\U000111cc'
            '\U000111ce-\U000111cf\U0001122c-\U00011237\U0001123e\U00011241'
            '\U000112df-\U000112ea\U00011300-\U00011303\U0001133b-\U0001133c'
            '\U0001133e-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d'
            '\U00011357\U00011362-\U00011363\U00011366-\U0001136c'
            '\U00011370-\U00011374\U00011435-\U00011446\U0001145e'
            '\U000114b0-\U000114c3\U000115af-\U000115b5\U000115b8-\U000115c0'
            '\U000115dc-\U000115dd\U00011630-\U00011640\U000116ab-\U000116b7'
            '\U0001171d-\U0001172b\U0001182c-\U0001183a\U00011930-\U00011935'
            '\U00011937-\U00011938\U0001193b-\U0001193e\U00011940'
            '\U00011942-\U00011943\U000119d1-\U000119d7\U000119da-\U000119e0'
            '\U000119e4\U00011a01-\U00011a0a\U00011a33-\U00011a39'
            '\U00011a3b-\U00011a3e\U00011a47\U00011a51-\U00011a5b'
            '\U00011a8a-\U00011a99\U00011c2f-\U00011c36\U00011c38-\U00011c3f'
            '\U00011c92-\U00011ca7\U00011ca9-\U00011cb6\U00011d31-\U00011d36'
            '\U00011d3a\U00011d3c-\U00011d3d\U00011d3f-\U00011d45\U00011d47'
            '\U00011d8a-\U00011d8e\U00011d90-\U00011d91\U00011d93-\U00011d97'
            '\U00011ef3-\U00011ef6\U00011f00-\U00011f01\U00011f03'
            '\U00011f34-\U00011f3a\U00011f3e-\U00011f42\U00013440'
            '\U00013447-\U00013455\U00016af0-\U00016af4\U00016b30-\U00016b36'
            '\U00016f4f\U00016f51-\U00016f87\U00016f8f-\U00016f92\U00016fe4'
            '\U00016ff0-\U00016ff1\U0001bc9d-\U0001bc9e\U0001cf00-\U0001cf2d'
            '\U0001cf30-\U0001cf46\U0001d165-\U0001d169\U0001d16d-\U0001d172'
            '\U0001d17b-\U0001d182\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad'
            '\U0001d242-\U0001d244\U0001da00-\U0001da36\U0001da3b-\U0001da6c'
            '\U0001da75\U0001da84\U0001da9b-\U0001da9f\U0001daa1-\U0001daaf'
            '\U0001e000-\U0001e006\U0001e008-\U0001e018\U0001e01b-\U0001e021'
            '\U0001e023-\U0001e024\U0001e026-\U0001e02a\U0001e08f'
            '\U0001e130-\U0001e136\U0001e2ae\U0001e2ec-\U0001e2ef'
            '\U0001e4ec-\U0001e4ef\U0001e8d0-\U0001e8d6\U0001e944-\U0001e94a'
            '\U000e0100-\U000e01ef]',
            '', 'g') COLLATE "und-x-icu"),
          E'\u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
          '                        '),
        ' {2,}', ' ', 'g'), ' ') COLLATE "C"
    END
  ) STORED,
  ADD COLUMN family_name_search text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN octet_length(family_name) = char_length(family_name) THEN
      btrim(regexp_replace(lower(family_name COLLATE "C"), '[\u0009-\u000d ]+', ' ', 'g'), ' ')
    ELSE
      btrim(regexp_replace(
        translate(
          lower(regexp_replace(normalize(family_name, NFD),
            '[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2'
            '\u05c4-\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc'
            '\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a'
            '\u07a6-\u07b0\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823'
            '\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0898-\u089f'
            '\u08ca-\u08e1\u08e3-\u0903\u093a-\u093c\u093e-\u094f'
            '\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09bc\u09be-\u09c4'
            '\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3\u09fe\u0a01-\u0a03'
            '\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71'
            '\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd'
            '\u0ae2-\u0ae3\u0afa-\u0aff\u0b01-\u0b03\u0b3c\u0b3e-\u0b44'
            '\u0b47-\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b62-\u0b63\u0b82'
            '\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0c00-\u0c04\u0c3c'
            '\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56'
            '\u0c62-\u0c63\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8'
            '\u0cca-\u0ccd\u0cd5-\u0cd6\u0ce2-\u0ce3\u0cf3\u0d00-\u0d03'
            '\u0d3b-\u0d3c\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57'
            '\u0d62-\u0d63\u0d81-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf'
            '\u0df2-\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0ebc'
            '\u0ec8-\u0ece\u0f18-\u0f19\u0f35\u0f37\u0f39\u0f3e-\u0f3f'
            '\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6'
            '\u102b-\u103e\u1056-\u1059\u105e-\u1060\u1062-\u1064'
            '\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f\u109a-\u109d'
            '\u135d-\u135f\u1712-\u1715\u1732-\u1734\u1752-\u1753'
            '\u1772-\u1773\u17b4-\u17d3\u17dd\u180b-\u180d\u180f\u1885-\u1886'
            '\u18a9\u1920-\u192b\u1930-\u193b\u1a17-\u1a1b\u1a55-\u1a5e'
            '\u1a60-\u1a7c\u1a7f\u1ab0-\u1ace\u1b00-\u1b04\u1b34-\u1b44'
            '\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1be6-\u1bf3'
            '\u1c24-\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf4\u1cf7-\u1cf9'
            '\u1dc0-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff'
            '\u302a-\u302f\u3099-\u309a\ua66f-\ua672\ua674-\ua67d'
            '\ua69e-\ua69f\ua6f0-\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua82c'
            '\ua880-\ua881\ua8b4-\ua8c5\ua8e0-\ua8f1\ua8ff\ua926-\ua92d'
            '\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9e5\uaa29-\uaa36\uaa43'
            '\uaa4c-\uaa4d\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7-\uaab8'
            '\uaabe-\uaabf\uaac1\uaaeb-\uaaef\uaaf5-\uaaf6\uabe3-\uabea'
            '\uabec-\uabed\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\U000101fd'
            '\U000102e0\U00010376-\U0001037a\U00010a01-\U00010a03'
            '\U00010a05-\U00010a06\U00010a0c-\U00010a0f\U00010a38-\U00010a3a'
            '\U00010a3f\U00010ae5-\U00010ae6\U00010d24-\U00010d27'
            '\U00010eab-\U00010eac\U00010efd-\U00010eff\U00010f46-\U00010f50'
            '\U00010f82-\U00010f85\U00011000-\U00011002\U00011038-\U00011046'
            '\U00011070\U00011073-\U00011074\U0001107f-\U00011082'
            '\U000110b0-\U000110ba\U000110c2\U00011100-\U00011102'
            '\U00011127-\U00011134\U00011145-\U00011146\U00011173'
            '\U00011180-\U00011182\U000111b3-\U000111c0\U000111c9-\U000111cc'
            '\U000111ce-\U000111cf\U0001122c-\U00011237\U0001123e\U00011241'
            '\U000112df-\U000112ea\U00011300-\U00011303\U0001133b-\U0001133c'
            '\U0001133e-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d'
            '\U00011357\U00011362-\U00011363\U00011366-\U0001136c'
            '\U00011370-\U00011374\U00011435-\U00011446\U0001145e'
            '\U000114b0-\U000114c3\U000115af-\U000115b5\U000115b8-\U000115c0'
            '\U000115dc-\U000115dd\U00011630-\U00011640\U000116ab-\U000116b7'
            '\U0001171d-\U0001172b\U0001182c-\U0001183a\U00011930-\U00011935'
            '\U00011937-\U00011938\U0001193b-\U0001193e\U00011940'
            '\U00011942-\U00011943\U000119d1-\U000119d7\U000119da-\U000119e0'
            '\U000119e4\U00011a01-\U00011a0a\U00011a33-\U00011a39'
            '\U00011a3b-\U00011a3e\U00011a47\U00011a51-\U00011a5b'
            '\U00011a8a-\U00011a99\U00011c2f-\U00011c36\U00011c38-\U00011c3f'
            '\U00011c92-\U00011ca7\U00011ca9-\U00011cb6\U00011d31-\U00011d36'
            '\U00011d3a\U00011d3c-\U00011d3d\U00011d3f-\U00011d45\U00011d47'
            '\U00011d8a-\U00011d8e\U00011d90-\U00011d91\U00011d93-\U00011d97'
            '\U00011ef3-\U00011ef6\U00011f00-\U00011f01\U00011f03'
            '\U00011f34-\U00011f3a\U00011f3e-\U00011f42\U00013440'
            '\U00013447-\U00013455\U00016af0-\U00016af4\U00016b30-\U00016b36'
            '\U00016f4f\U00016f51-\U00016f87\U00016f8f-\U00016f92\U00016fe4'
            '\U00016ff0-\U00016ff1\U0001bc9d-\U0001bc9e\U0001cf00-\U0001cf2d'
            '\U0001cf30-\U0001cf46\U0001d165-\U0001d169\U0001d16d-\U0001d172'
            '\U0001d17b-\U0001d182\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad'
            '\U0001d242-\U0001d244\U0001da00-\U0001da36\U0001da3b-\U0001da6c'
            '\U0001da75\U0001da84\U0001da9b-\U0001da9f\U0001daa1-\U0001daaf'
            '\U0001e000-\U0001e006\U0001e008-\U0001e018\U0001e01b-\U0001e021'
            '\U0001e023-\U0001e024\U0001e026-\U0001e02a\U0001e08f'
            '\U0001e130-\U0001e136\U0001e2ae\U0001e2ec-\U0001e2ef'
            '\U0001e4ec-\U0001e4ef\U0001e8d0-\U0001e8d6\U0001e944-\U0001e94a'
            '\U000e0100-\U000e01ef]',
            '', 'g') COLLATE "und-x-icu"),
          E'\u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
          '                        '),
        ' {2,}', ' ', 'g'), ' ') COLLATE "C"
    END
  ) STORED,
  ADD COLUMN company_name_search text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN octet_length(company_name) = char_length(company_name) THEN
      btrim(regexp_replace(lower(company_name COLLATE "C"), '[\u0009-\u000d ]+', ' ', 'g'), ' ')
    ELSE
      btrim(regexp_replace(
        translate(
          lower(regexp_replace(normalize(company_name, NFD),
            '[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2'
            '\u05c4-\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc'
            '\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a'
            '\u07a6-\u07b0\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823'
            '\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0898-\u089f'
            '\u08ca-\u08e1\u08e3-\u0903\u093a-\u093c\u093e-\u094f'
            '\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09bc\u09be-\u09c4'
            '\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3\u09fe\u0a01-\u0a03'
            '\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71'
            '\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd'
            '\u0ae2-\u0ae3\u0afa-\u0aff\u0b01-\u0b03\u0b3c\u0b3e-\u0b44'
            '\u0b47-\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b62-\u0b63\u0b82'
            '\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0c00-\u0c04\u0c3c'
            '\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56'
            '\u0c62-\u0c63\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8'
            '\u0cca-\u0ccd\u0cd5-\u0cd6\u0ce2-\u0ce3\u0cf3\u0d00-\u0d03'
            '\u0d3b-\u0d3c\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57'
            '\u0d62-\u0d63\u0d81-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf'
            '\u0df2-\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0ebc'
            '\u0ec8-\u0ece\u0f18-\u0f19\u0f35\u0f37\u0f39\u0f3e-\u0f3f'
            '\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6'
            '\u102b-\u103e\u1056-\u1059\u105e-\u1060\u1062-\u1064'
            '\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f\u109a-\u109d'
            '\u135d-\u135f\u1712-\u1715\u1732-\u1734\u1752-\u1753'
            '\u1772-\u1773\u17b4-\u17d3\u17dd\u180b-\u180d\u180f\u1885-\u1886'
            '\u18a9\u1920-\u192b\u1930-\u193b\u1a17-\u1a1b\u1a55-\u1a5e'
            '\u1a60-\u1a7c\u1a7f\u1ab0-\u1ace\u1b00-\u1b04\u1b34-\u1b44'
            '\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1be6-\u1bf3'
            '\u1c24-\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf4\u1cf7-\u1cf9'
            '\u1dc0-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff'
            '\u302a-\u302f\u3099-\u309a\ua66f-\ua672\ua674-\ua67d'
            '\ua69e-\ua69f\ua6f0-\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua82c'
            '\ua880-\ua881\ua8b4-\ua8c5\ua8e0-\ua8f1\ua8ff\ua926-\ua92d'
            '\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9e5\uaa29-\uaa36\uaa43'
            '\uaa4c-\uaa4d\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7-\uaab8'
            '\uaabe-\uaabf\uaac1\uaaeb-\uaaef\uaaf5-\uaaf6\uabe3-\uabea'
            '\uabec-\uabed\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\U000101fd'
            '\U000102e0\U00010376-\U0001037a\U00010a01-\U00010a03'
            '\U00010a05-\U00010a06\U00010a0c-\U00010a0f\U00010a38-\U00010a3a'
            '\U00010a3f\U00010ae5-\U00010ae6\U00010d24-\U00010d27'
            '\U00010eab-\U00010eac\U00010efd-\U00010eff\U00010f46-\U00010f50'
            '\U00010f82-\U00010f85\U00011000-\U00011002\U00011038-\U00011046'
            '\U00011070\U00011073-\U00011074\U0001107f-\U00011082'
            '\U000110b0-\U000110ba\U000110c2\U00011100-\U00011102'
            '\U00011127-\U00011134\U00011145-\U00011146\U00011173'
            '\U00011180-\U00011182\U000111b3-\U000111c0\U000111c9-\U000111cc'
            '\U000111ce-\U000111cf\U0001122c-\U00011237\U0001123e\U00011241'
            '\U000112df-\U000112ea\U00011300-\U00011303\U0001133b-\U0001133c'
            '\U0001133e-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d'
            '\U00011357\U00011362-\U00011363\U00011366-\U0001136c'
            '\U00011370-\U00011374\U00011435-\U00011446\U0001145e'
            '\U000114b0-\U000114c3\U000115af-\U000115b5\U000115b8-\U000115c0'
            '\U000115dc-\U000115dd\U00011630-\U00011640\U000116ab-\U000116b7'
            '\U0001171d-\U0001172b\U0001182c-\U0001183a\U00011930-\U00011935'
            '\U00011937-\U00011938\U0001193b-\U0001193e\U00011940'
            '\U00011942-\U00011943\U000119d1-\U000119d7\U000119da-\U000119e0'
            '\U000119e4\U00011a01-\U00011a0a\U00011a33-\U00011a39'
            '\U00011a3b-\U00011a3e\U00011a47\U00011a51-\U00011a5b'
            '\U00011a8a-\U00011a99\U00011c2f-\U00011c36\U00011c38-\U00011c3f'
            '\U00011c92-\U00011ca7\U00011ca9-\U00011cb6\U00011d31-\U00011d36'
            '\U00011d3a\U00011d3c-\U00011d3d\U00011d3f-\U00011d45\U00011d47'
            '\U00011d8a-\U00011d8e\U00011d90-\U00011d91\U00011d93-\U00011d97'
            '\U00011ef3-\U00011ef6\U00011f00-\U00011f01\U00011f03'
            '\U00011f34-\U00011f3a\U00011f3e-\U00011f42\U00013440'
            '\U00013447-\U00013455\U00016af0-\U00016af4\U00016b30-\U00016b36'
            '\U00016f4f\U00016f51-\U00016f87\U00016f8f-\U00016f92\U00016fe4'
            '\U00016ff0-\U00016ff1\U0001bc9d-\U0001bc9e\U0001cf00-\U0001cf2d'
            '\U0001cf30-\U0001cf46\U0001d165-\U0001d169\U0001d16d-\U0001d172'
            '\U0001d17b-\U0001d182\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad'
            '\U0001d242-\U0001d244\U0001da00-\U0001da36\U0001da3b-\U0001da6c'
            '\U0001da75\U0001da84\U0001da9b-\U0001da9f\U0001daa1-\U0001daaf'
            '\U0001e000-\U0001e006\U0001e008-\U0001e018\U0001e01b-\U0001e021'
            '\U0001e023-\U0001e024\U0001e026-\U0001e02a\U0001e08f'
            '\U0001e130-\U0001e136\U0001e2ae\U0001e2ec-\U0001e2ef'
            '\U0001e4ec-\U0001e4ef\U0001e8d0-\U0001e8d6\U0001e944-\U0001e94a'
            '\U000e0100-\U000e01ef]',
            '', 'g') COLLATE "und-x-icu"),
          E'\u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
          '                        '),
        ' {2,}', ' ', 'g'), ' ') COLLATE "C"
    END
  ) STORED;

ALTER TABLE account
  ADD COLUMN name_search text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN octet_length(name) = char_length(name) THEN
      btrim(regexp_replace(lower(name COLLATE "C"), '[\u0009-\u000d ]+', ' ', 'g'), ' ')
    ELSE
      btrim(regexp_replace(
        translate(
          lower(regexp_replace(normalize(name, NFD),
            '[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2'
            '\u05c4-\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc'
            '\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a'
            '\u07a6-\u07b0\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823'
            '\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0898-\u089f'
            '\u08ca-\u08e1\u08e3-\u0903\u093a-\u093c\u093e-\u094f'
            '\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09bc\u09be-\u09c4'
            '\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3\u09fe\u0a01-\u0a03'
            '\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71'
            '\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd'
            '\u0ae2-\u0ae3\u0afa-\u0aff\u0b01-\u0b03\u0b3c\u0b3e-\u0b44'
            '\u0b47-\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b62-\u0b63\u0b82'
            '\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0c00-\u0c04\u0c3c'
            '\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56'
            '\u0c62-\u0c63\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8'
            '\u0cca-\u0ccd\u0cd5-\u0cd6\u0ce2-\u0ce3\u0cf3\u0d00-\u0d03'
            '\u0d3b-\u0d3c\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57'
            '\u0d62-\u0d63\u0d81-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf'
            '\u0df2-\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0ebc'
            '\u0ec8-\u0ece\u0f18-\u0f19\u0f35\u0f37\u0f39\u0f3e-\u0f3f'
            '\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6'
            '\u102b-\u103e\u1056-\u1059\u105e-\u1060\u1062-\u1064'
            '\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f\u109a-\u109d'
            '\u135d-\u135f\u1712-\u1715\u1732-\u1734\u1752-\u1753'
            '\u1772-\u1773\u17b4-\u17d3\u17dd\u180b-\u180d\u180f\u1885-\u1886'
            '\u18a9\u1920-\u192b\u1930-\u193b\u1a17-\u1a1b\u1a55-\u1a5e'
            '\u1a60-\u1a7c\u1a7f\u1ab0-\u1ace\u1b00-\u1b04\u1b34-\u1b44'
            '\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1be6-\u1bf3'
            '\u1c24-\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf4\u1cf7-\u1cf9'
            '\u1dc0-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff'
            '\u302a-\u302f\u3099-\u309a\ua66f-\ua672\ua674-\ua67d'
            '\ua69e-\ua69f\ua6f0-\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua82c'
            '\ua880-\ua881\ua8b4-\ua8c5\ua8e0-\ua8f1\ua8ff\ua926-\ua92d'
            '\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9e5\uaa29-\uaa36\uaa43'
            '\uaa4c-\uaa4d\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7-\uaab8'
            '\uaabe-\uaabf\uaac1\uaaeb-\uaaef\uaaf5-\uaaf6\uabe3-\uabea'
            '\uabec-\uabed\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\U000101fd'
            '\U000102e0\U00010376-\U0001037a\U00010a01-\U00010a03'
            '\U00010a05-\U00010a06\U00010a0c-\U00010a0f\U00010a38-\U00010a3a'
            '\U00010a3f\U00010ae5-\U00010ae6\U00010d24-\U00010d27'
            '\U00010eab-\U00010eac\U00010efd-\U00010eff\U00010f46-\U00010f50'
            '\U00010f82-\U00010f85\U00011000-\U00011002\U00011038-\U00011046'
            '\U00011070\U00011073-\U00011074\U0001107f-\U00011082'
            '\U000110b0-\U000110ba\U000110c2\U00011100-\U00011102'
            '\U00011127-\U00011134\U00011145-\U00011146\U00011173'
            '\U00011180-\U00011182\U000111b3-\U000111c0\U000111c9-\U000111cc'
            '\U000111ce-\U000111cf\U0001122c-\U00011237\U0001123e\U00011241'
            '\U000112df-\U000112ea\U00011300-\U00011303\U0001133b-\U0001133c'
            '\U0001133e-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d'
            '\U00011357\U00011362-\U00011363\U00011366-\U0001136c'
            '\U00011370-\U00011374\U00011435-\U00011446\U0001145e'
            '\U000114b0-\U000114c3\U000115af-\U000115b5\U000115b8-\U000115c0'
            '\U000115dc-\U000115dd\U00011630-\U00011640\U000116ab-\U000116b7'
            '\U0001171d-\U0001172b\U0001182c-\U0001183a\U00011930-\U00011935'
            '\U00011937-\U00011938\U0001193b-\U0001193e\U00011940'
            '\U00011942-\U00011943\U000119d1-\U000119d7\U000119da-\U000119e0'
            '\U000119e4\U00011a01-\U00011a0a\U00011a33-\U00011a39'
            '\U00011a3b-\U00011a3e\U00011a47\U00011a51-\U00011a5b'
            '\U00011a8a-\U00011a99\U00011c2f-\U00011c36\U00011c38-\U00011c3f'
            '\U00011c92-\U00011ca7\U00011ca9-\U00011cb6\U00011d31-\U00011d36'
            '\U00011d3a\U00011d3c-\U00011d3d\U00011d3f-\U00011d45\U00011d47'
            '\U00011d8a-\U00011d8e\U00011d90-\U00011d91\U00011d93-\U00011d97'
            '\U00011ef3-\U00011ef6\U00011f00-\U00011f01\U00011f03'
            '\U00011f34-\U00011f3a\U00011f3e-\U00011f42\U00013440'
            '\U00013447-\U00013455\U00016af0-\U00016af4\U00016b30-\U00016b36'
            '\U00016f4f\U00016f51-\U00016f87\U00016f8f-\U00016f92\U00016fe4'
            '\U00016ff0-\U00016ff1\U0001bc9d-\U0001bc9e\U0001cf00-\U0001cf2d'
            '\U0001cf30-\U0001cf46\U0001d165-\U0001d169\U0001d16d-\U0001d172'
            '\U0001d17b-\U0001d182\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad'
            '\U0001d242-\U0001d244\U0001da00-\U0001da36\U0001da3b-\U0001da6c'
            '\U0001da75\U0001da84\U0001da9b-\U0001da9f\U0001daa1-\U0001daaf'
            '\U0001e000-\U0001e006\U0001e008-\U0001e018\U0001e01b-\U0001e021'
            '\U0001e023-\U0001e024\U0001e026-\U0001e02a\U0001e08f'
            '\U0001e130-\U0001e136\U0001e2ae\U0001e2ec-\U0001e2ef'
            '\U0001e4ec-\U0001e4ef\U0001e8d0-\U0001e8d6\U0001e944-\U0001e94a'
            '\U000e0100-\U000e01ef]',
            '', 'g') COLLATE "und-x-icu"),
          E'\u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
          '                        '),
        ' {2,}', ' ', 'g'), ' ') COLLATE "C"
    END
  ) STORED;

ALTER TABLE deal
  ADD COLUMN name_search text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN octet_length(name) = char_length(name) THEN
      btrim(regexp_replace(lower(name COLLATE "C"), '[\u0009-\u000d ]+', ' ', 'g'), ' ')
    ELSE
      btrim(regexp_replace(
        translate(
          lower(regexp_replace(normalize(name, NFD),
            '[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2'
            '\u05c4-\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc'
            '\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a'
            '\u07a6-\u07b0\u07eb-\u07f3\u07fd\u0816-\u0819\u081b-\u0823'
            '\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0898-\u089f'
            '\u08ca-\u08e1\u08e3-\u0903\u093a-\u093c\u093e-\u094f'
            '\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09bc\u09be-\u09c4'
            '\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3\u09fe\u0a01-\u0a03'
            '\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71'
            '\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd'
            '\u0ae2-\u0ae3\u0afa-\u0aff\u0b01-\u0b03\u0b3c\u0b3e-\u0b44'
            '\u0b47-\u0b48\u0b4b-\u0b4d\u0b55-\u0b57\u0b62-\u0b63\u0b82'
            '\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0c00-\u0c04\u0c3c'
            '\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56'
            '\u0c62-\u0c63\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8'
            '\u0cca-\u0ccd\u0cd5-\u0cd6\u0ce2-\u0ce3\u0cf3\u0d00-\u0d03'
            '\u0d3b-\u0d3c\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57'
            '\u0d62-\u0d63\u0d81-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf'
            '\u0df2-\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0ebc'
            '\u0ec8-\u0ece\u0f18-\u0f19\u0f35\u0f37\u0f39\u0f3e-\u0f3f'
            '\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6'
            '\u102b-\u103e\u1056-\u1059\u105e-\u1060\u1062-\u1064'
            '\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f\u109a-\u109d'
            '\u135d-\u135f\u1712-\u1715\u1732-\u1734\u1752-\u1753'
            '\u1772-\u1773\u17b4-\u17d3\u17dd\u180b-\u180d\u180f\u1885-\u1886'
            '\u18a9\u1920-\u192b\u1930-\u193b\u1a17-\u1a1b\u1a55-\u1a5e'
            '\u1a60-\u1a7c\u1a7f\u1ab0-\u1ace\u1b00-\u1b04\u1b34-\u1b44'
            '\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1be6-\u1bf3'
            '\u1c24-\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf4\u1cf7-\u1cf9'
            '\u1dc0-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff'
            '\u302a-\u302f\u3099-\u309a\ua66f-\ua672\ua674-\ua67d'
            '\ua69e-\ua69f\ua6f0-\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua82c'
            '\ua880-\ua881\ua8b4-\ua8c5\ua8e0-\ua8f1\ua8ff\ua926-\ua92d'
            '\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9e5\uaa29-\uaa36\uaa43'
            '\uaa4c-\uaa4d\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7-\uaab8'
            '\uaabe-\uaabf\uaac1\uaaeb-\uaaef\uaaf5-\uaaf6\uabe3-\uabea'
            '\uabec-\uabed\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\U000101fd'
            '\U000102e0\U00010376-\U0001037a\U00010a01-\U00010a03'
            '\U00010a05-\U00010a06\U00010a0c-\U00010a0f\U00010a38-\U00010a3a'
            '\U00010a3f\U00010ae5-\U00010ae6\U00010d24-\U00010d27'
            '\U00010eab-\U00010eac\U00010efd-\U00010eff\U00010f46-\U00010f50'
            '\U00010f82-\U00010f85\U00011000-\U00011002\U00011038-\U00011046'
            '\U00011070\U00011073-\U00011074\U0001107f-\U00011082'
            '\U000110b0-\U000110ba\U000110c2\U00011100-\U00011102'
            '\U00011127-\U00011134\U00011145-\U00011146\U00011173'
            '\U00011180-\U00011182\U000111b3-\U000111c0\U000111c9-\U000111cc'
            '\U000111ce-\U000111cf\U0001122c-\U00011237\U0001123e\U00011241'
            '\U000112df-\U000112ea\U00011300-\U00011303\U0001133b-\U0001133c'
            '\U0001133e-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d'
            '\U00011357\U00011362-\U00011363\U00011366-\U0001136c'
            '\U00011370-\U00011374\U00011435-\U00011446\U0001145e'
            '\U000114b0-\U000114c3\U000115af-\U000115b5\U000115b8-\U000115c0'
            '\U000115dc-\U000115dd\U00011630-\U00011640\U000116ab-\U000116b7'
            '\U0001171d-\U0001172b\U0001182c-\U0001183a\U00011930-\U00011935'
            '\U00011937-\U00011938\U0001193b-\U0001193e\U00011940'
            '\U00011942-\U00011943\U000119d1-\U000119d7\U000119da-\U000119e0'
            '\U000119e4\U00011a01-\U00011a0a\U00011a33-\U00011a39'
            '\U00011a3b-\U00011a3e\U00011a47\U00011a51-\U00011a5b'
            '\U00011a8a-\U00011a99\U00011c2f-\U00011c36\U00011c38-\U00011c3f'
            '\U00011c92-\U00011ca7\U00011ca9-\U00011cb6\U00011d31-\U00011d36'
            '\U00011d3a\U00011d3c-\U00011d3d\U00011d3f-\U00011d45\U00011d47'
            '\U00011d8a-\U00011d8e\U00011d90-\U00011d91\U00011d93-\U00011d97'
            '\U00011ef3-\U00011ef6\U00011f00-\U00011f01\U00011f03'
            '\U00011f34-\U00011f3a\U00011f3e-\U00011f42\U00013440'
            '\U00013447-\U00013455\U00016af0-\U00016af4\U00016b30-\U00016b36'
            '\U00016f4f\U00016f51-\U00016f87\U00016f8f-\U00016f92\U00016fe4'
            '\U00016ff0-\U00016ff1\U0001bc9d-\U0001bc9e\U0001cf00-\U0001cf2d'
            '\U0001cf30-\U0001cf46\U0001d165-\U0001d169\U0001d16d-\U0001d172'
            '\U0001d17b-\U0001d182\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad'
            '\U0001d242-\U0001d244\U0001da00-\U0001da36\U0001da3b-\U0001da6c'
            '\U0001da75\U0001da84\U0001da9b-\U0001da9f\U0001daa1-\U0001daaf'
            '\U0001e000-\U0001e006\U0001e008-\U0001e018\U0001e01b-\U0001e021'
            '\U0001e023-\U0001e024\U0001e026-\U0001e02a\U0001e08f'
            '\U0001e130-\U0001e136\U0001e2ae\U0001e2ec-\U0001e2ef'
            '\U0001e4ec-\U0001e4ef\U0001e8d0-\U0001e8d6\U0001e944-\U0001e94a'
            '\U000e0100-\U000e01ef]',
            '', 'g') COLLATE "und-x-icu"),
          E'\u0009\u000a\u000b\u000c\u000d\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
          '                        '),
        ' {2,}', ' ', 'g'), ' ') COLLATE "C"
    END
  ) STORED;

-- 3. The prefix indexes.
CREATE INDEX IF NOT EXISTS contact_display_name_search_idx
  ON contact (tenant_id, programme_id, display_name_search COLLATE "C", id);
CREATE INDEX IF NOT EXISTS contact_given_names_search_idx
  ON contact (tenant_id, programme_id, given_names_search COLLATE "C", id);
CREATE INDEX IF NOT EXISTS contact_family_name_search_idx
  ON contact (tenant_id, programme_id, family_name_search COLLATE "C", id);
CREATE INDEX IF NOT EXISTS contact_company_name_search_idx
  ON contact (tenant_id, programme_id, company_name_search COLLATE "C", id);
CREATE INDEX IF NOT EXISTS account_name_search_idx
  ON account (tenant_id, programme_id, name_search COLLATE "C", id);
CREATE INDEX IF NOT EXISTS deal_name_search_idx
  ON deal (tenant_id, programme_id, name_search COLLATE "C", id);

-- ---------------------------------------------------------------------------
-- 4. Self-check. It reads the catalogue and raises; it changes nothing.
--   4.1 the six columns: text, collation "C", GENERATED ... STORED, each
--       depending on exactly one other column of its table, its own source;
--       and every other `*_search` column in public is refused;
--   4.2 the six generation expressions are the SAME fold: identical once the
--       source column is replaced by a placeholder, so no copy folds
--       differently from another;
--   4.3 each index exists with exactly its keys, collations and options, and
--       is a valid, ready, non-partial, expression-free B-tree;
--   4.4 every same-type operator those indexes serve is leak-proof (reads
--       pg_proc.proleakproof only), so kasuwa_app can use them under FORCE RLS;
--   4.5 contact, account and deal still have row security enabled and forced,
--       and kasuwa_app can read the six copies.
-- ---------------------------------------------------------------------------

-- 4.1 and 4.2
DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ARRAY['contact', 'display_name_search', 'display_name'],
    ARRAY['contact', 'given_names_search', 'given_names'],
    ARRAY['contact', 'family_name_search', 'family_name'],
    ARRAY['contact', 'company_name_search', 'company_name'],
    ARRAY['account', 'name_search', 'name'],
    ARRAY['deal', 'name_search', 'name']
  ];
  entry int;
  shape text;
  sources text;
  expression text;
  reference text;
  extra text;
BEGIN
  FOR entry IN 1 .. array_length(expected, 1) LOOP
    SELECT format_type(a.atttypid, a.atttypmod) || ':' || coalesce(coll.collname, '-') || ':' ||
           a.attgenerated::text,
           pg_get_expr(d.adbin, d.adrelid)
      INTO shape, expression
      FROM pg_attribute a
      LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = format('public.%I', expected[entry][1])::regclass
       AND a.attname = expected[entry][2]
       AND NOT a.attisdropped;
    IF shape IS DISTINCT FROM 'text:C:s' THEN
      RAISE EXCEPTION '0038: %.% is missing or not text COLLATE "C" GENERATED ALWAYS ... STORED (found %)',
        expected[entry][1], expected[entry][2], coalesce(shape, 'nothing');
    END IF;

    SELECT string_agg(src.attname, ',' ORDER BY src.attname)
      INTO sources
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      JOIN pg_depend dep ON dep.classid = 'pg_attrdef'::regclass AND dep.objid = d.oid
                        AND dep.refclassid = 'pg_class'::regclass
                        AND dep.refobjid = d.adrelid AND dep.refobjsubid > 0
      JOIN pg_attribute src ON src.attrelid = dep.refobjid AND src.attnum = dep.refobjsubid
     WHERE d.adrelid = format('public.%I', expected[entry][1])::regclass
       AND a.attname = expected[entry][2]
       AND src.attnum <> a.attnum;
    IF sources IS DISTINCT FROM expected[entry][3] THEN
      RAISE EXCEPTION '0038: %.% must fold exactly its own source column %, found (%)',
        expected[entry][1], expected[entry][2], expected[entry][3], coalesce(sources, 'none');
    END IF;

    expression := regexp_replace(expression, '\m' || expected[entry][3] || '\M', '@', 'g');
    IF reference IS NULL THEN
      reference := expression;
    ELSIF expression IS DISTINCT FROM reference THEN
      RAISE EXCEPTION '0038: %.% does not use the same fold as contact.display_name_search',
        expected[entry][1], expected[entry][2];
    END IF;
  END LOOP;
  IF position('(@, NFD)' IN reference) = 0 THEN
    RAISE EXCEPTION '0038: the fold does not start from normalize(<source>, NFD)';
  END IF;

  SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname)
    INTO extra
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE '%\_search'
     AND (c.relname::text, a.attname::text) NOT IN (
       SELECT expected[e][1], expected[e][2] FROM generate_subscripts(expected, 1) AS e);
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION '0038: unexpected *_search column(s): %', extra;
  END IF;
END
$$;

-- 4.3 and 4.4
DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ARRAY['contact_display_name_search_idx', 'contact',
          'tenant_id:-:0,programme_id:-:0,display_name_search:C:0,id:-:0'],
    ARRAY['contact_given_names_search_idx', 'contact',
          'tenant_id:-:0,programme_id:-:0,given_names_search:C:0,id:-:0'],
    ARRAY['contact_family_name_search_idx', 'contact',
          'tenant_id:-:0,programme_id:-:0,family_name_search:C:0,id:-:0'],
    ARRAY['contact_company_name_search_idx', 'contact',
          'tenant_id:-:0,programme_id:-:0,company_name_search:C:0,id:-:0'],
    ARRAY['account_name_search_idx', 'account',
          'tenant_id:-:0,programme_id:-:0,name_search:C:0,id:-:0'],
    ARRAY['deal_name_search_idx', 'deal',
          'tenant_id:-:0,programme_id:-:0,name_search:C:0,id:-:0']
  ];
  entry int;
  found_columns text;
  leaky text;
BEGIN
  FOR entry IN 1 .. array_length(expected, 1) LOOP
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
       AND NOT i.indisunique
       AND i.indexprs IS NULL
       AND i.indpred IS NULL
       AND i.indnkeyatts = i.indnatts;
    IF found_columns IS DISTINCT FROM expected[entry][3] THEN
      RAISE EXCEPTION '0038: index % on % is missing, invalid, unique, partial, an expression index, not a B-tree, or not exactly (%) (column:collation:option); found (%)',
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
    RAISE EXCEPTION '0038: kasuwa_app could not use these indexes under FORCE RLS; proleakproof is false for %; escalate, do not mark', leaky;
  END IF;
END
$$;

-- 4.5
DO $$
DECLARE
  held text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO held
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE c.relname IN ('contact', 'account', 'deal')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0038: row security is not enabled and forced on: %', held;
  END IF;

  SELECT string_agg(t.tbl || '.' || t.col, ', ')
    INTO held
    FROM (VALUES ('contact', 'display_name_search'), ('contact', 'given_names_search'),
                 ('contact', 'family_name_search'), ('contact', 'company_name_search'),
                 ('account', 'name_search'), ('deal', 'name_search')) AS t(tbl, col)
   WHERE NOT has_column_privilege('kasuwa_app', format('public.%I', t.tbl), t.col, 'SELECT');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0038: kasuwa_app cannot SELECT: %', held;
  END IF;
END
$$;
