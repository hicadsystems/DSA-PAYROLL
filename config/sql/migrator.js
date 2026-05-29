// ============================================
// FILE: sql_migrations/migrator.js
// ============================================
const fs = require("fs").promises;
const path = require("path");
const mysql = require("mysql2/promise");
const config = require("../../config");

class Migrator {
  constructor() {
    this.migrationsDir = path.join(__dirname, "migrations");
    this.connection = null;
    this.targetDatabase = null;
  }

  async connect(database = null) {
    if (this.connection) return;

    this.targetDatabase = database || config.databases.officers;

    this.connection = await mysql.createConnection({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: this.targetDatabase,
      multipleStatements: true,
    });

    console.log(`🔗 Connected to database: ${this.targetDatabase}`);
  }

  async ensureMigrationsTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        batch INT NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_name (name),
        INDEX idx_batch (batch)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;
    await this.connection.query(createTableSQL);
  }

  async getLastBatch() {
    try {
      const [rows] = await this.connection.query(
        "SELECT MAX(batch) as last_batch FROM migrations",
      );
      return rows[0].last_batch || 0;
    } catch (error) {
      return 0;
    }
  }

  async getExecutedMigrations() {
    try {
      const [rows] = await this.connection.query(
        "SELECT name, batch FROM migrations ORDER BY id",
      );
      return rows;
    } catch (error) {
      return [];
    }
  }

  async getPendingMigrations() {
    const files = await fs.readdir(this.migrationsDir);
    const sqlFiles = files
      .filter((f) => f.endsWith(".sql") && !f.includes("migrator"))
      .sort();

    const executed = await this.getExecutedMigrations();
    const executedNames = executed.map((e) => e.name);

    return sqlFiles.filter((f) => !executedNames.includes(f));
  }

  async executeMigration(filename, batch) {
    const filepath = path.join(this.migrationsDir, filename);
    const content = await fs.readFile(filepath, "utf8");

    // Split migration into UP and DOWN sections
    const upMatch = content.match(/-- UP\s+([\s\S]*?)(?=-- DOWN|$)/i);
    const downMatch = content.match(/-- DOWN\s+([\s\S]*?)$/i);

    if (!upMatch) {
      throw new Error(`Migration ${filename} missing -- UP section`);
    }

    const upSQL = upMatch[1]
      .replace(/\r\n/g, "\n") // Standardize Windows newlines
      .replace(/\r/g, "\n") // Standardize old Mac newlines
      .replace(/\xA0/g, " ") // CRITICAL: Replace Non-Breaking Spaces with standard spaces
      .replace(/--.*$/gm, "") // Remove SQL comments
      .replace(/\/\/.*/g, "") // Remove JS-style comments
      .replace(/\s+/g, " ") // Collapse all whitespace to single spaces for the parser
      .trim();

    await this.connection.beginTransaction();

    try {
      // Execute UP migration
      if (upSQL) {
        await this.connection.query(upSQL);
      }

      // Record migration
      await this.connection.query(
        "INSERT INTO migrations (name, batch) VALUES (?, ?)",
        [filename, batch],
      );

      await this.connection.commit();
      console.log(`✓ Executed migration: ${filename}`);
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  async rollbackMigration(migration) {
    const filepath = path.join(this.migrationsDir, migration.name);
    const content = await fs.readFile(filepath, "utf8");

    const downMatch = content.match(/-- DOWN\s+([\s\S]*?)$/i);

    if (!downMatch) {
      throw new Error(`Migration ${migration.name} missing -- DOWN section`);
    }

    const downSQL = downMatch[1].trim();

    await this.connection.beginTransaction();

    try {
      // Execute DOWN migration
      if (downSQL) {
        await this.connection.query(downSQL);
      }

      // Remove migration record
      await this.connection.query("DELETE FROM migrations WHERE name = ?", [
        migration.name,
      ]);

      await this.connection.commit();
      console.log(`✓ Rolled back migration: ${migration.name}`);
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  async runMigrations(database = null) {
    try {
      await this.connect(database);
      await this.ensureMigrationsTable();

      const pending = await this.getPendingMigrations();

      if (pending.length === 0) {
        console.log("✅ No pending migrations");
        return;
      }

      console.log(
        `📋 Found ${pending.length} pending migration(s) for ${this.targetDatabase}`,
      );

      const batch = (await this.getLastBatch()) + 1;

      for (const migration of pending) {
        await this.executeMigration(migration, batch);
      }

      console.log(`✅ All migrations completed successfully (Batch ${batch})`);
    } catch (error) {
      console.error("❌ Migration failed:", error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async runOnAllDatabases() {
    console.log("🚀 Running migrations on all databases...\n");

    const databases = Object.values(config.databases);
    const results = [];

    for (const db of databases) {
      console.log(`\n📊 Migrating database: ${db}`);
      console.log("─".repeat(50));

      try {
        await this.connect(db);
        await this.ensureMigrationsTable();

        const pending = await this.getPendingMigrations();

        if (pending.length === 0) {
          console.log(`✅ ${db} - No pending migrations`);
          results.push({ database: db, status: "up-to-date", migrations: 0 });
        } else {
          const batch = (await this.getLastBatch()) + 1;
          for (const migration of pending) {
            await this.executeMigration(migration, batch);
          }
          console.log(`✅ ${db} - Completed ${pending.length} migration(s)`);
          results.push({
            database: db,
            status: "success",
            migrations: pending.length,
          });
        }
      } catch (error) {
        console.error(`❌ ${db} - Failed:`, error.message);
        results.push({ database: db, status: "failed", error: error.message });
      } finally {
        await this.disconnect();
      }
    }

    console.log("\n" + "=".repeat(50));
    console.log("📊 MIGRATION SUMMARY");
    console.log("=".repeat(50));
    results.forEach((r) => {
      const icon =
        r.status === "success" || r.status === "up-to-date" ? "✓" : "✗";
      console.log(
        `${icon} ${r.database}: ${r.status} ${r.migrations ? `(${r.migrations} migrations)` : ""}`,
      );
    });

    const failed = results.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      console.log(`\n⚠️  ${failed.length} database(s) failed migration`);
      process.exit(1);
    }
  }

  async rollback(database = null, steps = 1) {
    try {
      await this.connect(database);
      await this.ensureMigrationsTable();

      const executed = await this.getExecutedMigrations();

      if (executed.length === 0) {
        console.log("✅ No migrations to rollback");
        return;
      }

      const lastBatch = await this.getLastBatch();
      const migrationsToRollback = executed
        .filter((m) => m.batch === lastBatch)
        .reverse();

      if (migrationsToRollback.length === 0) {
        console.log("✅ No migrations in last batch");
        return;
      }

      console.log(
        `⚠️  Rolling back ${migrationsToRollback.length} migration(s) from batch ${lastBatch}...`,
      );

      for (const migration of migrationsToRollback) {
        await this.rollbackMigration(migration);
      }

      console.log("✅ Rollback completed successfully");
    } catch (error) {
      console.error("❌ Rollback failed:", error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async status(database = null) {
    try {
      await this.connect(database);
      await this.ensureMigrationsTable();

      const executed = await this.getExecutedMigrations();
      const pending = await this.getPendingMigrations();

      console.log(`\n${"=".repeat(50)}`);
      console.log(`📊 MIGRATION STATUS - ${this.targetDatabase}`);
      console.log("=".repeat(50));

      console.log(`\n✓ Executed (${executed.length}):`);
      if (executed.length === 0) {
        console.log("  (none)");
      } else {
        const batches = {};
        executed.forEach((m) => {
          if (!batches[m.batch]) batches[m.batch] = [];
          batches[m.batch].push(m.name);
        });

        Object.entries(batches).forEach(([batch, migrations]) => {
          console.log(`\n  Batch ${batch}:`);
          migrations.forEach((m) => console.log(`    ✓ ${m}`));
        });
      }

      console.log(`\n⧗ Pending (${pending.length}):`);
      if (pending.length === 0) {
        console.log("  (none)");
      } else {
        pending.forEach((m) => console.log(`  - ${m}`));
      }
      console.log("");
    } catch (error) {
      console.error("❌ Status check failed:", error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async statusAll() {
    console.log("\n" + "=".repeat(60));
    console.log("📊 MIGRATION STATUS - ALL DATABASES");
    console.log("=".repeat(60));

    const databases = Object.entries(config.databases);

    for (const [name, db] of databases) {
      try {
        await this.connect(db);
        await this.ensureMigrationsTable();

        const executed = await this.getExecutedMigrations();
        const pending = await this.getPendingMigrations();
        const lastBatch = await this.getLastBatch();

        console.log(`\n🗄️  ${name.toUpperCase()} (${db})`);
        console.log(`   ✓ Executed: ${executed.length} (Batch ${lastBatch})`);
        console.log(`   ⧗ Pending: ${pending.length}`);

        if (pending.length > 0) {
          pending.slice(0, 3).forEach((m) => console.log(`      - ${m}`));
          if (pending.length > 3)
            console.log(`      ... and ${pending.length - 3} more`);
        }
      } catch (error) {
        console.log(`\n🗄️  ${name.toUpperCase()} (${db})`);
        console.log(`   ❌ Error: ${error.message}`);
      } finally {
        await this.disconnect();
      }
    }
    console.log("");
  }

  async createMigration(name) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+/, "")
      .replace("T", "_");
    const filename = `${timestamp}_${name}.sql`;
    const filepath = path.join(`${this.migrationsDir}/migrations`, filename);

    const template = `-- Migration: ${name}
-- Created: ${new Date().toISOString()}

-- UP
-- Add your schema changes here


-- DOWN
-- Add rollback logic here (reverse of UP)

`;

    await fs.writeFile(filepath, template);
    console.log(`✓ Created migration: ${filename}`);
    console.log(`📝 Edit the file at: sql_migrations/${filename}`);
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }
}

module.exports = new Migrator();
