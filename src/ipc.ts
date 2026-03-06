import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
  DEVICE_JID_PATTERN,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getRegisteredGroup, getTaskById, setRegisteredGroup, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { AdditionalMount, ContainerConfig, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, fileName: string, filePath: string, mimeType: string) => Promise<void>;
  sendImage?: (jid: string, imagePath: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  reloadGroups?: () => void; // Reload groups from DB to refresh cache
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Helper function to move failed IPC files to error directory
    const moveToErrorDir = (filePath: string, sourceGroup: string, file: string) => {
      const errorDir = path.join(ipcBaseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    };

    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'send_file' && data.chatJid && data.fileName && data.filePath) {
                // Send file to client
                // Allow if:
                // 1. isMain (main group can send to anyone)
                // 2. Target is in registeredGroups and matches source group
                // 3. Target is a WebSocket device (device-*@nanoclaw pattern) - always allow
                const targetGroup = registeredGroups[data.chatJid];
                const isWebSocketDevice = DEVICE_JID_PATTERN.test(data.chatJid);

                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup) ||
                  isWebSocketDevice
                ) {
                  const mimeType = data.mimeType || 'application/octet-stream';

                  // Convert container path to host path
                  // Container path: /workspace/group/xxx.md
                  // Host path: {DATA_DIR}/sessions/{groupFolder}/xxx.md
                  let hostFilePath = data.filePath;
                  if (data.filePath.startsWith('/workspace/group/')) {
                    const relativePath = data.filePath.replace('/workspace/group/', '');
                    const groupHostDir = resolveGroupFolderPath(sourceGroup);
                    hostFilePath = path.join(groupHostDir, relativePath);
                  }

                  logger.info({ hostFilePath, exists: fs.existsSync(hostFilePath), mimeType }, 'Sending file to client');

                  // Use sendImage for image types, sendFile for others
                  const isImage = mimeType.startsWith('image/');
                  if (isImage && deps.sendImage) {
                    await deps.sendImage(data.chatJid, hostFilePath);
                  } else {
                    await deps.sendFile(data.chatJid, data.fileName, hostFilePath, mimeType);
                  }
                  logger.info(
                    { chatJid: data.chatJid, fileName: data.fileName, sourceGroup },
                    'IPC file sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file send attempt blocked',
                  );
                }
              } else if (data.type === 'container_config') {
                // Handle container config updates (mounts, etc.)
                // Allow only from the group's own IPC directory
                if (data.sourceGroup === sourceGroup || isMain) {
                  try {
                    await handleContainerConfig(data, sourceGroup, deps);
                    logger.info(
                      { action: data.action, sourceGroup },
                      'Container config updated',
                    );
                  } catch (err) {
                    logger.error(
                      { err, action: data.action, sourceGroup },
                      'Failed to update container config',
                    );
                  }
                } else {
                  logger.warn(
                    { sourceGroup, expected: data.sourceGroup },
                    'Unauthorized container config attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              moveToErrorDir(filePath, sourceGroup, file);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              moveToErrorDir(filePath, sourceGroup, file);
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Handle container configuration updates from IPC
 * Supports: add_mount, remove_mount, list, clear
 */
async function handleContainerConfig(
  data: {
    type: string;
    action: string;
    sourceGroup: string;
    mount?: {
      hostPath: string;
      containerPath?: string;
      readonly?: boolean;
      isDefault?: boolean;
    };
  },
  sourceGroup: string,
  _deps: IpcDeps,
): Promise<void> {
  const { action, sourceGroup: groupFolder, mount } = data;

  // Find the registered group by folder
  const groups = _deps.registeredGroups();
  let targetJid: string | undefined;
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === groupFolder) {
      targetJid = jid;
      break;
    }
  }

  if (!targetJid) {
    throw new Error(`Group not found: ${groupFolder}`);
  }

  const currentGroup = groups[targetJid];
  const currentConfig: ContainerConfig = currentGroup?.containerConfig || {};
  const currentMounts: AdditionalMount[] = currentConfig.additionalMounts || [];

  let newMounts: AdditionalMount[] = [];

  switch (action) {
    case 'add_mount': {
      if (!mount?.hostPath) {
        throw new Error('Missing mount.hostPath for add_mount');
      }
      // Check if already exists
      const exists = currentMounts.some((m) => m.hostPath === mount.hostPath);
      if (exists) {
        logger.warn({ hostPath: mount.hostPath }, 'Mount already exists, skipping');
        return;
      }
      newMounts = [
        ...currentMounts,
        {
          hostPath: mount.hostPath,
          containerPath: mount.containerPath,
          readonly: mount.readonly ?? true,
          isDefault: mount.isDefault ?? false,
        },
      ];
      logger.info(
        { hostPath: mount.hostPath, containerPath: mount.containerPath, readonly: mount.readonly },
        'Adding mount',
      );
      break;
    }

    case 'remove_mount': {
      if (!mount?.hostPath) {
        throw new Error('Missing mount.hostPath for remove_mount');
      }
      newMounts = currentMounts.filter((m) => m.hostPath !== mount.hostPath);
      logger.info({ hostPath: mount.hostPath }, 'Removing mount');
      break;
    }

    case 'clear': {
      // Keep only default mounts (isDefault: true)
      newMounts = currentMounts.filter((m) => m.isDefault === true);
      logger.info({ kept: newMounts.length }, 'Clearing user mounts, keeping defaults');
      break;
    }

    case 'list': {
      // For list, we just log - the container can query through other means
      logger.info(
        { mounts: currentMounts.map((m) => ({ ...m, isDefault: m.isDefault ?? false })) },
        'Listing mounts',
      );
      return;
    }

    default:
      throw new Error(`Unknown container_config action: ${action}`);
  }

  // Update the group configuration
  const newConfig: RegisteredGroup['containerConfig'] = {
    ...currentConfig,
    additionalMounts: newMounts,
  };

  setRegisteredGroup(targetJid, {
    ...currentGroup,
    containerConfig: newConfig,
  });

  // Reload groups cache if available
  if (_deps.reloadGroups) {
    _deps.reloadGroups();
  }

  logger.info(
    { action, mountCount: newMounts.length, groupFolder },
    'Container config updated successfully',
  );
}
