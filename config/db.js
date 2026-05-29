const { getConfig } = require("./db-config");
const { AsyncLocalStorage } = require("async_hooks");

// ==========================================
// MASTER TABLES CONFIGURATION
// ==========================================

// List of master tables that need to be qualified
const MASTER_TABLES = new Set([
  // Employee and Personal Info
  "hr_employees",
  "py_emplhistory",
  "Spouse",
  "Children",
  "NextOfKin",

  // Organizational Structure
  "ac_businessline",
  "ac_costcentre",
  "accchart",
  "ac_months",
  "py_navalcommand",
  "py_paysystem",

  // Payroll Configuration
  "py_bank",
  //'py_elementType',
  //'py_exclusiveType',
  "py_functionType",
  "py_Grade",
  "py_gradelevel",
  "py_paydesc",
  "py_payind",
  "py_payrollclass",
  "py_paysystem",
  //'py_stdrate',
  //'py_tax',
  "py_salarygroup",
  "py_salaryscale",
  "py_exittype",
  "entrymode",
  "py_specialisationarea",

  // Lookup/Reference Tables
  "py_MaritalStatus",
  "py_pfa",
  "py_relationship",
  "py_religion",
  "py_status",
  "py_tblLga",
  "py_tblstates",
  "geozone",
  "py_Country",
  "py_Title",
  "py_sex",

  // System Tables
  "roles",
  "menu_items",
  "role_menu_permissions",
  "users",
]);

// ==========================================
// SESSION MANAGEMENT
// ==========================================

const sessionDatabases = new Map();
const sessionContext = new AsyncLocalStorage();
const validDatabasesCache = new Set();
let cacheInitialized = false;

let dbConfig;
let adapter;
let MASTER_DB;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function qualifyMasterTables(sql, currentDb) {
  if (currentDb === MASTER_DB) return sql;

  // Handle object form: { sql: "...", values: [...] }
  if (typeof sql === "object" && sql !== null) {
    return {
      ...sql,
      sql: qualifyMasterTables(sql.sql, currentDb),
    };
  }

  // Guard: if still not a string, return as-is
  if (typeof sql !== "string") return sql;

  let processedSql = sql;
  let modificationsCount = 0;

  MASTER_TABLES.forEach((table) => {
    const regex = new RegExp(
      `(?<![.\\w])\\b${table}\\b(?=\\s|,|\\)|;|$|\\b(?!\\.))`,
      "gi",
    );
    const matches = processedSql.match(regex);
    if (matches) {
      processedSql = processedSql.replace(regex, `${MASTER_DB}.${table}`);
      modificationsCount += matches.length;
    }
  });

  if (modificationsCount > 0 && process.env.NODE_ENV !== "production") {
    console.log(
      `🔗 Auto-qualified ${modificationsCount} master table(s) in ${currentDb}`,
    );
  }

  return processedSql;
}

const initializeDatabaseCache = () => {
  if (!cacheInitialized) {
    Object.values(dbConfig.databases).forEach((db) =>
      validDatabasesCache.add(db),
    );
    cacheInitialized = true;
  }
};

const setSessionContext = (req, res, next) => {
  const sessionId =
    req.user_id || req.session?.id || req.sessionID || "default";
  sessionContext.run(sessionId, () => {
    next();
  });
};

// ==========================================
// UNIFIED POOL INTERFACE
// ==========================================

