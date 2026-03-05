import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  NewMessage,
} from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../config.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client;
  private opts: FeishuChannelOpts;
  private connected = false;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.opts = opts;

    // Initialize API client
    this.client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      disableTokenCache: false,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      // Create event dispatcher and register message handler
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          await this.handleMessage(data);
        },
      });

      // Get appId and appSecret from client
      const appId = (this.client as any).appId;
      const appSecret = (this.client as any).appSecret;

      // Create WebSocket client
      const wsClient = new (lark.WSClient as any)({
        appId,
        appSecret,
        appType: lark.AppType.SelfBuild,
      });

      // Start with event dispatcher
      await (wsClient as any).start({ eventDispatcher });
      this.connected = true;
      logger.info('Feishu channel connected via WebSocket');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Feishu channel');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Feishu channel not connected');

    const [prefix, receiveId] = jid.split(':');
    if (prefix !== 'feishu' || !receiveId) {
      throw new Error(`Invalid Feishu JID: ${jid}`);
    }

    try {
      // Extract thinking content
      let content = text;
      const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
      if (thinkingMatch) {
        content = text.replace(thinkingMatch[0], '').trim();
      }

      await this.client.im.message.create({
        params: {
          receive_id_type: 'open_id',
        },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
        },
      });

      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send Feishu message');
      throw err;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    logger.debug({ jid, isTyping }, 'Feishu typing indicator not implemented');
  }

  async sendFile(jid: string, fileName: string, filePath: string, mimeType: string): Promise<void> {
    logger.warn({ jid, fileName }, 'Feishu file sending not implemented');
  }

  private async handleMessage(data: any): Promise<void> {
    console.log('[Feishu] Received message:', JSON.stringify(data, null, 2));
    try {
      const message = data.message;
      if (!message) return;

      // Only handle text messages for now
      if (message.message_type !== 'text' && message.message_type !== 'file') {
        logger.debug({ messageType: message.message_type }, 'Unsupported message type');
        return;
      }

      const senderId = data.sender?.sender_id?.open_id;
      const chatId = message.chat_id;

      if (!senderId) {
        logger.warn({ data }, 'Missing sender ID in Feishu message');
        return;
      }

      // Determine if it's a group chat
      const isGroup = message.chat_type === 'group';

      // Construct JID
      const chatJid = `feishu:${isGroup ? chatId : senderId}`;

      const timestamp = new Date(parseInt(message.create_time)).toISOString();

      // Notify chat metadata
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        isGroup ? 'Feishu Group' : 'Feishu User',
        'feishu',
        isGroup,
      );

      let content = '';
      const attachments: { filename: string; path: string; mimeType: string; size: number }[] = [];

      if (message.message_type === 'text') {
        const messageContent = JSON.parse(message.content);
        content = messageContent.text || '';

        // Check for @ mentions and remove them
        content = content.replace(/<at id="all"><\/at>/g, '').trim();
      } else if (message.message_type === 'file') {
        const messageContent = JSON.parse(message.content);
        if (messageContent.file) {
          const fileKey = messageContent.file.file_key;
          content = `[发送了文件: ${fileKey}]`;
        }
      }

      // Skip empty messages
      if (!content && attachments.length === 0) {
        return;
      }

      const newMessage: NewMessage = {
        id: message.message_id,
        chat_jid: chatJid,
        sender: `feishu:${senderId}`,
        sender_name: 'Feishu User',
        content,
        timestamp,
        is_from_me: false,
      };

      if (attachments.length > 0) {
        newMessage.attachments = attachments;
      }

      this.opts.onMessage(chatJid, newMessage);

      logger.info({
        chatJid,
        messageType: message.message_type,
        contentPreview: content.slice(0, 50),
      }, 'Feishu message received');
    } catch (err) {
      logger.error({ err }, 'Error handling Feishu message');
    }
  }
}
