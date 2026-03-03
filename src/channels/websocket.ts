import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  NewMessage,
} from '../types.js';
import {
  WEBSOCKET_PORT,
  WEBSOCKET_PAIRING_CODE_LENGTH,
  WEBSOCKET_PAIRING_EXPIRY_MS,
} from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DATA_DIR } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';

export interface WebSocketChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Device info stored after successful pairing
interface PairedDevice {
  deviceId: string;
  displayName: string;
  pairedAt: string;
}

// Protocol message types
type ClientMessageType =
  | 'pairing_request'
  | 'pairing_verify'
  | 'message'
  | 'ping'
  | 'file_start'
  | 'file_chunk'
  | 'file_end';
type ServerMessageType =
  | 'pairing_challenge'
  | 'pairing_success'
  | 'pairing_failed'
  | 'message'
  | 'pong'
  | 'error'
  | 'file_start'
  | 'file_chunk'
  | 'file_end'
  | 'file_received';

interface ClientMessage {
  type: ClientMessageType;
  deviceId?: string;
  pairingCode?: string;
  content?: string;
  to?: string;
  timestamp?: number;
  // File transfer
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  chunk?: string;
}

interface FileTransfer {
  fileId: string;
  fileName: string;
  mimeType: string;
  totalSize: number;
  receivedSize: number;
  chunks: string[];
  tempPath?: string;
}

interface ServerMessage {
  type: ServerMessageType;
  message?: string;
  deviceId?: string;
  from?: string;
  content?: string;
  thinking?: string;
  timestamp?: number;
}

// Pending pairing request
interface PendingPairing {
  deviceId: string;
  displayName: string;
  pairingCode: string;
  expiresAt: number;
}

export class WebSocketChannel implements Channel {
  name = 'websocket';

  private server: WebSocketServer | null = null;
  private clients: Map<string, WebSocket> = new Map();
  private pairedDevices: Map<string, PairedDevice> = new Map();
  private pendingPairings: Map<string, PendingPairing> = new Map();
  private connected = false;
  private pendingFileTransfers: Map<string, Map<string, FileTransfer>> = new Map(); // deviceId -> fileId -> FileTransfer
  // Message queue for offline devices
  private messageQueue: Map<string, ServerMessage[]> = new Map();
  // Maximum queued messages per device
  private readonly MAX_QUEUED_MESSAGES = 50;

  private opts: WebSocketChannelOpts;

  // Path to persist paired devices
  private get pairedDevicesPath(): string {
    return path.join(DATA_DIR, 'websocket-paired-devices.json');
  }

  constructor(opts: WebSocketChannelOpts) {
    this.opts = opts;
    this.loadPairedDevices();
  }

  // Load paired devices from disk
  private loadPairedDevices(): void {
    try {
      const filePath = this.pairedDevicesPath;
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        for (const [deviceId, device] of Object.entries(data)) {
          this.pairedDevices.set(deviceId, device as PairedDevice);
        }
        logger.info({ count: this.pairedDevices.size }, 'Loaded paired WebSocket devices');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load paired devices');
    }
  }

