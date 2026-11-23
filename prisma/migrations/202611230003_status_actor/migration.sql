BEGIN;

-- AlterTable
ALTER TABLE "order_status_history" ADD COLUMN     "changedByRole" "UserRole";

COMMIT;
