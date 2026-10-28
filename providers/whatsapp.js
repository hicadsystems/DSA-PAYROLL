const cfg = require("../config");

class WhatsAppProvider {
  constructor(config = {}) {
    this.apiUrl =
      config.apiUrl ||
      process.env.WHATSAPP_API_URL ||
      "https://graph.facebook.com/v17.0";
    this.accessToken = config.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
    this.phoneNumberId =
      config.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.webhookVerifyToken =
      config.webhookVerifyToken || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    // Mock mode for development (when no credentials provided)
    this.mockMode = cfg.app.env === "development";

    if (this.mockMode) {
      console.log(
        "⚠️  WhatsApp Provider running in MOCK MODE (no credentials)",
      );
    } else {
      console.log("✅ WhatsApp Provider initialized with real credentials");
    }
  }

  /**
   * Send message via WhatsApp
   * @param {Object} data - Message data
   * @param {string} data.to - Recipient phone number
   * @param {string} data.message - Message text
   * @param {string} data.from - Sender user ID
   * @param {string} data.contact - Contact type (admin, payroll, etc.)
   * @returns {Promise<Object>} Response with message ID
   */
  async sendMessage(data) {
    const { to, message, from, contact } = data;

    // MOCK MODE: Simulate sending to WhatsApp
    if (this.mockMode) {
      return this._mockSendMessage(data);
    }

    // REAL MODE: Send to WhatsApp Business API
    try {
      const response = await fetch(
        `${this.apiUrl}/${this.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to.replace(/[^0-9]/g, ""), // Remove non-numeric characters
            type: "text",
            text: {
              preview_url: false,
              body: message,
            },
          }),
        },
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          `WhatsApp API Error: ${error.error?.message || "Unknown error"}`,
        );
      }

      const result = await response.json();

      return {
        success: true,
        messageId: result.messages[0].id,
        to,
        timestamp: new Date().toISOString(),
        provider: "whatsapp",
      };
    } catch (error) {
      console.error("WhatsApp send error:", error);
      throw error;
    }
  }

  /**
   * Receive message from WhatsApp webhook
   * @param {Object} webhookData - Webhook payload from WhatsApp
   * @returns {Object} Parsed message data
   */
  receiveMessage(webhookData) {
    try {
      // WhatsApp webhook format
      const entry = webhookData.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (!message) {
        return null;
      }

      return {
        from: message.from,
        message: message.text?.body || "",
        timestamp: new Date(parseInt(message.timestamp) * 1000).toISOString(),
        messageId: message.id,
        type: message.type,
        provider: "whatsapp",
      };
    } catch (error) {
      console.error("Error parsing WhatsApp webhook:", error);
      return null;
    }
  }

  /**
   * Verify webhook (required by WhatsApp)
   * @param {Object} query - Query parameters from webhook GET request
   * @returns {string|null} Challenge if valid, null otherwise
   */
  verifyWebhook(query) {
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === this.webhookVerifyToken) {
      console.log("Webhook verified successfully");
      return challenge;
    }

    console.error("Webhook verification failed");
    return null;
  }

  /**
   * Send message status/read receipt
   * @param {string} messageId - WhatsApp message ID
   * @param {string} status - Status (read, delivered)
   */
  async sendMessageStatus(messageId, status = "read") {
    if (this.mockMode) {
      console.log(`[MOCK] Marking message ${messageId} as ${status}`);
      return { success: true };
    }

    try {
      const response = await fetch(
        `${this.apiUrl}/${this.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            status: status,
            message_id: messageId,
          }),
        },
      );

      return { success: response.ok };
    } catch (error) {
      console.error("Error sending message status:", error);
      return { success: false };
    }
  }

  // ============================================
  // MOCK MODE METHODS (for development/testing)
  // ============================================

  /**
   * Mock sending message (for development)
   */
  _mockSendMessage(data) {
    const { to, message, from, contact } = data;

    console.log("📱 [MOCK WhatsApp] Sending message:");
    console.log(`   To: ${to}`);
    console.log(`   From User: ${from}`);
    console.log(`   Contact: ${contact}`);
    console.log(`   Message: ${message}`);

    const mockMessageId = `wamid.${Date.now()}${Math.random().toString(36).substr(2, 9)}`;

    // Simulate API delay
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: true,
          messageId: mockMessageId,
          to,
          timestamp: new Date().toISOString(),
          provider: "whatsapp-mock",
        });

        // Simulate auto-reply after 2 seconds
        setTimeout(() => {
          console.log(`📱 [MOCK WhatsApp] Simulated auto-reply to ${to}`);
          this._simulateIncomingMessage(to, from, contact);
        }, 2000);
      }, 500);
    });
  }

  /**
   * Simulate incoming message (for development)
   */
  _simulateIncomingMessage(from, userId, contact) {
    const responses = [
      "Thank you for contacting us. A support agent will be with you shortly.",
      "We've received your message and will respond as soon as possible.",
      "How can we assist you today?",
      "Your request has been noted. We'll get back to you within 24 hours.",
      "Is there anything else you'd like to know?",
    ];

    const randomResponse =
      responses[Math.floor(Math.random() * responses.length)];

    console.log(`📱 [MOCK WhatsApp] Simulated incoming message from ${from}`);

    // This would normally be triggered by the webhook
    // For mock mode, you can manually trigger it or use a callback
    return {
      from,
      message: randomResponse,
      timestamp: new Date().toISOString(),
      messageId: `wamid.incoming.${Date.now()}`,
      type: "text",
      provider: "whatsapp-mock",
    };
  }
}

module.exports = WhatsAppProvider;

// ============================================
// USAGE EXAMPLE:
// ============================================
/*

// Initialize provider
const whatsapp = new WhatsAppProvider({
  accessToken: 'your-access-token',
  phoneNumberId: 'your-phone-number-id',
  webhookVerifyToken: 'your-verify-token'
});

// Send message
await whatsapp.sendMessage({
  to: '+1234567890',
  message: 'Hello from support!',
  from: 'user123',
  contact: 'admin'
});

// Receive webhook message
const incomingMsg = whatsapp.receiveMessage(webhookPayload);

// Verify webhook
const challenge = whatsapp.verifyWebhook(req.query);

*/
