-- Which phone a pairing is. The desktop listed paired phones by an opaque
-- browser id ("手机设备 mweb_49569b5"), so with two paired there was no telling
-- which to unpair. A coarse label from the pairing request's User-Agent
-- ("iPhone · Safari") is enough to tell them apart and names no person.
alter table mobile_pairing_grants add column if not exists mobile_label text;
