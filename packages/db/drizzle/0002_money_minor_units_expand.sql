ALTER TABLE "invoices" ADD COLUMN "subtotal_minor" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_minor" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount_minor" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "total_minor" bigint;--> statement-breakpoint
CREATE INDEX "invoices_minor_backfill_idx" ON "invoices" USING btree ("id") WHERE "invoices"."total_minor" IS NULL AND "invoices"."amount" IS NOT NULL;