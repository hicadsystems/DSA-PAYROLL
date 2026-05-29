const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const cfg = require("../config");
const WhatsAppProvider = require("../providers/whatsapp");

class SocketService {
  // =========================
  // STATIC SHARED STATE
  // =========================
  static io = null;
  static whatsappProvider = new WhatsAppProvider();

  static activeRooms = new Map(); // room -> { users, contact, messages }
  static userSockets = new Map(); // userId -> socketId

  // =========================
  // INIT (called once)
  // =========================
  static init(server) {
    if (this.io) return this.io; // prevent double init

    console.log("Sockets Initializing");

    this.io = new Server(server, {
      cors: {
        origin: [
          "http://localhost:5500",
          "http://127.0.0.1:5500",
          "https://hicad.ng", // production
        ].filter(Boolean),
        credentials: true,
      },
    });

    this.setupAuth();
    this.handleConnections();

    console.log("Sockets Initialized");

    return this.io;
  }

  // =========================
  // JWT AUTH
  // =========================
  static setupAuth() {
    console.log("setting up auth");
    this.io.use((socket, next) => {
      console.log("set up");
      const token = socket.handshake.auth?.token;

      if (!token) {
        console.log("no token");
        socket.authError = "NO_TOKEN";
        return next(); // do NOT throw
      }

      try {
        const decoded = jwt.verify(token, cfg.jwt.secret);

        socket.user = decoded;
        socket.userId = decoded.user_id || decoded.userId || decoded.id;

        next();
      } catch (err) {
        next(new Error("Authentication error: Invalid token"));
      }
    });
    console.log("autj setup");
  }

  // =========================
  // CONNECTION HANDLER
  // =========================
  static handleConnections() {
    this.io.on("connection", (socket) => {
      this.userSockets.set(socket.userId, socket.id);

      socket.emit("connected", {
        message: "Connected to support chat",
        userId: socket.userId,
      });

      this.registerEvents(socket);
    });
  }

  // =========================
  // EVENTS
  // =========================
  static registerEvents(socket) {
    socket.on("join_room", (data) => this.joinRoom(socket, data));

    socket.on("leave_room", (data) => this.leaveRoom(socket, data));

    socket.on("whatsapp_send", (data) =>
      this.sendWhatsappMessage(socket, data),
    );

    socket.on("typing", (data) => this.typing(socket, data));

    socket.on("stop_typing", (data) => this.stopTyping(socket, data));

    socket.on("disconnect", (reason) => this.onDisconnect(socket, reason));

    socket.on("error", (error) => this.onError(socket, error));
  }

  // =========================
  // ROOM LOGIC
  // =========================
  static joinRoom(socket, { room, contact }) {
    socket.join(room);

    if (!this.activeRooms.has(room)) {
      this.activeRooms.set(room, {
        users: new Set(),
        contact,
        messages: [],
      });
    }

    const roomData = this.activeRooms.get(room);
    roomData.users.add(socket.userId);

    socket.emit("room_joined", {
      room,
      contact,
      messageCount: roomData.messages.length,
    });
  }

  static leaveRoom(socket, { room }) {
    socket.leave(room);

    const roomData = this.activeRooms.get(room);
    if (!roomData) return;

    roomData.users.delete(socket.userId);

    if (roomData.users.size === 0) {
      this.activeRooms.delete(room);
    }
  }

  // =========================
  // WHATSAPP
  // =========================
  static async sendWhatsappMessage(socket, data) {
    const { room, message, phone, contact, timestamp } = data;

    try {
      if (!this.activeRooms.has(room)) return;

      const messageData = {
        message_id: randomUUID(),
        sender_id: socket.userId,
        sender_name: socket.user?.name || "User",
        message,
        timestamp: timestamp || new Date().toISOString(),
        status: "sent",
        type: "outgoing",
      };

      const roomData = this.activeRooms.get(room);
      roomData.messages.push(messageData);

      const response = await this.whatsappProvider.sendMessage({
        to: phone,
        message,
        from: socket.userId,
        contact,
      });

      messageData.status = "delivered";
      messageData.whatsapp_message_id = response.messageId;

      this.io.to(room).emit("message_status", {
        message_id: messageData.message_id,
        status: "delivered",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      socket.emit("error", {
        message: "Failed to send message",
        error: err.message,
      });
    }
  }

  // =========================
  // UX EVENTS
  // =========================
  static typing(socket, { room, sender }) {
    socket.to(room).emit("typing", { room, sender });
  }

  static stopTyping(socket, { room, sender }) {
    socket.to(room).emit("stop_typing", { room, sender });
  }

  // =========================
  // DISCONNECT
  // =========================
  static onDisconnect(socket, reason) {
    this.userSockets.delete(socket.userId);

    for (const [room, data] of this.activeRooms.entries()) {
      data.users.delete(socket.userId);
      if (data.users.size === 0) {
        this.activeRooms.delete(room);
      }
    }
  }

  static onError(socket, error) {
    socket.emit("error", { message: error.message });
  }

  // =========================
  // ✅ STATIC GET ACTIVE ROOMS
  // =========================
  static getActiveRooms() {
    return Array.from(this.activeRooms.entries()).map(([room, data]) => ({
      room,
      contact: data.contact,
      usersCount: data.users.size,
      messageCount: data.messages.length,
    }));
  }
}

module.exports = SocketService;
