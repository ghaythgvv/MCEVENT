// ============ Voice Restriction Bot (single file) ============
try { require('dotenv').config(); } catch {}

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, MessageFlags,
  SlashCommandBuilder, PermissionFlagsBits,
} = require('discord.js');

// ---------- CONFIG ----------
const TOKEN = (process.env.TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || '').trim();
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '1551005021955559434';
const COLOR = 0x9b59b6; // purple

if (!TOKEN) {
  console.error('❌ Missing TOKEN. Add a variable named exactly TOKEN in your host Variables tab.');
  process.exit(1);
}

// ---------- DATABASE (JSON file) ----------
const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'restrictions.json');
let cache = [];
try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = []; }
const save = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
};
const same = (r, g, a, b) =>
  r.guildId === g && ((r.userA === a && r.userB === b) || (r.userA === b && r.userB === a));
const db = {
  find: (g, a, b) => cache.find((r) => same(r, g, a, b)) || null,
  add({ guildId, userA, userB, reason, moderatorId }) {
    if (db.find(guildId, userA, userB)) return null;
    const e = {
      id: Date.now().toString(36).toUpperCase(), guildId, userA, userB,
      reason: reason || 'No reason provided', moderatorId, createdAt: Date.now(),
    };
    cache.push(e); save(); return e;
  },
  remove(g, a, b) {
    const e = db.find(g, a, b);
    if (!e) return null;
    cache = cache.filter((r) => r !== e); save(); return e;
  },
  forGuild: (g) => cache.filter((r) => r.guildId === g),
  forUser: (g, u) => cache.filter((r) => r.guildId === g && (r.userA === u || r.userB === u)),
};

// ---------- EMBEDS ----------
const base = () => new EmbedBuilder().setColor(COLOR).setTimestamp();
const mention = (id) => `<@${id}> (\`${id}\`)`;
const unix = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;
const simple = (t, d) => base().setTitle(t).setDescription(d);

const dmBlocked = ({ guildName, channelName, others }) =>
  base()
    .setTitle('🚫 Voice Restriction')
    .setDescription(
      `You can't join **${channelName}** because **${others.join(', ')}** is in there.\n\n` +
      `You have a **restriction** with them, so you can't be in the same voice channel.`
    )
    .addFields(
      { name: '🏠 Server', value: guildName, inline: true },
      { name: '💡 What now?', value: 'Join another voice channel or wait until they leave.', inline: true }
    )
    .setFooter({ text: 'Voice Restriction System' });

const logCreated = (e, modId) =>
  base()
    .setTitle('🔒 Restriction Created')
    .setDescription('These two members can no longer be in the same voice channel.')
    .addFields(
      { name: '👤 Member 1', value: mention(e.userA), inline: true },
      { name: '👤 Member 2', value: mention(e.userB), inline: true },
      { name: '🛡️ Set by', value: mention(modId), inline: true },
      { name: '📝 Reason', value: e.reason },
      { name: '🆔 Restriction ID', value: `\`${e.id}\``, inline: true },
      { name: '🗑️ How to remove it', value: `\`/restriction remove user1:${e.userA} user2:${e.userB}\`` }
    );

const logRemoved = (e, modId) =>
  base()
    .setTitle('🔓 Restriction Removed')
    .addFields(
      { name: '👤 Member 1', value: mention(e.userA), inline: true },
      { name: '👤 Member 2', value: mention(e.userB), inline: true },
      { name: '🛡️ Removed by', value: mention(modId), inline: true },
      { name: '🆔 Restriction ID', value: `\`${e.id}\``, inline: true },
      { name: '📅 Originally created', value: unix(e.createdAt), inline: true }
    );

const logBlocked = ({ memberId, channel, conflicts, disconnected, dmSent, error }) =>
  base()
    .setTitle('🚨 Restricted Join Blocked')
    .setDescription(`<@${memberId}> tried to join ${channel} while a restricted member was inside.`)
    .addFields(
      { name: '👤 Member who joined', value: mention(memberId), inline: true },
      { name: '🔊 Voice channel', value: `${channel}\n\`${channel.id}\``, inline: true },
      { name: '⚔️ Restricted with', value: conflicts.map((c) => mention(c.otherId)).join('\n'), inline: true },
      {
        name: '⚙️ Action',
        value: disconnected ? '✅ Disconnected from voice' : `❌ Could not disconnect${error ? `: \`${error}\`` : ''}`,
        inline: true,
      },
      { name: '📩 DM', value: dmSent ? '✅ Delivered' : '❌ Failed (DMs closed)', inline: true },
      { name: '📝 Restriction reason', value: conflicts.map((c) => `\`${c.entry.id}\`: ${c.entry.reason}`).join('\n').slice(0, 1000) },
      {
        name: '🗑️ How to remove',
        value: conflicts.map((c) => `\`/restriction remove user1:${c.entry.userA} user2:${c.entry.userB}\``).join('\n').slice(0, 1000),
      }
    );

const listEmbed = (entries, guildName) => {
  const shown = entries.slice(0, 20);
  const lines = shown.map(
    (e, i) => `**${i + 1}.** <@${e.userA}> ↔ <@${e.userB}>\n┗ \`${e.id}\` • ${e.reason.slice(0, 80)} • by <@${e.moderatorId}>`
  );
  if (entries.length > shown.length) lines.push(`…and **${entries.length - shown.length}** more`);
  return base()
    .setTitle(`🔒 Active Restrictions (${entries.length})`)
    .setDescription(lines.join('\n\n') || 'No active restrictions.')
    .setFooter({ text: guildName });
};