  // Save paired devices to disk
  private savePairedDevices(): void {
    try {
      const data: Record<string, PairedDevice> = {};
      for (const [deviceId, device] of this.pairedDevices) {
        data[deviceId] = device;
      }
      fs.writeFileSync(this.pairedDevicesPath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Failed to save paired devices');
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = new WebSocketServer({ port: WEBSOCKET_PORT });

        this.server.on('listening', () => {
          this.connected = true;
          logger.info({ port: WEBSOCKET_PORT }, 'WebSocket server started');
          resolve();
        });

        this.server.on('connection', (ws, req) => {
          const clientIp = req.socket.remoteAddress;
          logger.debug({ clientIp }, 'New WebSocket connection');

          // Assign a temporary ID until paired
          const tempId = randomUUID();
          (ws as any).tempId = tempId;
          this.clients.set(tempId, ws);

          ws.on('message', (data) => {
            try {
              const message: ClientMessage = JSON.parse(data.toString());
              this.handleMessage(tempId, ws, message);
            } catch (err) {
              logger.warn({ err }, 'Failed to parse WebSocket message');
              this.sendJson(ws, { type: 'error', message: 'Invalid JSON' });
            }
          });

          ws.on('close', () => {
            const id = (ws as any).tempId || (ws as any).deviceId;
            this.clients.delete(id);
            logger.debug({ id }, 'WebSocket client disconnected');
          });

          ws.on('error', (err) => {
            logger.warn({ err }, 'WebSocket client error');
          });
        });

        this.server.on('error', (err) => {
          logger.error({ err }, 'WebSocket server error');
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // jid format: device-{deviceId}@nanoclaw
    const deviceId = jid.replace(/^device-/, '').replace(/@nanoclaw$/, '');
    const client = this.clients.get(deviceId);

    // Extract thinking content (common patterns: <thinking>, <reasoning>, ### Reasoning)
    let thinking: string | undefined;
    let content = text;

    // Try to extract thinking from various formats
    const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    if (thinkingMatch) {
      thinking = thinkingMatch[1].trim();
      content = text.replace(thinkingMatch[0], '').trim();
    }

    const message: ServerMessage = {
      type: 'message',
      from: 'assistant',
      content,
      thinking,
      timestamp: Date.now(),
    };

    if (!client || client.readyState !== WebSocket.OPEN) {
      // Device offline - queue the message
      this.queueMessage(deviceId, message);
      logger.warn({ jid, deviceId }, 'Device not connected, message queued');
      return;
    }

    this.sendJson(client, message);
    logger.info({ jid, length: text.length, hasThinking: !!thinking }, 'Message sent to device');
  }

  // Queue a message for offline device
  private queueMessage(deviceId: string, message: ServerMessage): void {
    if (!this.messageQueue.has(deviceId)) {
      this.messageQueue.set(deviceId, []);
    }
    const queue = this.messageQueue.get(deviceId)!;

    // Limit queue size
    if (queue.length >= this.MAX_QUEUED_MESSAGES) {
      queue.shift(); // Remove oldest message
    }

    queue.push(message);
    logger.debug({ deviceId, queueSize: queue.length }, 'Message queued for offline device');
  }

  // Send queued messages to device
  private flushMessageQueue(deviceId: string, client: WebSocket): void {
    const queue = this.messageQueue.get(deviceId);
    if (!queue || queue.length === 0) {
      return;
    }

    logger.info({ deviceId, count: queue.length }, 'Flushing message queue to device');

    for (const message of queue) {
      this.sendJson(client, message);
    }

    // Clear the queue
    this.messageQueue.delete(deviceId);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Owns device-{deviceId}@nanoclaw JIDs
    return /^device-[^@]+@nanoclaw$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          logger.info('WebSocket server stopped');
          resolve();
        });
      });
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // WebSocket doesn't support typing indicators natively
    // Could implement as a separate message type if needed
    logger.debug({ jid, isTyping }, 'Typing indicator not supported on WebSocket');
  }

  private sendJson(ws: WebSocket, obj: object): void {
    ws.send(JSON.stringify(obj));
  }

  private generatePairingCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding confusing chars
    let code = '';
    for (let i = 0; i < WEBSOCKET_PAIRING_CODE_LENGTH; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  private handleMessage(tempId: string, ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'pairing_request':
        this.handlePairingRequest(tempId, ws, msg);
        break;
      case 'pairing_verify':
        this.handlePairingVerify(ws, msg);
        break;
      case 'message':
        this.handleChatMessage(ws, msg);
        break;
      case 'ping':
        this.sendJson(ws, { type: 'pong' });
        break;
      case 'file_start':
        this.handleFileStart(ws, msg);
        break;
      case 'file_chunk':
        this.handleFileChunk(ws, msg);
        break;
      case 'file_end':
        this.handleFileEnd(ws, msg);
        break;
      default:
        logger.warn({ type: msg.type }, 'Unknown message type');
    }
  }

