BEGIN;

-- CreateTable
CREATE TABLE "order_uploads" (
    "url" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "order_uploads_pkey" PRIMARY KEY ("url")
);

-- CreateIndex
CREATE INDEX "order_uploads_orderId_idx" ON "order_uploads"("orderId");

-- AddForeignKey
ALTER TABLE "order_uploads" ADD CONSTRAINT "order_uploads_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
