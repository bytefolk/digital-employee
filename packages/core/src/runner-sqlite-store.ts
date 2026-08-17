/**
 * SQLite-backed durable store for the Runner (node:sqlite, zero deps).
 *
 * Persists deployments, task attempts (with fencing), and the event/receipt
 * outbox so that a restarted Runner cannot reopen the replay window and never
 * loses a signed event or receipt before delivery.
 *
 * Security invariant (inherited from RunnerDurableStorePort): records never
 * contain Host credentials, private model output, chain-of-thought, or
 * platform-supplied filesystem paths.
 */

import { mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { CoreError } from "./contracts.js"
import {
  DURABLE_OUTBOX_COMPACTION_THRESHOLD,
  DURABLE_OUTBOX_MAX_RETRIES,
  DURABLE_OUTBOX_MAX_SIZE,
  DURABLE_STORE_MAX_DEPLOYMENTS,
  DURABLE_STORE_SCHEMA_VERSION,
} from "./runner-durable-store.js"
import type {
  DurableStoreCorruption,
  DurableStoreDegradedState,
  OutboxEntryKind,
  RunnerAttemptState,
  RunnerDeploymentRecord,
  RunnerDurableStorePort,
  RunnerOutbox,
  RunnerOutboxEntry,
} from "./runner-durable-store.js"

interface SqliteOutboxRow {
  sequence: number
  kind: OutboxEntryKind
  task_id: string
  fencing_token: number
  payload: string
  status: RunnerOutboxEntry["status"]
  retry_count: number
  next_retry_at: string | null
  created_at: string
}

function outboxRowToEntry(row: SqliteOutboxRow): RunnerOutboxEntry {
  return {
    sequence: row.sequence,
    kind: row.kind,
    taskId: row.task_id,
    fencingToken: row.fencing_token,
    payload: row.payload,
    status: row.status,
    retryCount: row.retry_count,
    ...(row.next_retry_at !== null ? { nextRetryAt: row.next_retry_at } : {}),
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Process-level single-active lock
// ---------------------------------------------------------------------------

/**
 * Owner identity of the process-level runner lock. `startedAt` is an opaque
 * ownership token for CAS release/steal; liveness is decided by `pid` only.
 */
export interface RunnerLockHolder {
  pid: number
  startedAt: string
}

export type RunnerLockAcquireResult =
  | { acquired: true; stolen: boolean }
  | { acquired: false; holder: RunnerLockHolder }

/**
 * SQLite durable store. One database file; WAL journal; foreign keys on.
 * All port operations are synchronous under the hood but exposed through the
 * same async port surface for drop-in compatibility.
 */
export class SqliteDurableStore implements RunnerDurableStorePort {
  readonly #db: DatabaseSync
  readonly #file: string

  constructor(filePath: string) {
    if (!filePath || typeof filePath !== "string") {
      throw new CoreError("DURABLE_STORE_INVALID_PATH", "SQLite store path required", {
        retryable: false,
      })
    }
    this.#file = path.resolve(filePath)
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.#file)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployments (
        employee_id TEXT NOT NULL,
        employee_version TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        local_package_ref TEXT NOT NULL,
        agent_host_id TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_health_check_at TEXT,
        PRIMARY KEY (employee_id, employee_version)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        task_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        status TEXT NOT NULL,
        events_emitted INTEGER NOT NULL DEFAULT 0,
        receipt_digest TEXT,
        claimed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (task_id, nonce)
      );
      CREATE INDEX IF NOT EXISTS attempts_by_task ON attempts (task_id, fencing_token);
      CREATE TABLE IF NOT EXISTS outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        task_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_by_status ON outbox (status, next_retry_at, sequence);
      CREATE TABLE IF NOT EXISTS runner_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL
      );
    `)
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING",
    ).run(String(DURABLE_STORE_SCHEMA_VERSION))
    this.#db = db
  }

  close(): void {
    this.#db.close()
  }

  // -- Process-level single-active lock --

  /**
   * Acquires the process-level single-active lock for this store file.
   * Refused while the current holder pid is alive; a lock whose owner is
   * dead is stolen atomically (CAS on the observed holder), so a crashed
   * runner can never permanently wedge the home.
   */
  acquireRunnerLock(holder: RunnerLockHolder): RunnerLockAcquireResult {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = this.#readRunnerLock()
      if (!existing) {
        const result = this.#db
          .prepare(
            "INSERT INTO runner_lock (id, pid, started_at) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING",
          )
          .run(holder.pid, holder.startedAt)
        if (result.changes === 1) return { acquired: true, stolen: false }
        continue
      }
      if (existing.pid === holder.pid && existing.startedAt === holder.startedAt) {
        return { acquired: true, stolen: false }
      }
      if (SqliteDurableStore.#isProcessAlive(existing.pid)) {
        return { acquired: false, holder: existing }
      }
      const stolen = this.#db
        .prepare(
          "UPDATE runner_lock SET pid = ?, started_at = ? WHERE id = 1 AND pid = ? AND started_at = ?",
        )
        .run(holder.pid, holder.startedAt, existing.pid, existing.startedAt)
      if (stolen.changes === 1) return { acquired: true, stolen: true }
    }
    const contended = this.#readRunnerLock()
    if (contended) return { acquired: false, holder: contended }
    throw new CoreError("RUNNER_LOCK_CONTENTION", "Runner lock contention; retry", {
      retryable: true,
    })
  }

  /** Releases the lock only if `holder` still owns it. */
  releaseRunnerLock(holder: RunnerLockHolder): boolean {
    const result = this.#db
      .prepare("DELETE FROM runner_lock WHERE id = 1 AND pid = ? AND started_at = ?")
      .run(holder.pid, holder.startedAt)
    this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
    return result.changes === 1
  }

  #readRunnerLock(): RunnerLockHolder | null {
    const row = this.#db
      .prepare("SELECT pid, started_at FROM runner_lock WHERE id = 1")
      .get() as { pid: number; started_at: string } | undefined
    return row ? { pid: row.pid, startedAt: row.started_at } : null
  }

  static #isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM: the process exists but is owned by another user.
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  // -- Schema / health --

  schemaVersion(): number | null {
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined
    return row ? Number.parseInt(row.value, 10) : null
  }

  detectCorruption(): DurableStoreCorruption | null {
    const now = new Date().toISOString()
    try {
      const version = this.schemaVersion()
      if (version !== DURABLE_STORE_SCHEMA_VERSION) {
        return {
          kind: "schema_version_mismatch",
          message: `expected schema version ${DURABLE_STORE_SCHEMA_VERSION}, found ${String(version)}`,
          detectedAt: now,
        }
      }
      const check = this.#db.prepare("PRAGMA integrity_check").get() as
        | { integrity_check: string }
        | undefined
      if (!check || check.integrity_check !== "ok") {
        return {
          kind: "checksum_invalid",
          message: `SQLite integrity check failed: ${check?.integrity_check ?? "unavailable"}`,
          detectedAt: now,
        }
      }
      const bad = this.#db
        .prepare(
          "SELECT sequence FROM outbox WHERE (kind = 'event' OR kind = 'receipt') AND payload IS NOT NULL",
        )
        .all()
        .filter((row) => {
          try {
            const raw = Buffer.from((row as { payload: string }).payload, "base64url")
            JSON.parse(raw.toString("utf8"))
            return false
          } catch {
            return true
          }
        }) as Array<{ sequence: number }>
      if (bad.length > 0) {
        return {
          kind: "data_truncated",
          message: `outbox payload(s) unparseable at sequence ${bad.map((b) => b.sequence).join(",")}`,
          detectedAt: now,
        }
      }
      return null
    } catch (error) {
      return {
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error),
        detectedAt: now,
      }
    }
  }

  degradedState(): DurableStoreDegradedState | null {
    const size = (this.#db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n
    if (size >= DURABLE_OUTBOX_MAX_SIZE * 0.9) {
      return { reason: "near_capacity", message: `Outbox is at ${size} entries` }
    }
    const acknowledged = (
      this.#db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('acknowledged', 'dead')")
        .get() as { n: number }
    ).n
    if (acknowledged >= DURABLE_OUTBOX_COMPACTION_THRESHOLD) {
      return { reason: "compaction_overdue", message: `${acknowledged} acknowledged entries await compaction` }
    }
    return null
  }

  // -- Deployments --

  putDeployment(record: RunnerDeploymentRecord): void {
    if (this.#deploymentCount() >= DURABLE_STORE_MAX_DEPLOYMENTS && !this.getDeployment(record.employeeId, record.employeeVersion)) {
      throw new CoreError("DURABLE_STORE_CAPACITY", "Maximum deployment records exceeded", {
        retryable: false,
      })
    }
    const existing = this.#db
      .prepare(
        "SELECT package_digest FROM deployments WHERE employee_id = ? AND employee_version = ?",
      )
      .get(record.employeeId, record.employeeVersion) as { package_digest: string } | undefined
    if (existing && existing.package_digest !== record.packageDigest) {
      throw new CoreError(
        "DURABLE_STORE_DIGEST_MISMATCH",
        `Package digest mismatch for ${record.employeeId}@${record.employeeVersion}: ` +
          `existing=${existing.package_digest}, incoming=${record.packageDigest}`,
        { retryable: false },
      )
    }
    this.#db
      .prepare(
        `INSERT INTO deployments
           (employee_id, employee_version, package_digest, local_package_ref, agent_host_id, registered_at, last_health_check_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (employee_id, employee_version) DO UPDATE SET
           package_digest = excluded.package_digest,
           local_package_ref = excluded.local_package_ref,
           agent_host_id = excluded.agent_host_id,
           registered_at = excluded.registered_at,
           last_health_check_at = excluded.last_health_check_at`,
      )
      .run(
        record.employeeId,
        record.employeeVersion,
        record.packageDigest,
        record.localPackageRef,
        record.agentHostId,
        record.registeredAt,
        record.lastHealthCheckAt ?? null,
      )
  }

  #deploymentCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM deployments").get() as { n: number }).n
  }

  getDeployment(employeeId: string, employeeVersion: string): RunnerDeploymentRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT employee_id, employee_version, package_digest, local_package_ref, agent_host_id, registered_at, last_health_check_at
         FROM deployments WHERE employee_id = ? AND employee_version = ?`,
      )
      .get(employeeId, employeeVersion) as
      | {
          employee_id: string
          employee_version: string
          package_digest: string
          local_package_ref: string
          agent_host_id: string
          registered_at: string
          last_health_check_at: string | null
        }
      | undefined
    if (!row) return undefined
    return {
      employeeId: row.employee_id,
      employeeVersion: row.employee_version,
      packageDigest: row.package_digest,
      localPackageRef: row.local_package_ref,
      agentHostId: row.agent_host_id,
      registeredAt: row.registered_at,
      ...(row.last_health_check_at !== null ? { lastHealthCheckAt: row.last_health_check_at } : {}),
    }
  }

  listDeployments(): RunnerDeploymentRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT employee_id, employee_version, package_digest, local_package_ref, agent_host_id, registered_at, last_health_check_at
         FROM deployments ORDER BY employee_id, employee_version`,
      )
      .all() as Array<{
      employee_id: string
      employee_version: string
      package_digest: string
      local_package_ref: string
      agent_host_id: string
      registered_at: string
      last_health_check_at: string | null
    }>
    return rows.map((row) => ({
      employeeId: row.employee_id,
      employeeVersion: row.employee_version,
      packageDigest: row.package_digest,
      localPackageRef: row.local_package_ref,
      agentHostId: row.agent_host_id,
      registeredAt: row.registered_at,
      ...(row.last_health_check_at !== null ? { lastHealthCheckAt: row.last_health_check_at } : {}),
    }))
  }

  removeDeployment(employeeId: string, employeeVersion: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM deployments WHERE employee_id = ? AND employee_version = ?")
      .run(employeeId, employeeVersion)
    return result.changes > 0
  }

  // -- Atomic claim --

  claimNonce(attempt: RunnerAttemptState): boolean {
    try {
      const result = this.#db
        .prepare(
          `INSERT INTO attempts
             (task_id, nonce, runner_id, fencing_token, status, events_emitted, receipt_digest, claimed_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM attempts WHERE task_id = ? AND fencing_token > ?
           )`,
        )
        .run(
          attempt.taskId,
          attempt.nonce,
          attempt.runnerId,
          attempt.fencingToken,
          attempt.status,
          attempt.eventsEmitted,
          attempt.receiptDigest ?? null,
          attempt.claimedAt,
          attempt.expiresAt,
          attempt.taskId,
          attempt.fencingToken,
        )
      return result.changes === 1
    } catch {
      // Duplicate (task_id, nonce) violates the primary key: treat it as a
      // rejected claim, matching the InMemory reference semantics.
      return false
    }
  }

  getAttempt(taskId: string, nonce: string): RunnerAttemptState | undefined {
    const row = this.#db
      .prepare(
        `SELECT task_id, nonce, runner_id, fencing_token, status, events_emitted, receipt_digest, claimed_at, expires_at
         FROM attempts WHERE task_id = ? AND nonce = ?`,
      )
      .get(taskId, nonce) as
      | {
          task_id: string
          nonce: string
          runner_id: string
          fencing_token: number
          status: RunnerAttemptState["status"]
          events_emitted: number
          receipt_digest: string | null
          claimed_at: string
          expires_at: string
        }
      | undefined
    if (!row) return undefined
    return {
      taskId: row.task_id,
      nonce: row.nonce,
      runnerId: row.runner_id,
      fencingToken: row.fencing_token,
      status: row.status,
      eventsEmitted: row.events_emitted,
      ...(row.receipt_digest !== null ? { receiptDigest: row.receipt_digest } : {}),
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
    }
  }

  advanceAttempt(
    taskId: string,
    nonce: string,
    update: Partial<Pick<RunnerAttemptState, "status" | "eventsEmitted" | "receiptDigest">>,
  ): boolean {
    this.#db
      .prepare(
        `UPDATE attempts SET status = 'superseded'
         WHERE task_id = ? AND nonce = ? AND EXISTS (
           SELECT 1 FROM attempts AS newer
           WHERE newer.task_id = attempts.task_id AND newer.nonce <> attempts.nonce
             AND newer.fencing_token > attempts.fencing_token
         )`,
      )
      .run(taskId, nonce)
    const fields: string[] = []
    const values: Array<string | number> = []
    if (update.status !== undefined) {
      fields.push("status = ?")
      values.push(update.status)
    }
    if (update.eventsEmitted !== undefined) {
      fields.push("events_emitted = ?")
      values.push(update.eventsEmitted)
    }
    if (update.receiptDigest !== undefined) {
      fields.push("receipt_digest = ?")
      values.push(update.receiptDigest)
    }
    if (fields.length === 0) return false
    const result = this.#db
      .prepare(
        `UPDATE attempts SET ${fields.join(", ")}
         WHERE task_id = ? AND nonce = ? AND NOT EXISTS (
           SELECT 1 FROM attempts AS newer
           WHERE newer.task_id = attempts.task_id AND newer.nonce <> attempts.nonce
             AND newer.fencing_token > attempts.fencing_token
         )`,
      )
      .run(...values, taskId, nonce)
    return result.changes === 1
  }

  // -- Outbox --

  outbox(): RunnerOutbox {
    return new SqliteOutbox(this.#db)
  }
}

class SqliteOutbox implements RunnerOutbox {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  append(
    entry: Omit<RunnerOutboxEntry, "sequence" | "status" | "retryCount" | "createdAt">,
  ): RunnerOutboxEntry {
    if (this.size() >= DURABLE_OUTBOX_MAX_SIZE) {
      throw new CoreError("DURABLE_OUTBOX_OVERFLOW", "Outbox has reached maximum capacity", {
        retryable: true,
      })
    }
    const createdAt = new Date().toISOString()
    const result = this.#db
      .prepare(
        "INSERT INTO outbox (kind, task_id, fencing_token, payload, status, retry_count, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)",
      )
      .run(entry.kind, entry.taskId, entry.fencingToken, entry.payload, createdAt)
    return {
      sequence: Number(result.lastInsertRowid),
      kind: entry.kind,
      taskId: entry.taskId,
      fencingToken: entry.fencingToken,
      payload: entry.payload,
      status: "pending",
      retryCount: 0,
      createdAt,
    }
  }

  pending(limit: number): RunnerOutboxEntry[] {
    const now = new Date().toISOString()
    const rows = this.#db
      .prepare(
        `SELECT sequence, kind, task_id, fencing_token, payload, status, retry_count, next_retry_at, created_at
         FROM outbox
         WHERE status = 'pending'
            OR (status = 'inflight' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(now, limit) as unknown as SqliteOutboxRow[]
    return rows.map(outboxRowToEntry)
  }

  markInflight(sequence: number): boolean {
    const result = this.#db
      .prepare("UPDATE outbox SET status = 'inflight' WHERE sequence = ? AND status IN ('pending', 'inflight')")
      .run(sequence)
    return result.changes === 1
  }

  markRetry(sequence: number, nextRetryAt: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE outbox
         SET status = CASE WHEN retry_count + 1 >= ? THEN 'dead' ELSE 'pending' END,
             next_retry_at = ?,
             retry_count = retry_count + 1
         WHERE sequence = ? AND status IN ('pending', 'inflight')`,
      )
      .run(DURABLE_OUTBOX_MAX_RETRIES, nextRetryAt, sequence)
    if (result.changes === 0) return false
    const row = this.#db
      .prepare("SELECT status FROM outbox WHERE sequence = ?")
      .get(sequence) as { status: RunnerOutboxEntry["status"] }
    return row.status !== "dead"
  }

  ack(sequence: number): boolean {
    const result = this.#db
      .prepare("UPDATE outbox SET status = 'acknowledged' WHERE sequence = ? AND status <> 'dead'")
      .run(sequence)
    return result.changes === 1
  }

  compact(): number {
    const result = this.#db
      .prepare("DELETE FROM outbox WHERE status IN ('acknowledged', 'dead')")
      .run()
    return Number(result.changes)
  }

  size(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n
  }
}