  private handlePairingRequest(
    tempId: string,
    ws: WebSocket,
    msg: ClientMessage,
  ): void {
    if (!msg.deviceId) {
      this.sendJson(ws, {
        type: 'pairing_failed',
        message: 'deviceId is required',
      });
      return;
    }

    // Check if already paired
    if (this.pairedDevices.has(msg.deviceId)) {
      // Reconnect - restore session
      this.clients.delete(tempId);
      this.clients.set(msg.deviceId, ws);
      (ws as any).deviceId = msg.deviceId;
      this.sendJson(ws, {
        type: 'pairing_success',
        deviceId: msg.deviceId,
        message: 'Reconnected',
      });
      logger.info({ deviceId: msg.deviceId }, 'Device reconnected');

      // Flush queued messages
      this.flushMessageQueue(msg.deviceId, ws);
      return;
    }

    // Generate pairing code
    const pairingCode = this.generatePairingCode();
    const pending: PendingPairing = {
      deviceId: msg.deviceId,
      displayName: msg.deviceId, // TODO: could ask for display name
      pairingCode,
      expiresAt: Date.now() + WEBSOCKET_PAIRING_EXPIRY_MS,
    };

    this.pendingPairings.set(msg.deviceId, pending);

    // Send challenge to client
    this.sendJson(ws, {
      type: 'pairing_challenge',
      deviceId: msg.deviceId,
      pairingCode,
      expiresIn: WEBSOCKET_PAIRING_EXPIRY_MS / 1000,
    });

    // Log pairing code for user to enter on device
    logger.info(
      { deviceId: msg.deviceId, code: pairingCode },
      'Pairing code generated - enter on device',
    );

    // Auto-cleanup expired pairings
    setTimeout(() => {
      const p = this.pendingPairings.get(msg.deviceId!);
      if (p && p.expiresAt < Date.now()) {
        this.pendingPairings.delete(msg.deviceId!);
      }
    }, WEBSOCKET_PAIRING_EXPIRY_MS + 1000);
  }

  private handlePairingVerify(ws: WebSocket, msg: ClientMessage): void {
    if (!msg.deviceId || !msg.pairingCode) {
      this.sendJson(ws, {
        type: 'pairing_failed',
        message: 'deviceId and pairingCode are required',
      });
      return;
    }

    const pending = this.pendingPairings.get(msg.deviceId);
    if (!pending) {
      this.sendJson(ws, {
        type: 'pairing_failed',
        message: 'No pending pairing request',
      });
      return;
    }

    if (pending.expiresAt < Date.now()) {
      this.pendingPairings.delete(msg.deviceId);
      this.sendJson(ws, {
        type: 'pairing_failed',
        message: 'Pairing code expired',
      });
      return;
    }

    if (pending.pairingCode !== msg.pairingCode.toUpperCase()) {
      this.sendJson(ws, {
        type: 'pairing_failed',
        message: 'Invalid pairing code',
      });
      return;
    }

    // Pairing successful
    this.pendingPairings.delete(msg.deviceId);

    const device: PairedDevice = {
      deviceId: msg.deviceId,
      displayName: pending.displayName,
      pairedAt: new Date().toISOString(),
    };
    this.pairedDevices.set(msg.deviceId, device);
    this.savePairedDevices();

    // Update client mapping
    const tempId = (ws as any).tempId;
    if (tempId) {
      this.clients.delete(tempId);
    }
    this.clients.set(msg.deviceId, ws);
    (ws as any).deviceId = msg.deviceId;

    this.sendJson(ws, {
      type: 'pairing_success',
      deviceId: msg.deviceId,
      message: 'Paired successfully',
    });

    logger.info({ deviceId: msg.deviceId }, 'Device paired successfully');

    // Flush queued messages
    this.flushMessageQueue(msg.deviceId, ws);
  }

