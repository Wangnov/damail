-- 分类、提示词、标签：只新增表，不改现有表。categories / prompts 是系统内置内容的副本（启动时从代码同步，只读），
-- labels / label_suggestions 按语言存名称和说明（i18n jsonb）。见 docs/labels.md


CREATE TABLE "categories" (
	"key" text PRIMARY KEY NOT NULL,
	"i18n" jsonb NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL,
	"builtin" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "label_suggestions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "label_suggestions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"i18n" jsonb NOT NULL,
	"color" text NOT NULL,
	"message_ids" bigint[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"label_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"i18n" jsonb NOT NULL,
	"color" text NOT NULL,
	"pinned" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_labels" (
	"message_id" bigint NOT NULL,
	"label_id" integer NOT NULL,
	"source" text NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_labels_message_id_label_id_pk" PRIMARY KEY("message_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"key" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"vars" text[] NOT NULL,
	"text" jsonb NOT NULL,
	"position" integer NOT NULL,
	"builtin" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "label_suggestions" ADD CONSTRAINT "label_suggestions_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_suggestions_status" ON "label_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "message_labels_label" ON "message_labels" USING btree ("label_id","message_id") WHERE NOT "message_labels"."removed";