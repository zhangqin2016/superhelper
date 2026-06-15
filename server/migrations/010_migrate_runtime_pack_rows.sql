-- Forward-migrate pre-rename document pack rows into runtime_packs.
-- Keep the old table intact so a server rollback can still resolve old clients.
do $$
begin
  if to_regclass('public.document_packs') is not null then
    insert into runtime_packs (
      id,
      pack_id,
      platform,
      url,
      sha256,
      version,
      size_bytes,
      enabled,
      created_at
    )
    select
      id,
      pack_id,
      platform,
      url,
      sha256,
      version,
      size_bytes,
      enabled,
      created_at
    from document_packs
    on conflict (pack_id, platform, version) do nothing;
  end if;
end $$;