  private handleChatMessage(ws: WebSocket, msg: ClientMessage): void {
    const deviceId = (ws as any).deviceId;
    if (!deviceId) {
      this.sendJson(ws, {
        type: 'error',
        message: 'Not paired',
      });
      return;
    }

    // Check if device is already registered (via device group in database)
    const chatJid = `device-${deviceId}@nanoclaw`;
    const registeredGroups = this.opts.registeredGroups();
    const isRegistered = !!registeredGroups[chatJid];

    // Check in-memory paired devices
    const isPaired = this.pairedDevices.has(deviceId);

    // If device group exists in registered groups, auto-pair it
    if (isRegistered && !isPaired) {
      this.pairedDevices.set(deviceId, {
        deviceId,
        displayName: deviceId,
        pairedAt: new Date().toISOString(),
      });
      this.savePairedDevices();
      this.sendJson(ws, {
        type: 'pairing_success',
        deviceId,
        message: 'Auto-reconnected',
      });
      logger.info({ deviceId }, 'Device auto-paired via registered group');
    } else if (!isPaired) {
      this.sendJson(ws, {
        type: 'error',
        message: 'Not paired',
      });
      return;
    }

    if (!msg.content) {
      this.sendJson(ws, {
        type: 'error',
        message: 'Content is required',
      });
      return;
    }

    // Notify about chat metadata
    this.opts.onChatMetadata(
      chatJid,
      new Date().toISOString(),
      this.pairedDevices.get(deviceId)?.displayName,
      'websocket',
      false,
    );

    // Deliver the message
    const newMessage: NewMessage = {
      id: randomUUID(),
      chat_jid: chatJid,
      sender: `device-${deviceId}`,
      sender_name: this.pairedDevices.get(deviceId)?.displayName || deviceId,
      content: msg.content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    };

    this.opts.onMessage(chatJid, newMessage);
    logger.info({ deviceId, content: msg.content.slice(0, 50) }, 'Message received from device');
  }

  private handleFileStart(ws: WebSocket, msg: ClientMessage): void {
    let deviceId = (ws as any).deviceId;

    // Auto-pair if device is registered in database
    if (!deviceId) {
      // Try to get deviceId from the message or use tempId
      const chatJid = `device-${(ws as any).tempId}@nanoclaw`;
      const registeredGroups = this.opts.registeredGroups();
      if (registeredGroups[chatJid]) {
        deviceId = (ws as any).tempId;
        // Auto-pair
        this.pairedDevices.set(deviceId, {
          deviceId,
          displayName: deviceId,
          pairedAt: new Date().toISOString(),
        });
        this.savePairedDevices();
        this.clients.delete((ws as any).tempId);
        this.clients.set(deviceId, ws);
        (ws as any).deviceId = deviceId;
      }
    }

    if (!deviceId) {
      this.sendJson(ws, { type: 'file_received', fileId: msg.fileId, status: 'error', message: 'Not paired' });
      return;
    }

    if (!msg.fileId || !msg.fileName || !msg.fileSize || !msg.mimeType) {
      this.sendJson(ws, { type: 'file_received', fileId: msg.fileId, status: 'error', message: 'Missing file metadata' });
      return;
    }

    // Initialize file transfer
    if (!this.pendingFileTransfers.has(deviceId)) {
      this.pendingFileTransfers.set(deviceId, new Map());
    }

    const fileTransfer: FileTransfer = {
      fileId: msg.fileId!,
      fileName: msg.fileName!,
      mimeType: msg.mimeType!,
      totalSize: msg.fileSize!,
      receivedSize: 0,
      chunks: [],
    };

    this.pendingFileTransfers.get(deviceId)!.set(msg.fileId!, fileTransfer);

    logger.info({ deviceId, fileId: msg.fileId, fileName: msg.fileName, size: msg.fileSize }, 'File transfer started');
  }

  private handleFileChunk(ws: WebSocket, msg: ClientMessage): void {
    const deviceId = (ws as any).deviceId;
    if (!deviceId || !msg.fileId || !msg.chunk) return;

    const deviceFiles = this.pendingFileTransfers.get(deviceId);
    if (!deviceFiles) return;

    const fileTransfer = deviceFiles.get(msg.fileId);
    if (!fileTransfer) return;

    fileTransfer.chunks.push(msg.chunk);
    fileTransfer.receivedSize += Buffer.from(msg.chunk, 'base64').length;

    logger.debug({ fileId: msg.fileId, received: fileTransfer.receivedSize, total: fileTransfer.totalSize }, 'File chunk received');
  }

