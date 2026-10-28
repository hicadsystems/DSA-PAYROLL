// ================================================
// REPLACE the contents of script/personnel-user-login.js
// with this file — OR add the script block below
// to personnel-user-login.html before </body>
// ================================================

// ========= TAILWIND CONFIG ============ //
/*tailwind.config = {
  theme: {
    extend: {
      colors: {
        navy: "#1e40af",
      },
    },
  },
};*/

// Alert Modal System (same as personnel-login.js)
const AlertModal = {
  modal: null,
  title: null,
  message: null,
  icon: null,
  okBtn: null,
  cancelBtn: null,
  resolve: null,

  init() {
    this.modal = document.getElementById("alertModal");
    this.title = document.getElementById("alert-title");
    this.message = document.getElementById("alert-message");
    this.icon = document.getElementById("alert-icon");
    this.okBtn = document.getElementById("alert-ok-btn");
    this.cancelBtn = document.getElementById("alert-cancel-btn");
    this.okBtn?.addEventListener("click", () => this.close(true));
    this.cancelBtn?.addEventListener("click", () => this.close(false));
  },

  show(options = {}) {
    return new Promise((resolve) => {
      this.resolve = resolve;
      const type = options.type || "info";
      this.title.textContent = options.title || this.getDefaultTitle(type);
      this.message.textContent = options.message || "";
      this.icon.innerHTML = this.getIcon(type);
      const showCancel = options.showCancel || false;
      if (showCancel) {
        this.cancelBtn.classList.remove("hidden");
        this.okBtn.textContent = options.okText || "Yes";
      } else {
        this.cancelBtn.classList.add("hidden");
        this.okBtn.textContent = options.okText || "OK";
      }
      this.modal.classList.remove("hidden");
      document.body.style.overflow = "hidden";
    });
  },

  close(result) {
    this.modal.classList.add("hidden");
    document.body.style.overflow = "";
    if (this.resolve) {
      this.resolve(result);
      this.resolve = null;
    }
  },

  getDefaultTitle(type) {
    return (
      {
        info: "Information",
        error: "Error",
        warning: "Warning",
        success: "Success",
      }[type] || "Alert"
    );
  },

  getIcon(type) {
    const icons = {
      info: '<svg class="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
      error:
        '<svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
      warning:
        '<svg class="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>',
      success:
        '<svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
    };
    return icons[type] || icons.info;
  },
};

AlertModal.init();

// ── Encrypt — must match user-dashboard.js and logout.js ───
function encryptVal(val) {
  return btoa(
    val
      .split("")
      .map((c) => String.fromCharCode(c.charCodeAt(0) + 3))
      .join(""),
  );
}

// ── Login form — calls /api/users/pre-login ────────────────
document
  .getElementById("login-form")
  .addEventListener("submit", async function (e) {
    e.preventDefault();

    const formData = new FormData(this);
    const loginData = {
      user_id: formData.get("user_id"),
      password: formData.get("password"),
      // No payroll_class — that's picked later on the dashboard
    };

    console.log(">>> Sending pre-login payload:", loginData);

    try {
      const res = await fetch("/auth/users/pre-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginData),
      });

      const data = await res.json();
      console.log(">>> Pre-login response:", data);

      if (res.ok) {
        // Show success popup
        const popup = document.getElementById("loginSuccessPopup");
        const spinner = document.getElementById("loginSpinner");
        const message = document.getElementById("loginMessage");

        popup.classList.remove("hidden");
        spinner.innerHTML = `
        <div class="relative w-10 h-10">
          <div class="absolute left-1 w-[6px] bg-orange-600 rounded animate-grow-up"></div>
          <div class="absolute right-1 w-[6px] bg-orange-600 rounded animate-grow-down"></div>
          <div class="absolute top-1/2 left-1 h-[6px] bg-orange-600 rounded animate-expand -translate-y-1/2"></div>
        </div>
      `;

        message.textContent = "Logging you in...";

        setTimeout(() => {
          spinner.classList.add("hidden");
          message.innerHTML = `<span class="text-green-600">✔ Login successful!</span>`;
        }, 1200);

        setTimeout(() => {
          popup.classList.add("hidden");

          // Save token & user info to localStorage
          localStorage.setItem("token", data.token);
          localStorage.setItem("pre_login_token", data.token);
          localStorage.setItem("user_id", data.user.user_id);
          localStorage.setItem("full_name", data.user.full_name);
          localStorage.setItem("role", data.user.role);
          localStorage.setItem("class", data.user.primary_class);

          // Store capabilities so dashboard knows what to show
          localStorage.setItem(
            "capabilities",
            JSON.stringify(data.capabilities),
          );

          // Encrypt and store credentials temporarily in sessionStorage
          // so dashboard modal can complete Login 2 flow with class selection.
          // Wiped immediately after /api/users/login succeeds.
          sessionStorage.setItem(
            "_classes",
            JSON.stringify(data.available_classes || []),
          );
          sessionStorage.setItem("_pid", encryptVal(data.user.user_id));

          // Go to user dashboard — NOT the payroll dashboard
          window.location.href = "user-dashboard.html";
        }, 2500);
      } else {
        await AlertModal.show({
          type: "error",
          title: "Login Failed",
          message: data.error,
        });
      }
    } catch (err) {
      console.error("❌ Pre-login error:", err);
      await AlertModal.show({
        type: "error",
        title: "Connection Error",
        message: "Server not responding. Please try again.",
      });
    }
  });

