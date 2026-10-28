const cfg = require("../config");

/**
 * @typedef {Object} EmailAttachment
 * @property {string} filename
 * @property {Buffer|string} content
 * @property {string} [contentType]
 */

/**
 * @typedef {Object} OTPEmail
 * @property {string} email_address
 * @property {string} code
 */

/**
 * @typedef {Object} EmailMessage
 * @property {string|string[]} to
 * @property {string} subject
 * @property {string} [html]
 * @property {string} [text]
 * @property {string} [from]
 * @property {EmailAttachment[]} [attachments]
 */

class TermiiEmailProvider {
  constructor() {
    this.api_key = cfg.termii.api_key;
    this.email_configuration_id = cfg.termii.email_config_id;
    this.BASE_URL = "https://v4.api.termii.com";
  }
  /**
   * Send an email
   *
   * @param {OTPEmail} data
   * @returns {Promise<{
   *   code: string,
   *   message_id: string,
   *   balance: string,
   *   message: string,
   *   user: string
   *   timestamp: string
   * }>}
   */
  async sendOTP(data) {
    try {
      const result = await fetch(`${this.BASE_URL}/api/email/otp/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...data,
          api_key: this.api_key,
          email_configuration_id: this.email_configuration_id,
        }),
      });
      const res = await result.json();

      if (!result.ok) {
        throw new Error(
          `Termii email API failed (${result.status}): ${JSON.stringify(res)}`,
        );
      }

      return res;
    } catch (error) {
      console.log("Termii Error: " + error);
      throw error;
    }
  }
}

module.exports = new TermiiEmailProvider();