  private async handleFileEnd(ws: WebSocket, msg: ClientMessage): Promise<void> {
    const deviceId = (ws as any).deviceId;
    if (!deviceId || !msg.fileId) {
      this.sendJson(ws, { type: 'file_received', fileId: msg.fileId, status: 'error', message: 'Not paired' });
      return;
    }

    const deviceFiles = this.pendingFileTransfers.get(deviceId);
    if (!deviceFiles) {
      this.sendJson(ws, { type: 'file_received', fileId: msg.fileId, status: 'error', message: 'No pending file transfer' });
      return;
    }

    const fileTransfer = deviceFiles.get(msg.fileId);
    if (!fileTransfer) {
      this.sendJson(ws, { type: 'file_received', fileId: msg.fileId, status: 'error', message: 'File not found' });
      return;
    }

    try {
      // Save to device group's folder so container can access it
      const groupFolder = `device-${deviceId}`;
      const groupDir = resolveGroupFolderPath(groupFolder);
      const uploadDir = path.join(groupDir, 'uploads');

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const filePath = path.join(uploadDir, `${msg.fileId}-${fileTransfer.fileName}`);
      const fileBuffer = Buffer.from(fileTransfer.chunks.join(''), 'base64');
      fs.writeFileSync(filePath, fileBuffer);

      fileTransfer.tempPath = filePath;

      logger.info({ deviceId, fileId: msg.fileId, fileName: fileTransfer.fileName, size: fileTransfer.receivedSize }, 'File received successfully');

      // Send success response
      this.sendJson(ws, { type: 'file_received', fileId: msg.fileId, status: 'ok' });

      // Notify about chat metadata
      const chatJid = `device-${deviceId}@nanoclaw`;
      this.opts.onChatMetadata(
        chatJid,
        new Date().toISOString(),
        this.pairedDevices.get(deviceId)?.displayName,
        'websocket',
        false,
      );

      // Deliver file message to AI
      const newMessage: NewMessage = {
        id: randomUUID(),
        chat_jid: chatJid,
        sender: `device-${deviceId}`,
        sender_name: this.pairedDevices.get(deviceId)?.displayName || deviceId,
        content: `[发送了文件: ${fileTransfer.fileName} (${this.formatFileSize(fileTransfer.totalSize)})]`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        attachments: [
          {
            filename: fileTransfer.fileName,
            path: filePath,
            mimeType: fileTransfer.mimeType,
            size: fileTransfer.totalSize,
          },
        ],
      };

      this.opts.onMessage(chatJid, newMessage);

      // Clean up transfer state (but keep temp file for the attachment)
      deviceFiles.delete(msg.fileId);
    } catch (err) {
      logger.error({ err, fileId: msg.fileId }, 'Failed to save file');
      this.sendJson(ws, { type: 'file_received', fileId: msg.fileId, status: 'error', message: 'Failed to save file' });
      deviceFiles.delete(msg.fileId);
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Send file to client (called from router or other parts)
  async sendFile(jid: string, fileName: string, filePath: string, mimeType: string): Promise<void> {
    const deviceId = jid.replace(/^device-/, '').replace(/@nanoclaw$/, '');
    const client = this.clients.get(deviceId);

    if (!client || client.readyState !== WebSocket.OPEN) {
      logger.warn({ jid, deviceId }, 'Device not connected, file not sent');
      return;
    }

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const fileSize = fileBuffer.length;
      const fileId = randomUUID();
      const base64 = fileBuffer.toString('base64');

      // Send file_start
      this.sendJson(client, {
        type: 'file_start',
        fileId,
        fileName,
        fileSize,
        mimeType,
      });

      // Split into chunks (16KB per chunk for WebSocket)
      const chunkSize = 16 * 1024;
      const totalChunks = Math.ceil(base64.length / chunkSize);

      for (let i = 0; i < totalChunks; i++) {
        const chunk = base64.slice(i * chunkSize, (i + 1) * chunkSize);
        this.sendJson(client, {
          type: 'file_chunk',
          fileId,
          chunk,
        });

        // Small delay to avoid overwhelming the WebSocket
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Send file_end
      this.sendJson(client, {
        type: 'file_end',
        fileId,
      });

      logger.info({ jid, fileName, size: fileSize }, 'File sent to device');
    } catch (err) {
      logger.error({ err, jid, fileName }, 'Failed to send file to device');
    }
  }
}
