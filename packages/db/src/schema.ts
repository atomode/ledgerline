import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Placeholder: the full schema arrives in step 3 (data). Kept so drizzle-kit has a target.
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
