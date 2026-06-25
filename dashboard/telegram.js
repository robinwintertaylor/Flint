import TelegramBot from 'node-telegram-bot-api';
import { getDb, getMonthCost } from './db.js';
import { getApiKeyValue } from './apikeys.js';
import { listAgents } from './agents.js';
import { info, error as logError } from './logger.js';

const COST_ALERT_USD = parseFloat(process.env.TELEGRAM_COST_ALERT_USD ?? '5');

let _bot = null;
let _services = {};
let _lastAlertDate = '';
let _alertInterval = null;

function getChatIds() {
  return getDb().prepare('SELECT chat_id FROM telegram_chat_ids').all().map(r => r.chat_id);
}

function addChatId(chatId) {
  getDb().prepare('INSERT OR IGNORE INTO telegram_chat_ids (chat_id) VALUES (?)').run(String(chatId));
}

function isAuthorized(chatId) {
  return getDb().prepare('SELECT 1 FROM telegram_chat_ids WHERE chat_id = ?').get(String(chatId)) != null;
}

export function notify(text) {
  if (!_bot) return;
  for (const chatId of getChatIds()) {
    _bot.sendMessage(chatId, text).catch(err => logError('telegram notify failed', { err: err.message }));
  }
}

export function initTelegram(services, _BotConstructor = TelegramBot) {
  // Clear any existing interval from a previous initialization
  if (_alertInterval) {
    clearInterval(_alertInterval);
    _alertInterval = null;
  }

  _services = services ?? {};
  const token = getApiKeyValue('telegram');
  if (!token) {
    info('telegram: no token configured — bot disabled');
    _bot = null;
    return null;
  }

  _bot = new _BotConstructor(token, { polling: true });
  info('telegram: bot started');

  _bot.on('message', (msg) => {
    const chatId = String(msg.chat.id);
    const text = (msg.text ?? '').trim();

    if (text === '/start') {
      const ids = getChatIds();
      if (ids.length === 0) {
        addChatId(chatId);
        _bot.sendMessage(chatId,
          '👋 Hi Robin! I\'m Flint. You\'re now registered.\n\n' +
          'Commands:\n/status — running agents\n/cost — today\'s spend\n' +
          '/addtask <title> — add queue task\n/message <agent> <text> — message agent\n/help — this list'
        ).catch(() => {});
      } else if (isAuthorized(chatId)) {
        _bot.sendMessage(chatId, '👋 Already registered. Try /help.').catch(() => {});
      }
      // unauthorized /start: silent drop
      return;
    }

    if (!isAuthorized(chatId)) return;

    if (text === '/help') {
      _bot.sendMessage(chatId,
        'Commands:\n/status — running agents\n/cost — today\'s spend\n' +
        '/addtask <title> — add queue task\n/message <agent> <text> — message agent'
      ).catch(() => {});
      return;
    }

    if (text === '/status' || text === '/agents') {
      const agents = listAgents();
      if (agents.length === 0) {
        _bot.sendMessage(chatId, 'No agents registered.').catch(() => {});
        return;
      }
      const lines = agents.map(a => `• ${a.name}: ${a.status ?? 'unknown'}`).join('\n');
      _bot.sendMessage(chatId, `Agents:\n${lines}`).catch(() => {});
      return;
    }

    if (text === '/cost') {
      const todayRow = getDb().prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE date(timestamp) = date('now')`
      ).get();
      const month = getMonthCost();
      _bot.sendMessage(chatId,
        `💰 Today: $${todayRow.total.toFixed(4)}\n📅 This month: $${month.toFixed(4)}`
      ).catch(() => {});
      return;
    }

    if (text.startsWith('/addtask ')) {
      const title = text.slice('/addtask '.length).trim();
      if (!title) {
        _bot.sendMessage(chatId, 'Usage: /addtask <title>').catch(() => {});
        return;
      }
      try {
        const task = _services.createQueueTask({ title, created_by: 'telegram' });
        _bot.sendMessage(chatId, `✅ Task #${task.id} added: "${task.title}"`).catch(() => {});
      } catch (err) {
        _bot.sendMessage(chatId, `❌ Failed: ${err.message}`).catch(() => {});
      }
      return;
    }

    if (text.startsWith('/message ')) {
      const rest = text.slice('/message '.length).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        _bot.sendMessage(chatId, 'Usage: /message <agent> <text>').catch(() => {});
        return;
      }
      const agent = rest.slice(0, spaceIdx);
      const msg2 = rest.slice(spaceIdx + 1);
      _services.writeToAgent?.(agent, msg2 + '\n');
      _bot.sendMessage(chatId, `✉️ Sent to ${agent}`).catch(() => {});
      return;
    }

    _bot.sendMessage(chatId, 'Unknown command. Try /help').catch(() => {});
  });

  _alertInterval = setInterval(() => {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      if (_lastAlertDate === todayStr) return;
      const row = getDb().prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE date(timestamp) = date('now')`
      ).get();
      if (row.total >= COST_ALERT_USD) {
        _lastAlertDate = todayStr;
        notify(`⚠️ Daily spend alert: $${row.total.toFixed(4)} (threshold: $${COST_ALERT_USD})`);
      }
    } catch (err) {
      logError('telegram cost alert error', { err: err.message });
    }
  }, 60 * 60 * 1000);

  // Allow process to exit even if interval is pending
  if (_alertInterval.unref) _alertInterval.unref();

  return _bot;
}
