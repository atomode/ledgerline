ALTER TABLE "invoices" ADD COLUMN "currency_as_printed" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "default_currency" char(3);