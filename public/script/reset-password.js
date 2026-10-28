// script/reset-password.js
// Vanilla JS — no frameworks. Reads ?token= from the URL, verifies it against
// the backend, then handles the new-password submission.

(() => {
  const checkingState = document.getElementById("checking-state");
  const invalidState = document.getElementById("invalid-state");
  const formState = document.getElementById("form-state");
  const invalidTitle = document.getElementById("invalid-title");
  const invalidMessage = document.getElementById("invalid-message");

  const resetForm = document.getElementById("reset-password-form");
  const submitBtn = document.getElementById("reset-submit-btn");
  const newPasswordInput = document.getElementById("new-password");
  const confirmInput = document.getElementById("confirm-password");
  const lengthMsg = document.getElementById("password-length-msg");
  const matchMsg = document.getElementById("password-match-msg");

  const successModal = document.getElementById("resetSuccessModal");
  const goToLoginBtn = document.getElementById("go-to-login-btn");

  const alertModal = document.getElementById("alertModal");
  const alertTitle = document.getElementById("alert-title");
  const alertMessage = document.getElementById("alert-message");
  const alertOkBtn = document.getElementById("alert-ok-btn");

  function showState(state) {
    checkingState.classList.add("hidden");
    invalidState.classList.add("hidden");
    formState.classList.add("hidden");
    state.classList.remove("hidden");
  }

  function showAlert(title, message) {
    alertTitle.textContent = title;
    alertMessage.textContent = message;
    alertModal.classList.remove("hidden");
  }

  alertOkBtn.addEventListener("click", () => {
    alertModal.classList.add("hidden");
  });

  goToLoginBtn.addEventListener("click", () => {
    window.location.href = "/personnel-user-login.html";
  });

  // ---------------------------------------------------------------------
  // Password show/hide toggles
  // ---------------------------------------------------------------------
  document.querySelectorAll(".toggle-password").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const targetId = toggle.dataset.target;
      const input = document.getElementById(targetId);
      const eyeOpen = toggle.querySelector(".eye-open");
      const eyeClosed = toggle.querySelector(".eye-closed");

      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      eyeOpen.style.display = isPassword ? "none" : "block";
      eyeClosed.style.display = isPassword ? "block" : "none";
    });
  });

  // ---------------------------------------------------------------------
  // Live validation
  // ---------------------------------------------------------------------
  function validatePasswords() {
    const pw = newPasswordInput.value;
    const confirm = confirmInput.value;

    let valid = true;

    if (pw.length > 0 && pw.length < 8) {
      lengthMsg.textContent = "Password must be at least 8 characters.";
      lengthMsg.className = "text-xs text-red-600";
      valid = false;
    } else {
      lengthMsg.textContent = "";
    }

    if (confirm.length > 0 && pw !== confirm) {
      matchMsg.textContent = "Passwords do not match.";
      matchMsg.className = "text-xs text-red-600";
      valid = false;
    } else if (confirm.length > 0) {
      matchMsg.textContent = "Passwords match.";
      matchMsg.className = "text-xs text-green-600";
    } else {
      matchMsg.textContent = "";
    }

    submitBtn.disabled = !(pw.length >= 8 && pw === confirm);
    return valid;
  }

  newPasswordInput.addEventListener("input", validatePasswords);
  confirmInput.addEventListener("input", validatePasswords);

  // ---------------------------------------------------------------------
  // Read user_id and otp from local storage
  // ---------------------------------------------------------------------
  // const params = new URLSearchParams(window.location.search);
  // const token = params.get("token");

  // if (!token) {
  //   invalidTitle.textContent = "Missing Reset Token";
  //   invalidMessage.textContent =
  //     "No reset token was found in this link. Please request a new password reset.";
  //   showState(invalidState);
  //   return;
  // }

  const raw = localStorage.getItem("reset_token");
  if (!raw) {
    invalidTitle.textContent = "Missing Reset OTP";
    invalidMessage.textContent =
      "No reset otp was found. Please request a new password reset.";
    showState(invalidState);
    return;
  }

  // ---------------------------------------------------------------------
  // Verify otp with backend before showing the form
  // ---------------------------------------------------------------------
  async function verifyToken() {
  
  const parsed = JSON.parse(raw)
    try {    
      const res = await fetch(
        `/auth/users/verify-reset-otp`,
        {
          method: "PATCH",
          body: JSON.stringify({ user_id: parsed.user_id, otp: parsed.otp }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const data = await res.json();

      if (res.ok && data.valid) {
        showState(formState);
        return;
      }

      // Custom messages per reason returned by the backend
      switch (data.reason) {
        case "expired":
          invalidTitle.textContent = "OTP Expired";
          invalidMessage.textContent =
            "This password reset OTP has expired. Please request a new one.";
          break;
        case "invalid":
          invalidTitle.textContent = "Invalid OTP";
          invalidMessage.textContent =
            "This reset OTP is invalid or has already been used.";
          break;
        case "server_error":
          invalidTitle.textContent = "Something Went Wrong";
          invalidMessage.textContent =
            "We could not verify this OTP right now. Please try again shortly.";
          break;
        default:
          invalidTitle.textContent = "OTP Invalid";
          invalidMessage.textContent =
            "This password reset OTP could not be verified.";
      }

      showState(invalidState);
    } catch (err) {
      console.error("Token verification failed:", err);
      invalidTitle.textContent = "Connection Error";
      invalidMessage.textContent =
        "Could not reach the server. Check your connection and try again.";
      showState(invalidState);
    }
  }

  verifyToken();

  // ---------------------------------------------------------------------
  // Submit new password
  // ---------------------------------------------------------------------
  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!validatePasswords()) return;

    const newPassword = newPasswordInput.value;

    submitBtn.disabled = true;
    submitBtn.textContent = "Resetting...";

    try {

      const parsed = JSON.parse(raw)
      const res = await fetch(`/auth/users/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token:`${parsed.user_id}:${parsed.otp}`, new_password: newPassword }),
      });

      const data = await res.json();

      if (res.ok) {
        successModal.classList.remove("hidden");
        return;
      }

      // Custom messages for different backend error reasons
      switch (data.error) {
        case "expired":
          showAlert(
            "Link Expired",
            "This reset link has expired. Please request a new one from the login page.",
          );
          break;
        case "invalid":
          showAlert(
            "Invalid Link",
            "This reset link is invalid or has already been used.",
          );
          break;
        default:
          showAlert(
            "Reset Failed",
            data.error || "Something went wrong. Please try again.",
          );
      }
    } catch (err) {
      console.error("Reset password request failed:", err);
      showAlert(
        "Connection Error",
        "Could not reach the server. Check your connection and try again.",
      );
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Reset Password";
    }
  });
})();
