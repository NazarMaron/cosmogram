const socket = io();
let myUsername = localStorage.getItem('cosmogram_user') || "";
let myAvatar = localStorage.getItem('cosmogram_avatar') || "";
let currentChatUser = null;
let myFriends = []; 
let unreadMessagesFrom = new Set();

const loginContainer = document.getElementById('login-container');
const chatContainer = document.getElementById('chat-container');
const messagesList = document.getElementById('messages');
const userList = document.getElementById('user-list');
const chatHeader = document.getElementById('chat-header');
const input = document.getElementById('input');
const form = document.getElementById('form');
const sendBtn = document.getElementById('send-btn');
const addFriendInput = document.getElementById('add-friend-input');
const addFriendBtn = document.getElementById('add-friend-btn');
const logoutBtn = document.getElementById('logout-btn');

const myAvatarImg = document.getElementById('my-avatar');
const myNameDisplay = document.getElementById('my-name-display');
const changeAvatarBtn = document.getElementById('change-avatar-btn');
const avatarInput = document.getElementById('avatar-input');

function enterChatArea(username, avatar) {
    myUsername = username;
    myAvatar = avatar;
    
    myNameDisplay.innerText = username;
    myAvatarImg.src = avatar;
    
    socket.emit('join', username);
    loginContainer.style.display = 'none';
    chatContainer.style.display = 'flex';
    
    if ("Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission();
    }
}

if (myUsername && myAvatar) {
    enterChatArea(myUsername, myAvatar);
}

changeAvatarBtn.onclick = () => avatarInput.click();

avatarInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('avatarImage', file);
    formData.append('username', myUsername);

    const response = await fetch('/upload-avatar', {
        method: 'POST',
        body: formData
    });
    
    const data = await response.json();
    if (data.success) {
        myAvatarImg.src = data.avatarUrl; 
        localStorage.setItem('cosmogram_avatar', data.avatarUrl); 
    }
};

logoutBtn.onclick = () => {
    localStorage.clear();
    location.reload(); 
};

document.getElementById('register-btn').onclick = async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    await fetch('/register', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username, password })
    });
    alert("Done! You can log in now.");
};

document.getElementById('login-btn').onclick = async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const res = await fetch('/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
        localStorage.setItem('cosmogram_user', data.username);
        localStorage.setItem('cosmogram_avatar', data.avatar);
        enterChatArea(data.username, data.avatar);
    } else {
        alert(data.error);
    }
};

addFriendBtn.onclick = () => {
    if (addFriendInput.value.trim()) {
        socket.emit('addFriend', addFriendInput.value.trim());
        addFriendInput.value = '';
    }
};

socket.on('friendError', (msg) => alert(msg));
socket.on('friendList', (friends) => {
    myFriends = friends;
    renderUsers();
});

socket.on('userStatus', ({ username, isOnline }) => {
    const friend = myFriends.find(f => f.username === username);
    if (friend) {
        friend.isOnline = isOnline;
        renderUsers();
    }
});

socket.on('avatarUpdated', ({ username, avatarUrl }) => {
    const friend = myFriends.find(f => f.username === username);
    if (friend) {
        friend.avatar = avatarUrl;
        
        if (currentChatUser === username) {
            chatHeader.innerHTML = `<img src="${avatarUrl}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;"> Chat with: ${username}`;
        }
        renderUsers();
    }
});

function renderUsers() {
    userList.innerHTML = '';
    myFriends.forEach(friend => {
        const li = document.createElement('li');
        li.setAttribute('data-username', friend.username);
        li.setAttribute('data-avatar', friend.avatar); 
        li.style.padding = "10px";
        li.style.borderBottom = "1px solid #333";
        li.style.cursor = "pointer";
        li.style.borderRadius = "5px";
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.gap = "10px";

        let statusIcon = friend.isOnline ? "🟢" : "⚪";
        
        const avatarImg = `<img src="${friend.avatar}" style="width: 30px; height: 30px; border-radius: 50%; object-fit: cover;">`;

        if (unreadMessagesFrom.has(friend.username)) {
            li.innerHTML = `${avatarImg} <div>📩 <b>${friend.username} (New)</b></div>`;
            li.style.background = "#00f2ff";
            li.style.color = "#050508";
        } else {
            li.innerHTML = `${avatarImg} <div>${statusIcon} ${friend.username}</div>`;
            li.style.background = "transparent";
            li.style.color = friend.isOnline ? "white" : "#777";
        }
        userList.appendChild(li);
    });
}

userList.onclick = (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const clickedUser = li.getAttribute('data-username');
    const clickedAvatar = li.getAttribute('data-avatar');
    
    if (clickedUser) {
        currentChatUser = clickedUser;
        chatHeader.innerHTML = `<img src="${clickedAvatar}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;"> Chat with: ${currentChatUser}`;
        
        unreadMessagesFrom.delete(currentChatUser);
        renderUsers();

        input.disabled = false;
        sendBtn.disabled = false;
        sendBtn.style.background = "#00f2ff";
        sendBtn.style.cursor = "pointer";
        
        messagesList.innerHTML = ''; 
        socket.emit('getHistory', currentChatUser); 
    }
};

socket.on('chatHistory', (rows) => {
    rows.forEach(msg => appendMessage(msg.sender, msg.text));
});

socket.on('newPrivateMessage', (data) => {
    if (data.sender === currentChatUser || data.sender === myUsername) {
        appendMessage(data.sender, data.text);
    } else {
        unreadMessagesFrom.add(data.sender);
        renderUsers();
        if ("Notification" in window && Notification.permission === "granted") {
            new Notification(`New message from ${data.sender}`, { body: data.text });
        }
    }
});

function appendMessage(sender, text) {
    const li = document.createElement('li');
    li.style.color = sender === myUsername ? "#00f2ff" : "#ccc";
    li.style.marginBottom = "10px";
    li.style.background = "rgba(0,0,0,0.3)";
    li.style.padding = "8px";
    li.style.borderRadius = "5px";
    li.innerHTML = `<strong>${sender === myUsername ? "You" : sender}:</strong> ${text}`;
    messagesList.appendChild(li);
    messagesList.scrollTo(0, messagesList.scrollHeight);
}

form.onsubmit = (e) => {
    e.preventDefault();
    if (input.value && currentChatUser) {
        socket.emit('privateMessage', { receiver: currentChatUser, text: input.value });
        input.value = '';
    }
};