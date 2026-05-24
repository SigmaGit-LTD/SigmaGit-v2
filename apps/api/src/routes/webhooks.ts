import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { EmbedBuilder, WebhookClient } from "discord.js";
import { config } from "../config";
import { authMiddleware, requireAdmin, type AuthVariables } from "../middleware/auth";

const app = new Hono<{ Variables: AuthVariables }>();

const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

let webhookClient: WebhookClient | null = null;

if (!discordWebhookUrl) {
  console.warn("[Webhooks] DISCORD_WEBHOOK_URL not configured, Discord notifications disabled");
} else {
  try {
    webhookClient = new WebhookClient({ url: discordWebhookUrl });
  } catch {
    console.warn(
      `[Webhooks] DISCORD_WEBHOOK_URL is not a valid Discord webhook URL ("${discordWebhookUrl}"), Discord notifications disabled`
    );
  }
}

interface DiscordWebhookData {
  type: string;
  repository?: {
    owner: string;
    name: string;
  };
  data: any;
}

function createIssueEmbed(data: any, repo: any): any {
  const embed = new EmbedBuilder()
    .setTitle(`${getEmojiForAction(data.action)} Issue #${data.number}`)
    .setDescription(data.title)
    .setURL(`${getWebUrl()}/${repo.ownerUsername}/${repo.name}/issues/${data.number}`)
    .addFields(
      { name: 'State', value: data.state, inline: true },
      { name: 'Author', value: data.author?.username || 'Unknown', inline: true },
    )
    .setColor(getColorForState(data.state))
    .setTimestamp(new Date(data.createdAt));

  if (data.labels && data.labels.length > 0) {
    embed.addFields({
      name: 'Labels',
      value: data.labels.map((l: any) => l.name).join(', '),
      inline: false,
    });
  }

  if (data.body) {
    embed.setDescription(data.body.substring(0, 400) + (data.body.length > 400 ? '...' : ''));
  }

  return embed.toJSON();
}

function createPREmbed(data: any, repo: any): any {
  const embed = new EmbedBuilder()
    .setTitle(`${getEmojiForAction(data.action)} PR #${data.number}`)
    .setDescription(data.title)
    .setURL(`${getWebUrl()}/${repo.ownerUsername}/${repo.name}/pulls/${data.number}`)
    .addFields(
      { name: 'State', value: data.state, inline: true },
      { name: 'Author', value: data.author?.username || 'Unknown', inline: true },
    )
    .setColor(getColorForState(data.state))
    .setTimestamp(new Date(data.createdAt));

  if (data.baseBranch && data.headBranch) {
    embed.addFields({
      name: 'Branches',
      value: `${data.baseBranch} ← ${data.headBranch}`,
      inline: false,
    });
  }

  if (data.body) {
    embed.setDescription(data.body.substring(0, 400) + (data.body.length > 400 ? '...' : ''));
  }

  return embed.toJSON();
}

function createPushEmbed(data: any, repo: any): any {
  const embed = new EmbedBuilder()
    .setTitle('📥 New Push')
    .setDescription(`${data.pusher} pushed ${data.commits?.length || 0} commit(s)`)
    .setURL(`${getWebUrl()}/${repo.ownerUsername}/${repo.name}`)
    .setColor('Blurple')
    .setTimestamp(new Date());

  if (data.commits && data.commits.length > 0) {
    const commitMessages = data.commits.slice(0, 5).map((commit: any) => 
      `• \`${commit.oid.substring(0, 7)}\` ${commit.message.split('\n')[0]}`
    ).join('\n');

    if (commitMessages) {
      embed.addFields({
        name: 'Recent Commits',
        value: commitMessages,
        inline: false,
      });
    }

    if (data.commits.length > 5) {
      embed.addFields({
        name: 'More',
        value: `... and ${data.commits.length - 5} more`,
        inline: true,
      });
    }
  }

  return embed.toJSON();
}

function createStarEmbed(data: any, repo: any): any {
  const embed = new EmbedBuilder()
    .setTitle(`${data.action === 'added' ? '⭐' : '💔'} Repository ${data.action === 'added' ? 'starred' : 'unstarred'}`)
    .setDescription(repo.name)
    .setURL(`${getWebUrl()}/${repo.ownerUsername}/${repo.name}`)
    .setColor(data.action === 'added' ? 'Yellow' : 'Grey')
    .setTimestamp(new Date());

  return embed.toJSON();
}

