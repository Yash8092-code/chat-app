const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();
console.log("MongoDB URI from .env:", process.env.MONGODB_URI);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MongoDB connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error", err));

// --- Schema & Model ---
const messageSchema = new mongoose.Schema({
  user: { type: String, default: "Anonymous" },
  text: String,
  time: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", messageSchema);

// Serve static files
app.use(express.static(__dirname + "/public"));

// --- Socket.IO ---
io.on("connection", (socket) => {
  console.log("🔌 User connected");

  // Send chat history
  Message.find().sort({ time: 1 }).limit(20).then(messages => {
    socket.emit("chat history", messages);
  });

  // Listen for new messages
  socket.on("chat message", async (msg) => {
    const newMsg = new Message({ text: msg });
    await newMsg.save();
    io.emit("chat message", newMsg); // broadcast to all
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected");
  });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});