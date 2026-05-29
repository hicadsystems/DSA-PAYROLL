const express = require("express");
const Sockets = require("../../config/sockets");
const { getContactPhone, generateMessageId } = require("../../utils/helper");
const router = express.Router();

router.post("/whatsapp", async (req, res) => {
  try {
    const { from, message, timestamp, messageId } = req.body;

    console.log("Incoming WhatsApp message:", { from, message });

    // Find the room associated with this phone number
    for (const [room, roomData] of Sockets.getActiveRooms()) {
      const contact = roomData.contact;
      const contactPhone = getContactPhone(contact);

      if (contactPhone === from) {
        const messageData = {
          message_id: messageId || generateMessageId(),
          sender_id: "support",
          sender_name: contact + " Support",
          message,
          timestamp: timestamp || new Date().toISOString(),
          status: "received",
          type: "incoming",
        };

        // Store message
        roomData.messages.push(messageData);

        // Broadcast to room
        io.to(room).emit("whatsapp_incoming", {
          room,
          message,
          timestamp: messageData.timestamp,
          status: "received",
          message_id: messageData.message_id,
        });

        break;
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