// ---------- CLIENT ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

async function sendLog(payload) {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    if (ch && ch.isTextBased()) await ch.send(payload);
  } catch (err) {
    console.error('[LOG] Could not send to log channel:', err.message);
  }
}

// ---------- ENFORCEMENT ----------
async function enforce(member, channel, restrictions) {
  const conflicts = restrictions
    .map((entry) => ({ entry, otherId: entry.userA === member.id ? entry.userB : entry.userA }))
    .filter((c) => channel.members.has(c.otherId));
  if (!conflicts.length) return false;

  let disconnected = false, dmSent = false, error = null;
  try { await member.voice.disconnect('Voice restriction'); disconnected = true; }
  catch (err) { error = err.message; }

  const others = conflicts.map((c) => channel.members.get(c.otherId).displayName);
  try {
    await member.send({ embeds: [dmBlocked({ guildName: member.guild.name, channelName: channel.name, others })] });
    dmSent = true;
  } catch { dmSent = false; }

  await sendLog({ embeds: [logBlocked({ memberId: member.id, channel, conflicts, disconnected, dmSent, error })] });
  return true;
}

// ---------- SLASH COMMAND ----------
const commandData = new SlashCommandBuilder()
  .setName('restriction')
  .setDescription('Manage voice restrictions between two members')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('add').setDescription('Stop two members from being in the same voice channel')
    .addUserOption((o) => o.setName('user1').setDescription('First member').setRequired(true))
    .addUserOption((o) => o.setName('user2').setDescription('Second member').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why are they restricted?').setMaxLength(200)))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a restriction between two members')
    .addUserOption((o) => o.setName('user1').setDescription('First member').setRequired(true))
    .addUserOption((o) => o.setName('user2').setDescription('Second member').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('Show all active restrictions'))
  .addSubcommand((s) => s.setName('check').setDescription('Show all restrictions of one member')
    .addUserOption((o) => o.setName('user').setDescription('Member to check').setRequired(true)));

const eph = MessageFlags.Ephemeral;

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  if (sub === 'add') {
    const u1 = interaction.options.getUser('user1');
    const u2 = interaction.options.getUser('user2');
    const reason = interaction.options.getString('reason');
    if (u1.id === u2.id)
      return interaction.reply({ embeds: [simple('❌ Invalid', "You can't restrict someone from themselves.")], flags: eph });
    if (u1.bot || u2.bot)
      return interaction.reply({ embeds: [simple('❌ Invalid', "You can't restrict bots.")], flags: eph });

    const entry = db.add({ guildId: guild.id, userA: u1.id, userB: u2.id, reason, moderatorId: interaction.user.id });
    if (!entry)
      return interaction.reply({ embeds: [simple('⚠️ Already restricted', `${u1} and ${u2} already have a restriction.`)], flags: eph });

    await interaction.reply({
      embeds: [simple('🔒 Restriction created', `${u1} ↔ ${u2}\n**Reason:** ${entry.reason}\n**ID:** \`${entry.id}\``)],
      flags: eph,
    });
    await sendLog({ embeds: [logCreated(entry, interaction.user.id)] });

    const m1 = await guild.members.fetch(u1.id).catch(() => null);
    const m2 = await guild.members.fetch(u2.id).catch(() => null);
    if (m1?.voice.channelId && m1.voice.channelId === m2?.voice.channelId)
      await enforce(m2, m2.voice.channel, [entry]);
    return;
  }

  if (sub === 'remove') {
    const u1 = interaction.options.getUser('user1');
    const u2 = interaction.options.getUser('user2');
    const entry = db.remove(guild.id, u1.id, u2.id);
    if (!entry)
      return interaction.reply({ embeds: [simple('❌ Not found', `${u1} and ${u2} don't have a restriction.`)], flags: eph });
    await interaction.reply({
      embeds: [simple('🔓 Restriction removed', `${u1} and ${u2} can now join the same voice channel.`)],
      flags: eph,
    });
    return sendLog({ embeds: [logRemoved(entry, interaction.user.id)] });
  }

  if (sub === 'list')
    return interaction.reply({ embeds: [listEmbed(db.forGuild(guild.id), guild.name)], flags: eph });

  if (sub === 'check') {
    const user = interaction.options.getUser('user');
    const entries = db.forUser(guild.id, user.id);
    return interaction.reply({
      embeds: [listEmbed(entries, guild.name).setTitle(`🔍 Restrictions of ${user.username} (${entries.length})`)],
      flags: eph,
    });
  }
}

// ---------- EVENTS ----------
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set([commandData.toJSON()]);
      console.log(`✅ Commands registered in ${guild.name}`);
    } catch (err) {
      console.error(`❌ Could not register commands in ${guild.name}:`, err.message);
    }
  }
});

client.on(Events.GuildCreate, (guild) =>
  guild.commands.set([commandData.toJSON()]).catch((e) => console.error(e.message))
);

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'restriction') return;
  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Something went wrong.', flags: eph };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!newState.channelId || oldState.channelId === newState.channelId) return;
  const member = newState.member;
  if (!member || member.user.bot) return;
  const restrictions = db.forUser(newState.guild.id, member.id);
  if (!restrictions.length) return;
  await enforce(member, newState.channel, restrictions);
});

client.login(TOKEN);
