// server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2");
const bcrypt = require("bcryptjs"); // safer, works in Render
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// -------- MySQL Connection --------
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
}).promise();

// -------- Session Store --------
const sessionStore = new MySQLStore({}, db);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    key: "chat_sid",
    secret: "super-secret-key", // 🔐 change for production
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 }, // 1 hour
  })
);

// -------- Initialize Tables --------
async function initTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        reply_user VARCHAR(50),
        reply_text TEXT,
        time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Tables ensured");
  } catch (err) {
    console.error("❌ Error creating tables:", err);
  }
}
initTables();

// -------- Auth Routes --------
app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const [rows] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
    if (rows.length) return res.status(400).json({ error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);
    await db.query("INSERT INTO users (username, email, password) VALUES (?, ?, ?)", [
      username,
      email,
      hash,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = { id: user.id, username: user.username, email: user.email };
    res.json({ success: true, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/me", (req, res) => {
  if (req.session.user) res.json({ user: req.session.user });
  else res.status(401).json({ error: "Not logged in" });
});

// -------- STATIC + ROUTING FIX --------

// serve static files but without auto index
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// root always goes to login
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// only authenticated users can access chat
app.get("/chat", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// -------- Socket.IO Chat --------
io.on("connection", (socket) => {
  console.log("🔌 User connected:", socket.id);

  // Send last 20 messages
  (async () => {
    try {
      const [msgs] = await db.query(
        "SELECT * FROM messages ORDER BY time ASC LIMIT 20"
      );
      socket.emit(
        "chat history",
        msgs.map((m) => ({
          user: m.user,
          text: m.text,
          replyTo: m.reply_user ? { user: m.reply_user, text: m.reply_text } : null,
          time: m.time,
        }))
      );
    } catch (err) {
      console.error("❌ Error fetching history:", err);
    }
  })();

  // Save + Broadcast message
  socket.on("chat message", async (msg) => {
    try {
      await db.query(
        "INSERT INTO messages (user, text, reply_user, reply_text) VALUES (?, ?, ?, ?)",
        [msg.user, msg.text, msg.replyTo?.user || null, msg.replyTo?.text || null]
      );
      io.emit("chat message", msg);
    } catch (err) {
      console.error("❌ Error saving message:", err);
    }
  });

  // Clear chat
  socket.on("clear chat", async () => {
    try {
      await db.query("DELETE FROM messages");
      io.emit("chat cleared");
    } catch (err) {
      console.error("❌ Error clearing chat:", err);
    }
  });

  // Alerts
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