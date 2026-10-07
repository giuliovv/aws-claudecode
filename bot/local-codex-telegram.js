#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');

const TELEGRAM_TOKEN = process.env.CODEX_TELEGRAM_BOT_TOKEN || '';
const MODEL = process.env.CODEX_MODEL || 'gpt-5.3-codex';
const WORKDIR = process.env.CODEX_WORKDIR || '/home/ubuntu/giuliowd';
const ALLOWED_CHAT_ID = process.env.CODEX_ALLOWED_CHAT_ID || '';
const OFFSET_FILE = '/home/ubuntu/.codex-telegram-offset';
const STATE_FILE = '/home/ubuntu/.codex-telegram-state.json';
const MAX_REPLY_CHARS = 3500;
const MAX_PROCESS_OUTPUT = 12000;
const TASK_TIMEOUT_MS = 20 * 60 * 1000;

if (!TELEGRAM_TOKEN) {
  throw new Error('Missing CODEX_TELEGRAM_BOT_TOKEN');
}

const telegramApiBase = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let busy = false;
let currentTask = 'idle';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function splitMessage(text) {
  if (!text) {
    return ['Codex completed with no final message.'];
  }

  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_REPLY_CHARS) {
    chunks.push(text.slice(i, i + MAX_REPLY_CHARS));
  }
  return chunks;
}

function loadOffset() {
  try {
    return Number(fs.readFileSync(OFFSET_FILE, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, String(offset));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { chats: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getChatSession(chatId) {
  const state = loadState();
  return state.chats[String(chatId)] || null;
}

function setChatSession(chatId, threadId) {
  const state = loadState();
  state.chats[String(chatId)] = { threadId, updatedAt: new Date().toISOString() };
  saveState(state);
}

function clearChatSession(chatId) {
  const state = loadState();
  delete state.chats[String(chatId)];
  saveState(state);
}

async function telegram(method, payload) {
  const timeoutMs = method === 'getUpdates' ? 45000 : 15000;
  const response = await fetch(`${telegramApiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Telegram API HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || 'unknown error'}`);
  }

  return data.result;
}

async function sendMessage(chatId, text, replyToMessageId) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    });
  }
}

function isAllowedChat(chatId) {
  return !ALLOWED_CHAT_ID || String(chatId) === ALLOWED_CHAT_ID;
}

function runCodex(chatId, prompt) {
  return new Promise((resolve) => {
    const session = getChatSession(chatId);
    const args = session && session.threadId
      ? [
        'exec',
        'resume',
        session.threadId,
        prompt,
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-m',
        MODEL,
        '--json',
      ]
      : [
        'exec',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        WORKDIR,
        '-m',
        MODEL,
        '--json',
        prompt,
      ];

    const child = spawn('codex', args, {
      env: {
        ...process.env,
        HOME: '/home/ubuntu',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let threadId = session && session.threadId ? session.threadId : null;
    let lastMessage = '';
    let lineBuffer = '';

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TASK_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = truncate(stdout + text, MAX_PROCESS_OUTPUT);
      lineBuffer += text;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const event = JSON.parse(trimmed);
          if (event.type === 'thread.started' && event.thread_id) {
            threadId = event.thread_id;
          }
          if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && event.item.text) {
            lastMessage = event.item.text.trim();
          }
        } catch {
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = truncate(stderr + chunk.toString(), MAX_PROCESS_OUTPUT);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer.trim());
          if (event.type === 'thread.started' && event.thread_id) {
            threadId = event.thread_id;
          }
          if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && event.item.text) {
            lastMessage = event.item.text.trim();
          }
        } catch {
        }
      }

      if (code === 0 && threadId) {
        setChatSession(chatId, threadId);
      }

      resolve({
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        lastMessage,
        threadId,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        stdout,
        stderr: truncate(`${stderr}\n${error.message}`, MAX_PROCESS_OUTPUT),
        lastMessage: '',
        threadId,
      });
    });
  });
}

async function handleMessage(message) {
  const chatId = message.chat && message.chat.id;
  if (!chatId || !isAllowedChat(chatId)) {
    return;
  }

  const text = (message.text || '').trim();
  if (!text) {
    await sendMessage(chatId, 'Send a text prompt for Codex.', message.message_id);
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, `Send any prompt and I will keep a Codex session per chat in ${WORKDIR} using model ${MODEL}. Use /reset to clear context.`, message.message_id);
    return;
  }

  if (text === '/status') {
    const status = busy ? `busy: ${currentTask}` : 'idle';
    const session = getChatSession(chatId);
    await sendMessage(chatId, `Codex bot is ${status}.\nworkdir: ${WORKDIR}\nmodel: ${MODEL}\nthread: ${session && session.threadId ? session.threadId : 'none'}`, message.message_id);
    return;
  }

  if (text === '/reset') {
    clearChatSession(chatId);
    await sendMessage(chatId, 'Cleared Codex context for this chat.', message.message_id);
    return;
  }

  if (busy) {
    await sendMessage(chatId, `Codex is busy with ${currentTask}. Try again after it finishes.`, message.message_id);
    return;
  }

  busy = true;
  currentTask = `chat ${chatId} at ${new Date().toISOString()}`;

  try {
    const result = await runCodex(chatId, text);

    if (result.code === 0) {
      await sendMessage(chatId, result.lastMessage || 'Codex completed with no final message.', message.message_id);
      return;
    }

    const failure = [
      result.timedOut ? 'Codex timed out after 20 minutes.' : `Codex failed (exit ${result.code ?? result.signal ?? 'unknown'}).`,
      result.lastMessage,
      result.stderr,
      result.stdout,
    ].filter(Boolean).join('\n\n');

    await sendMessage(chatId, truncate(failure, MAX_PROCESS_OUTPUT), message.message_id);
  } finally {
    busy = false;
    currentTask = 'idle';
  }
}

async function poll() {
  let offset = loadOffset();

  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        saveOffset(offset);
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      console.error(new Date().toISOString(), error);
      await delay(5000);
    }
  }
}

poll().catch((error) => {
  console.error(error);
  process.exit(1);
});
