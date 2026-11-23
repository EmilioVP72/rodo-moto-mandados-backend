ALTER TABLE "broadcast_notifications" ADD COLUMN "publishAt" TIMESTAMP(3), ADD COLUMN "publishedAt" TIMESTAMP(3);
UPDATE "broadcast_notifications" SET "publishedAt" = "storedAt" WHERE "scheduledFor" IS NULL;
DO $$
DECLARE campaign RECORD;
DECLARE due TIMESTAMPTZ;
BEGIN
  FOR campaign IN SELECT id, "scheduledFor" FROM "broadcast_notifications" WHERE "scheduledFor" IS NOT NULL LOOP
    BEGIN
      IF campaign."scheduledFor" ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        due := campaign."scheduledFor"::timestamptz;
      ELSE
        due := campaign."scheduledFor"::timestamp AT TIME ZONE 'America/Mexico_City';
      END IF;
      UPDATE "broadcast_notifications" SET "publishAt" = due AT TIME ZONE 'UTC',
        "publishedAt" = CASE WHEN due <= now() THEN due AT TIME ZONE 'UTC' END WHERE id = campaign.id;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE WARNING 'Fecha pendiente de corregir en campaña %', campaign.id;
    END;
  END LOOP;
END $$;
CREATE INDEX "broadcast_notifications_publishedAt_publishAt_idx" ON "broadcast_notifications"("publishedAt","publishAt");
