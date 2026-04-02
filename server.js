const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Налаштування Multer для збереження картинок
const storage = multer.diskStorage({
  destination: "./public/uploads/",
  filename: (req, file, cb) => {
    cb(null, "avatar-" + Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage: storage });

// Підключення до хмарної бази даних Neon
const pool = new Pool({
  connectionString:
    "postgresql://neondb_owner:npg_tXNL3QGUh8Zc@ep-mute-unit-als64zjm.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require",
});

// Створення таблиць (Синтаксис PostgreSQL)
pool
  .query(
    `
  CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, avatar TEXT);
  CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, sender TEXT, receiver TEXT, text TEXT);
  CREATE TABLE IF NOT EXISTS friends ("user" TEXT, friend TEXT, UNIQUE("user", friend));
`,
  )
  .catch((err) => console.error("Помилка створення таблиць:", err));

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const defaultAvatar = `https://ui-avatars.com/api/?name=${username}&background=0D8ABC&color=fff&rounded=true`;

    pool.query(
      "INSERT INTO users (username, password, avatar) VALUES ($1, $2, $3)",
      [username, hashedPassword, defaultAvatar],
      (err) => {
        if (err) {
          return res.status(400).json({ error: "Цей нікнейм вже зайнятий!" });
        }
        res.json({ success: true });
      },
    );
  } catch {
    res.status(500).send();
  }
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  pool.query(
    "SELECT * FROM users WHERE username = $1",
    [username],
    async (err, result) => {
      const row = result ? result.rows[0] : null;
      if (!row) return res.status(400).json({ error: "Акаунт не знайдено" });
      if (await bcrypt.compare(password, row.password)) {
        res.json({ success: true, username: row.username, avatar: row.avatar });
      } else {
        res.status(400).json({ error: "Невірний пароль" });
      }
    },
  );
});

app.post("/upload-avatar", upload.single("avatarImage"), (req, res) => {
  const username = req.body.username;
  if (!req.file || !username) {
    return res.status(400).json({ error: "Файл не отримано" });
  }

  const avatarUrl = "/uploads/" + req.file.filename;

  pool.query(
    "UPDATE users SET avatar = $1 WHERE username = $2",
    [avatarUrl, username],
    (err) => {
      if (err) return res.status(500).json({ error: "Помилка бази" });
      io.emit("avatarUpdated", { username, avatarUrl });
      res.json({ success: true, avatarUrl });
    },
  );
});
const userSockets = {};

function sendFriendList(socket, username) {
  pool.query(
    'SELECT friends.friend, users.avatar FROM friends JOIN users ON friends.friend = users.username WHERE friends."user" = $1',
    [username],
    (err, result) => {
      if (err) return;
      const rows = result ? result.rows : [];
      const friends = rows.map((row) => ({
        username: row.friend,
        avatar: row.avatar,
        isOnline: !!userSockets[row.friend],
      }));
      socket.emit("friendList", friends);
    },
  );
}

io.on("connection", (socket) => {
  socket.on("join", (username) => {
    socket.username = username;
    userSockets[username] = socket.id;
    io.emit("userStatus", { username: username, isOnline: true });
    sendFriendList(socket, username);
  });

  socket.on("addFriend", (friendUsername) => {
    const me = socket.username;
    if (!me || !friendUsername) return;

    pool.query(
      "SELECT username FROM users WHERE LOWER(username) = LOWER($1)",
      [friendUsername],
      (err, result) => {
        const row = result ? result.rows[0] : null;
        if (!row) {
          return socket.emit(
            "friendError",
            `Акаунт "${friendUsername}" не знайдено!`,
          );
        }
        const exactFriendName = row.username;
        if (exactFriendName === me) {
          return socket.emit("friendError", "Не можна додати себе!");
        }

        pool.query(
          'INSERT INTO friends ("user", friend) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING',
          [me, exactFriendName, exactFriendName, me],
          (err) => {
            if (!err) {
              sendFriendList(socket, me);
              if (userSockets[exactFriendName]) {
                sendFriendList(
                  io.sockets.sockets.get(userSockets[exactFriendName]),
                  exactFriendName,
                );
              }
            }
          },
        );
      },
    );
  });

  socket.on("getHistory", (withUser) => {
    const me = socket.username;
    pool.query(
      "SELECT * FROM messages WHERE (sender = $1 AND receiver = $2) OR (sender = $3 AND receiver = $4) ORDER BY id ASC",
      [me, withUser, withUser, me],
      (err, result) => {
        if (err) return;
        socket.emit("chatHistory", result ? result.rows : []);
      },
    );
  });

  socket.on("privateMessage", ({ receiver, text }) => {
    const sender = socket.username;
    if (!sender || !receiver) return;

    pool.query(
      "INSERT INTO messages (sender, receiver, text) VALUES ($1, $2, $3) RETURNING id",
      [sender, receiver, text],
      (err, result) => {
        if (err) return;
        const insertedId = result.rows[0].id;
        const messageData = { sender, receiver, text, id: insertedId };

        if (userSockets[receiver]) {
          io.to(userSockets[receiver]).emit("newPrivateMessage", messageData);
        }
        socket.emit("newPrivateMessage", messageData);
      },
    );
  });

  socket.on("disconnect", () => {
    if (socket.username) {
      delete userSockets[socket.username];
      io.emit("userStatus", { username: socket.username, isOnline: false });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер працює на порту ${PORT}`));
