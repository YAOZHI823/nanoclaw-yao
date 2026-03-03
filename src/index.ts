import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { WebSocketChannel } from './channels/websocket.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  db,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
let websocket: WebSocketChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Create CLAUDE.md for device chats if it doesn't exist
  if (group.folder.startsWith('device-')) {
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const deviceClaudeMd = `# Device Chat

You are chatting with a user via WebSocket.

## Important
- Do NOT use \`mcp__nanoclaw__send_message\` tool
- Just output your text response directly
- NanoClaw will automatically send via the correct channel

## Scheduling Tasks

You can create real scheduled tasks! When the user asks for a reminder (e.g., "5 minutes later remind me to drink water"), you MUST create an actual scheduled task.

### How to Create a Task

Write a JSON file to \`/workspace/ipc/tasks/\` to create a task:

\`\`\`bash
echo '{"type": "schedule_task", "prompt": "提醒我喝水", "schedule_type": "interval", "schedule_value": "300000"}' > /workspace/ipc/tasks/task_$(date +%s).json
\`\`\`

**schedule_type options:**
- \`interval\` - Run after X milliseconds (e.g., "300000" for 5 minutes)
- \`once\` - Run at specific time (ISO timestamp)
- \`cron\` - Recurring (e.g., "0 9 * * *" for daily at 9am)

**Examples:**

"5分钟后提醒我喝水":
\`\`\`bash
echo '{"type": "schedule_task", "prompt": "提醒我喝水", "schedule_type": "interval", "schedule_value": "300000"}' > /workspace/ipc/tasks/task_$(date +%s).json
\`\`\`

"1分钟后提醒我喝水":
\`\`\`bash
echo '{"type": "schedule_task", "prompt": "提醒我喝水", "schedule_type": "interval", "schedule_value": "60000"}' > /workspace/ipc/tasks/task_$(date +%s).json
\`\`\`

"每天早上9点提醒我":
\`\`\`bash
echo '{"type": "schedule_task", "prompt": "早安提醒", "schedule_type": "cron", "schedule_value": "0 9 * * *"}' > /workspace/ipc/tasks/task_$(date +%s).json
\`\`\`

After creating the task, confirm to the user that the reminder is set.
`;
      fs.writeFileSync(claudeMdPath, deviceClaudeMd);
      logger.info({ folder: group.folder }, 'Created device CLAUDE.md');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];

  // Auto-create a virtual group for WebSocket device chats
  if (!group && /^device-[^@]+@nanoclaw$/.test(chatJid)) {
    const deviceId = chatJid.replace(/^device-/, '').replace(/@nanoclaw$/, '');
    group = {
      name: `Device: ${deviceId}`,
      folder: `device-${deviceId}`,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false, // Device chats don't need trigger
    };
    registerGroup(chatJid, group);
    logger.info({ chatJid, deviceId }, 'Auto-registered device chat');
  }

  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        logger.info({ chatJid, channel: channel.name, textLength: text.length }, 'Sending response via channel');
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      // Get all registered group JIDs plus any WebSocket device JIDs from recent messages
      let jids = Object.keys(registeredGroups);

      // Also check for device chats in recent messages
      try {
        const recentDeviceChats = db
          .prepare(
            `SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE 'device-%@nanoclaw' AND timestamp > ?`,
          )
          .all(lastTimestamp) as { chat_jid: string }[];

        if (recentDeviceChats && recentDeviceChats.length > 0) {
          logger.debug({ recentDeviceChats, lastTimestamp }, 'Found device chats in messages');
          for (const row of recentDeviceChats) {
            if (!jids.includes(row.chat_jid)) {
              jids.push(row.chat_jid);
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to query device chats');
      }
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          let group = registeredGroups[chatJid];

          // Auto-create a virtual group for WebSocket device chats
          if (!group && /^device-[^@]+@nanoclaw$/.test(chatJid)) {
            const deviceId = chatJid.replace(/^device-/, '').replace(/@nanoclaw$/, '');
            group = {
              name: `Device: ${deviceId}`,
              folder: `device-${deviceId}`,
              trigger: '',
              added_at: new Date().toISOString(),
              requiresTrigger: false,
            };
            registerGroup(chatJid, group);
            logger.info({ chatJid, deviceId }, 'Auto-registered device chat');
          }

          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels (start both in parallel)
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);

  websocket = new WebSocketChannel(channelOpts);
  channels.push(websocket);

  // Start WhatsApp in background, don't block on it
  whatsapp.connect().catch((err) => {
    logger.error({ err }, 'WhatsApp connection failed');
  });

  // Start WebSocket
  try {
    await websocket.connect();
  } catch (err) {
    logger.error({ err }, 'Failed to start WebSocket channel');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: async (jid, fileName, filePath, mimeType) => {
      const channel = findChannel(channels, jid);
      if (!channel || !channel.sendFile) {
        logger.warn({ channel: channel?.name, jid }, 'Channel does not support file transfer');
        return;
      }
      return channel.sendFile(jid, fileName, filePath, mimeType);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) =>
      whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  const command = process.argv[2];

  if (command === 'device-list') {
    // List paired WebSocket devices
    const devicesPath = path.join(DATA_DIR, 'websocket-paired-devices.json');
    if (fs.existsSync(devicesPath)) {
      const devices = JSON.parse(fs.readFileSync(devicesPath, 'utf-8'));
      console.log('Paired WebSocket devices:');
      for (const [id, device] of Object.entries(devices)) {
        console.log(`  - ${id} (paired at: ${(device as any).pairedAt})`);
      }
    } else {
      console.log('No paired devices');
    }
    process.exit(0);
  } else if (command === 'device-delete') {
    // Wrap in async IIFE to allow await
    (async () => {
      const deviceId = process.argv[3];
      if (!deviceId) {
        console.log('Usage: nanoclaw device-delete <device-id>');
        process.exit(1);
      }

      // Normalize device ID (add device- prefix if missing)
      const normalizedId = deviceId.startsWith('device-') ? deviceId : `device-${deviceId}`;
      const chatJid = `${normalizedId}@nanoclaw`;

      const devicesPath = path.join(DATA_DIR, 'websocket-paired-devices.json');
      if (fs.existsSync(devicesPath)) {
        const devices = JSON.parse(fs.readFileSync(devicesPath, 'utf-8'));

        // Try both with and without device- prefix
        const keyWithPrefix = deviceId.startsWith('device-') ? deviceId : `device-${deviceId}`;
        const keyWithoutPrefix = deviceId.replace(/^device-/, '');

        let deleted = false;
        for (const key of [keyWithPrefix, keyWithoutPrefix]) {
          if (devices[key]) {
            delete devices[key];
            fs.writeFileSync(devicesPath, JSON.stringify(devices, null, 2));
            console.log(`Deleted device: ${key}`);
            deleted = true;

            // Also delete device session directory
            const sessionDir = path.join(DATA_DIR, 'sessions', key);
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true });
              console.log(`Deleted session directory: ${sessionDir}`);
            }
            break;
          }
        }

        if (!deleted) {
          console.log(`Device not found: ${deviceId}`);
        } else {
          // Delete messages for this device using direct SQLite connection
          try {
            const dbPath = path.join(STORE_DIR, 'messages.db');
            if (fs.existsSync(dbPath)) {
              const db = new Database(dbPath);
              const result = db.prepare(`DELETE FROM messages WHERE chat_jid LIKE ?`).run(`${normalizedId}%`);
              console.log(`Deleted ${result.changes} message(s) for ${chatJid}`);
              db.close();
            }
          } catch (err) {
            console.log(`Note: Could not delete messages: ${err}`);
          }
        }
      } else {
        console.log('No paired devices');
      }
      process.exit(0);
    })();
  } else if (command === 'device-clear') {
    const devicesPath = path.join(DATA_DIR, 'websocket-paired-devices.json');
    if (fs.existsSync(devicesPath)) {
      fs.unlinkSync(devicesPath);
      console.log('Cleared all paired devices');
    }

    // Delete all device session directories
    const sessionsDir = path.join(DATA_DIR, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const dir of fs.readdirSync(sessionsDir)) {
        if (dir.startsWith('device-')) {
          const fullPath = path.join(sessionsDir, dir);
          fs.rmSync(fullPath, { recursive: true });
          console.log(`Deleted: ${fullPath}`);
        }
      }
    }

    // Delete all device messages
    try {
      const dbPath = path.join(STORE_DIR, 'messages.db');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath);
        const result = db.prepare(`DELETE FROM messages WHERE chat_jid LIKE 'device-%@nanoclaw'`).run();
        console.log(`Deleted ${result.changes} device message(s)`);
        db.close();
      }
    } catch (err) {
      console.log(`Note: Could not delete messages: ${err}`);
    }

    console.log('Cleared all device data');
    process.exit(0);
  } else if (!command || command === 'start') {
    main().catch((err) => {
      logger.error({ err }, 'Failed to start NanoClaw');
      process.exit(1);
    });
  } else {
    console.log(`Unknown command: ${command}`);
    console.log('Available commands:');
    console.log('  device-list         - List paired WebSocket devices');
    console.log('  device-delete <id> - Delete a specific device');
    console.log('  device-clear       - Clear all device data');
    console.log('  (no command)       - Start NanoClaw service');
    process.exit(1);
  }
}
