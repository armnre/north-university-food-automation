ALTER TYPE "employee_kind" ADD VALUE IF NOT EXISTS 'Visiting';--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "kind" SET DEFAULT 'Faculty';
