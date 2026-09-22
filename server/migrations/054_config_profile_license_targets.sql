-- A license-scoped config profile matches on the license's internal id, but the
-- admin form took free text and an operator naturally typed the license KEY
-- (the thing customers are given). Those rules saved, listed, and never fired:
-- every device kept the global config. 2026-09-22 production carried one.
--
-- Heal them in place. license_key_hash is unique, so a row is rewritten only
-- when the typed text hashes to exactly one license, and only when it is not
-- already a valid license id. Idempotent: a second run matches nothing.
update config_profiles p
set target_id = l.id,
    updated_at = now()
from licenses l
where p.scope = 'license'
  and p.target_id is not null
  and btrim(p.target_id) <> ''
  and not exists (select 1 from licenses x where x.id = p.target_id)
  and l.license_key_hash = encode(sha256(convert_to(upper(btrim(p.target_id)), 'UTF8')), 'hex');
