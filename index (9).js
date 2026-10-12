const fs = require('fs');
const {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;

// ---------- your IDs ----------
const SUSPENSION_ROLE_ID = '1559270452587794572';  // XP suspension role
const FALLBACK_CHANNEL_ID = '1513904263502499870'; // people with closed DMs get tagged here

const DATA_FILE = 'data.json';
const DEFAULTS = {
  windowMinutes: 60,
  checkTime: '03:00',
  timezone: 'UTC',
  lastRun: null,
  active: null,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,     // enable "Server Members Intent" in the Dev Portal
    GatewayIntentBits.GuildVoiceStates, // to see who is in VC
  ],
});

// ---------- storage ----------
let db = {};
if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

function getCfg(guildId) {
  if (!db[guildId]) db[guildId] = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (db[guildId][k] === undefined) db[guildId][k] = v;
  }
  return db[guildId];
}

// find which running check a panel message (DM or channel) belongs to
function findActive(messageId) {
  for (const cfg of Object.values(db)) {
    const a = cfg.active;
    if (a && (Object.values(a.dmMsgs).includes(messageId) || a.fallbackMsgId === messageId)) return a;
  }
  return null;
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIn(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function chunkMentions(ids, limit = 1900) {
  const chunks = [];
  let cur = '';
  for (const id of ids) {
    const m = `<@${id}> `;
    if (cur.length + m.length > limit) { chunks.push(cur); cur = ''; }
    cur += m;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------- panel ----------
function makeEmbed(deadlineMs, closedDms = false) {
  let desc =
    '**Respond or you get an XP suspension.**\n\n' +
    "Hit the button below to confirm you're here.\n" +
    `Deadline: <t:${Math.floor(deadlineMs / 1000)}:R>`;
  if (closedDms) desc += '\n\n*Your DMs are closed so respond here.*';
  return new EmbedBuilder().setTitle('🚨 Presence Check').setDescription(desc).setColor(0xed4245);
}

const panelRow = (disabled = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('presence:imhere')
      .setLabel("I'm here")
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );

// ---------- check logic ----------
const finalizeTimers = new Map();

function scheduleFinalize(gid) {
  const delay = Math.max(0, new Date(db[gid].active.deadline).getTime() - Date.now());
  clearTimeout(finalizeTimers.get(gid));
  finalizeTimers.set(gid, setTimeout(() => finalize(gid).catch(console.error), delay));
}

async function runCheck(guild) {
  const cfg = getCfg(guild.id);
  const fallback = guild.channels.cache.get(FALLBACK_CHANNEL_ID);

  // only people currently sitting in a voice or stage channel
  const members = new Map();
  for (const ch of guild.channels.cache.values()) {
    if (!ch.isVoiceBased()) continue;
    for (const m of ch.members.values()) if (!m.user.bot) members.set(m.id, m);
  }
  if (members.size === 0) return;

  const deadline = Date.now() + cfg.windowMinutes * 60000;

  // register the check first so button clicks work while DMs are still going out
  const active = {
    deadline: new Date(deadline).toISOString(),
    targets: [...members.keys()],
    responded: [],
    dmMsgs: {},
    fallbackMsgId: null,
  };
  cfg.active = active;
  save();

  // 1) try to DM everyone the panel
  const closed = [];
  for (const m of members.values()) {
    try {
      const msg = await m.send({ embeds: [makeEmbed(deadline)], components: [panelRow()] });
      active.dmMsgs[m.id] = msg.id;
    } catch {
      closed.push(m.id);
    }
    await sleep(500); // don't trip Discord's anti-spam
  }

  // 2) anyone with DMs closed gets tagged in the fallback channel with a panel
  if (closed.length && fallback) {
    for (const text of chunkMentions(closed)) {
      await fallback.send({ content: text, allowedMentions: { parse: ['users'] } });
    }
    const fmsg = await fallback.send({
      embeds: [makeEmbed(deadline, true)],
      components: [panelRow()],
    });
    active.fallbackMsgId = fmsg.id;
  }

  save();
  scheduleFinalize(guild.id);
}

async function finalize(gid) {
  const cfg = db[gid];
  if (!cfg || !cfg.active) return;
  const active = cfg.active;
  const guild = client.guilds.cache.get(gid);
  if (!guild) return;

  const role = guild.roles.cache.get(SUSPENSION_ROLE_ID);
  const suspended = [];
  const failed = [];
  for (const uid of active.targets) {
    if (active.responded.includes(uid)) continue;
    const member = await guild.members.fetch(uid).catch(() => null);
    if (!member || !role) continue;
    try {
      await member.roles.add(role, 'Failed presence check');
      suspended.push(member);
    } catch {
      failed.push(member);
    }
  }

  // close all the panels
  const ended = new EmbedBuilder()
    .setTitle('🚨 Presence Check')
    .setDescription('This check has ended.')
    .setColor(0x4f545c);
  const endedPayload = { embeds: [ended], components: [panelRow(true)] };

  for (const [uid, mid] of Object.entries(active.dmMsgs)) {
    try {
      const user = await client.users.fetch(uid);
      const dm = await user.createDM();
      await dm.messages.edit(mid, endedPayload);
    } catch { /* ignore */ }
  }

  const channel = guild.channels.cache.get(FALLBACK_CHANNEL_ID);
  if (channel) {
    if (active.fallbackMsgId) {
      await channel.messages.edit(active.fallbackMsgId, endedPayload).catch(() => {});
    }
    const lines = [
      `✅ Check finished. **${active.responded.length}** responded, ` +
        `**${suspended.length}** got ${role ? `<@&${role.id}>` : 'the suspension role'}.`,
    ];
    if (suspended.length) lines.push('Suspended: ' + suspended.map((m) => `<@${m.id}>`).join(', ').slice(0, 1500));
    if (failed.length) {
      lines.push(`⚠️ Couldn't give the role to ${failed.length} member(s). Move my role above the suspension role.`);
    }
    await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  }

  cfg.active = null;
  save();
  finalizeTimers.delete(gid);
}

function startScheduler() {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      if (!guild.roles.cache.has(SUSPENSION_ROLE_ID)) continue; // only the server with the suspension role
      const cfg = getCfg(guild.id);
      if (cfg.active) continue;
      const { date, time } = nowIn(cfg.timezone);
      if (time === cfg.checkTime && cfg.lastRun !== date) {
        cfg.lastRun = date;
        save();
        runCheck(guild).catch(console.error);
      }
    }
  }, 30000);
}

// ---------- slash commands ----------
const adminOnly = (b) =>
  b.setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setContexts(InteractionContextType.Guild);

const commands = [
  adminOnly(new SlashCommandBuilder().setName('setup').setDescription('Change when the presence check runs'))
    .addStringOption((o) => o.setName('check_time').setDescription('24h time the check runs, e.g. 03:00'))
    .addStringOption((o) => o.setName('tz').setDescription('Timezone, e.g. America/New_York, Europe/London, UTC'))
    .addIntegerOption((o) =>
      o.setName('window_minutes').setDescription('How long people have to respond').setMinValue(1).setMaxValue(720)),
  adminOnly(new SlashCommandBuilder().setName('checknow').setDescription('Run a presence check right now (for testing)')),
  adminOnly(new SlashCommandBuilder().setName('unsuspend').setDescription('Remove the XP suspension role from a member'))
    .addUserOption((o) => o.setName('member').setDescription('Who to unsuspend').setRequired(true)),
].map((c) => c.toJSON());

const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ----- the "I'm here" button -----
    if (interaction.isButton() && interaction.customId === 'presence:imhere') {
      const active = findActive(interaction.message.id);
      if (!active) return reply(interaction, 'This check is over.');
      if (Date.now() > new Date(active.deadline).getTime()) return reply(interaction, 'Too late, the check is over.');

      const uid = interaction.user.id;
      if (!active.targets.includes(uid)) return reply(interaction, "You weren't part of this check.");
      if (active.responded.includes(uid)) return reply(interaction, 'You already checked in ✅');

      active.responded.push(uid);
      save();
      return reply(interaction, "You're marked present ✅ no suspension for you.");
    }

    if (!interaction.isChatInputCommand()) return;

    // ----- /setup -----
    if (interaction.commandName === 'setup') {
      const time = interaction.options.getString('check_time');
      const tz = interaction.options.getString('tz');
      const win = interaction.options.getInteger('window_minutes');
      const cfg = getCfg(interaction.guildId);

      if (time) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return reply(interaction, 'Time must look like `03:00`.');
        cfg.checkTime = time;
      }
      if (tz) {
        try { new Intl.DateTimeFormat('en', { timeZone: tz }); }
        catch { return reply(interaction, 'Unknown timezone. Try something like `Europe/London`.'); }
        cfg.timezone = tz;
      }
      if (win) cfg.windowMinutes = win;
      save();
      return reply(interaction, `Done. Check runs daily at **${cfg.checkTime} ${cfg.timezone}**, ${cfg.windowMinutes} min to respond.`);
    }

    // ----- /checknow -----
    if (interaction.commandName === 'checknow') {
      const cfg = getCfg(interaction.guildId);
      if (cfg.active) return reply(interaction, 'A check is already running.');
      await reply(interaction, 'Starting check…');
      return runCheck(interaction.guild);
    }

    // ----- /unsuspend -----
    if (interaction.commandName === 'unsuspend') {
      const role = interaction.guild.roles.cache.get(SUSPENSION_ROLE_ID);
      if (!role) return reply(interaction, 'Suspension role not found.');
      const member = await interaction.guild.members.fetch(interaction.options.getUser('member').id);
      await member.roles.remove(role, `Unsuspended by ${interaction.user.tag}`);
      return reply(interaction, `Removed <@&${role.id}> from <@${member.id}>.`);
    }
  } catch (err) {
    console.error(err);
  }
});

// ---------- startup ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await client.application.commands.set(commands);

  // resume checks that were running when the bot restarted
  for (const [gid, cfg] of Object.entries(db)) {
    if (cfg.active) scheduleFinalize(gid);
  }
  startScheduler();
});

process.on('unhandledRejection', console.error);
client.login(TOKEN);
