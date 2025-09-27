const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

console.log("MongoDB URI from .env:", process.env.MONGODB_URI);

const app = express();
const server = http.createServer(app);

// ✅ Allow cross-origin connections (important for phone/web)
const io = new Server(server, {
  cors: {
    origin: "*", // you can restrict this to your domain later
    methods: ["GET", "POST"]
  }
});

// --- MongoDB connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error", err));

// --- Schema & Model ---
const messageSchema = new mongoose.Schema({
  user: { type: String, default: "Anonymous" },
  text: String,
  replyTo: {
    user: String,
    text: String
  },
  time: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", messageSchema);

// Serve static files from "public"
app.use(express.static(__dirname + "/public"));

// --- Socket.IO ---
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // ✅ Clear all chat messages
  socket.on("clear chat", async () => {
    await Message.deleteMany({});
    io.emit("chat cleared");
  });

  // ✅ Send last 20 messages
  Message.find().sort({ time: 1 }).limit(20).then(messages => {
    socket.emit("chat history", messages);
  });

  // ✅ Normal messages
  socket.on("chat message", async (msg) => {
    const newMsg = new Message({
      user: msg.user,
      text: msg.text,
      replyTo: msg.replyTo || null
    });
    await newMsg.save();
    io.emit("chat message", newMsg);
  });

  // ✅ Global Red Alert Feature
  socket.on("send alert", (data) => {
    io.emit("alert", {
      sender: data.user,
      text: data.text || "⚠️ ALERT from admin!"
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});