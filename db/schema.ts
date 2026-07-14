import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  inviteCode: text("invite_code").notNull().unique(),
  invitedBy: text("invited_by"),
  membershipEnd: text("membership_end"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userStates = sqliteTable("user_states", {
  userId: text("user_id").primaryKey(),
  progressJson: text("progress_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const redemptionCodes = sqliteTable("redemption_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  codeHash: text("code_hash").notNull().unique(),
  codePreview: text("code_preview").notNull(),
  batchName: text("batch_name").notNull(),
  durationDays: integer("duration_days").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  status: text("status").notNull().default("active"),
  validFrom: text("valid_from"),
  validUntil: text("valid_until"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const redemptions = sqliteTable(
  "redemptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    codeId: integer("code_id").notNull(),
    userId: text("user_id").notNull(),
    redeemedAt: text("redeemed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("redemptions_code_user_uq").on(table.codeId, table.userId)],
);

export const inviteRelations = sqliteTable("invite_relations", {
  inviteeId: text("invitee_id").primaryKey(),
  inviterId: text("inviter_id").notNull(),
  status: text("status").notNull().default("pending"),
  boundAt: text("bound_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  rewardedAt: text("rewarded_at"),
});

export const membershipLedger = sqliteTable(
  "membership_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    deltaDays: integer("delta_days").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("membership_ledger_source_uq").on(table.userId, table.sourceType, table.sourceId)],
);

export const configs = sqliteTable("configs", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const contentItems = sqliteTable(
  "content_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentType: text("content_type").notNull(),
    contentKey: text("content_key").notNull().unique(),
    title: text("title").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("draft"),
    publishAt: text("publish_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("content_items_key_uq").on(table.contentKey)],
);

export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    eventName: text("event_name").notNull(),
    eventData: text("event_data").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("analytics_events_name_time_idx").on(table.eventName, table.createdAt),
    index("analytics_events_user_time_idx").on(table.userId, table.createdAt),
  ],
);

export const questionBanks = sqliteTable("question_banks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bankCode: text("bank_code").notNull().unique(),
  name: text("name").notNull(),
  examType: text("exam_type").notNull(),
  province: text("province"),
  examYear: integer("exam_year"),
  subject: text("subject").notNull(),
  description: text("description").notNull().default(""),
  coverColor: text("cover_color").notNull().default("blue"),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const questions = sqliteTable(
  "questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionCode: text("question_code").notNull().unique(),
    subject: text("subject").notNull(),
    module: text("module").notNull(),
    subType: text("sub_type").notNull().default(""),
    stem: text("stem").notNull(),
    optionsJson: text("options_json").notNull().default("[]"),
    answer: text("answer"),
    explanation: text("explanation").notNull().default(""),
    technique: text("technique").notNull().default(""),
    material: text("material").notNull().default(""),
    prompt: text("prompt").notNull().default(""),
    wordLimit: integer("word_limit"),
    scoringPointsJson: text("scoring_points_json").notNull().default("[]"),
    difficulty: text("difficulty").notNull().default("中等"),
    source: text("source").notNull().default(""),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("questions_subject_module_idx").on(table.subject, table.module)],
);

export const questionBankItems = sqliteTable(
  "question_bank_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bankId: integer("bank_id").notNull(),
    questionId: integer("question_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("question_bank_items_bank_question_uq").on(table.bankId, table.questionId),
    index("question_bank_items_bank_idx").on(table.bankId, table.sortOrder),
  ],
);

export const questionImports = sqliteTable("question_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bankId: integer("bank_id").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  totalRows: integer("total_rows").notNull().default(0),
  importedRows: integer("imported_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  status: text("status").notNull().default("processing"),
  errorSummary: text("error_summary").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});
