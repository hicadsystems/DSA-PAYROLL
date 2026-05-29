(function () {
  class AuthService {
    constructor() {
      this.API_BASE = "/api/users"; // Relative path (same server)
      this.ACCESS_TOKEN_KEY = "token";
      this.REFRESH_TOKEN_KEY = "refresh_token";
      this.USER_KEY = "user_data";

      this.inactivityTimer = null;
      this.warningTimer = null;

      // 5 minutes inactivity timeout
      this.INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
      this.WARNING_TIME = 1 * 60 * 1000; // Warn 1 minute before

      // Activity events
      this.activityEvents = [
        "mousedown",
        "mousemove",
        "keypress",
        "scroll",
        "touchstart",
        "click",
      ];

      // Auto-initialize if logged in
      if (this.isLoggedIn()) {
        this.startInactivityTracking();
      }
    }

    // ============================================
    // INACTIVITY TRACKING
    // ============================================

    startInactivityTracking() {
      console.log("⏱️ Inactivity tracking started (5 minutes)");

      // Listen for user activity
      this.activityEvents.forEach((event) => {
        document.addEventListener(event, () => this.resetTimer(), true);
      });

      // Start timer
      this.resetTimer();
    }

    resetTimer() {
      // Clear existing timers
      if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
      if (this.warningTimer) clearTimeout(this.warningTimer);

      // Close warning if open
      this.closeWarning();

      // Set warning at 4 minutes
      this.warningTimer = setTimeout(() => {
        this.showWarning();
      }, this.INACTIVITY_TIMEOUT - this.WARNING_TIME);

      // Set timeout at 5 minutes
      this.inactivityTimer = setTimeout(() => {
        this.handleTimeout();
      }, this.INACTIVITY_TIMEOUT);
    }

    showWarning() {
      if (document.getElementById("inactivity-warning")) return;

      const warning = document.createElement("div");
      warning.id = "inactivity-warning";
      warning.innerHTML = `
      <div style="
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
      ">
        <div style="
          background: white;
          padding: 30px;
          border-radius: 10px;
          max-width: 400px;
          text-align: center;
        ">
          <h2 style="color: #f59e0b; margin: 0 0 15px;">⚠️ Inactivity Warning</h2>
          <p style="color: #666; margin: 0 0 20px;">
            You will be logged out in <strong id="countdown-seconds">60</strong> seconds.
          </p>
          <button id="stay-btn" style="
            background: #3b82f6;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
          ">Stay Logged In</button>
        </div>
      </div>
    `;

      document.body.appendChild(warning);

      // Stay button handler
      document.getElementById("stay-btn").addEventListener("click", () => {
        this.resetTimer();
      });

      // Countdown
      let seconds = 60;
      const interval = setInterval(() => {
        seconds--;
        const el = document.getElementById("countdown-seconds");
        if (el) el.textContent = seconds;
        if (seconds <= 0) clearInterval(interval);
      }, 1000);

      warning.dataset.interval = interval;
    }

    closeWarning() {
      const warning = document.getElementById("inactivity-warning");
      if (warning) {
        if (warning.dataset.interval) {
          clearInterval(parseInt(warning.dataset.interval));
        }
        warning.remove();
      }
    }

    async handleTimeout() {
      console.log("⏱️ 5 minutes of inactivity - logging out");

      this.closeWarning();

      // Try to logout via API
      await this.logout();
    }

    stopTracking() {
      if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
      if (this.warningTimer) clearTimeout(this.warningTimer);
      this.closeWarning();
    }

    // ============================================
    // LOGIN
    // ============================================

    async login(user_id, password, payroll_class) {
      try {
        const response = await fetch(`${this.API_BASE}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id, password, payroll_class }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Login failed");
        }

        // Store tokens
        localStorage.setItem(this.ACCESS_TOKEN_KEY, data.token);
        localStorage.setItem(this.REFRESH_TOKEN_KEY, data.refresh_token);

        // Start inactivity tracking
        this.startInactivityTracking();

        console.log("✅ Login successful");
        return data;
      } catch (error) {
        console.error("❌ Login failed:", error.message);
        throw error;
      }
    }

    // ============================================
    // LOGOUT
    // ============================================

    async logout() {
      try {
        const token = localStorage.getItem("token");
        if (token) {
          await fetch("/api/users/logout", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            },
          });
        }
      } catch (err) {
        console.error("Logout error:", err);
      } finally {
        var pid = sessionStorage.getItem("_pid");
        // var ppwd = sessionStorage.getItem("_ppwd");
        var preLoginToken = localStorage.getItem("pre_login_token"); // ← restore this
        var userId = localStorage.getItem("user_id");
        var fullName = localStorage.getItem("full_name");
        var role = localStorage.getItem("role");
        var cls = localStorage.getItem("class");
        var capabilities = localStorage.getItem("capabilities");

        localStorage.clear();
        sessionStorage.clear();

        if (pid) sessionStorage.setItem("_pid", pid);
        // if (ppwd) sessionStorage.setItem("_ppwd", ppwd);
        if (preLoginToken) localStorage.setItem("token", preLoginToken); // clean, no current_class
        if (preLoginToken)
          localStorage.setItem("pre_login_token", preLoginToken);
        if (userId) localStorage.setItem("user_id", userId);
        if (fullName) localStorage.setItem("full_name", fullName);
        if (role) localStorage.setItem("role", role);
        if (cls) localStorage.setItem("class", cls);
        if (capabilities) localStorage.setItem("capabilities", capabilities);

        this.stopTracking();
        sessionStorage.setItem("_from_logout", "true");
        window.location.href = "user-dashboard.html";
      }
    }

    // ============================================
    // AUTHENTICATED REQUESTS
    // ============================================

    async fetchWithAuth(url, options = {}) {
      console.log("🔐 Making authenticated request to", url);
      let accessToken = this.getAccessToken();

      if (!accessToken) {
        window.location.href = "/";
        throw new Error("No access token");
      }

      options.headers = {
        ...options.headers,
        Authorization: `Bearer ${accessToken}`,
      };

      let response = await fetch(url, options);

      console.log(response.status, response.statusText, "rseponse", url);

      //   If token expired, try refresh
      if (response.status === 401) {
        try {
          await this.refreshToken();          // try refresh first
          options.headers.Authorization = `Bearer ${this.getAccessToken()}`;
          response = await fetch(url, options); // retry once
          if (response.status === 401) await this.logout(); // still 401 → logout
        } catch {
          await this.logout();
        }
      }

      return response;
    }

    // ============================================
    // REFRESH TOKEN
    // ============================================

    async refreshToken() {
      try {
        const refreshToken = this.getRefreshToken();

        if (!refreshToken) {
          throw new Error("No refresh token");
        }

        const response = await fetch(`${this.API_BASE}/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Refresh failed");
        }

        // Update access token
        localStorage.setItem(this.ACCESS_TOKEN_KEY, data.token);

        console.log("🔄 Token refreshed");
        return data.token;
      } catch (error) {
        console.error("❌ Refresh failed:", error);
        throw error;
      }
    }

    // ============================================
    // HELPERS
    // ============================================

    getAccessToken() {
      return localStorage.getItem(this.ACCESS_TOKEN_KEY);
    }

    getRefreshToken() {
      return localStorage.getItem(this.REFRESH_TOKEN_KEY);
    }

    clearAuth() {
      localStorage.removeItem(this.ACCESS_TOKEN_KEY);
      localStorage.removeItem(this.REFRESH_TOKEN_KEY);
      localStorage.removeItem(this.USER_KEY);
    }

    isLoggedIn() {
      return !!this.getAccessToken();
    }
  }

  window.AuthService = AuthService;
  window.authService = new AuthService();
})();
