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
      info: '<svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
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
          <div class="absolute left-1 w-[6px] bg-blue-600 rounded animate-grow-up"></div>
          <div class="absolute right-1 w-[6px] bg-blue-600 rounded animate-grow-down"></div>
          <div class="absolute top-1/2 left-1 h-[6px] bg-blue-600 rounded animate-expand -translate-y-1/2"></div>
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
          localStorage.setItem('capabilities', JSON.stringify(data.capabilities));

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
  ["userID"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      el.value = el.value.toUpperCase();
    });
  });

// Forgot Password Link
const isLocal = window.location.hostname === "localhost";
const BASE_URL = isLocal ? "http://localhost:5500" : "https://hicad.ng";

// Forgot Password Manager
const ForgotPasswordManager = {
  modal: null,
  verifyStep: null,
  resetStep: null,
  successModal: null,
  verifiedData: null,

  init() {
    this.modal = document.getElementById("forgotPasswordModal");
    this.verifyStep = document.getElementById("verify-step");
    this.resetStep = document.getElementById("reset-step");
    this.successModal = document.getElementById("resetSuccessModal");

    // Load payroll classes for verification
    //this.loadPayrollClasses();

    // Bind events
    document
      .getElementById("close-forgot-modal")
      ?.addEventListener("click", () => this.close());
    document
      .getElementById("close-reset-modal")
      ?.addEventListener("click", () => this.close());
    document
      .getElementById("cancel-verify-btn")
      ?.addEventListener("click", () => this.close());
    document
      .getElementById("back-to-verify-btn")
      ?.addEventListener("click", () => this.backToVerify());
    document
      .getElementById("close-success-modal")
      ?.addEventListener("click", () => this.closeSuccess());

    // Form submissions
    document
      .getElementById("verify-identity-form")
      ?.addEventListener("submit", (e) => this.verifyIdentity(e));
    document
      .getElementById("reset-password-form")
      ?.addEventListener("submit", (e) => this.resetPassword(e));

    // Password matching validation
    document
      .getElementById("confirm-new-password")
      ?.addEventListener("input", () => this.validatePasswordMatch());
    document
      .getElementById("new-password")
      ?.addEventListener("input", () => this.validatePasswordMatch());

    // Password length validation
    document
      .getElementById("new-password")
      ?.addEventListener("input", () => this.validatePasswordLength());

    // Password toggle
    document.querySelectorAll(".toggle-password-reset").forEach((toggle) => {
      toggle.addEventListener("click", function () {
        const targetId = this.getAttribute("data-target");
        const input = document.getElementById(targetId);
        if (!input) return;

        const isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";

        const eyeOpen = this.querySelector(".eye-open");
        const eyeClosed = this.querySelector(".eye-closed");
        if (eyeOpen && eyeClosed) {
          eyeOpen.style.display = isPassword ? "none" : "inline";
          eyeClosed.style.display = isPassword ? "inline" : "none";
        }
      });
    });
  },

  open() {
    this.modal.classList.remove("hidden");
    this.verifyStep.classList.remove("hidden");
    this.resetStep.classList.add("hidden");
    document.body.style.overflow = "hidden";

    // Reset forms
    document.getElementById("verify-identity-form")?.reset();
    document.getElementById("reset-password-form")?.reset();
  },

  close() {
    this.modal.classList.add("hidden");
    document.body.style.overflow = "";
    this.verifiedData = null;
  },

  closeSuccess() {
    this.successModal.classList.add("hidden");
    document.body.style.overflow = "";
  },

  backToVerify() {
    this.verifyStep.classList.remove("hidden");
    this.resetStep.classList.add("hidden");
  },

  validatePasswordMatch() {
    const password = document.getElementById("new-password")?.value || "";
    const confirm =
      document.getElementById("confirm-new-password")?.value || "";
    const msg = document.getElementById("password-match-msg");

    if (!msg) return true;

    if (confirm === "") {
      msg.textContent = "";
      msg.className = "text-xs";
      return true;
    }

    if (password === confirm) {
      msg.textContent = "✓ Passwords match";
      msg.className = "text-xs text-green-600";
      return true;
    } else {
      msg.textContent = "✗ Passwords do not match";
      msg.className = "text-xs text-red-600";
      return false;
    }
  },

  validatePasswordLength() {
    const password = document.getElementById("new-password")?.value || "";
    const msg = document.getElementById("password-length-msg");

    if (!msg) return true;

    if (password.length < 6) {
      msg.textContent = "✗ Password must be at least 6 characters long";
      msg.className = "text-xs text-red-600";
      return false;
    } else {
      msg.textContent = "✓ Password is valid";
      msg.className = "text-xs text-green-600";
      return true;
    }
  },

  async verifyIdentity(e) {
    e.preventDefault();

    const btn = document.getElementById("verify-btn");
    btn.disabled = true;
    btn.textContent = "Verifying...";

    const formData = new FormData(e.target);
    const data = {
      user_id: formData.get("user_id"),
      full_name: formData.get("full_name"),
    };

    try {
      const res = await fetch(
        `${BASE_URL}/auth/users/verify-identity`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );

      const result = await res.json();

      if (res.ok) {
        this.verifiedData = data;

        document.getElementById("reset-user-id").value = data.user_id;
        document.getElementById("reset-full-name").value = data.full_name;

        this.verifyStep.classList.add("hidden");
        this.resetStep.classList.remove("hidden");
      } else {
        await AlertModal.show({
          type: "error",
          title: "Verification Failed",
          message: result.error || "Identity verification failed",
        });
      }
    } catch (err) {
      console.error("Verification error:", err);
      await AlertModal.show({
        type: "error",
        title: "Connection Error",
        message: "Failed to connect to server. Please try again.",
      });
    } finally {
      btn.disabled = false;
      btn.textContent = "Verify Identity";
    }
  },

  async resetPassword(e) {
    e.preventDefault();

    const password = document.getElementById("new-password").value;
    const confirm = document.getElementById("confirm-new-password").value;

    if (password.length < 6) {
      await AlertModal.show({
        type: "error",
        title: "Invalid Password",
        message: "Password must be at least 6 characters long",
      });
      return;
    }

    if (password !== confirm) {
      await AlertModal.show({
        type: "error",
        title: "Password Mismatch",
        message: "Passwords do not match. Please try again.",
      });
      return;
    }

    const btn = document.getElementById("reset-btn");
    btn.disabled = true;
    btn.textContent = "Resetting...";

    const data = {
      user_id: document.getElementById("reset-user-id").value,
      full_name: document.getElementById("reset-full-name").value,
      new_password: password,
    };

    try {
      const res = await fetch(
        `${BASE_URL}/auth/users/reset-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );

      const result = await res.json();

      if (res.ok) {
        this.close();
        this.successModal.classList.remove("hidden");
        document.body.style.overflow = "hidden";
      } else {
        await AlertModal.show({
          type: "error",
          title: "Password Reset Failed",
          message: result.error || "Password reset failed. Please try again.",
        });
      }
    } catch (err) {
      console.error("Reset error:", err);
      await AlertModal.show({
        type: "error",
        title: "Connection Error",
        message: "Failed to connect to server. Please try again.",
      });
    } finally {
      btn.disabled = false;
      btn.textContent = "Reset Password";
    }
  },
};

// Initialize when page loads
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () =>
    ForgotPasswordManager.init(),
  );
} else {
  ForgotPasswordManager.init();
}

// Expose to global scope so you can call it from login page
window.openForgotPassword = () => ForgotPasswordManager.open();
