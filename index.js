// index.js
const mineflayer = require('mineflayer');
const { Movements, pathfinder } = require('mineflayer-pathfinder');
const { GoalBlock, GoalNear } = require('mineflayer-pathfinder').goals;
const config = require('./settings.json');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.send('Bot has arrived'));
app.listen(8000, () => console.log('Server started'));

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createBot() {
  const bot = mineflayer.createBot({
    username: config['bot-account']['username'],
    password: config['bot-account']['password'],
    auth: config['bot-account']['type'],
    host: config.server.ip,
    port: config.server.port,
    version: config.server.version,
  });

  // load pathfinder plugin
  bot.loadPlugin(pathfinder);

  // We'll create Movements after we know the bot version (below)
  let defaultMove = null;

  bot.settings.colorsEnabled = false;

  let pendingPromise = Promise.resolve();
  let wanderInterval = null;
  let currentWanderTimeout = null;

  // -------- auth helpers ----------
  function sendRegister(password) {
    return new Promise((resolve, reject) => {
      try { bot.chat(`/register ${password} ${password}`); } catch (e) {}
      console.log(`[Auth] Sent /register command.`);

      const listener = (username, message) => {
        console.log(`[ChatLog] <${username}> ${message}`);
        if (message.toLowerCase().includes('successfully registered') || message.toLowerCase().includes('registered successfully')) {
          bot.removeListener('chat', listener);
          resolve();
        } else if (message.toLowerCase().includes('already registered')) {
          bot.removeListener('chat', listener);
          resolve();
        } else if (message.toLowerCase().includes('invalid command')) {
          bot.removeListener('chat', listener);
          reject(`Registration failed: Invalid command. Message: "${message}"`);
        }
      };

      bot.on('chat', listener);
      setTimeout(() => {
        bot.removeListener('chat', listener);
        resolve(); // fallback after timeout so it doesn't hang
      }, 8000);
    });
  }

  function sendLogin(password) {
    return new Promise((resolve, reject) => {
      try { bot.chat(`/login ${password}`); } catch (e) {}
      console.log(`[Auth] Sent /login command.`);

      const listener = (username, message) => {
        console.log(`[ChatLog] <${username}> ${message}`);
        const lower = message.toLowerCase();
        if (lower.includes('successfully logged in') || lower.includes('logged in successfully') || lower.includes('login successful')) {
          bot.removeListener('chat', listener);
          resolve();
        } else if (lower.includes('invalid password')) {
          bot.removeListener('chat', listener);
          reject(`Login failed: Invalid password. Message: "${message}"`);
        } else if (lower.includes('not registered')) {
          bot.removeListener('chat', listener);
          reject(`Login failed: Not registered. Message: "${message}"`);
        }
      };

      bot.on('chat', listener);
      setTimeout(() => {
        bot.removeListener('chat', listener);
        resolve(); // fallback
      }, 8000);
    });
  }

  // -------- wandering (mob-like) ----------
  function startWandering() {
    const cfg = config.utils?.['mob-movement'] || {};
    const radius = cfg.radius || 8;
    const minDelay = cfg.minDelaySeconds || 5;
    const maxDelay = cfg.maxDelaySeconds || 12;
    const wanderTimeoutMs = (cfg.wanderTimeoutSeconds || 20) * 1000;

    if (!defaultMove) {
      // safety: if Movements hasn't been created (edge case), create it now
      try {
        const mcData = require('minecraft-data')(bot.version);
        defaultMove = new Movements(bot, mcData);
      } catch (e) {
        console.warn('[WANDER] Unable to create Movements yet:', e.message);
        return;
      }
    }

    if (wanderInterval) clearInterval(wanderInterval);

    function clearCurrentWanderTimeout() {
      if (currentWanderTimeout) {
        clearTimeout(currentWanderTimeout);
        currentWanderTimeout = null;
      }
    }

    function pickTargetAndGo() {
      if (!bot.entity || !bot.entity.position) return;

      const pos = bot.entity.position;
      const dx = randomInt(-radius, radius);
      const dz = randomInt(-radius, radius);
      const targetX = Math.floor(pos.x + dx);
      const targetZ = Math.floor(pos.z + dz);

      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalNear(targetX, pos.y, targetZ, 1));

      // cancel previous timeout and set new: if the bot hasn't reached the goal within wanderTimeoutMs, clear goal
      clearCurrentWanderTimeout();
      currentWanderTimeout = setTimeout(() => {
        try {
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
        } catch (e) {}
      }, wanderTimeoutMs);

      // small random actions to look natural (do not interfere heavily with pathfinder)
      if (Math.random() < 0.35) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300 + Math.random() * 700);
      }
      if (Math.random() < 0.6) {
        bot.setControlState('forward', true);
        setTimeout(() => bot.setControlState('forward', false), 500 + Math.random() * 1800);
      }
      if (Math.random() < 0.7) {
        const yaw = (Math.random() - 0.5) * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * 0.6;
        bot.look(yaw, pitch, true).catch(() => {});
      }
    }

    // run first pick immediately
    pickTargetAndGo();

    // random interval so it doesn't feel mechanical
    wanderInterval = setInterval(() => {
      pickTargetAndGo();
    }, randomInt(minDelay, maxDelay) * 1000);

    // clear wander timer when we reach a goal
    bot.once('goal_reached', () => {
      clearCurrentWanderTimeout();
      // allow next wander to be scheduled by the interval
    });
  }

  function stopWandering() {
    if (wanderInterval) {
      clearInterval(wanderInterval);
      wanderInterval = null;
    }
    if (currentWanderTimeout) {
      clearTimeout(currentWanderTimeout);
      currentWanderTimeout = null;
    }
    try { bot.clearControlStates(); } catch (e) {}
    try { bot.pathfinder.setGoal(null); } catch (e) {}
  }

  // Called when the bot spawns
  bot.once('spawn', () => {
    console.log('\x1b[33m[AfkBot] Bot joined the server\x1b[0m');

    // create Movements now that bot.version is set (avoid mcData undefined issues)
    try {
      const mcData = require('minecraft-data')(bot.version);
      defaultMove = new Movements(bot, mcData);
    } catch (e) {
      console.warn('[INIT] Could not init Movements immediately:', e.message);
    }

    // Auto auth
    if (config.utils?.['auto-auth']?.enabled) {
      console.log('[INFO] Started auto-auth module');
      const password = config.utils['auto-auth'].password;
      pendingPromise = pendingPromise
        .then(() => sendRegister(password))
        .then(() => sendLogin(password))
        .catch(error => console.error('[ERROR]', error));
    }

    // Chat messages
    if (config.utils?.['chat-messages']?.enabled) {
      console.log('[INFO] Started chat-messages module');
      const messages = config.utils['chat-messages'].messages || [];
      if (config.utils['chat-messages'].repeat) {
        const delay = config.utils['chat-messages']['repeat-delay'] || 60;
        let i = 0;
        const t = setInterval(() => {
          try { bot.chat(messages[i]); } catch (e) {}
          i = (i + 1) % messages.length;
        }, delay * 1000);
        bot.once('end', () => clearInterval(t));
      } else {
        messages.forEach((m) => {
          try { bot.chat(m); } catch (e) {}
        });
      }
    }

    // Move to fixed position if configured
    if (config.position?.enabled) {
      const pos = config.position;
      console.log(`\x1b[32m[Afk Bot] Moving to (${pos.x}, ${pos.y}, ${pos.z})\x1b[0m`);
      try {
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
      } catch (e) {
        console.warn('[POSITION] Could not set position goal yet:', e.message);
      }
    }

    // Mob-like wandering (if enabled)
    if (config.utils?.['mob-movement']?.enabled) {
      console.log('[INFO] Mob-like movement enabled');
      startWandering();
    }

    // Anti-afk
    if (config.utils?.['anti-afk']?.enabled) {
      bot.setControlState('jump', true);
      if (config.utils['anti-afk'].sneak) bot.setControlState('sneak', true);
    }
  });

  // Events
  bot.on('goal_reached', () => {
    console.log('\x1b[32m[AfkBot] Goal reached', bot.entity?.position, '\x1b[0m');
  });

  bot.on('death', () => {
    console.log('\x1b[33m[AfkBot] Bot died and respawned', bot.entity?.position, '\x1b[0m');
  });

  if (config.utils?.['auto-reconnect']?.enabled) {
    bot.on('end', () => {
      stopWandering();
      setTimeout(() => createBot(), config.utils['auto-reconnect'].delay || 5000);
    });
  }

  bot.on('kicked', (reason) => console.log('\x1b[33m[AfkBot] Kicked:', reason, '\x1b[0m'));
  bot.on('error', (err) => console.log('\x1b[31m[ERROR]', err.message, '\x1b[0m'));

  bot.on('end', stopWandering);
}

createBot();
