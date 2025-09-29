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
const multer = require("multer"); // For file uploads
const cloudinary = require("cloudinary").v2; // For cloud storage
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

// --- Configure Multer for in-memory file handling ---
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
    cookie: { maxAge: 1000 * 60 * 60 }, // 1 hour
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
  audio_url: String, // For voice notes
  replyTo: { user: String, text: String },
  time: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", messageSchema);

let activeUsers = {};

// ------------ Auth Routes (Postgres) ------------
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests, please try again after 15 minutes.'
});

app.post("/signup", authLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const check = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (check.rows.length) return res.status(400).json({ error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, email, password, avatar_url) VALUES ($1,$2,$3,$4)",
      [username, email, hash, "/default-avatar.png"]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Signup error", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar_url: user.avatar_url
    };
    res.json({ success: true, username: user.username });
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
  if (!req.session.user)
    return res.status(401).json({ error: "Not logged in" });
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
    if (!req.session.user) {
        return res.status(401).json({ error: "Not logged in" });
    }
    if (!req.file) {
        return res.status(400).json({ error: "No audio file provided" });
    }

    cloudinary.uploader.upload_stream({ resource_type: "video" }, async (error, result) => {
        if (error || !result) {
            console.error("Cloudinary upload error:", error);
            return res.status(500).json({ error: "Failed to upload audio" });
        }

        const newMsg = new Message({
            user: req.session.user.username,
            avatar_url: req.session.user.avatar_url,
            audio_url: result.secure_url,
            time: new Date()
        });
        await newMsg.save();

        io.emit("chat message", newMsg);
        res.json({ success: true, url: result.secure_url });
    }).end(req.file.buffer);
});

// ------------ Routing ------------
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

app.get("/chat", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ------------ Socket.IO with MongoDB ------------
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  const broadcastUserList = () => {
    io.emit("update user list", Object.values(activeUsers));
  };

  Message.find().sort({ time: 1 }).limit(50).then((msgs) => {
    socket.emit("chat history", msgs);
  });

  socket.on("user connected", (userData) => {
    activeUsers[socket.id] = {
        username: userData.username,
        avatar_url: userData.avatar_url
    };
    console.log(`${userData.username} has joined the chat.`);
    broadcastUserList();
  });

  socket.on("chat message", async (msg) => {
    try {
      const newMsg = new Message({
        user: msg.user,
        avatar_url: msg.avatar_url || "/default-avatar.png",
        text: msg.text,
        replyTo: msg.replyTo || null,
        time: new Date()
      });
      await newMsg.save();
      io.emit("chat message", newMsg);
    } catch (err) {
      console.error("❌ Error saving message", err);
    }
  });

  socket.on('typing start', () => {
    if (activeUsers[socket.id]) {
      socket.broadcast.emit('user typing start', activeUsers[socket.id]);
    }
  });

  socket.on('typing stop', () => {
    if (activeUsers[socket.id]) {
      socket.broadcast.emit('user typing stop', activeUsers[socket.id]);
    }
  });

  socket.on("clear chat", async () => {
    try {
      await Message.deleteMany({});
      io.emit("chat cleared");
    } catch (err) {
      console.error("❌ Error clearing chat", err);
    }
  });

  socket.on("send alert", (data) => {
    io.emit("alert", {
      sender: data.user,
      text: data.text || "⚠️ ALERT!"
    });
  });

  socket.on("disconnect", () => {
    const disconnectedUser = activeUsers[socket.id];
    if (disconnectedUser) {
      console.log(`❌ ${disconnectedUser.username} disconnected`);
      socket.broadcast.emit('user typing stop', disconnectedUser);
      delete activeUsers[socket.id];
      broadcastUserList();
    } else {
      console.log("❌ User disconnected:", socket.id);
    }
  });
});

// ------------ Start Server ------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});