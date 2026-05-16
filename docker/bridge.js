'use strict';
const express = require('express');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const PORT = 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const USER_CHAT_ID = process.env.USER_CHAT_ID || '';
const DYNAMO_TABLE = process.env.DYNAMO_TABLE || 'claudecode-users';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Each user's data lives in their own subdirectory on EFS
const USER_DIR = path.join(DATA_DIR, USER_CHAT_ID);
const CLAUDE_HOME = path.join(USER_DIR, 'home');
const SESSION_FILE = path.join(USER_DIR, 'session.json');

fs.mkdirSync(CLAUDE_HOME, { recursive: true });

const dynamo = new DynamoDBClient({ region: AWS_REGION });
const app = express();
app.use(express.json());

let authProc = null;
let authUrl = null;
let sessionId = null;

try {
  const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  sessionId = saved.sessionId || null;
} catch {}

// ── Register our private IP in DynamoDB so the router can reach us ────────
async function registerSelf() {
  try {
    const ip = execSync("hostname -i | awk '{print $1}'").toString().trim();
    await dynamo.send(new UpdateItemCommand({
      TableName: DYNAMO_TABLE,
      Key: { chatId: { S: USER_CHAT_ID } },
      UpdateExpression: 'SET privateIp = :ip, #st = :st, lastSeen = :ts',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':ip': { S: ip },
        ':st': { S: 'running' },
        ':ts': { S: new Date().toISOString() },
      },
    }));
    console.log(`Registered as ${ip} for chatId ${USER_CHAT_ID}`);
  } catch (e) {
    console.error('registerSelf failed:', e.message);
  }
}

// ── Check if Claude is authenticated ─────────────────────────────────────
function isAuthenticated() {
  try {
    const credPath = path.join(CLAUDE_HOME, '.claude', 'credentials.json');
    if (!fs.existsSync(credPath)) return false;
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return !!(creds?.oauth?.access_token || creds?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}

// ── Start the Claude Code auth flow, return the OAuth URL ────────────────
function startAuthFlow() {
  return new Promise((resolve, reject) => {
    if (authUrl) return resolve(authUrl);
    if (authProc) return reject(new Error('Auth already in progress'));

    authProc = spawn('claude', ['auth', 'login'], {
      env: { ...process.env, HOME: CLAUDE_HOME },
    });

    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/claude\.ai\/[^\s]+/);
      if (match && !authUrl) {
        authUrl = match[0];
        resolve(authUrl);
      }
    };

    authProc.stdout.on('data', onData);
    authProc.stderr.on('data', onData);

    authProc.on('close', (code) => {
      authProc = null;
      if (code === 0) {
        authUrl = null; // Auth completed successfully
        console.log('Auth completed for', USER_CHAT_ID);
      }
    });

    setTimeout(() => {
      if (!authUrl) {
        authProc?.kill();
        authProc = null;
        reject(new Error('Auth URL not received within 20s'));
      }
    }, 20000);
  });
}

// ── Run a message through Claude Code (non-interactive) ───────────────────
function runClaude(message) {
  return new Promise((resolve, reject) => {
    const args = ['--print'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push(message);

    let stdout = '';
    let stderr = '';
    const proc = spawn('claude', args, {
      env: { ...process.env, HOME: CLAUDE_HOME },
      timeout: 120000,
    });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        // Session may have expired — clear it and report error
        sessionId = null;
        try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: null })); } catch {}
        return reject(new Error(stderr.trim() || `claude exited ${code}`));
      }

      // Try to parse JSON output for session ID
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.session_id) {
          sessionId = parsed.session_id;
          fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }));
        }
        resolve(parsed.result || parsed.content || stdout.trim());
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', chatId: USER_CHAT_ID, authenticated: isAuthenticated() });
});

app.get('/auth-status', async (_req, res) => {
  if (isAuthenticated()) return res.json({ authenticated: true });
  try {
    const url = await startAuthFlow();
    res.json({ authenticated: false, authUrl: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  if (!isAuthenticated()) {
    try {
      const url = await startAuthFlow();
      return res.json({ needsAuth: true, authUrl: url });
    } catch (e) {
      return res.status(500).json({ error: 'auth failed: ' + e.message });
    }
  }

  try {
    const response = await runClaude(message);
    res.json({ response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bridge on :${PORT} — chatId=${USER_CHAT_ID}`);
  registerSelf();
});
