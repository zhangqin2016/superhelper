-- Machine-readable skill capability contracts for routing, broker scoping,
-- verification, and client-side capability explanations.
alter table skill_packages
  add column if not exists capability_contract jsonb;
