-- Preserve localized skill package metadata in the server-managed registry.
-- Without these columns, refreshing skills from production downgrades English/Arabic
-- clients to Chinese fallback labels even when local manifests include i18n.
alter table skill_packages
  add column if not exists name_i18n jsonb,
  add column if not exists description_i18n jsonb,
  add column if not exists category_label_i18n jsonb;
