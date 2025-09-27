const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error", err));

// Schema & Model
const messageSchema = new mongoose.Schema({
  user: { type: String, default: "Anonymous" },
  text: String,
  replyTo: {
    user: String,
    text: String,
  },
  time: { type: Date, default: Date.now },
});
const Message = mongoose.model("Message", messageSchema);

app.use(express.static(__dirname + "/public"));

// --- Socket.IO ---
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  socket.on("clear chat", async () => {
    await Message.deleteMany({});
    io.emit("chat cleared");
  });

  Message.find().sort({ time: 1 }).limit(20).then(messages => {
    socket.emit("chat history", messages);
  });

  socket.on("chat message", async (msg) => {
    const newMsg = new Message({
      user: msg.user,
      text: msg.text,
      replyTo: msg.replyTo || null,
    });
    await newMsg.save();
    io.emit("chat message", newMsg);
  });

  socket.on("send alert", (data) => {
    io.emit("alert", {
      sender: data.user,
      text: data.text || "⚠️ ALERT!",
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});