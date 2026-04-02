const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const multer = require("multer"); // Новий інструмент для файлів
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
    // Даємо файлу унікальне ім'я (час + оригінальне розширення)
    cb(null, "avatar-" + Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage: storage });

const db = new sqlite3.Database("./cosmogram.db");

db.serialize(() => {
  // ДОДАНО: колонка avatar
  db.run(
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, avatar TEXT)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, text TEXT)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS friends (user TEXT, friend TEXT, UNIQUE(user, friend))",
  );
});

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    // За замовчуванням генеруємо круту аватарку з першої літери імені!
    const defaultAvatar = `https://ui-avatars.com/api/?name=${username}&background=0D8ABC&color=fff&rounded=true`;

    db.run(
      "INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)",
      [username, hashedPassword, defaultAvatar],
      (err) => {
        if (err)
          return res.status(400).json({ error: "Цей нікнейм вже зайнятий!" });
        res.json({ success: true });
      },
    );
  } catch {
    res.status(500).send();
  }
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, row) => {
      if (!row) return res.status(400).json({ error: "Акаунт не знайдено" });
      if (await bcrypt.compare(password, row.password)) {
        // Відправляємо аватарку разом з успішним логіном
        res.json({ success: true, username: row.username, avatar: row.avatar });
      } else {
        res.status(400).json({ error: "Невірний пароль" });
      }
    },
  );
});

// НОВИЙ МАРШРУТ: Завантаження аватарки
app.post("/upload-avatar", upload.single("avatarImage"), (req, res) => {
  const username = req.body.username;
  if (!req.file || !username)
    return res.status(400).json({ error: "Файл не отримано" });

  // Шлях до нової картинки
  const avatarUrl = "/uploads/" + req.file.filename;

  // Оновлюємо базу даних
  db.run(
    "UPDATE users SET avatar = ? WHERE username = ?",
    [avatarUrl, username],
    (err) => {
      if (err) return res.status(500).json({ error: "Помилка бази" });

      // Сповіщаємо всіх, що цей користувач оновив аватарку
      io.emit("avatarUpdated", { username, avatarUrl });
      res.json({ success: true, avatarUrl });
    },
  );
});

const userSockets = {};

function sendFriendList(socket, username) {
  // Тепер ми дістаємо ще й аватарку друга
  db.all(
    `
        SELECT friends.friend, users.avatar 
        FROM friends 
        JOIN users ON friends.friend = users.username 
        WHERE friends.user = ?
    `,
    [username],
    (err, rows) => {
      if (err) return;
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

    db.get(
      "SELECT username FROM users WHERE LOWER(username) = LOWER(?)",
      [friendUsername],
      (err, row) => {
        if (!row)
          return socket.emit(
            "friendError",
            `Акаунт "${friendUsername}" не знайдено!`,
          );
        const exactFriendName = row.username;
        if (exactFriendName === me)
          return socket.emit("friendError", "Не можна додати себе!");

        db.run(
          "INSERT OR IGNORE INTO friends (user, friend) VALUES (?, ?), (?, ?)",
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
    db.all(
      "SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY id ASC",
      [me, withUser, withUser, me],
      (err, rows) => {
        if (err) return;
        socket.emit("chatHistory", rows);
      },
    );
  });

  socket.on("privateMessage", ({ receiver, text }) => {
    const sender = socket.username;
    if (!sender || !receiver) return;

    db.run(
      "INSERT INTO messages (sender, receiver, text) VALUES (?, ?, ?)",
      [sender, receiver, text],
      function (err) {
        if (err) return;
        const messageData = { sender, receiver, text, id: this.lastID };
        if (userSockets[receiver])
          io.to(userSockets[receiver]).emit("newPrivateMessage", messageData);
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
