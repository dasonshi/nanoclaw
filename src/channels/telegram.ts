import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onOnboardingStart?: (chatJid: string, senderName: string) => void;
  onOnboardingMessage?: (
    chatJid: string,
    text: string,
    senderName: string,
  ) => void;
  onCommand?: (chatJid: string, command: string) => void;
  isInCommandFlow?: (chatJid: string) => boolean;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private pausedNotifyTimestamps = new Map<string, number>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Onboarding: /start command in private chats
    this.bot.command('start', (ctx) => {
      if (ctx.chat.type === 'private') {
        const senderName = ctx.from?.first_name || 'there';
        this.opts.onOnboardingStart?.(`tg:${ctx.chat.id}`, senderName);
      }
    });

    // Multi-location bot commands (private chats only)
    const privateCommands = [
      'locations',
      'connect',
      'reconnect',
      'disconnect',
      'pause',
      'resume',
      'help',
      'apikey',
    ];
    for (const cmd of privateCommands) {
      this.bot.command(cmd, (ctx) => {
        if (ctx.chat.type === 'private') {
          this.opts.onCommand?.(`tg:${ctx.chat.id}`, cmd);
        }
      });
    }

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];

      // Private DM from registered user in a command flow (e.g. mid-/connect)
      // Route to onboarding handler instead of AI
      if (
        group &&
        ctx.chat.type === 'private' &&
        this.opts.isInCommandFlow?.(chatJid)
      ) {
        this.opts.onOnboardingMessage?.(chatJid, content, senderName);
        return;
      }

      if (!group) {
        // Route private DMs from unregistered users to onboarding
        if (ctx.chat.type === 'private') {
          this.opts.onOnboardingMessage?.(chatJid, content, senderName);
        } else {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Telegram chat',
          );
        }
        return;
      }

      // Handle paused/suspended groups
      if (group.status === 'paused' || group.status === 'suspended') {
        const now = Date.now();
        const lastNotify = this.pausedNotifyTimestamps.get(chatJid) || 0;
        // Throttle: max once per hour per chat
        if (now - lastNotify > 3600000) {
          this.pausedNotifyTimestamps.set(chatJid, now);
          const statusMsg =
            group.status === 'suspended'
              ? 'Your account has been suspended. Please contact support.'
              : 'Your account is currently paused. Send "reactivate" to resume, or contact support.';
          sendTelegramMessage(
            this.bot!.api,
            ctx.chat.id.toString(),
            statusMsg,
          ).catch((err) =>
            logger.warn({ chatJid, err }, 'Failed to send paused notification'),
          );
        }
        // Check for reactivation keyword
        if (
          group.status === 'paused' &&
          content.trim().toLowerCase() === 'reactivate'
        ) {
          // Write self_resume IPC task
          this.opts.onOnboardingMessage?.(
            chatJid,
            '__self_resume__',
            senderName,
          );
        }
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Register bot commands for Telegram autocomplete menu
    this.bot.api
      .setMyCommands(
        [
          { command: 'locations', description: 'List & switch GHL locations' },
          { command: 'connect', description: 'Connect a new GHL location' },
          {
            command: 'reconnect',
            description: 'Update PIT token for active location',
          },
          { command: 'disconnect', description: 'Remove active location' },
          { command: 'pause', description: 'Pause AI responses' },
          { command: 'resume', description: 'Resume AI responses' },
          { command: 'help', description: 'Show available commands' },
        ],
        { scope: { type: 'all_private_chats' } },
      )
      .catch((err) => logger.warn({ err }, 'Failed to set bot commands'));

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // Download a Telegram file and save to the group's photos/ directory
    const downloadAndSave = async (
      fileId: string,
      group: RegisteredGroup,
      ext: string,
      msgId: string,
    ): Promise<string | null> => {
      try {
        const file = await this.bot!.api.getFile(fileId);
        if (!file.file_path) return null;

        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const photosDir = path.join(GROUPS_DIR, group.folder, 'photos');
        fs.mkdirSync(photosDir, { recursive: true });

        const filename = `${msgId}.${ext}`;
        const filePath = path.join(photosDir, filename);

        const res = await fetch(url);
        if (!res.ok) return null;
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(filePath, buffer);

        return `/workspace/group/photos/${filename}`;
      } catch (err) {
        logger.warn({ fileId, err }, 'Failed to download Telegram file');
        return null;
      }
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Get highest resolution photo
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const msgId = ctx.message.message_id.toString();

      const savedPath = await downloadAndSave(
        best.file_id,
        group,
        'jpg',
        msgId,
      );
      if (savedPath) {
        storeNonText(ctx, `[Photo saved to ${savedPath}]`);
      } else {
        storeNonText(ctx, '[Photo — download failed]');
      }
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const name = ctx.message.document?.file_name || 'file';

      if (group && ctx.message.document) {
        const ext = name.includes('.') ? name.split('.').pop()! : 'bin';
        const msgId = ctx.message.message_id.toString();
        const savedPath = await downloadAndSave(
          ctx.message.document.file_id,
          group,
          ext,
          msgId,
        );
        if (savedPath) {
          storeNonText(ctx, `[Document: ${name} saved to ${savedPath}]`);
          return;
        }
      }
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