const pool = {
  middleware: setSessionContext,

  useDatabase(databaseName, sessionId = null) {
    initializeDatabaseCache();
    if (!sessionId) sessionId = sessionContext.getStore() || "default";

    const validDatabases = Array.from(validDatabasesCache);

    // Try direct database name first
    let dbToUse = validDatabases.includes(databaseName)
      ? databaseName
      : dbConfig.databases[databaseName];

    // If not found, try case-insensitive search in database values
    if (!dbToUse) {
      const lowerDbName = databaseName.toLowerCase();
      dbToUse = validDatabases.find((db) => db.toLowerCase() === lowerDbName);
    }

    // Still not found? Try finding by key
    if (!dbToUse) {
      const entry = Object.entries(dbConfig.databases).find(
        ([key, value]) => value?.toLowerCase() === databaseName.toLowerCase(),
      );
      if (entry) dbToUse = entry[1];
    }

    if (!dbToUse) {
      throw new Error(`❌ Invalid database: ${databaseName}`);
    }

    sessionDatabases.set(sessionId, dbToUse);
    console.log(`📊 Database context: ${dbToUse} for session: ${sessionId}`);
    return this;
  },

  getCurrentDatabase(sessionId = null) {
    if (!sessionId) sessionId = sessionContext.getStore() || "default";
    return sessionDatabases.get(sessionId) || null;
  },

  async smartQuery(sql, params = []) {
    const sessionId = sessionContext.getStore() || "default";
    const currentDatabase = sessionDatabases.get(sessionId);

    if (!currentDatabase) {
      throw new Error(`❌ No database selected for session ${sessionId}`);
    }

    try {
      const processedSql = qualifyMasterTables(sql, currentDatabase);
      const [rows, fields] = await adapter.query(
        currentDatabase,
        processedSql,
        params,
      );
      return [rows, fields];
    } catch (error) {
      console.error(
        `❌ Query error on ${currentDatabase} for session ${sessionId}:`,
        error.message,
      );
      throw error;
    }
  },

  async smartExecute(sql, params = []) {
    const sessionId = sessionContext.getStore() || "default";
    const currentDatabase = sessionDatabases.get(sessionId);

    if (!currentDatabase) {
      throw new Error(`❌ No database selected for session ${sessionId}`);
    }

    try {
      const processedSql = qualifyMasterTables(sql, currentDatabase);
      const [rows, fields] = await adapter.execute(
        currentDatabase,
        processedSql,
        params,
      );
      return [rows, fields];
    } catch (error) {
      console.error(`❌ Execute error on ${currentDatabase}:`, error.message);
      throw error;
    }
  },

  async getConnection() {
    const sessionId = sessionContext.getStore() || "default";
    const currentDatabase = sessionDatabases.get(sessionId);
    return await adapter.getConnection(currentDatabase);
  },

  async smartTransaction(callback) {
    const sessionId = sessionContext.getStore() || "default";
    const currentDatabase = sessionDatabases.get(sessionId);

    if (!currentDatabase) {
      throw new Error(`❌ No database selected for session ${sessionId}`);
    }

    try {
      const connection = await adapter.getConnection(currentDatabase);
      await adapter.beginTransaction(connection);

      const smartConnection = {
        query: async (sql, params = []) => {
          const processedSql = qualifyMasterTables(sql, currentDatabase);
          return adapter.queryWithConnection(connection, processedSql, params);
        },
        execute: async (sql, params = []) => {
          const processedSql = qualifyMasterTables(sql, currentDatabase);
          return adapter.executeWithConnection(
            connection,
            processedSql,
            params,
          );
        },
        release: () => adapter.releaseConnection(connection),
      };

      const result = await callback(smartConnection);
      await adapter.commitTransaction(connection);
      adapter.releaseConnection(connection);
      return result;
    } catch (error) {
      console.error(
        `❌ Transaction error on ${currentDatabase}:`,
        error.message,
      );
      throw error;
    }
  },

  async batchQuery(queries) {
    const sessionId = sessionContext.getStore() || "default";
    const currentDatabase = sessionDatabases.get(sessionId);

    if (!currentDatabase) {
      throw new Error(`❌ No database selected for session ${sessionId}`);
    }

    try {
      const results = [];
      for (const { sql, params = [] } of queries) {
        const processedSql = qualifyMasterTables(sql, currentDatabase);
        const [rows, fields] = await adapter.query(
          currentDatabase,
          processedSql,
          params,
        );
        results.push([rows, fields]);
      }
      return results;
    } catch (error) {
      console.error(`❌ Batch query error:`, error.message);
      throw error;
    }
  },

  async rawQuery(sql, params = []) {
    try {
      const [rows, fields] = await adapter.rawQuery(sql, params);
      return [rows, fields];
    } catch (error) {
      console.error("❌ Raw query error:", error.message);
      throw error;
    }
  },

  clearSession(sessionId = null) {
    if (!sessionId) sessionId = sessionContext.getStore() || "default";
    const wasCleared = sessionDatabases.delete(sessionId);
    if (wasCleared) console.log(`🧹 Session cleared: ${sessionId}`);
    return wasCleared;
  },

  getActiveSessions() {
    return Array.from(sessionDatabases.keys());
  },

  getSessionMappings() {
    return Object.fromEntries(sessionDatabases);
  },

  getAvailableDatabases() {
    initializeDatabaseCache();
    return Array.from(validDatabasesCache);
  },

  getPayrollClassFromDatabase(databaseName) {
    for (const [className, dbName] of Object.entries(dbConfig.databases)) {
      if (dbName === databaseName) return className;
    }
    return null;
  },

  getDatabaseFromPayrollClass(className) {
    return dbConfig.databases[className] || null;
  },

  getMasterDb() {
    return MASTER_DB;
  },

  isMasterTable(tableName) {
    return MASTER_TABLES.has(tableName);
  },

  getMasterTables() {
    return Array.from(MASTER_TABLES);
  },

  qualify(tableName) {
    return MASTER_TABLES.has(tableName)
      ? `${MASTER_DB}.${tableName}`
      : tableName;
  },

  getPoolStats() {
    const sessionId = sessionContext.getStore() || "default";
    return {
      databaseType: dbConfig.type,
      activeSessions: sessionDatabases.size,
      currentSession: sessionId,
      currentDatabase: sessionDatabases.get(sessionId),
      sessionMappings: this.getSessionMappings(),
      masterDatabase: MASTER_DB,
      totalMasterTables: MASTER_TABLES.size,
      adapterStats: adapter.getStats(),
    };
  },

  async healthCheck() {
    try {
      await adapter.healthCheck();
      const sessionId = sessionContext.getStore() || "default";
      return {
        status: "healthy",
        databaseType: dbConfig.type,
        timestamp: new Date(),
        currentSession: sessionId,
        currentDatabase: sessionDatabases.get(sessionId),
        activeSessions: sessionDatabases.size,
        poolStats: this.getPoolStats(),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        error: error.message,
        timestamp: new Date(),
      };
    }
  },

  cleanupInactiveSessions(activeSessionIds) {
    let cleanedCount = 0;
    for (const sessionId of sessionDatabases.keys()) {
      if (!activeSessionIds.includes(sessionId)) {
        sessionDatabases.delete(sessionId);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} inactive session(s)`);
    }
    return cleanedCount;
  },

  async end() {
    try {
      sessionDatabases.clear();
      await adapter.close();
      console.log("✅ Database pool closed successfully");
    } catch (error) {
      console.error("❌ Error closing database pool:", error.message);
      throw error;
    }
  },

  _getSessionContext: () => sessionContext,
};

pool.query = pool.smartQuery;
pool.execute = pool.smartExecute;
pool.transaction = pool.smartTransaction;

// ==========================================
// ASYNC INITIALIZATION
// ==========================================

(async () => {
  try {
    console.log("🔄 Initializing database connection pool...");

    // Get config with auto-detection
    dbConfig = await getConfig();
    MASTER_DB = dbConfig.databases.officers;

    console.log(`🔧 Database Type: ${dbConfig.type.toUpperCase()}`);

    // Load appropriate adapter
    if (dbConfig.type === "mssql") {
      const mssql = require("mssql");
      const MSSQLAdapter = require("./adapters/mssql-adapter");
      adapter = new MSSQLAdapter(dbConfig, mssql);
    } else {
      const mysql = require("mysql2/promise");
      const MySQLAdapter = require("./adapters/mysql-adapter");
      adapter = new MySQLAdapter(dbConfig, mysql);
    }

    await adapter.initialize();

    console.log("🔍 Checking database accessibility...");
    const dbResults = [];

    for (const [payrollClass, dbName] of Object.entries(dbConfig.databases)) {
      try {
        await adapter.testDatabase(dbName);
        console.log(`  ✓ ${payrollClass} → ${dbName} - OK`);
        dbResults.push({ class: payrollClass, database: dbName, status: "OK" });
      } catch (err) {
        console.warn(`  ⚠️  ${payrollClass} → ${dbName} - ${err.message}`);
        dbResults.push({
          class: payrollClass,
          database: dbName,
          status: "ERROR",
          error: err.message,
        });
      }
    }

    const failedDbs = dbResults.filter((db) => db.status === "ERROR");
    if (failedDbs.length > 0) {
      console.warn(`⚠️  ${failedDbs.length} database(s) are not accessible`);
    } else {
      console.log("✅ All databases are accessible");
    }

    initializeDatabaseCache();
    console.log("🚀 Database pool initialized successfully");
    console.log(`📊 Master Database: ${MASTER_DB}`);
    console.log(`🔗 Master Tables: ${MASTER_TABLES.size} configured`);
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    console.error(
      "💡 Please check your database configuration and ensure database server is running",
    );
    process.exit(1);
  }
})();

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

const shutdown = async (signal) => {
  console.log(`\n🔄 Received ${signal}, shutting down gracefully...`);
  try {
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during shutdown:", error.message);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = pool;