function createForkEmbed(data: any, repo: any): any {
  const embed = new EmbedBuilder()
    .setTitle('🔀 Repository Forked')
    .setDescription(`${data.username} forked ${repo.name}`)
    .setURL(`${getWebUrl()}/${data.username}/${repo.name}`)
    .setColor('Green')
    .setTimestamp(new Date());

  return embed.toJSON();
}

function getEmojiForAction(action: string): string {
  const emojiMap: Record<string, string> = {
    opened: '🎉',
    closed: '✅',
    reopened: '🔄',
    edited: '✏️',
    deleted: '🗑️',
    merged: '🎊',
    added: '➕',
    removed: '➖',
  };
  return emojiMap[action] || '📌';
}

function getColorForState(state: string): number {
  const colorMap: Record<string, number> = {
    open: 0x00ff00,
    closed: 0xff0000,
    merged: 0x00ffff,
  };
  return colorMap[state] || 0x0099ff;
}

function getWebUrl(): string {
  return process.env.WEB_URL || 'http://localhost:3000';
}

async function sendToDiscord(webhookData: DiscordWebhookData) {
  if (!webhookClient) {
    console.log('[Webhooks] Discord webhook not configured, skipping notification');
    return;
  }

  try {
    let embed: any = null;

    switch (webhookData.type) {
      case 'issue':
        embed = createIssueEmbed(webhookData.data, webhookData.repository);
        break;
      case 'pull_request':
        embed = createPREmbed(webhookData.data, webhookData.repository);
        break;
      case 'push':
        embed = createPushEmbed(webhookData.data, webhookData.repository);
        break;
      case 'star':
        embed = createStarEmbed(webhookData.data, webhookData.repository);
        break;
      case 'fork':
        embed = createForkEmbed(webhookData.data, webhookData.repository);
        break;
      default:
        console.log(`[Webhooks] Unknown event type: ${webhookData.type}`);
        return;
    }

    if (embed) {
      await webhookClient.send({ embeds: [embed] });
      console.log(`[Webhooks] Sent ${webhookData.type} notification to Discord`);
    }
  } catch (error) {
    console.error('[Webhooks] Failed to send to Discord:', error);
  }
}

function verifyWebhookSecret(provided: string | undefined): boolean {
  const secret = config.discordWebhookSecret;
  if (!secret) {
    return !config.isProduction;
  }
  if (!provided) return false;
  const secretBuf = Buffer.from(secret, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (secretBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(secretBuf, providedBuf);
}

app.post('/api/webhooks/discord', async (c) => {
  if (!webhookClient) {
    return c.json({ error: 'Discord webhook not configured' }, 501);
  }

  const secret = config.discordWebhookSecret;
  if (!secret && config.isProduction) {
    return c.json({ error: 'Webhook secret not configured' }, 503);
  }
  if (secret) {
    const provided =
      c.req.header("X-Webhook-Secret") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!verifyWebhookSecret(provided)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  try {
    const body = await c.req.json() as DiscordWebhookData;

    if (!body.type || !body.data) {
      return c.json({ error: 'Invalid webhook payload' }, 400);
    }

    await sendToDiscord(body);
    return c.json({ success: true });
  } catch (error) {
    console.error('[Webhooks] Error processing webhook:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/webhooks/discord/test', authMiddleware, requireAdmin, async (c) => {
  if (!webhookClient) {
    return c.json({ error: 'Discord webhook not configured' }, 501);
  }

  try {
    const testData: DiscordWebhookData = {
      type: 'test',
      repository: {
        owner: 'sigmagit',
        name: 'test-repo',
      },
      data: {
        title: 'Test Notification',
        body: 'This is a test webhook notification from Sigmagit to Discord.',
        state: 'open',
        number: 1,
        createdAt: new Date().toISOString(),
        author: { username: 'testuser', name: 'Test User' },
      },
    };

    await sendToDiscord(testData);
    return c.json({ success: true, message: 'Test webhook sent' });
  } catch (error) {
    console.error('[Webhooks] Error sending test webhook:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;
