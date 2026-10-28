// script/otp-verify.js
// Vanilla JS. Reads the User ID saved by the forgot-password / first-time
// step, collects the 6-digit code, exchanges both for a reset token, then hands
// off to the existing reset-password page (unchanged; reads ?token= from the URL).
//
// Contract with the previous step (forgot-password / first-time flow):
//   localStorage.setItem(
//     "reset_identifier",
//     JSON.stringify({ id: userId, ts: Date.now() })
//   );
// A plain string value also works, but without `ts` it never goes stale.

(() => {
  // ---- Config: adjust to your routes ------------------------------------
  const VERIFY_OTP_URL = "/auth/users/verify-reset-otp";
  const RESET_PAGE = "/reset-password.html";
  const OTP_LENGTH = 6;
  const IDENTIFIER_KEY = "reset_identifier";
  // -----------------------------------------------------------------------

  const otpState = document.getElementById("otp-state");
  const missingState = document.getElementById("missing-state");
  const form = document.getElementById("otp-form");
  const otpInput = document.getElementById("otp-input");
  const errorEl = document.getElementById("otp-error");
  const submitBtn = document.getElementById("otp-submit-btn");

 

  const identifier = localStorage.getItem("reset_identifier");

  if (!identifier) {
    otpState.classList.add("hidden");
    missingState.classList.remove("hidden");
    return;
  }

  otpInput.focus();

  function showError(msg) {
    errorEl.textContent = msg;
    otpInput.classList.toggle("border-red-500", Boolean(msg));
  }

  function digitsOnly(value) {
    return value.replace(/\D/g, "").slice(0, OTP_LENGTH);
  }

  function updateSubmitState() {
    submitBtn.disabled = otpInput.value.length !== OTP_LENGTH;
  }

  // Strip spaces/dashes/letters so "123 456" or "123-456" pastes cleanly.
  otpInput.addEventListener("input", () => {
    otpInput.value = digitsOnly(otpInput.value);
    showError("");
    updateSubmitState();
  });

  otpInput.addEventListener("paste", (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData).getData("text");
    otpInput.value = digitsOnly(pasted);
    showError("");
    updateSubmitState();
    if (otpInput.value.length === OTP_LENGTH) submitBtn.focus();
  });

  updateSubmitState();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const otp = otpInput.value;
    if (otp.length !== OTP_LENGTH) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Verifying...";
    showError("");

    let redirecting = false;


    try {
      const res = await fetch(VERIFY_OTP_URL, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id:identifier, otp }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        redirecting = true;
        submitBtn.textContent = "Verified. Redirecting...";
        try {
          localStorage.removeItem(IDENTIFIER_KEY);
          localStorage.setItem("reset_token", JSON.stringify({ user_id: identifier, otp }));
        } catch {}
        window.location.href = `${RESET_PAGE}`;

        return;
      }

      switch (data.error) {
        case "invalid":
          showError(
            typeof data.attempts_left === "number"
              ? `Incorrect code. ${data.attempts_left} attempt${data.attempts_left === 1 ? "" : "s"} left.`
              : "Incorrect code. Check the email and try again.",
          );
          break;
        case "locked":
          showError(
            "Too many incorrect attempts. Request a new code to continue.",
          );
          break;
        case "expired":
          showError("This code is invalid or has expired. Request a new one.");
          break;
        case "rate_limited":
          showError("Too many requests. Please wait a few minutes and retry.");
          break;
        default:
          showError(data.error || "Something went wrong. Please try again.");
      }
      otpInput.select();
    } catch (err) {
      console.error("OTP verification failed:", err);
      showError(
        "Could not reach the server. Check your connection and try again.",
      );
    } finally {
      if (!redirecting) {
        submitBtn.textContent = "Verify Code";
        updateSubmitState();
      }
    }
  });
})();
