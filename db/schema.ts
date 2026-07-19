import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  inviteCode: text("invite_code").notNull().unique(),
  invitedBy: text("invited_by"),
    membershipType: text("membership_type").notNull().default("duration"),
    membershipEnd: text("membership_end"),
    verifiedAt: text("verified_at"),
    analyticsEligible: integer("analytics_eligible").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userSessions = sqliteTable(
  "user_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("user_sessions_user_expiry_idx").on(table.userId, table.expiresAt)],
);

export const deviceAccountLinks = sqliteTable(
  "device_account_links",
  {
    deviceHash: text("device_hash").notNull(),
    userId: text("user_id").notNull(),
    firstSeenAt: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("device_account_links_device_user_uq").on(table.deviceHash, table.userId),
    index("device_account_links_user_device_idx").on(table.userId, table.deviceHash),
  ],
);

export const userDailyUsage = sqliteTable(
  "user_daily_usage",
  {
    userId: text("user_id").notNull(),
    dateKey: text("date_key").notNull(),
    practiceCount: integer("practice_count").notNull().default(0),
    audioCount: integer("audio_count").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("user_daily_usage_user_date_uq").on(table.userId, table.dateKey)],
);

export const userDailyAudioAccess = sqliteTable(
  "user_daily_audio_access",
  {
    userId: text("user_id").notNull(),
    dateKey: text("date_key").notNull(),
    assetId: text("asset_id").notNull(),
    grantedAt: text("granted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("user_daily_audio_access_user_date_uq").on(table.userId, table.dateKey),
    index("user_daily_audio_access_asset_idx").on(table.assetId, table.dateKey),
  ],
);

export const dailyCheckins = sqliteTable(
  "daily_checkins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    dateKey: text("date_key").notNull(),
    sessionId: text("session_id"),
    source: text("source").notNull().default("daily_practice"),
    completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("daily_checkins_user_date_uq").on(table.userId, table.dateKey),
    index("daily_checkins_user_completed_idx").on(table.userId, table.completedAt),
  ],
);

export const dailyStepCompletions = sqliteTable(
  "daily_step_completions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    dateKey: text("date_key").notNull(),
    step: text("step").notNull(),
    sourceRef: text("source_ref").notNull().default(""),
    completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("daily_step_completions_user_date_step_uq").on(table.userId, table.dateKey, table.step),
    index("daily_step_completions_user_completed_idx").on(table.userId, table.completedAt),
  ],
);

