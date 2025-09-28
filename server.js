// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// -------- Postgres Connection --------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // needed for Render hosted postgres
});

// -------- Session Store in Postgres --------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new pgSession({
      pool,
      tableName: "session",
    }),
    secret: "super-secret-key", // ✅ change for production
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 }, // 1 hour
  })
);

// -------- Initialize Tables --------
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      text TEXT NOT NULL,
      reply_user VARCHAR(50),
      reply_text TEXT,
      time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ Tables ensured");
}
initTables();

// -------- Auth Routes --------
app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const userCheck = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (userCheck.rows.length) return res.status(400).json({ error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, email, password) VALUES ($1, $2, $3)",
      [username, email, hash]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Signup error", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
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

// -------- Routing --------
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

app.get("/chat", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// -------- Socket.IO Chat --------
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // send last 20 messages
  (async () => {
    try {
      const result = await pool.query(
        "SELECT * FROM messages ORDER BY time ASC LIMIT 20"
      );
      socket.emit(
        "chat history",
        result.rows.map((m) => ({
          user: m.username,
          text: m.text,
          replyTo: m.reply_user
            ? { user: m.reply_user, text: m.reply_text }
            : null,
          time: m.time,
        }))
      );
    } catch (err) {
      console.error("❌ Error fetching history:", err);
    }
  })();

  socket.on("chat message", async (msg) => {
    try {
      await pool.query(
        "INSERT INTO messages (username, text, reply_user, reply_text) VALUES ($1, $2, $3, $4)",
        [msg.user, msg.text, msg.replyTo?.user || null, msg.replyTo?.text || null]
      );
      io.emit("chat message", msg);
    } catch (err) {
      console.error("❌ Error saving message:", err);
    }
  });

  socket.on("clear chat", async () => {
    try {
      await pool.query("DELETE FROM messages");
      io.emit("chat cleared");
    } catch (err) {
      console.error("❌ Error clearing chat:", err);
    }
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

// -------- Start Server --------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});