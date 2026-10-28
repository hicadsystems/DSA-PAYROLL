const cfg = require("../config");
const nodemailer = require("nodemailer");

/**
 * @typedef {Object} EmailAttachment
 * @property {string} filename
 * @property {Buffer|string} content
 * @property {string} [contentType]
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

class EmailProvider {
  constructor() {
    this.host = cfg.email.host || process.env.SMTP_HOST;
    this.port = Number(cfg.email.port || process.env.SMTP_PORT || 587);

    this.secure = Number(this.port) === 465;

    this.user = cfg.email.user || process.env.SMTP_USER;
    this.pass = cfg.email.password || process.env.SMTP_PASS;

    this.fromEmail = cfg.email.from || process.env.SMTP_FROM_EMAIL;

    this.fromName = "DSA Payroll";

    this.transporter = null;
  }

  /**
   * Initialize SMTP transport
   * @returns {Promise<void>}
   */
  async startup() {
    this.transporter = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.secure,
      auth: {
        user: this.user,
        pass: this.pass,
      },
      pool: true,
    });

    try {
      await this.transporter.verify();
      this.isReady = true;
      console.log("✅ Email Provider initialized");
    } catch (err) {
      this.isReady = false;
      console.error("❌ Email Provider failed to initialize:", err.message);
    }
  }
  /**
   * Close SMTP transport pool
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }

    console.log("🛑 Email Provider shut down");
  }

  /**
   * Send an email
   *
   * @param {EmailMessage} data
   * @returns {Promise<{
   *   success: boolean,
   *   messageId: string,
   *   to: string|string[],
   *   timestamp: string,
   *   provider: string
   * }>}
   */
  async sendMessage(data) {
    if (!this.transporter) {
      throw new Error("EmailProvider not initialized. Call startup() first.");
    }

    const { to, subject, html, text, from, attachments } = data;

    const result = await this.transporter.sendMail({
      from: from || `"${this.fromName}" <${this.fromEmail}>`,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject,
      html,
      text,
      attachments,
    });

    return {
      success: true,
      messageId: result.messageId,
      to,
      timestamp: new Date().toISOString(),
      provider: "email",
    };
  }
}

module.exports = new EmailProvider();