export const userDailyQueueItems = sqliteTable(
  "user_daily_queue_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    dateKey: text("date_key").notNull(),
    itemType: text("item_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceParentId: text("source_parent_id").notNull().default(""),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    estimatedMinutes: integer("estimated_minutes").notNull().default(5),
    status: text("status").notNull().default("scheduled"),
    origin: text("origin").notNull().default("manual"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("user_daily_queue_items_user_date_source_uq")
      .on(table.userId, table.dateKey, table.itemType, table.sourceId),
    index("user_daily_queue_items_user_date_status_idx")
      .on(table.userId, table.dateKey, table.status, table.sortOrder),
    index("user_daily_queue_items_user_source_idx")
      .on(table.userId, table.itemType, table.sourceId, table.status),
  ],
);

export const userStates = sqliteTable("user_states", {
  userId: text("user_id").primaryKey(),
  progressJson: text("progress_json").notNull().default("{}"),
  version: integer("version").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const redemptionCodes = sqliteTable("redemption_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  codeHash: text("code_hash").notNull().unique(),
  codePreview: text("code_preview").notNull(),
  batchName: text("batch_name").notNull(),
  grantType: text("grant_type").notNull().default("duration"),
  durationDays: integer("duration_days").notNull(),
  channel: text("channel").notNull().default("manual"),
  createdBy: text("created_by").notNull().default("system"),
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
    status: text("status").notNull().default("pending"),
    membershipBeforeType: text("membership_before_type"),
    membershipBeforeEnd: text("membership_before_end"),
    membershipAfterType: text("membership_after_type"),
    membershipAfterEnd: text("membership_after_end"),
    redeemedAt: text("redeemed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [uniqueIndex("redemptions_code_user_uq").on(table.codeId, table.userId)],
);

export const inviteRelations = sqliteTable("invite_relations", {
  inviteeId: text("invitee_id").primaryKey(),
  inviterId: text("inviter_id").notNull(),
  status: text("status").notNull().default("pending"),
  verifiedAt: text("verified_at"),
  firstValidPracticeAt: text("first_valid_practice_at"),
  riskStatus: text("risk_status").notNull().default("clear"),
  inviterGrantId: text("inviter_grant_id"),
  inviteeGrantId: text("invitee_grant_id"),
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

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    grantType: text("grant_type").notNull(),
    durationDays: integer("duration_days"),
    publicPromise: text("public_promise").notNull().default(""),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("products_status_sort_idx").on(table.status, table.sortOrder)],
);

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    orderNo: text("order_no").notNull(),
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull(),
    productName: text("product_name").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    status: text("status").notNull().default("created"),
    channel: text("channel").notNull().default("test"),
    idempotencyKey: text("idempotency_key").notNull(),
    returnContextJson: text("return_context_json").notNull().default("{}"),
    entitlementGrantId: text("entitlement_grant_id"),
    paidAt: text("paid_at"),
    closedAt: text("closed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("orders_order_no_uq").on(table.orderNo),
    uniqueIndex("orders_user_idempotency_uq").on(table.userId, table.idempotencyKey),
    index("orders_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const paymentTransactions = sqliteTable(
  "payment_transactions",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    provider: text("provider").notNull().default("test"),
    providerTransactionId: text("provider_transaction_id").notNull(),
    callbackId: text("callback_id").notNull(),
    eventType: text("event_type").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    status: text("status").notNull().default("received"),
    rawPayloadJson: text("raw_payload_json").notNull().default("{}"),
    processedAt: text("processed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("payment_transactions_provider_tx_uq").on(table.provider, table.providerTransactionId),
    uniqueIndex("payment_transactions_callback_uq").on(table.provider, table.callbackId),
    index("payment_transactions_order_idx").on(table.orderId, table.createdAt),
  ],
);

export const refunds = sqliteTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    transactionId: text("transaction_id"),
    provider: text("provider").notNull().default("test"),
    providerRefundId: text("provider_refund_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    status: text("status").notNull().default("created"),
    reason: text("reason").notNull().default(""),
    processedAt: text("processed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("refunds_provider_refund_uq").on(table.provider, table.providerRefundId),
    uniqueIndex("refunds_idempotency_uq").on(table.idempotencyKey),
    index("refunds_order_idx").on(table.orderId, table.createdAt),
  ],
);

export const entitlementGrants = sqliteTable(
  "entitlement_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: text("product_id"),
    orderId: text("order_id"),
    grantType: text("grant_type").notNull(),
    durationDays: integer("duration_days").notNull().default(0),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    status: text("status").notNull().default("active"),
    grantedAt: text("granted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason").notNull().default(""),
  },
  (table) => [
    uniqueIndex("entitlement_grants_source_uq").on(table.userId, table.sourceType, table.sourceId),
    index("entitlement_grants_user_status_idx").on(table.userId, table.status),
  ],
);

export const configs = sqliteTable("configs", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const adminUsers = sqliteTable(
  "admin_users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordIterations: integer("password_iterations").notNull().default(210000),
    role: text("role").notNull().default("read_only"),
    status: text("status").notNull().default("active"),
    lastLoginAt: text("last_login_at"),
    createdBy: integer("created_by"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("admin_users_username_uq").on(table.username),
    index("admin_users_status_role_idx").on(table.status, table.role),
  ],
);

export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    adminUserId: integer("admin_user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    ipAddress: text("ip_address").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("admin_sessions_token_hash_uq").on(table.tokenHash),
    index("admin_sessions_user_expiry_idx").on(table.adminUserId, table.expiresAt),
  ],
);

export const adminAuditLogs = sqliteTable(
  "admin_audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    adminUserId: integer("admin_user_id"),
    username: text("username").notNull().default("system"),
    role: text("role").notNull().default("system"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull().default("system"),
    resourceId: text("resource_id").notNull().default(""),
    summary: text("summary").notNull().default(""),
    result: text("result").notNull().default("success"),
    detailsJson: text("details_json").notNull().default("{}"),
    ipAddress: text("ip_address").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("admin_audit_logs_user_time_idx").on(table.adminUserId, table.createdAt),
    index("admin_audit_logs_action_time_idx").on(table.action, table.createdAt),
  ],
);

export const contentItems = sqliteTable(
  "content_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentType: text("content_type").notNull(),
    contentKey: text("content_key").notNull().unique(),
    title: text("title").notNull(),
    payloadJson: text("payload_json").notNull(),
    accessLevel: text("access_level").notNull().default("member"),
    status: text("status").notNull().default("draft"),
    publishAt: text("publish_at"),
    reviewNote: text("review_note").notNull().default(""),
    submittedBy: integer("submitted_by"),
    submittedAt: text("submitted_at"),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("content_items_key_uq").on(table.contentKey)],
);

export const contentItemVersions = sqliteTable(
  "content_item_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentId: integer("content_id").notNull(),
    version: integer("version").notNull(),
    contentType: text("content_type").notNull(),
    contentKey: text("content_key").notNull(),
    title: text("title").notNull(),
    payloadJson: text("payload_json").notNull(),
    accessLevel: text("access_level").notNull().default("member"),
    status: text("status").notNull(),
    publishAt: text("publish_at"),
    changeType: text("change_type").notNull().default("update"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("content_item_versions_content_version_uq").on(table.contentId, table.version),
    index("content_item_versions_content_idx").on(table.contentId, table.createdAt),
  ],
);

export const contentImports = sqliteTable(
  "content_imports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentType: text("content_type").notNull(),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size").notNull().default(0),
    fileHash: text("file_hash").notNull(),
    sourceName: text("source_name").notNull().default(""),
    sourceUrl: text("source_url").notNull().default(""),
    sourcePublishedAt: text("source_published_at"),
    dataVersion: text("data_version").notNull().default(""),
    duplicateStrategy: text("duplicate_strategy").notNull().default("reject"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    totalRows: integer("total_rows").notNull().default(0),
    uploadedRows: integer("uploaded_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    totalChunks: integer("total_chunks").notNull().default(0),
    uploadedChunks: integer("uploaded_chunks").notNull().default(0),
    processedChunks: integer("processed_chunks").notNull().default(0),
    cancelRequested: integer("cancel_requested").notNull().default(0),
    status: text("status").notNull().default("uploading"),
    errorSummary: text("error_summary").notNull().default(""),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    nextRetryAt: text("next_retry_at"),
    reviewStatus: text("review_status").notNull().default("draft"),
    createdBy: integer("created_by"),
    submittedBy: integer("submitted_by"),
    submittedAt: text("submitted_at"),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    reviewNote: text("review_note").notNull().default(""),
    publishedAt: text("published_at"),
    rolledBackAt: text("rolled_back_at"),
    sealedAt: text("sealed_at"),
    startedAt: text("started_at"),
    lastHeartbeatAt: text("last_heartbeat_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("content_imports_status_idx").on(table.status, table.updatedAt),
    index("content_imports_hash_idx").on(table.fileHash, table.createdAt),
  ],
);

export const contentImportChunks = sqliteTable(
  "content_import_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importId: integer("import_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    rowOffset: integer("row_offset").notNull(),
    rowCount: integer("row_count").notNull(),
    payloadHash: text("payload_hash").notNull(),
    rowsJson: text("rows_json").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    errorSummary: text("error_summary").notNull().default(""),
    leaseToken: text("lease_token"),
    leaseUntil: text("lease_until"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("content_import_chunks_import_index_uq").on(table.importId, table.chunkIndex),
    index("content_import_chunks_status_idx").on(table.importId, table.status, table.chunkIndex),
  ],
);

export const contentImportRowResults = sqliteTable(
  "content_import_row_results",
  {
    importId: integer("import_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    status: text("status").notNull(),
    contentKey: text("content_key").notNull().default(""),
    contentVersion: integer("content_version"),
    message: text("message").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("content_import_row_results_import_row_uq").on(table.importId, table.rowIndex),
    index("content_import_row_results_status_idx").on(table.importId, table.status),
  ],
);

export const contentImportKeys = sqliteTable(
  "content_import_keys",
  {
    importId: integer("import_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    contentKey: text("content_key").notNull(),
  },
  (table) => [
    uniqueIndex("content_import_keys_import_row_uq").on(table.importId, table.rowIndex),
    uniqueIndex("content_import_keys_import_key_uq").on(table.importId, table.contentKey),
  ],
);

export const contentImportErrors = sqliteTable(
  "content_import_errors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importId: integer("import_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    rowIndex: integer("row_index").notNull(),
    contentKey: text("content_key").notNull().default(""),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    rawJson: text("raw_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("content_import_errors_import_row_kind_uq").on(table.importId, table.rowIndex, table.kind),
    index("content_import_errors_import_idx").on(table.importId, table.rowIndex),
  ],
);

export const contentReports = sqliteTable(
  "content_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    contentType: text("content_type").notNull().default("question"),
    contentKey: text("content_key").notNull(),
    reasonCode: text("reason_code").notNull(),
    detail: text("detail").notNull().default(""),
    contextJson: text("context_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    resolvedBy: integer("resolved_by"),
    resolutionNote: text("resolution_note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    uniqueIndex("content_reports_open_uq")
      .on(table.userId, table.contentType, table.contentKey, table.reasonCode)
      .where(sql`${table.status} = 'pending'`),
    index("content_reports_status_time_idx").on(table.status, table.createdAt),
    index("content_reports_user_time_idx").on(table.userId, table.createdAt),
    index("content_reports_content_idx").on(table.contentType, table.contentKey),
  ],
);

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    objectKey: text("object_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    storage: text("storage").notNull().default("r2"),
    fallbackData: text("fallback_data"),
    accessLevel: text("access_level").notNull().default("member"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("media_assets_status_idx").on(table.status, table.createdAt)],
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

export const quizTests = sqliteTable(
  "quiz_tests",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    questionCount: integer("question_count").notNull().default(10),
    status: text("status").notNull().default("draft"),
    shareTitle: text("share_title").notNull().default(""),
    disclaimer: text("disclaimer").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("quiz_tests_slug_uq").on(table.slug),
    index("quiz_tests_status_idx").on(table.status, table.updatedAt),
  ],
);

export const quizQuestions = sqliteTable(
  "quiz_questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quizId: text("quiz_id").notNull(),
    questionCode: text("question_code").notNull(),
    stem: text("stem").notNull(),
    optionsJson: text("options_json").notNull().default("[]"),
    correctIndex: integer("correct_index").notNull().default(0),
    explanation: text("explanation").notNull().default(""),
    category: text("category").notNull().default("办公室语言"),
    difficulty: text("difficulty").notNull().default("medium"),
    weight: integer("weight").notNull().default(10),
    status: text("status").notNull().default("draft"),
    reviewStatus: text("review_status").notNull().default("pending_review"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("quiz_questions_code_uq").on(table.questionCode),
    index("quiz_questions_quiz_status_idx").on(table.quizId, table.status, table.reviewStatus),
    index("quiz_questions_category_idx").on(table.quizId, table.category),
  ],
);

export const quizResultLevels = sqliteTable(
  "quiz_result_levels",
  {
    id: text("id").primaryKey(),
    quizId: text("quiz_id").notNull(),
    levelKey: text("level_key").notNull(),
    title: text("title").notNull(),
    minScore: integer("min_score").notNull(),
    maxScore: integer("max_score").notNull(),
    theme: text("theme").notNull().default("blue"),
    description: text("description").notNull().default(""),
    shareText: text("share_text").notNull().default(""),
    badgeLabel: text("badge_label").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default("active"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("quiz_result_levels_quiz_key_uq").on(table.quizId, table.levelKey),
    index("quiz_result_levels_quiz_score_idx").on(table.quizId, table.minScore, table.maxScore),
  ],
);

export const quizAttempts = sqliteTable(
  "quiz_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    quizId: text("quiz_id").notNull(),
    challengeId: text("challenge_id").notNull().default(""),
    sourceAttemptId: text("source_attempt_id").notNull().default(""),
    questionIdsJson: text("question_ids_json").notNull().default("[]"),
    optionOrdersJson: text("option_orders_json").notNull().default("[]"),
    answersJson: text("answers_json").notNull().default("{}"),
    correctCount: integer("correct_count"),
    resultKey: text("result_key").notNull().default(""),
    status: text("status").notNull().default("active"),
    startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
    shareCount: integer("share_count").notNull().default(0),
  },
  (table) => [
    index("quiz_attempts_user_time_idx").on(table.userId, table.startedAt),
    index("quiz_attempts_quiz_status_idx").on(table.quizId, table.status, table.completedAt),
    index("quiz_attempts_source_idx").on(table.sourceAttemptId),
  ],
);

export const quizShareEvents = sqliteTable(
  "quiz_share_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    quizId: text("quiz_id").notNull(),
    attemptId: text("attempt_id").notNull().default(""),
    challengeId: text("challenge_id").notNull().default(""),
    eventName: text("event_name").notNull(),
    eventData: text("event_data").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("quiz_share_events_quiz_time_idx").on(table.quizId, table.createdAt),
    index("quiz_share_events_attempt_idx").on(table.attemptId, table.eventName),
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
  paperType: text("paper_type").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  resourceUrl: text("resource_url").notNull().default(""),
  libraryEnabled: integer("library_enabled").notNull().default(0),
  libraryAccessLevel: text("library_access_level").notNull().default("free"),
  libraryStatus: text("library_status").notNull().default("draft"),
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
    sourceExamType: text("source_exam_type").notNull().default(""),
    sourceRegion: text("source_region").notNull().default("全国"),
    sourceYear: integer("source_year"),
    sourceBatch: text("source_batch").notNull().default(""),
    truthVerified: integer("truth_verified").notNull().default(0),
    truthVerifiedAt: text("truth_verified_at"),
    reviewStatus: text("review_status").notNull().default("pending_review"),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    reviewNote: text("review_note").notNull().default(""),
    frequency: text("frequency").notNull().default("中频"),
    frequencyOccurrences: integer("frequency_occurrences").notNull().default(0),
    frequencyPapers: integer("frequency_papers").notNull().default(0),
    frequencyYearsJson: text("frequency_years_json").notNull().default("[]"),
    frequencyUpdatedAt: text("frequency_updated_at"),
    importanceStars: integer("importance_stars").notNull().default(3),
    importanceRuleVersion: text("importance_rule_version").notNull().default(""),
    importanceReason: text("importance_reason").notNull().default(""),
    importanceOverrideReason: text("importance_override_reason").notNull().default(""),
    scoreRate: integer("score_rate").notNull().default(60),
    scoreRateCorrect: integer("score_rate_correct").notNull().default(0),
    scoreRateAttempts: integer("score_rate_attempts").notNull().default(0),
    scoreRateScope: text("score_rate_scope").notNull().default(""),
    scoreRateSource: text("score_rate_source").notNull().default("platform"),
    scoreRateUpdatedAt: text("score_rate_updated_at"),
    suggestedSeconds: integer("suggested_seconds").notNull().default(60),
    imageUrl: text("image_url").notNull().default(""),
    resourceUrl: text("resource_url").notNull().default(""),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
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
    questionNumber: text("question_number").notNull().default(""),
    score: integer("score"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("question_bank_items_bank_question_uq").on(table.bankId, table.questionId),
    index("question_bank_items_bank_idx").on(table.bankId, table.sortOrder),
  ],
);

export const essayLibraryMaterials = sqliteTable(
  "essay_library_materials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bankId: integer("bank_id").notNull(),
    label: text("label").notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("essay_library_materials_bank_label_uq").on(table.bankId, table.label),
    index("essay_library_materials_bank_sort_idx").on(table.bankId, table.status, table.sortOrder),
  ],
);

export const essayLibraryQuestionMaterials = sqliteTable(
  "essay_library_question_materials",
  {
    questionId: integer("question_id").notNull(),
    materialId: integer("material_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("essay_library_question_materials_uq").on(table.questionId, table.materialId),
    index("essay_library_question_materials_question_idx").on(table.questionId, table.sortOrder),
  ],
);

export const essayAnswerSources = sqliteTable(
  "essay_answer_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceKey: text("source_key").notNull(),
    name: text("name").notNull(),
    homepageUrl: text("homepage_url").notNull().default(""),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("essay_answer_sources_key_uq").on(table.sourceKey),
    index("essay_answer_sources_status_sort_idx").on(table.status, table.sortOrder),
  ],
);

export const essayReferenceAnswers = sqliteTable(
  "essay_reference_answers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionId: integer("question_id").notNull(),
    sourceId: integer("source_id").notNull(),
    sourceTitle: text("source_title").notNull().default(""),
    displayMode: text("display_mode").notNull().default("link_only"),
    content: text("content").notNull().default(""),
    excerpt: text("excerpt").notNull().default(""),
    sourceUrl: text("source_url").notNull().default(""),
    copyrightStatus: text("copyright_status").notNull().default("pending_verification"),
    publicationStatus: text("publication_status").notNull().default("draft"),
    sortOrder: integer("sort_order").notNull().default(0),
    originalPublishedAt: text("original_published_at"),
    collectedAt: text("collected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdBy: integer("created_by"),
    updatedBy: integer("updated_by"),
    publishedAt: text("published_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("essay_reference_answers_question_source_uq").on(table.questionId, table.sourceId),
    index("essay_reference_answers_question_status_idx").on(table.questionId, table.publicationStatus, table.sortOrder),
    index("essay_reference_answers_source_idx").on(table.sourceId, table.publicationStatus),
  ],
);

export const questionImports = sqliteTable("question_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bankId: integer("bank_id").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  fileHash: text("file_hash").notNull().default(""),
  duplicateStrategy: text("duplicate_strategy").notNull().default("reject"),
  totalRows: integer("total_rows").notNull().default(0),
  uploadedRows: integer("uploaded_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  importedRows: integer("imported_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  totalChunks: integer("total_chunks").notNull().default(0),
  uploadedChunks: integer("uploaded_chunks").notNull().default(0),
  processedChunks: integer("processed_chunks").notNull().default(0),
  cancelRequested: integer("cancel_requested").notNull().default(0),
  status: text("status").notNull().default("uploading"),
  errorSummary: text("error_summary").notNull().default(""),
  createdBy: integer("created_by"),
  sealedAt: text("sealed_at"),
  startedAt: text("started_at"),
  lastHeartbeatAt: text("last_heartbeat_at"),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

export const questionImportChunks = sqliteTable(
  "question_import_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importId: integer("import_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    rowOffset: integer("row_offset").notNull(),
    rowCount: integer("row_count").notNull(),
    payloadHash: text("payload_hash").notNull(),
    rowsJson: text("rows_json").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    errorSummary: text("error_summary").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("question_import_chunks_import_index_uq").on(table.importId, table.chunkIndex),
    index("question_import_chunks_status_idx").on(table.importId, table.status, table.chunkIndex),
  ],
);

export const questionImportCodes = sqliteTable(
  "question_import_codes",
  {
    importId: integer("import_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    rowNumber: integer("row_number").notNull(),
    questionCode: text("question_code").notNull(),
    baseVersion: integer("base_version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("question_import_codes_import_row_uq").on(table.importId, table.rowNumber),
    index("question_import_codes_code_idx").on(table.importId, table.questionCode),
  ],
);

export const questionImportRowResults = sqliteTable(
  "question_import_row_results",
  {
    importId: integer("import_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    status: text("status").notNull(),
    questionCode: text("question_code").notNull().default(""),
    questionVersion: integer("question_version"),
    message: text("message").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("question_import_row_results_import_row_uq").on(table.importId, table.rowNumber),
    index("question_import_row_results_status_idx").on(table.importId, table.status),
  ],
);

export const questionImportErrors = sqliteTable(
  "question_import_errors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importId: integer("import_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    rowNumber: integer("row_number").notNull(),
    questionCode: text("question_code").notNull().default(""),
    kind: text("kind").notNull().default("validation"),
    message: text("message").notNull(),
    rawJson: text("raw_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("question_import_errors_import_row_uq").on(table.importId, table.rowNumber),
    index("question_import_errors_import_idx").on(table.importId, table.rowNumber),
  ],
);

export const questionVersions = sqliteTable(
  "question_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionId: integer("question_id").notNull(),
    version: integer("version").notNull(),
    questionCode: text("question_code").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    changeType: text("change_type").notNull().default("import"),
    importId: integer("import_id"),
    sourceRow: integer("source_row"),
    fromVersion: integer("from_version"),
    adminUserId: integer("admin_user_id"),
    reviewStatus: text("review_status").notNull().default("pending_review"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("question_versions_question_version_uq").on(table.questionId, table.version),
    uniqueIndex("question_versions_import_row_uq").on(table.importId, table.sourceRow),
    index("question_versions_question_idx").on(table.questionId, table.createdAt),
  ],
);

export const userExamProfiles = sqliteTable("user_exam_profiles", {
  userId: text("user_id").primaryKey(),
  examType: text("exam_type").notNull().default("国考"),
  province: text("province").notNull().default(""),
  examYear: integer("exam_year").notNull().default(2027),
  examDate: text("exam_date"),
  dailyMinutes: integer("daily_minutes").notNull().default(30),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userExamTargets = sqliteTable(
  "user_exam_targets",
  {
    userId: text("user_id").notNull(),
    targetCode: text("target_code").notNull(),
    examType: text("exam_type").notNull(),
    province: text("province").notNull().default(""),
    examYear: integer("exam_year").notNull(),
    examDate: text("exam_date"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("user_exam_targets_user_target_uq").on(table.userId, table.targetCode),
    index("user_exam_targets_user_idx").on(table.userId, table.createdAt),
  ],
);

export const userQuestionBanks = sqliteTable(
  "user_question_banks",
  {
    userId: text("user_id").notNull(),
    bankCode: text("bank_code").notNull(),
    addedAt: text("added_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("user_question_banks_user_bank_uq").on(table.userId, table.bankCode),
    index("user_question_banks_user_idx").on(table.userId, table.addedAt),
  ],
);

export const userQuestionProgress = sqliteTable(
  "user_question_progress",
  {
    userId: text("user_id").notNull(),
    questionCode: text("question_code").notNull(),
    state: text("state").notNull().default("learning"),
    correctCount: integer("correct_count").notNull().default(0),
    wrongCount: integer("wrong_count").notNull().default(0),
    uncertainCount: integer("uncertain_count").notNull().default(0),
    lastAnswer: integer("last_answer"),
    lastCorrect: integer("last_correct").notNull().default(0),
    lastDurationMs: integer("last_duration_ms").notNull().default(0),
    lastAnsweredAt: text("last_answered_at"),
    nextReviewAt: text("next_review_at"),
    favorite: integer("favorite").notNull().default(0),
    wrongReason: text("wrong_reason").notNull().default(""),
    reviewCount: integer("review_count").notNull().default(0),
    reviewStage: integer("review_stage").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("user_question_progress_user_question_uq").on(table.userId, table.questionCode),
    index("user_question_progress_due_idx").on(table.userId, table.nextReviewAt),
    index("user_question_progress_state_idx").on(table.userId, table.state),
  ],
);

export const practiceAttempts = sqliteTable(
  "practice_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    attemptKey: text("attempt_key"),
    practiceSessionId: text("practice_session_id"),
    userId: text("user_id").notNull(),
    questionCode: text("question_code").notNull(),
    bankCode: text("bank_code").notNull(),
    module: text("module").notNull(),
    selectedAnswer: integer("selected_answer"),
    isCorrect: integer("is_correct").notNull(),
    uncertain: integer("uncertain").notNull().default(0),
    confidence: text("confidence").notNull().default("confident"),
    wrongReason: text("wrong_reason").notNull().default(""),
    overtime: integer("overtime").notNull().default(0),
    wasDue: integer("was_due").notNull().default(0),
    applyStatus: text("apply_status").notNull().default("applied"),
    durationMs: integer("duration_ms").notNull().default(0),
    answeredAt: text("answered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("practice_attempts_user_key_uq").on(table.userId, table.attemptKey),
    uniqueIndex("practice_attempts_session_question_uq").on(table.userId, table.practiceSessionId, table.questionCode)
      .where(sql`${table.practiceSessionId} is not null`),
    index("practice_attempts_user_time_idx").on(table.userId, table.answeredAt),
    index("practice_attempts_user_module_idx").on(table.userId, table.module),
  ],
);

export const practiceSessions = sqliteTable(
  "practice_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    dateKey: text("date_key").notNull(),
    kind: text("kind").notNull(),
    mode: text("mode").notNull().default("mixed"),
    status: text("status").notNull().default("active"),
    planMinutes: integer("plan_minutes").notNull().default(30),
    targetCount: integer("target_count").notNull().default(0),
    bankCodesJson: text("bank_codes_json").notNull().default("[]"),
    questionCodesJson: text("question_codes_json").notNull().default("[]"),
    answeredCount: integer("answered_count").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    reviewAdded: integer("review_added").notNull().default(0),
    elapsedSeconds: integer("elapsed_seconds").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("practice_sessions_user_date_idx").on(table.userId, table.dateKey),
    index("practice_sessions_status_idx").on(table.userId, table.status),
    uniqueIndex("practice_sessions_active_uq").on(table.userId, table.dateKey, table.kind, table.mode)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const essayAttempts = sqliteTable(
  "essay_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    questionCode: text("question_code").notNull(),
    dateKey: text("date_key").notNull(),
    stage: text("stage").notNull().default("draft"),
    firstDraft: text("first_draft").notNull().default(""),
    selfChecksJson: text("self_checks_json").notNull().default("[]"),
    selfScore: integer("self_score"),
    lossReasonsJson: text("loss_reasons_json").notNull().default("[]"),
    revisedDraft: text("revised_draft").notNull().default(""),
    rewriteDraft: text("rewrite_draft").notNull().default(""),
    elapsedSeconds: integer("elapsed_seconds").notNull().default(0),
    rewriteDueAt: text("rewrite_due_at"),
    submittedAt: text("submitted_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("essay_attempts_user_question_date_uq").on(table.userId, table.questionCode, table.dateKey),
    index("essay_attempts_rewrite_due_idx").on(table.userId, table.rewriteDueAt),
  ],
);
