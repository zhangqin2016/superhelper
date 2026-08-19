-- Legal knowledge packs are available to every signed Lily device.
-- Keep this backfill so a pack registered during an earlier rollout cannot
-- accidentally retain the old paid-plan gate.
update legal_knowledge_packs
set min_plan = 'free'
where pack_id = 'legal-cn-enterprise'
  and character_id = 'lily-cn-legal-counsel'
  and min_plan <> 'free';
