-- =====================================================================
-- 004_storage.sql — Justificatifs (photos) dans un bucket PRIVÉ Supabase Storage.
-- Chemin des objets : <expense_id>/<nom-fichier>. Accès par URL signée uniquement.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists receipts_read on storage.objects;
create policy receipts_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.is_authorized());

drop policy if exists receipts_insert on storage.objects;
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_authorized());
-- Pas de policy update/delete : un justificatif déposé ne peut pas être remplacé ni supprimé.
