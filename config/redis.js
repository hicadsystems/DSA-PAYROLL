const jwt = require("jsonwebtoken");
const redis = require("redis");

// ─────────────────────────────────────────────────────────────
// NOTE: All process.env values are read inside the constructor
// and initRedis() — NOT at module level — so that dotenv in
// server.js is guaranteed to have run first.
// ─────────────────────────────────────────────────────────────

class RedisTokenManager {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.isEnabled = process.env.REDIS_ENABLED !== "false"; // read live from env

    if (!this.isEnabled) {
      console.log(
        "ℹ️  Redis disabled via REDIS_ENABLED=false — skipping connection",
      );
      return;
    }

    this.initRedis();
  }

  // ============================================
  // CONNECTION
  // ============================================

  async initRedis() {
    // Read connection config lazily — env is loaded by now
    const socket = process.env.REDIS_SOCKET || null;
    const host = process.env.REDIS_HOST || "127.0.0.1";
    const port = parseInt(process.env.REDIS_PORT) || 6379;
    const password = process.env.REDIS_PASSWORD || undefined;

    try {
      this.client = redis.createClient({
        socket: {
          // ── Use Unix socket if provided, otherwise fall back to TCP ──
          ...(socket ? { path: socket } : { host, port }),
          // ── FIX: was two separate `socket` objects before (duplicate key bug)
          //    merged into one so host/port are no longer silently overwritten
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.warn("⚠️  Redis: too many reconnect attempts — stopping");
              return false; // stop retrying, don't throw
            }
            return retries * 100; // exponential backoff in ms
          },
        },
        password,
      });

      this.client.on("connect", () => {
        console.log("🔄 Redis: Connecting...");
      });

      this.client.on("ready", () => {
        console.log("✅ Redis: Connected and ready");
        this.isConnected = true;
      });

      this.client.on("error", (err) => {
        // Warn only — Redis being unavailable is non-fatal
        console.warn("⚠️  Redis unavailable:", err.message);
        this.isConnected = false;
      });

      this.client.on("end", () => {
        console.log("🔌 Redis: Connection closed");
        this.isConnected = false;
      });

      await this.client.connect();
    } catch (err) {
      // ── FIX: warn instead of throw so app starts fine without Redis ──
      console.warn("⚠️  Redis not available, running without it:", err.message);
      this.isConnected = false;
    }
  }

  // ── Internal guard — all methods check this before operating ──
  _ready() {
    return this.isEnabled && this.isConnected && this.client !== null;
  }

  // ============================================
  // TOKEN METHODS
  // ============================================

  /**
   * Blacklist a JWT token on logout.
   * Token will auto-expire from Redis when the JWT itself expires.
   */
  async blacklistToken(token) {
    if (!this._ready()) return false;
    try {
      const decoded = jwt.decode(token);
      if (!decoded?.exp) return false;

      const ttl = decoded.exp - Math.floor(Date.now() / 1000);
      if (ttl <= 0) return false;

      await this.client.setEx(
        `blacklist:${token}`,
        ttl,
        JSON.stringify({
          user_id: decoded.user_id,
          blacklisted_at: new Date().toISOString(),
        }),
      );

      console.log(
        `🔒 Token blacklisted for user: ${decoded.user_id} (TTL: ${ttl}s)`,
      );
      return true;
    } catch (err) {
      console.warn("Redis blacklistToken error:", err.message);
      return false;
    }
  }

  /**
   * Returns true if token has been blacklisted (logged out).
   * Returns false if Redis is unavailable — fail open, don't block users.
   */
  async isTokenBlacklisted(token) {
    if (!this._ready()) return false;
    try {
      const exists = await this.client.exists(`blacklist:${token}`);
      return exists === 1;
    } catch (err) {
      console.warn("Redis isTokenBlacklisted error:", err.message);
      return false;
    }
  }

  /**
   * Revoke all active refresh tokens for a user (logout all devices).
   */
  async revokeAllUserTokens(user_id) {
    if (!this._ready()) return 0;
    try {
      const userTokensKey = `user:${user_id}:tokens`;
      const tokens = await this.client.sMembers(userTokensKey);

      if (tokens.length === 0) return 0;

      await Promise.all(tokens.map((t) => this.client.del(`refresh:${t}`)));
      await this.client.del(userTokensKey);

      console.log(
        `🔒 Revoked ${tokens.length} refresh token(s) for user: ${user_id}`,
      );
      return tokens.length;
    } catch (err) {
      console.warn("Redis revokeAllUserTokens error:", err.message);
      return 0;
    }
  }

  // ============================================
  // HEALTH CHECK
  // ============================================

  async healthCheck() {
    if (!this.isEnabled) {
      return {
        status: "disabled",
        message: "Redis disabled via REDIS_ENABLED=false",
      };
    }
    if (!this._ready()) {
      return { status: "disconnected", message: "Redis not connected" };
    }
    try {
      await this.client.ping();
      return { status: "healthy", message: "Redis connection active" };
    } catch (err) {
      return { status: "unhealthy", message: err.message };
    }
  }

  // ============================================
  // SHUTDOWN
  // ============================================

  async shutdown() {
    // ── FIX: guard prevents ClientClosedError when Redis was never connected ──
    if (!this._ready()) return;
    try {
      await this.client.quit();
      console.log("✅ Redis connection closed gracefully");
    } catch (err) {
      console.warn("Redis shutdown warning:", err.message);
    }
  }
}

// ============================================
// SINGLETON
// ============================================

const redisTokenManager = new RedisTokenManager();

process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  await redisTokenManager.shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("🛑 SIGINT received, shutting down gracefully...");
  await redisTokenManager.shutdown();
  process.exit(0);
});

module.exports = redisTokenManager;
