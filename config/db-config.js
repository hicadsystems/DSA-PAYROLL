// config/db-config.js (REPLACES your existing db-config.js)
const config = require("../config");

// ==========================================
// AUTO-DETECT DATABASE TYPE
// ==========================================

async function detectAvailableDatabase() {
  const mysqlConfig = {
    host: config.mysql.host,
    port: parseInt(config.mysql.port) || 3306,
    user: config.mysql.user,
    password: config.mysql.password,
  };

  const mssqlConfig = {
    host: config.mssql.host,
    port: parseInt(config.mssql.port) || 1433,
    user: config.mssql.user,
    password: config.mssql.password,
  };

  const available = {
    mysql: false,
    mssql: false,
  };

  // Test MySQL
  if (mysqlConfig.user && mysqlConfig.password) {
    try {
      const mysql = require("mysql2/promise");
      const connection = await mysql.createConnection({
        host: mysqlConfig.host,
        port: mysqlConfig.port,
        user: mysqlConfig.user,
        password: mysqlConfig.password,
        connectTimeout: 10000,
      });
      await connection.query("SELECT 1");
      await connection.end();
      available.mysql = true;
      console.log("✅ MySQL is available");
    } catch (error) {
      console.log("❌ MySQL not available:", error.message);
    }
  }

  // Test MSSQL
  if (mssqlConfig.user && mssqlConfig.password) {
    try {
      const mssql = require("mssql");
      const pool = await mssql.connect({
        server: mssqlConfig.host,
        port: mssqlConfig.port,
        user: mssqlConfig.user,
        password: mssqlConfig.password,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          connectTimeout: 5000,
        },
      });
      await pool.request().query("SELECT 1");
      await pool.close();
      available.mssql = true;
      console.log("✅ MSSQL is available");
    } catch (error) {
      console.log("❌ MSSQL not available:", error.message);
    }
  }

  return available;
}

// ==========================================
// DETERMINE WHICH DB TO USE
// ==========================================

async function selectDatabase() {
  // Manual override from environment
  const manualType = config.app.dbType?.toLowerCase();

  if (manualType === "mysql" || manualType === "mssql") {
    console.log(
      `🎯 Using manually specified database: ${manualType.toUpperCase()}`,
    );
    return manualType;
  }

  // Auto-detect
  console.log("🔍 Auto-detecting available databases...");
  const available = await detectAvailableDatabase();

  // Prefer MySQL if both available (you can change this preference)
  if (available.mysql && available.mssql) {
    console.log("⚡ Both databases available, preferring MySQL");
    return "mysql";
  }

  if (available.mysql) {
    console.log("📊 Using MySQL");
    return "mysql";
  }

  if (available.mssql) {
    console.log("📊 Using MSSQL");
    return "mssql";
  }

  throw new Error(
    "❌ No database is available! Please check your configuration.",
  );
}

// ==========================================
// BUILD CONFIG (Same format as your original!)
// ==========================================

async function buildConfig() {
  const dbType = await selectDatabase();

  if (dbType === "mysql") {
    // Map MYSQL_* env vars to DB_* format
    process.env.DB_USER = config.mysql.user;
    process.env.DB_PASSWORD = config.mysql.password;
    process.env.DB_HOST = config.mysql.host;
    process.env.DB_PORT = config.mysql.port;
    process.env.DB_TYPE = "mysql";

    // Map database names
    process.env.DB_OFFICERS = config.databases.officers;
    process.env.DB_WOFFICERS = config.databases.wofficers;
    process.env.DB_RATINGS = config.databases.ratings;
    process.env.DB_RATINGS_A = config.databases.ratingsA;
    process.env.DB_RATINGS_B = config.databases.ratingsB;
    process.env.DB_JUNIOR_TRAINEE = config.databases.juniorTrainee;
  } else {
    // Map MSSQL_* env vars to DB_* format
    process.env.DB_USER = config.mssql.user;
    process.env.DB_PASSWORD = config.mssql.password;
    process.env.DB_HOST = config.mssql.host;
    process.env.DB_PORT = config.mssql.port;
    process.env.DB_TYPE = "mssql";

    // Map database names
    process.env.DB_OFFICERS = config.databases.officers;
    process.env.DB_WOFFICERS = config.databases.wofficers;
    process.env.DB_RATINGS = config.databases.ratings;
    process.env.DB_RATINGS_A = config.databases.ratingsA;
    process.env.DB_RATINGS_B = config.databases.ratingsB;
    process.env.DB_JUNIOR_TRAINEE = config.databases.juniorTrainee;
  }

  // Return config in YOUR EXACT format!
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,

    // Database type: 'mysql' or 'mssql'
    type: process.env.DB_TYPE || "mysql",

    // Payroll class to database mapping (YOUR FORMAT!)
    databases: {
      officers: process.env.DB_OFFICERS,
      wofficers: process.env.DB_WOFFICERS,
      ratings: process.env.DB_RATINGS,
      ratingsA: process.env.DB_RATINGS_A,
      ratingsB: process.env.DB_RATINGS_B,
      juniorTrainee: process.env.DB_JUNIOR_TRAINEE,
    },
  };
}

// ==========================================
// INITIALIZE AND EXPORT
// ==========================================

let configPromise;
let cachedConfig;

function getConfig() {
  if (cachedConfig) {
    return Promise.resolve(cachedConfig);
  }

  if (!configPromise) {
    configPromise = buildConfig().then((config) => {
      cachedConfig = config;
      return config;
    });
  }

  return configPromise;
}

// For synchronous access (after initialization)
function getConfigSync() {
  if (!cachedConfig) {
    throw new Error("Config not initialized! Call await getConfig() first.");
  }
  return cachedConfig;
}

module.exports = { getConfig, getConfigSync, detectAvailableDatabase };
