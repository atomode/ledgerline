ALTER TABLE "invoices" ADD COLUMN "vendor_tax_id_raw" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "review_flags" text[] DEFAULT '{}'::text[] NOT NULL;