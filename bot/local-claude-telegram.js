#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const TELEGRAM_TOKEN = process.env.CLAUDE_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'fable';
const MODEL_ALIASES = {
  fable: 'fable',
  'claude-fable-5': 'claude-fable-5',
  sonnet: 'sonnet',
  'claude-sonnet-5': 'claude-sonnet-5',
  opus: 'opus',
  'claude-opus-5': 'claude-opus-5',
};
const WORKDIR = process.env.CLAUDE_WORKDIR || '/home/ubuntu/giuliowd';
const ALLOWED_CHAT_ID = process.env.CLAUDE_ALLOWED_CHAT_ID || process.env.ADMIN_CHAT_ID || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/ubuntu/.local/bin/claude';
const OFFSET_FILE = process.env.CLAUDE_TELEGRAM_OFFSET_FILE || '/home/ubuntu/.claude-telegram-offset';
const STATE_FILE = process.env.CLAUDE_TELEGRAM_STATE_FILE || '/home/ubuntu/.claude-telegram-state.json';
const MAX_REPLY_CHARS = Number(process.env.CLAUDE_TELEGRAM_MAX_REPLY_CHARS || '3500');
const MAX_PROCESS_OUTPUT = Number(process.env.CLAUDE_TELEGRAM_MAX_PROCESS_OUTPUT || '12000');
const TASK_TIMEOUT_MS = Number(process.env.CLAUDE_TASK_TIMEOUT_MS || String(30 * 60 * 1000));
const APPEND_SYSTEM_PROMPT = process.env.CLAUDE_APPEND_SYSTEM_PROMPT || [
  'You are running unattended behind a Telegram bridge.',
  'Return concise final answers suitable for Telegram.',
  'If you need user input, ask for it explicitly in the final answer instead of waiting silently.',
].join(' ');

if (!TELEGRAM_TOKEN) {
  throw new Error('Missing CLAUDE_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN');
}

const telegramApiBase = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
let busy = false;
let currentTask = 'idle';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function splitMessage(text) {
  const body = text || 'Claude completed with no final message.';
  const chunks = [];
  for (let i = 0; i < body.length; i += MAX_REPLY_CHARS) {
    chunks.push(body.slice(i, i + MAX_REPLY_CHARS));
  }
  return chunks;
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
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

function getChatState(chatId) {
  const state = loadJson(STATE_FILE, { chats: {} });
  return state.chats[String(chatId)] || null;
}

function getChatModel(chatId) {
  return getChatState(chatId)?.model || DEFAULT_MODEL;
}

function setChatSession(chatId, sessionId) {
  const state = loadJson(STATE_FILE, { chats: {} });
  const current = state.chats[String(chatId)] || {};
  state.chats[String(chatId)] = {
    ...current,
    sessionId,
    model: current.model || DEFAULT_MODEL,
    updatedAt: new Date().toISOString(),
  };
  saveJson(STATE_FILE, state);
}

function setChatModel(chatId, model) {
  const state = loadJson(STATE_FILE, { chats: {} });
  const current = state.chats[String(chatId)] || {};
  state.chats[String(chatId)] = {
    ...current,
    model,
    updatedAt: new Date().toISOString(),
  };
  saveJson(STATE_FILE, state);
}

function clearChatSession(chatId) {
  const state = loadJson(STATE_FILE, { chats: {} });
  const current = state.chats[String(chatId)] || {};
  state.chats[String(chatId)] = {
    ...(current.model ? { model: current.model } : {}),
    updatedAt: new Date().toISOString(),
  };
  saveJson(STATE_FILE, state);
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
  for (const chunk of splitMessage(text)) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    });
  }
}

async function sendChatAction(chatId, action = 'typing') {
  try {
    await telegram('sendChatAction', { chat_id: chatId, action });
  } catch {
    // Non-critical progress indicator.
  }
}

function isAllowedChat(chatId) {
  return !ALLOWED_CHAT_ID || String(chatId) === String(ALLOWED_CHAT_ID);
}

