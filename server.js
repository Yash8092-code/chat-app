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
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ------------ PostgreSQL (Users + Sessions) ------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres requires SSL
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
    secret: "super-secret-key", 
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 },
  })
);

async function initPgTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("✅ Postgres users table ready");
}
initPgTables();

// ------------ MongoDB (Messages) ------------

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected (messages)"))
  .catch((err) => console.error("❌ MongoDB error", err));

const messageSchema = new mongoose.Schema({
  user: String,
  text: String,
  replyTo: {
    user: String,
    text: String,
  },
  time: { type: Date, default: Date.now },
});
const Message = mongoose.model("Message", messageSchema);

// ------------ Auth Routes (Postgres) ------------

app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "All fields required" });

  try {
    const check = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (check.rows.length) return res.status(400).json({ error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (username, email, password) VALUES ($1,$2,$3)", [
      username,
      email,
      hash,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Signup error", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "All fields required" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (!result.rows.length) return res.status(401).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = { id: user.id, username: user.username, email: user.email };
    res.json({ success: true, username: user.username });
  } catch (err) {
    console.error("❌ Login error", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/me", (req, res) => {
  if (req.session.user) res.json({ user: req.session.user });
  else res.status(401).json({ error: "Not logged in" });
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

  // Send last 20 messages from Mongo
  Message.find().sort({ time: 1 }).limit(20).then((msgs) => {
    socket.emit("chat history", msgs);
  });

  // Save + broadcast new message
  socket.on("chat message", async (msg) => {
    try {
      const newMsg = new Message({
        user: msg.user,
        text: msg.text,
        replyTo: msg.replyTo || null,
      });
      await newMsg.save();
      io.emit("chat message", newMsg);
    } catch (err) {
      console.error("❌ Error saving message", err);
    }
  });

  // Clear chat from Mongo
  socket.on("clear chat", async () => {
    try {
      await Message.deleteMany({});
      io.emit("chat cleared");
    } catch (err) {
      console.error("❌ Error clearing chat", err);
    }
  });

  // Alerts (just broadcast, no DB)
  socket.on("send alert", (data) => {
    io.emit("alert", { sender: data.user, text: data.text || "⚠️ ALERT!" });
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

// -------- Logout --------
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("chat_sid"); // same key used in session()
    res.json({ success: true });
  });
});

// ------------ Start Server ------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});