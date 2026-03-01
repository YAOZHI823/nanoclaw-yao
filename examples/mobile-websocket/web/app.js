// NanoClaw WebSocket Chat Client

const WS_URL = window.location.protocol === 'https:'
  ? 'wss://' + window.location.host + ':9876'
  : 'ws://localhost:9876';

const STORAGE_KEY = 'nanoclaw_device';
const PAIRED_KEY = 'nanoclaw_paired';
const MESSAGES_KEY = 'nanoclaw_messages_';

let ws = null;
let deviceId = null;
let isPaired = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingInterval = null;

// DOM Elements
const elements = {
  statusIndicator: document.getElementById('status-indicator'),
  statusText: document.getElementById('status-text'),
  rebindBtn: document.getElementById('rebind-btn'),
  bindScreen: document.getElementById('bind-screen'),
  pairingScreen: document.getElementById('pairing-screen'),
  chatScreen: document.getElementById('chat-screen'),
  deviceIdEl: document.getElementById('device-id'),
  pairingCodeEl: document.getElementById('pairing-code'),
  verifyCodeInput: document.getElementById('verify-code-input'),
  verifyPairingBtn: document.getElementById('verify-pairing-btn'),
  requestPairingBtn: document.getElementById('request-pairing-btn'),
  cancelPairingBtn: document.getElementById('cancel-pairing-btn'),
  messagesContainer: document.getElementById('messages-container'),
  messagesList: document.getElementById('messages-list'),
  loadingMore: document.getElementById('loading-more'),
  messageInput: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn'),
};

// 初始化
function init() {
  loadDeviceId();
  loadMessages();
  setupEventListeners();

  // 根据配对状态显示对应界面
  if (isPaired) {
    showScreen('chat');
    elements.rebindBtn.style.display = 'block';
  }

  connect();
}

// 加载或生成 deviceId
function loadDeviceId() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    deviceId = stored;
  } else {
    deviceId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(STORAGE_KEY, deviceId);
  }

  // 检查是否已配对
  isPaired = localStorage.getItem(PAIRED_KEY) === 'true';

  elements.deviceIdEl.textContent = `设备 ID: ${deviceId}`;
}

// 获取消息存储key
function getMessagesKey() {
  return MESSAGES_KEY + deviceId;
}

// 加载消息历史
function loadMessages() {
  try {
    const stored = localStorage.getItem(getMessagesKey());
    if (stored) {
      const messages = JSON.parse(stored);
      renderMessages(messages);
    }
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
}

// 保存消息
function saveMessage(msg) {
  try {
    const key = getMessagesKey();
    const messages = JSON.parse(localStorage.getItem(key) || '[]');
    messages.push(msg);
    // 最多保存500条
    if (messages.length > 500) {
      messages.splice(0, messages.length - 500);
    }
    localStorage.setItem(key, JSON.stringify(messages));
  } catch (e) {
    console.error('Failed to save message:', e);
  }
}

// 渲染消息
function renderMessages(messages) {
  elements.messagesList.innerHTML = '';
  messages.forEach(msg => addMessageToUI(msg));
  scrollToBottom();
}

// 添加单条消息到UI
function addMessageToUI(msg) {
  const div = document.createElement('div');
  div.className = `message ${msg.from}`;

  // 添加思考过程（如果是助手消息且有thinking）
  if (msg.from === 'assistant' && msg.thinking) {
    const thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    thinkingEl.textContent = '🤔 ' + msg.thinking;
    div.appendChild(thinkingEl);
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = msg.content;

  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = formatTime(msg.timestamp);

  div.appendChild(content);
  div.appendChild(time);
  elements.messagesList.appendChild(div);
}

// 格式化时间
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 滚动到底部
function scrollToBottom() {
  elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}

// 设置事件监听
function setupEventListeners() {
  // 请求配对
  elements.requestPairingBtn.addEventListener('click', requestPairing);
  elements.cancelPairingBtn.addEventListener('click', cancelPairing);

  // 验证配对
  elements.verifyPairingBtn.addEventListener('click', verifyPairing);
  elements.verifyCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') verifyPairing();
  });

  // 发送消息
  elements.sendBtn.addEventListener('click', sendMessage);
  elements.messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // 重新绑定
  elements.rebindBtn.addEventListener('click', rebind);

  // 滚动加载历史
  elements.messagesContainer.addEventListener('scroll', () => {
    if (elements.messagesContainer.scrollTop < 50) {
      // 可以在这里实现加载更多历史
    }
  });
}

// 请求配对
function requestPairing() {
  showScreen('pairing');
  send({ type: 'pairing_request', deviceId });
}

// 取消配对
function cancelPairing() {
  showScreen('bind');
  elements.pairingCodeEl.textContent = '------';
}