function extractResult(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === 'result') {
        return event;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return null;
}

function runClaude(chatId, prompt) {
  return new Promise((resolve) => {
    const session = getChatState(chatId);
    const model = getChatModel(chatId);
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', model,
      '--dangerously-skip-permissions',
      '--append-system-prompt', APPEND_SYSTEM_PROMPT,
    ];

    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
    }

    args.push(prompt);

    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKDIR,
      env: {
        ...process.env,
        HOME: '/home/ubuntu',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TASK_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout = truncate(stdout + chunk.toString(), MAX_PROCESS_OUTPUT);
    });

    child.stderr.on('data', (chunk) => {
      stderr = truncate(stderr + chunk.toString(), MAX_PROCESS_OUTPUT);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const parsed = extractResult(stdout);
      if (code === 0 && parsed?.session_id) {
        setChatSession(chatId, parsed.session_id);
      }
      resolve({ code, signal, timedOut, stdout, stderr, parsed });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        stdout,
        stderr: truncate(`${stderr}\n${error.message}`, MAX_PROCESS_OUTPUT),
        parsed: null,
      });
    });
  });
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  if (!chatId || !isAllowedChat(chatId)) return;

  const text = (message.text || '').trim();
  if (!text) {
    await sendMessage(chatId, 'Send a text prompt for Claude.', message.message_id);
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendMessage(
      chatId,
      [
        `Send any prompt and I will keep a Claude session per chat in ${WORKDIR}.`,
        `Current model: ${getChatModel(chatId)}`,
        'Commands: /status, /reset, /model, /model fable, /model sonnet, /model opus',
      ].join('\n'),
      message.message_id,
    );
    return;
  }

  if (text === '/status') {
    const session = getChatState(chatId);
    await sendMessage(
      chatId,
      `Claude bridge is ${busy ? `busy: ${currentTask}` : 'idle'}.\nworkdir: ${WORKDIR}\nmodel: ${getChatModel(chatId)}\nsession: ${session?.sessionId || 'none'}`,
      message.message_id,
    );
    return;
  }

  if (text === '/model' || text.startsWith('/model ')) {
    const requested = text.slice('/model'.length).trim().toLowerCase();
    if (!requested) {
      await sendMessage(
        chatId,
        `Current model: ${getChatModel(chatId)}\nAvailable: fable, sonnet, opus\nUse: /model sonnet`,
        message.message_id,
      );
      return;
    }

    const model = MODEL_ALIASES[requested];
    if (!model) {
      await sendMessage(
        chatId,
        `Unknown model: ${requested}\nAvailable: fable, sonnet, opus`,
        message.message_id,
      );
      return;
    }

    setChatModel(chatId, model);
    await sendMessage(chatId, `Model set to ${model}. Context/session is unchanged.`, message.message_id);
    return;
  }

  if (text === '/reset') {
    clearChatSession(chatId);
    await sendMessage(chatId, 'Cleared Claude context for this chat.', message.message_id);
    return;
  }

  if (busy) {
    await sendMessage(chatId, `Claude is busy with ${currentTask}. Try again after it finishes.`, message.message_id);
    return;
  }

  busy = true;
  currentTask = `chat ${chatId} at ${new Date().toISOString()}`;

  try {
    await sendChatAction(chatId);
    const result = await runClaude(chatId, text);

    if (result.code === 0 && result.parsed && !result.parsed.is_error) {
      await sendMessage(chatId, result.parsed.result || 'Claude completed with no final message.', message.message_id);
      return;
    }

    const failure = [
      result.timedOut ? `Claude timed out after ${Math.round(TASK_TIMEOUT_MS / 60000)} minutes.` : `Claude failed (exit ${result.code ?? result.signal ?? 'unknown'}).`,
      result.parsed?.result,
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
  console.log(`Claude Telegram bridge started: default_model=${DEFAULT_MODEL} workdir=${WORKDIR}`);

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
