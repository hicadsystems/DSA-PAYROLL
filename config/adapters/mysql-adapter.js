/**
 * FILE: config/adapters/mysql-adapter.js
 *
 * mysql2 adapter — optimised for 40k personnel, multi-database, modest server.
 *
 * ─── TUNING GUIDE ────────────────────────────────────────────
 *
 * If you see "Too many pending requests" errors during peak load:
 *   → Increase POOL_SIZE_PER_DB (env var) by 5, test, repeat.
 *   → Check getStats() — if queuedRequests is consistently > 0,
 *     the pool is undersized for your concurrency level.
 *
 * If MySQL server reports "Too many connections":
 *   → Your MySQL max_connections is lower than N_databases × POOL_SIZE_PER_DB.
 *   → Check with: SHOW VARIABLES LIKE 'max_connections';
 *   → Either increase MySQL max_connections or reduce POOL_SIZE_PER_DB.
 *   → Rule of thumb: MySQL max_connections should be at least
 *     (N_app_instances × N_databases × POOL_SIZE_PER_DB) + 10 for admin headroom.
 *
 * If you run multiple Node processes (pm2 cluster mode):
 *   → Each process gets its own pool. Total connections = processes × per-db-limit.
 *   → With 4 pm2 workers and 3 databases at limit 10: 4 × 3 × 10 = 120 connections.
 *   → Reduce POOL_SIZE_PER_DB to 5 in cluster mode.
 */

"use strict";

// Pool size per database — override via environment variable.
// Default 10 is conservative for a modest single server.
// Increase to 15-20 if your server has 8+ cores and 16GB+ RAM.
const POOL_SIZE_PER_DB = parseInt(
  process.env.MYSQL_POOL_SIZE_PER_DB || "10",
  10,
);

// Max queued requests per pool before rejecting with 503-able error.
// 50 gives burst headroom without unbounded memory growth.
const POOL_QUEUE_LIMIT = parseInt(process.env.MYSQL_QUEUE_LIMIT || "50", 10);

class MySQLAdapter {
  constructor(dbConfig, mysqlDriver) {
    this.dbConfig = dbConfig;
    this.mysql = mysqlDriver;
    this.pools = new Map(); // dbName → mysql2 pool
  }

  // ─────────────────────────────────────────────────────────────
  // POOL FACTORY — one pool per database, database baked in.
  // Called lazily on first access so unused databases don't
  // consume connections at startup.
  // ─────────────────────────────────────────────────────────────

