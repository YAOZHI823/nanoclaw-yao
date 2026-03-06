import * as lark from '@larksuiteoapi/node-sdk';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
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
import { resolveGroupFolderPath } from '../group-folder.js';

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

  // Store temporary processing message IDs for each chat
  private processingMessages = new Map<string, string>();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;

    const [prefix, receiveId] = jid.split(':');
    if (prefix !== 'feishu' || !receiveId) {
      return;
    }

    const isGroup = receiveId.startsWith('oc_');
    const receiveIdType = isGroup ? 'chat_id' : 'open_id';

    try {
      if (isTyping) {
        // Send a temporary "thinking" message
        const response = await this.client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: receiveId,
            msg_type: 'text',
            content: JSON.stringify({ text: '🤖 AI 正在思考中...' }),
          },
        });

        // Store the message ID so we can update it later
        const messageId = response.data?.message_id;
        if (messageId) {
          this.processingMessages.set(jid, messageId);
          logger.debug({ jid, messageId }, 'Sent processing indicator, stored for update');
        }
      }
    } catch (err) {
      logger.debug({ jid, isTyping, err }, 'Failed to set typing indicator');
    }
  }

  // Update the processing message with actual response content
  async updateProcessingMessage(jid: string, newContent: string): Promise<void> {
    logger.debug({ jid, connected: this.connected, processingMessages: Array.from(this.processingMessages.keys()) }, 'updateProcessingMessage called');

    if (!this.connected) {
      logger.debug({ jid }, 'Not connected, skipping update');
      return;
    }

    const messageId = this.processingMessages.get(jid);
    if (!messageId) {
      logger.debug({ jid, processingMessages: Array.from(this.processingMessages.keys()) }, 'No processing message to update');
      return;
    }

    logger.debug({ jid, messageId, newContent: newContent.slice(0, 50) }, 'Updating processing message');
    try {
      // Get tenant token
      const appId = (this.client as any).appId;
      const appSecret = (this.client as any).appSecret;
      const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const tokenData = await tokenResponse.json() as { tenant_access_token?: string };
      const tenantToken = tokenData.tenant_access_token;

      if (tenantToken) {
        // Use SDK with tenant token to update message (PUT method)
        await this.client.im.v1.message.update(
          {
            path: { message_id: messageId },
            data: {
              msg_type: 'text',
              content: JSON.stringify({ text: newContent }),
            },
          },
          lark.withTenantToken(tenantToken),
        );
        logger.debug({ jid, messageId }, 'Updated processing message successfully');
      }
      this.processingMessages.delete(jid);
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to update processing message');
    }
  }

  // Helper to get file type from mime type or extension
  private getFileType(fileName: string, mimeType: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const mimeToType: Record<string, string> = {
      'pdf': 'pdf',
      'doc': 'doc',
      'docx': 'docx',
      'xls': 'xls',
      'xlsx': 'xlsx',
      'ppt': 'ppt',
      'pptx': 'pptx',
      'mp4': 'mp4',
      'mp3': 'mp3',
      'wav': 'wav',
      'png': 'png',
      'jpg': 'jpg',
      'jpeg': 'jpeg',
      'gif': 'gif',
    };
    return mimeToType[ext] || 'stream';
  }

  async sendFile(jid: string, fileName: string, filePath: string, mimeType: string): Promise<void> {
    if (!this.connected) throw new Error('Feishu channel not connected');

    const [prefix, receiveId] = jid.split(':');
    if (prefix !== 'feishu' || !receiveId) {
      throw new Error(`Invalid Feishu JID: ${jid}`);
    }

    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

    try {
      // Read file from disk
      let fileBuffer: Buffer;
      try {
        fileBuffer = fs.readFileSync(filePath);
      } catch (err) {
        logger.error({ err, filePath }, 'Failed to read file');
        throw new Error(`Failed to read file: ${filePath}`);
      }

      // Check file size
      const fileSize = fileBuffer.length;
      if (fileSize > MAX_FILE_SIZE) {
        logger.error({ fileSize, maxSize: MAX_FILE_SIZE }, 'File too large for Feishu');
        throw new Error(`File too large: ${fileSize} bytes (max: ${MAX_FILE_SIZE} bytes)`);
      }

      // Determine file type
      const fileType = this.getFileType(fileName, mimeType);

      logger.info({ jid, fileName, filePath, fileSize, fileType }, 'Uploading file to Feishu');

      // Get tenant token
      const appId = (this.client as any).appId;
      const appSecret = (this.client as any).appSecret;

      const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const tokenData = await tokenResponse.json() as { tenant_access_token?: string };
      const tenantToken = tokenData.tenant_access_token;
      if (!tenantToken) {
        throw new Error('Failed to get tenant access token');
      }

      // Upload file using im/v1/files API with FormData
      const formData = new FormData();
      formData.append('file_type', fileType);
      formData.append('file_name', fileName);
      formData.append('file', new Blob([fileBuffer]), fileName);

      const uploadResponse = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tenantToken}` },
        body: formData,
      });
      const uploadData = await uploadResponse.json() as { data?: { file_key?: string } };

      if (!uploadData.data?.file_key) {
        logger.error({ response: uploadData }, 'Failed to upload file');
        throw new Error('Failed to upload file: no file_key returned');
      }

      const fileKey = uploadData.data.file_key;
      logger.info({ fileKey }, 'File uploaded successfully, sending message');

      // Send file message using im.message.create
      await this.client.im.message.create({
        params: {
          receive_id_type: 'open_id',
        },
        data: {
          receive_id: receiveId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      logger.info({ jid, fileName, fileKey }, 'Feishu file sent successfully');
    } catch (err) {
      logger.error({ err, jid, fileName, filePath }, 'Failed to send Feishu file');
      throw err;
    }
  }

  async sendImage(jid: string, imagePath: string): Promise<void> {
    if (!this.connected) throw new Error('Feishu channel not connected');

    const [prefix, receiveId] = jid.split(':');
    if (prefix !== 'feishu' || !receiveId) {
      throw new Error(`Invalid Feishu JID: ${jid}`);
    }

    // Check if file exists
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }

    // Get file stats for size validation
    const stats = fs.statSync(imagePath);
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (stats.size > maxSize) {
      throw new Error(`Image file too large: ${stats.size} bytes (max: ${maxSize} bytes)`);
    }

    // Determine image type from extension
    const ext = path.extname(imagePath).toLowerCase().slice(1);
    const supportedFormats = ['jpeg', 'jpg', 'png', 'gif', 'webp', 'tiff', 'bmp', 'ico'];
    if (!supportedFormats.includes(ext)) {
      throw new Error(`Unsupported image format: ${ext}. Supported: ${supportedFormats.join(', ')}`);
    }

    try {
      // Read image file
      const imageBuffer = fs.readFileSync(imagePath);

      // Upload image using im.image.create API
      const imageResult = await (this.client as any).im.image.create({
        data: {
          image_type: 'message',
          image: imageBuffer,
        },
      });

      // The SDK returns the response directly, not wrapped in .data
      const imageKey = imageResult?.image_key;
      if (!imageKey) {
        throw new Error('Failed to upload image: no image_key returned');
      }

      // Send image message using im.message.create API
      await this.client.im.message.create({
        params: {
          receive_id_type: 'open_id',
        },
        data: {
          receive_id: receiveId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      logger.info({ jid, imagePath, imageKey, size: stats.size }, 'Feishu image sent');
    } catch (err) {
      logger.error({ err, jid, imagePath }, 'Failed to send Feishu image');
      throw err;
    }
  }

  private async handleMessage(data: any): Promise<void> {
    console.log('[Feishu] Received message:', JSON.stringify(data, null, 2));
    try {
      const message = data.message;
      if (!message) return;

      // Only handle text, file and image messages
      if (message.message_type !== 'text' && message.message_type !== 'file' && message.message_type !== 'image') {
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

      // Resolve group folder path for file storage (container can access this)
      const folder = chatJid.replace(':', '-');
      const groupDir = resolveGroupFolderPath(folder);

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
      } else if (message.message_type === 'image') {
        const messageContent = JSON.parse(message.content);
        if (messageContent.image_key) {
          // Download the image using messageResource API
          try {
            const imageInfo = await this.downloadImage(groupDir, message.message_id, messageContent.image_key);
            content = '[发送了图片]';
            attachments.push(imageInfo);
          } catch (err) {
            logger.error({ err, imageKey: messageContent.image_key }, 'Failed to download Feishu image');
            content = '[发送了图片，但下载失败]';
          }
        }
      } else if (message.message_type === 'file') {
        const messageContent = JSON.parse(message.content);
        if (messageContent.file_key) {
          const fileKey = messageContent.file_key;
          // Download the file using messageResource API
          try {
            const fileInfo = await this.downloadFile(groupDir, message.message_id, fileKey);
            content = '[发送了文件]';
            attachments.push(fileInfo);
          } catch (err) {
            logger.error({ err, fileKey }, 'Failed to download Feishu file');
            content = '[发送了文件，但下载失败]';
          }
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

  private async downloadImage(groupDir: string, messageId: string, imageKey: string): Promise<{
    filename: string;
    path: string;
    mimeType: string;
    size: number;
  }> {
    // Get image from Feishu API using messageResource.get
    // This is needed for user-sent images (not bot-uploaded images)
    const imageResponse = await (this.client as any).im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: imageKey,
      },
      params: {
        type: 'image',
      },
    });

    // Determine file extension - default to jpg for images
    const extension = 'jpg';
    const fileName = `${imageKey}.${extension}`;
    const uploadDir = path.join(groupDir, 'uploads');
    const filePath = path.join(uploadDir, fileName);

    // Ensure directory exists
    const fs = await import('fs');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Write the image using SDK's writeFile method
    await imageResponse.writeFile(filePath);

    const stats = fs.statSync(filePath);
    const mimeType = 'image/jpeg';

    logger.info({ imageKey, fileName, size: stats.size }, 'Feishu image downloaded');

    return {
      filename: fileName,
      path: filePath,
      mimeType,
      size: stats.size,
    };
  }

  private async downloadFile(groupDir: string, messageId: string, fileKey: string): Promise<{
    filename: string;
    path: string;
    mimeType: string;
    size: number;
  }> {
    // Get file from Feishu API using messageResource.get
    const fileResponse = await (this.client as any).im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: { type: 'file' },
    });

    // Try to get filename from response headers
    let fileName = fileKey;
    let mimeType = 'application/octet-stream';

    const contentDisposition = fileResponse?.headers?.['content-disposition'];
    if (contentDisposition) {
      // Parse filename from content-disposition header
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=(?:(\\?['"])(.*?)\1|([^;\n]*))/i);
      if (filenameMatch && filenameMatch[2]) {
        fileName = filenameMatch[2];
      }
    }

    // Determine file extension
    let extension = '';
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot > 0) {
      extension = fileName.substring(lastDot + 1).toLowerCase();
    }

    // Map common extensions to MIME types
    const mimeTypeMap: Record<string, string> = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      zip: 'application/zip',
      rar: 'application/x-rar-compressed',
    };

    if (extension && mimeTypeMap[extension]) {
      mimeType = mimeTypeMap[extension];
    }

    // Generate unique filename to avoid conflicts
    const timestamp = Date.now();
    const finalFileName = extension ? `${fileKey}_${timestamp}.${extension}` : `${fileKey}_${timestamp}`;
    const uploadDir = path.join(groupDir, 'uploads');
    const filePath = path.join(uploadDir, finalFileName);

    // Ensure directory exists
    const fs = await import('fs');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Write the file using SDK's writeFile method
    await fileResponse.writeFile(filePath);

    const stats = fs.statSync(filePath);

    logger.info({ fileKey, fileName: finalFileName, originalName: fileName, size: stats.size }, 'Feishu file downloaded');

    return {
      filename: finalFileName,
      path: filePath,
      mimeType,
      size: stats.size,
    };
  }
}
