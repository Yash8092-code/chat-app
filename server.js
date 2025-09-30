// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const mongoose = require("mongoose");
const path = require("path");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

// --- Configure Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- Configure Multer ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ------------ PostgreSQL (Users + Sessions) ------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "a-default-fallback-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 24 hours
    name: "chat_sid"
  })
);

async function initPgTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      avatar_url TEXT DEFAULT '/default-avatar.png',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("✅ Postgres users table ready");
}
initPgTables();

// ------------ MongoDB (Messages) ------------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected (messages)"))
  .catch(err => console.error("❌ MongoDB error", err));

const messageSchema = new mongoose.Schema({
  user: String,
  avatar_url: { type: String, default: "/default-avatar.png" },
  text: String,
  audio_url: String,
  image_url: String,
  seen: { type: Boolean, default: false },
  replyTo: { user: String, text: String },
  time: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", messageSchema);

let activeUsers = {};

// ------------ Auth & File Upload Routes ------------
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests, please try again after 15 minutes.'
});

app.post("/signup", authLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "All fields required" });
  try {
    const check = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (check.rows.length) return res.status(400).json({ error: "Email already exists" });
    const hash = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (username, email, password) VALUES ($1,$2,$3)", [username, email, hash]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Signup error", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "All fields required" });
  try {
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid credentials" });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = { id: user.id, username: user.username, email: user.email, avatar_url: user.avatar_url };
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Login error", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("chat_sid");
    res.json({ success: true });
  });
});

app.post("/update-avatar", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const { avatarUrl } = req.body;
  try {
    await pool.query("UPDATE users SET avatar_url=$1 WHERE id=$2", [avatarUrl, req.session.user.id]);
    req.session.user.avatar_url = avatarUrl;
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Avatar update error", err);
    res.status(500).json({ error: "Avatar update failed" });
  }
});

app.get("/me", (req, res) => {
  if (req.session.user) res.json({ user: req.session.user });
  else res.status(401).json({ error: "Not logged in" });
});

app.post("/upload-voice-note", upload.single('audio'), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
    if (!req.file) return res.status(400).json({ error: "No audio file provided" });
    cloudinary.uploader.upload_stream({ resource_type: "video" }, async (error, result) => {
        if (error || !result) {
            console.error("Cloudinary upload error:", error);
            return res.status(500).json({ error: "Failed to upload audio" });
        }
        const newMsg = new Message({ user: req.session.user.username, avatar_url: req.session.user.avatar_url, audio_url: result.secure_url });
        await newMsg.save();
        io.emit("chat message", newMsg);
        res.json({ success: true });
    }).end(req.file.buffer);
});

app.post("/upload-image", upload.single('image'), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    cloudinary.uploader.upload_stream({ resource_type: "image" }, async (error, result) => {
        if (error || !result) {
            console.error("Cloudinary image upload error:", error);
            return res.status(500).json({ error: "Failed to upload image" });
        }
        const newMsg = new Message({ user: req.session.user.username, avatar_url: req.session.user.avatar_url, image_url: result.secure_url });
        await newMsg.save();
        io.emit("chat message", newMsg);
        res.json({ success: true });
    }).end(req.file.buffer);
});

// ------------ Routing ------------
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get("/", (req, res) => res.redirect("/login.html"));
app.get("/chat", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ------------ Socket.IO ------------
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);
  const broadcastUserList = () => io.emit("update user list", Object.values(activeUsers));
  Message.find().sort({ time: 1 }).limit(100).then((msgs) => socket.emit("chat history", msgs));

  socket.on("user connected", (userData) => {
    activeUsers[socket.id] = { username: userData.username, avatar_url: userData.avatar_url };
    console.log(`${userData.username} has joined.`);
    broadcastUserList();
  });

  socket.on("chat message", async (msg) => {
    try {
      const newMsg = new Message({ user: msg.user, avatar_url: msg.avatar_url, text: msg.text, replyTo: msg.replyTo });
      await newMsg.save();
      io.emit("chat message", newMsg);
    } catch (err) {
      console.error("❌ Error saving message", err);
    }
  });

  socket.on('message seen', async ({ messageId }) => {
    try {
        const msg = await Message.findById(messageId);
        if (msg && !msg.seen) {
            await Message.updateOne({ _id: messageId }, { $set: { seen: true } });
            io.emit('message status updated', { messageId, status: 'seen' });
        }
    } catch (err) {
        console.error("Error marking message as seen:", err);
    }
  });

  socket.on('typing start', () => { if (activeUsers[socket.id]) socket.broadcast.emit('user typing start', activeUsers[socket.id]); });
  socket.on('typing stop', () => { if (activeUsers[socket.id]) socket.broadcast.emit('user typing stop', activeUsers[socket.id]); });
  socket.on("clear chat", async () => { try { await Message.deleteMany({}); io.emit("chat cleared"); } catch (err) { console.error("❌ Error clearing chat", err); } });
  socket.on("send alert", (data) => io.emit("alert", { sender: data.user, text: data.text }));

  socket.on("disconnect", () => {
    const user = activeUsers[socket.id];
    if (user) {
      console.log(`❌ ${user.username} disconnected`);
      socket.broadcast.emit('user typing stop', user);
      delete activeUsers[socket.id];
      broadcastUserList();
    }
  });
});

// ------------ Start Server ------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));