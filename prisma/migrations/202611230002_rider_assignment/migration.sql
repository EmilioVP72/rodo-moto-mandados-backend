BEGIN;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "assignedRiderUserId" TEXT;

-- CreateIndex
CREATE INDEX "orders_assignedRiderUserId_status_idx" ON "orders"("assignedRiderUserId", "status");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_assignedRiderUserId_fkey" FOREIGN KEY ("assignedRiderUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
