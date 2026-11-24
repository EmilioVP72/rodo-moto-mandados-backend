BEGIN;

CREATE TABLE "riders" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO riders (id, "userId", name, phone, "createdAt")
SELECT id, id, name, phone, "createdAt" FROM users WHERE role = 'RIDER';

-- Keep the first linked slot on the account. Other configured numbers remain WhatsApp contacts.
CREATE TEMP TABLE rider_slots ON COMMIT DROP AS
SELECT slot, pos, u.id AS uid, row_number() OVER (PARTITION BY u.id ORDER BY pos) AS link_number
FROM settings s
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(s.payload->'ridersList') = 'array' AND s.payload->'ridersList' <> '[]'::jsonb
       THEN s.payload->'ridersList'
       ELSE jsonb_build_array(
         jsonb_build_object('name',s.payload->>'defaultRider1Name','phone',s.payload->>'defaultRider1Phone'),
         jsonb_build_object('name',s.payload->>'defaultRider2Name','phone',s.payload->>'defaultRider2Phone'))
  END
) WITH ORDINALITY AS entry(slot,pos)
LEFT JOIN users u ON u.id = slot->>'userId' AND u.role = 'RIDER'
WHERE s.id = 'general' AND (u.id IS NOT NULL OR trim(coalesce(slot->>'phone','')) <> '');

UPDATE riders r SET name = coalesce(nullif(trim(slot->>'name'),''), r.name),
  phone = coalesce(nullif(trim(slot->>'phone'),''), r.phone),
  available = coalesce(slot->>'isActive','true') <> 'false'
FROM rider_slots WHERE uid = r.id AND link_number = 1;

INSERT INTO riders (id, name, phone, available)
SELECT 'legacy-contact-' || pos, coalesce(nullif(trim(slot->>'name'),''),'Contacto ' || pos),
       trim(slot->>'phone'), coalesce(slot->>'isActive','true') <> 'false'
FROM rider_slots WHERE (uid IS NULL OR link_number > 1) AND trim(coalesce(slot->>'phone','')) <> '';

COMMIT;