  _getPool(database) {
    if (this.pools.has(database)) return this.pools.get(database);

    const pool = this.mysql.createPool({
      host: this.dbConfig.host,
      port: this.dbConfig.port || 3306,
      user: this.dbConfig.user,
      password: this.dbConfig.password,
      database, // ← baked in — no USE query needed per request

      // ── Connection limits ──────────────────────────────────
      connectionLimit: POOL_SIZE_PER_DB,
      maxIdle: POOL_SIZE_PER_DB, // keep all connections warm
      queueLimit: POOL_QUEUE_LIMIT, // reject instead of queue forever
      waitForConnections: true,

      // ── Timeouts ───────────────────────────────────────────
      connectTimeout: 10000, // 10s to establish a new connection
      idleTimeout: 60000, // 60s before recycling idle connections

      // ── Keep-alive ─────────────────────────────────────────
      // Prevents silent TCP drops by load balancers / NAT during idle periods.
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000, // 30s

      // ── Safety ─────────────────────────────────────────────
      multipleStatements: false, // prevent SQL injection via stacked statements
      timezone: "+00:00",
      charset: "utf8mb4",

      // ── mysql2-specific ────────────────────────────────────
      // decimalNumbers: true parses DECIMAL columns as JS numbers instead of strings.
      // Useful if any report queries do ROUND() or division that returns DECIMAL.
      decimalNumbers: true,
    });

    // Surface pool errors to the application log — without this, errors
    // on idle connections are silently swallowed by mysql2.
    pool.on("connection", (conn) => {
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `🔌 New connection established to ${database} (threadId: ${conn.threadId})`,
        );
      }
    });

    pool.on("error", (err) => {
      console.error(`❌ Pool error on database ${database}:`, err.message);
      // PROTOCOL_CONNECTION_LOST is normal when MySQL drops idle connections.
      // The pool automatically replaces them — no action needed.
      if (err.code !== "PROTOCOL_CONNECTION_LOST") {
        // For unexpected errors, log the full stack for debugging.
        console.error(err.stack);
      }
    });

    this.pools.set(database, pool);
    return pool;
  }

  // ─────────────────────────────────────────────────────────────
  // INITIALIZE — test one connection per configured database.
  // Fails fast at startup if the DB is unreachable.
  // ─────────────────────────────────────────────────────────────

  async initialize() {
    // Eagerly initialise pools for all configured databases
    // so startup errors surface immediately rather than on first request.
    for (const dbName of Object.values(this.dbConfig.databases)) {
      this._getPool(dbName);
    }

    // Test with a lightweight query on the master database
    const masterDb =
      this.dbConfig.databases.officers ||
      Object.values(this.dbConfig.databases)[0];
    const conn = await this._getPool(masterDb).getConnection();
    await conn.query("SELECT 1");
    conn.release();
    console.log(
      `✅ MySQL pool initialised (${POOL_SIZE_PER_DB} connections/db, queue limit: ${POOL_QUEUE_LIMIT})`,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // QUERY — single round-trip, no USE overhead
  // ─────────────────────────────────────────────────────────────

  async query(database, sql, params = []) {
    try {
      const [rows, fields] = await this._getPool(database).query(sql, params);
      return [rows, fields];
    } catch (err) {
      // Annotate queue exhaustion with a recognisable code so the
      // API layer can return 503 instead of 500.
      if (err.message?.includes("No connections available")) {
        err.code = "POOL_EXHAUSTED";
      }
      throw err;
    }
  }

  async execute(database, sql, params = []) {
    try {
      const [rows, fields] = await this._getPool(database).execute(sql, params);
      return [rows, fields];
    } catch (err) {
      if (err.message?.includes("No connections available")) {
        err.code = "POOL_EXHAUSTED";
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // CONNECTION — for transaction use (withTransaction helper)
  // ─────────────────────────────────────────────────────────────

  async getConnection(database) {
    const conn = await this._getPool(database).getConnection();
    return conn;
  }

  async queryWithConnection(connection, sql, params = []) {
    const [rows, fields] = await connection.query(sql, params);
    return [rows, fields];
  }

  async executeWithConnection(connection, sql, params = []) {
    const [rows, fields] = await connection.query(sql, params);
    return [rows, fields];
  }

  async beginTransaction(connection) {
    await connection.beginTransaction();
  }

  async commitTransaction(connection) {
    await connection.commit();
  }

  async rollbackTransaction(connection) {
    await connection.rollback();
  }

  releaseConnection(connection) {
    connection.release();
  }

  // ─────────────────────────────────────────────────────────────
  // RAW QUERY — no database context, for system-level queries
  // ─────────────────────────────────────────────────────────────

  async rawQuery(sql, params = []) {
    const masterDb =
      this.dbConfig.databases.officers ||
      Object.values(this.dbConfig.databases)[0];
    const [rows, fields] = await this._getPool(masterDb).query(sql, params);
    return [rows, fields];
  }

  // ─────────────────────────────────────────────────────────────
  // TEST + HEALTH
  // ─────────────────────────────────────────────────────────────

  async testDatabase(dbName) {
    const [rows] = await this._getPool(dbName).query("SELECT 1 AS ok");
    if (!rows?.[0]?.ok) throw new Error(`Health check failed for ${dbName}`);
  }

  async healthCheck() {
    const masterDb =
      this.dbConfig.databases.officers ||
      Object.values(this.dbConfig.databases)[0];
    await this._getPool(masterDb).query("SELECT 1 AS health_check");
  }

  // ─────────────────────────────────────────────────────────────
  // STATS — per-pool breakdown
  // Exposed via pool.getPoolStats() → getStats() in db.js
  // ─────────────────────────────────────────────────────────────

  getStats() {
    const stats = {};
    for (const [dbName, pool] of this.pools.entries()) {
      // mysql2 PoolNamespace internal — these fields exist in mysql2 >= 2.x
      const p = pool.pool;
      stats[dbName] = {
        total: p?._allConnections?.length ?? "n/a",
        free: p?._freeConnections?.length ?? "n/a",
        used:
          (p?._allConnections?.length ?? 0) -
          (p?._freeConnections?.length ?? 0),
        queued: p?._connectionQueue?.length ?? "n/a",
        limit: POOL_SIZE_PER_DB,
        queueLimit: POOL_QUEUE_LIMIT,
      };
    }
    return stats;
  }

  // ─────────────────────────────────────────────────────────────
  // CLOSE — drain all pools gracefully
  // ─────────────────────────────────────────────────────────────

  async close() {
    const closes = Array.from(this.pools.values()).map((p) => p.end());
    await Promise.all(closes);
    this.pools.clear();
    console.log("✅ All MySQL pools closed");
  }
}

module.exports = MySQLAdapter;