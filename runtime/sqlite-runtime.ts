import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

type BoundValue = string | number | bigint | null | ArrayBuffer | Uint8Array | boolean | undefined;

function normalizedValue(value: BoundValue) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
  return value;
}

function meta(changes = 0, lastRowId: number | bigint = 0) {
  return {
    changed_db: changes > 0,
    changes,
    duration: 0,
    last_row_id: Number(lastRowId),
    rows_read: 0,
    rows_written: changes,
    size_after: 0,
  };
}

class LocalStatement {
  private readonly database: Database.Database;
  private readonly sql: string;
  private readonly values: BoundValue[];

  constructor(database: Database.Database, sql: string, values: BoundValue[] = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: BoundValue[]) {
    return new LocalStatement(this.database, this.sql, values);
  }

  private prepared() {
    return this.database.prepare(this.sql);
  }

  private bindings() {
    return this.values.map(normalizedValue);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const statement = this.prepared();
    if (!statement.reader) {
      statement.run(...this.bindings());
      return null;
    }
    const row = statement.get(...this.bindings()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    const statement = this.prepared();
    if (!statement.reader) {
      const result = statement.run(...this.bindings());
      return { success: true, results: [] as T[], meta: meta(result.changes, result.lastInsertRowid) };
    }
    const results = statement.all(...this.bindings()) as T[];
    return { success: true, results, meta: meta() };
  }

  async run<T = Record<string, unknown>>() {
    const statement = this.prepared();
    if (statement.reader) {
      const results = statement.all(...this.bindings()) as T[];
      return { success: true, results, meta: meta() };
    }
    const result = statement.run(...this.bindings());
    return { success: true, results: [] as T[], meta: meta(result.changes, result.lastInsertRowid) };
  }

  executeForBatch() {
    const statement = this.prepared();
    if (statement.reader) {
      return { success: true, results: statement.all(...this.bindings()), meta: meta() };
    }
    const result = statement.run(...this.bindings());
    return { success: true, results: [], meta: meta(result.changes, result.lastInsertRowid) };
  }
}

class LocalD1 {
  private readonly database: Database.Database;

  constructor(path: string) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.database = new Database(absolutePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
  }

  prepare(sql: string) {
    return new LocalStatement(this.database, sql);
  }

  async batch(statements: LocalStatement[]) {
    return this.database.transaction(() => statements.map((statement) => statement.executeForBatch()))();
  }

  async exec(sql: string) {
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }
}

function safeObjectPath(root: string, key: string) {
  const absoluteRoot = resolve(root);
  const objectPath = resolve(absoluteRoot, key.replaceAll("\\", "/"));
  if (objectPath !== absoluteRoot && !objectPath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error("Invalid media object key");
  }
  return objectPath;
}

class LocalMediaBucket {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  async put(key: string, value: ArrayBuffer | Uint8Array) {
    const path = safeObjectPath(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value));
    return { key };
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    try {
      const bytes = readFileSync(safeObjectPath(this.root, key));
      const body = options?.range
        ? bytes.subarray(options.range.offset, options.range.offset + options.range.length)
        : bytes;
      return {
        body,
        writeHttpMetadata() {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

let localD1: D1Database | undefined;
let localMedia: R2Bucket | undefined;

export function createLocalD1(path: string) {
  localD1 ??= new LocalD1(path) as unknown as D1Database;
  return localD1;
}

export function createLocalMediaBucket(path: string) {
  localMedia ??= new LocalMediaBucket(path) as unknown as R2Bucket;
  return localMedia;
}
