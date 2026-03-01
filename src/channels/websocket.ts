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
type ClientMessageType = 'pairing_request' | 'pairing_verify' | 'message' | 'ping';
type ServerMessageType =
  | 'pairing_challenge'
  | 'pairing_success'
  | 'pairing_failed'
  | 'message'
  | 'pong'
  | 'error';

interface ClientMessage {
  type: ClientMessageType;
  deviceId?: string;
  pairingCode?: string;
  content?: string;
  to?: string;
  timestamp?: number;
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

  private opts: WebSocketChannelOpts;

  constructor(opts: WebSocketChannelOpts) {
    this.opts = opts;
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

    if (!client || client.readyState !== WebSocket.OPEN) {
      logger.warn({ jid, deviceId }, 'Device not connected, message not sent');
      return;
    }

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

    this.sendJson(client, message);
    logger.info({ jid, length: text.length, hasThinking: !!thinking }, 'Message sent to device');
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
}