// ── Password toggle ────────────────────────────────────────
const passwordInput = document.getElementById("loginPassword");
const togglePassword = document.getElementById("togglePassword");
const eyeOpen = document.getElementById("eyeOpen");
const eyeClosed = document.getElementById("eyeClosed");

togglePassword.addEventListener("click", () => {
  const isPassword = passwordInput.type === "password";
  passwordInput.type = isPassword ? "text" : "password";
  eyeOpen.style.display = isPassword ? "none" : "inline";
  eyeClosed.style.display = isPassword ? "inline" : "none";
});

//capitalize all
["userID"].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("input", () => {
    el.value = el.value.toUpperCase();
  });
});

// Forgot Password Manager
const ForgotPasswordManager = {
  modal: null,
  sentModal: null,

  init() {
    this.modal = document.getElementById("forgotPasswordModal");
    this.sentModal = document.getElementById("resetSentModal");

    document
      .getElementById("forgot-password-form")
      ?.addEventListener("submit", (e) => this.sendResetLink(e));

    document
      .getElementById("close-forgot-modal")
      ?.addEventListener("click", () => this.close());

    document
      .getElementById("cancel-forgot-btn")
      ?.addEventListener("click", () => this.close());

    document
      .getElementById("close-sent-modal")
      ?.addEventListener("click", () => this.closeSent());
  },

  open() {
    this.modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";

    document.getElementById("forgot-password-form").reset();
  },

  close() {
    this.modal.classList.add("hidden");
    document.body.style.overflow = "";
  },

  closeSent() {
    this.sentModal.classList.add("hidden");
    document.body.style.overflow = "";
  },

  async sendResetLink(e) {
    e.preventDefault();

    const btn = document.getElementById("forgot-submit-btn");

    btn.disabled = true;
    btn.textContent = "Sending...";

    const form = new FormData(e.target);

    const payload = {
      user_id: form.get("user_id"),
      email: form.get("email"),
    };

    try {
      const res = await fetch(`/auth/users/forgot-password-otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (res.ok) {
        this.close();

        localStorage.setItem("reset_identifier",payload.user_id)
        document.body.style.overflow = "hidden";
        window.location.href = "otp-verify.html";

      } else {
        await AlertModal.show({
          type: "error",
          title: "Request Failed",
          message: result.error || "Unable to send reset link.",
        });
      }
    } catch (err) {
      console.error(err);

      await AlertModal.show({
        type: "error",
        title: "Connection Error",
        message: "Unable to connect to the server. Please try again.",
      });
    } finally {
      btn.disabled = false;
      btn.textContent = "Send Reset Link";
    }
  },
};

// Set Password Manager
const SetPasswordManager = {
  modal: null,
  sentModal: null,

  init() {
    this.modal = document.getElementById("setPasswordModal");
    this.sentModal = document.getElementById("resetSentModal");

    document
      .getElementById("set-password-form")
      ?.addEventListener("submit", (e) => this.sendSetLink(e));

    document
      .getElementById("close-set-modal")
      ?.addEventListener("click", () => this.close());

    document
      .getElementById("cancel-set-btn")
      ?.addEventListener("click", () => this.close());

    document
      .getElementById("close-sent-modal")
      ?.addEventListener("click", () => this.closeSent());
  },

  open() {
    this.modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";

    document.getElementById("set-password-form").reset();
  },

  close() {
    this.modal.classList.add("hidden");
    document.body.style.overflow = "";
  },

  closeSent() {
    this.sentModal.classList.add("hidden");
    document.body.style.overflow = "";
  },

  async sendSetLink(e) {
    e.preventDefault();

    const btn = document.getElementById("set-submit-btn");

    btn.disabled = true;
    btn.textContent = "Sending...";

    const form = new FormData(e.target);

    const payload = {
      user_id: form.get("user_id"),
      ac_number: form.get("ac_number"),
    };

    try {
      const res = await fetch(`/auth/users/verify-identity`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (res.ok) {
        localStorage.setItem('user_id', payload.user_id)
        // Short-lived proof from verify-identity; required by /set-password
        sessionStorage.setItem('set_password_token', result.setup_token || '')
        this.close();
        
        window.location.href = "set-password.html";
        
        document.body.style.overflow = "hidden";
      } else {
        await AlertModal.show({
          type: "error",
          title: "Request Failed",
          message: result.error || "Unable to send link.",
        });
      }
    } catch (err) {
      console.error(err);

      await AlertModal.show({
        type: "error",
        title: "Connection Error",
        message: "Unable to connect to the server. Please try again.",
      });
    } finally {
      btn.disabled = false;
      btn.textContent = "Send Reset Link";
    }
  },
};

// Initialize when page loads
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => ForgotPasswordManager.init(),
    SetPasswordManager.init(),
  );
} else {
  ForgotPasswordManager.init();
  SetPasswordManager.init();
}

// Expose to global scope so you can call it from login page
window.openForgotPassword = () => ForgotPasswordManager.open();
window.openSetPassword = () => SetPasswordManager.open();
