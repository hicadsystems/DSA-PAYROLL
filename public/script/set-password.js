// script/set-password.js
// Vanilla JS — no frameworks. Reads ?token= from the URL, verifies it against
// the backend, then handles the new-password submission.

(() => {
  const checkingState = document.getElementById("checking-state");
  const invalidState = document.getElementById("invalid-state");
  const formState = document.getElementById("form-state");
  const invalidTitle = document.getElementById("invalid-title");
  const invalidMessage = document.getElementById("invalid-message");

  const setForm = document.getElementById("set-password-form");
  const submitBtn = document.getElementById("set-submit-btn");
  const newPasswordInput = document.getElementById("new-password");
  const confirmInput = document.getElementById("confirm-password");
  const lengthMsg = document.getElementById("password-length-msg");
  const matchMsg = document.getElementById("password-match-msg");

  const successModal = document.getElementById("setSuccessModal");
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
  // Read User ID from local storage
  // ---------------------------------------------------------------------
  const user_id = localStorage.getItem("user_id");
  const setup_token = sessionStorage.getItem("set_password_token");

  function verifySvcNo() {
    if (!user_id || !setup_token) {
      invalidTitle.textContent = "Missing User ID";
      invalidMessage.textContent =
        "No User ID found. Please go to the login page";
      showState(invalidState);
      return;
    }
    showState(formState);
  }

  verifySvcNo();
  // ---------------------------------------------------------------------
  // Submit new password
  // ---------------------------------------------------------------------
  setForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!validatePasswords()) return;

    const newPassword = newPasswordInput.value;

    submitBtn.disabled = true;
    submitBtn.textContent = "Setting...";

    try {
      const res = await fetch(`/auth/users/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id, new_password: newPassword, setup_token }),
      });

      const data = await res.json();

      if (res.ok) {
        successModal.classList.remove("hidden");
        localStorage.removeItem("user_id")
        sessionStorage.removeItem("set_password_token")
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
            "Invalid User ID",
            "This User ID is invalid does not exist. Please go to the login page",
          );
          break;
        default:
          showAlert(
            "Password Creation Failed",
            data.error || "Something went wrong. Please try again.",
          );
      }
    } catch (err) {
      console.error("Set password request failed:", err);
      showAlert(
        "Connection Error",
        "Could not reach the server. Check your connection and try again.",
      );
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Set Password";
    }
  });
})();