// 验证配对
function verifyPairing() {
  const code = elements.verifyCodeInput.value.trim().toUpperCase();
  if (!code || code.length !== 6) {
    alert('请输入6位配对码');
    return;
  }
  console.log('Verifying with code:', code);
  send({ type: 'pairing_verify', deviceId, pairingCode: code });
}

// 重新绑定
function rebind() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(getMessagesKey());
  isPaired = false;
  deviceId = null;
  loadDeviceId();
  elements.messagesList.innerHTML = '';
  showScreen('bind');
  elements.rebindBtn.style.display = 'none';
}

// 发送消息
function sendMessage() {
  const content = elements.messageInput.value.trim();
  if (!content) return;

  elements.messageInput.value = '';

  // 添加用户消息到UI
  const msg = { from: 'user', content, timestamp: Date.now() };
  addMessageToUI(msg);
  saveMessage(msg);

  // 发送消息到服务器
  send({ type: 'message', content });

  // 显示正在输入
  showTyping();
}

// 显示正在输入
function showTyping() {
  const div = document.createElement('div');
  div.className = 'message assistant typing';
  div.id = 'typing-indicator';

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = '';

  div.appendChild(content);
  elements.messagesList.appendChild(div);
  scrollToBottom();
}

// 隐藏正在输入
function hideTyping() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) {
    indicator.remove();
  }
}

// WebSocket 连接
function connect() {
  updateStatus('connecting', '连接中...');

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('WebSocket connected');
    reconnectAttempts = 0;
    updateStatus('connected', '已连接');

    // 如果已配对，重新发送配对请求
    if (isPaired) {
      send({ type: 'pairing_request', deviceId });
    }

    // 启动心跳
    startPing();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    updateStatus('disconnected', '已断开');
    stopPing();
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateStatus('disconnected', '连接错误');
  };
}

// 发送WebSocket消息
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    console.log('Sent:', obj.type);
  }
}

// 处理接收到的消息
function handleMessage(msg) {
  console.log('Received:', msg.type);

  switch (msg.type) {
    case 'pairing_challenge':
      elements.pairingCodeEl.textContent = msg.pairingCode;
      break;

    case 'pairing_success':
      isPaired = true;
      localStorage.setItem(PAIRED_KEY, 'true');
      showScreen('chat');
      elements.rebindBtn.style.display = 'block';
      break;

    case 'pairing_failed':
      alert('配对失败: ' + msg.message);
      showScreen('bind');
      break;

    case 'message':
      hideTyping();

      // 提取思考过程（从content中查找<thinking>标签或使用独立的thinking字段）
      let thinking = msg.thinking;
      let content = msg.content;

      if (!thinking && content) {
        // 尝试从content中提取thinking
        const match = content.match(/<thinking>([\s\S]*?)<\/thinking>/i);
        if (match) {
          thinking = match[1].trim();
          content = content.replace(match[0], '').trim();
        }
      }

      // 添加助手消息
      const assistantMsg = {
        from: 'assistant',
        content: content,
        thinking: thinking,
        timestamp: msg.timestamp || Date.now()
      };
      addMessageToUI(assistantMsg);
      saveMessage(assistantMsg);
      break;

    case 'error':
      hideTyping();

      // 如果是未配对错误，自动重新请求配对
      if (msg.message === 'Not paired') {
        console.log('Not paired, auto requesting pairing...');
        // 清空配对状态，重新请求配对
        localStorage.removeItem(PAIRED_KEY);
        isPaired = false;
        showScreen('pairing');
        send({ type: 'pairing_request', deviceId });
      } else {
        const errorMsg = {
          from: 'assistant',
          content: '错误: ' + msg.message,
          timestamp: Date.now()
        };
        addMessageToUI(errorMsg);
        saveMessage(errorMsg);
      }
      break;

    case 'pong':
      // 心跳响应
      break;
  }
}

// 心跳
function startPing() {
  stopPing();
  pingInterval = setInterval(() => {
    send({ type: 'ping' });
  }, 30000);
}

function stopPing() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// 重连
function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;

  updateStatus('connecting', `重连中 (${reconnectAttempts})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// 更新状态显示
function updateStatus(state, text) {
  const dot = elements.statusIndicator.querySelector('.status-dot');
  dot.className = 'status-dot ' + state;
  elements.statusText.textContent = text;
}

// 显示指定屏幕
function showScreen(screen) {
  elements.bindScreen.style.display = 'none';
  elements.pairingScreen.style.display = 'none';
  elements.chatScreen.style.display = 'none';

  switch (screen) {
    case 'bind':
      elements.bindScreen.style.display = 'flex';
      break;
    case 'pairing':
      elements.pairingScreen.style.display = 'flex';
      break;
    case 'chat':
      elements.chatScreen.style.display = 'flex';
      break;
  }
}

// 启动
init();
