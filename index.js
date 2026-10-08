require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder, PermissionFlagsBits, MessageFlags,
} = require("discord.js");

// ---------- config (from environment variables) ----------
const TOKEN = process.env.DISCORD_TOKEN;
const SERVER_IP = (process.env.SERVER_IP || "play.example.com").trim();
const PANEL_CHANNEL_ID = (process.env.PANEL_CHANNEL_ID || "").trim();
const ADMIN_CHANNEL_ID = (process.env.ADMIN_CHANNEL_ID || "").trim(); // optional
const TOURNAMENT_NAME = (process.env.TOURNAMENT_NAME || "Minecraft Tournament").trim();
const PRIZE = (process.env.PRIZE || "").trim(); // optional, shown on the panel if set
const DATA_DIR = process.env.DATA_DIR || ".";

let TZ = (process.env.TIMEZONE || "Africa/Tunis").trim();
if (!DateTime.now().setZone(TZ).isValid) {
  console.warn(`⚠️ TIMEZONE "${TZ}" is not valid, using Africa/Tunis. Use names like Africa/Tunis.`);
  TZ = "Africa/Tunis";
}

const EVENT_HOUR = 20; // 8 PM
const PURPLE = 0x8a2be2;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/; // valid Minecraft Java usernames
const EPHEMERAL = MessageFlags.Ephemeral;
const GIF_NAME = "panel.gif";
// Looks for the gif in ./assets/panel.gif or next to index.js
const GIF_PATH =
  [path.join(__dirname, "assets", GIF_NAME), path.join(__dirname, GIF_NAME)].find((p) => fs.existsSync(p)) ||
  path.join(__dirname, GIF_NAME);
const HAS_GIF = fs.existsSync(GIF_PATH);
if (!HAS_GIF) console.warn(`⚠️ GIF not found at ${GIF_PATH}. The panel will be posted without it.`);

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "registrations.json");
const load = () => (fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : {});
const save = (d) => fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));

// ---------- event date: next Sunday 8 PM ----------
function nextEvent() {
  const now = DateTime.now().setZone(TZ);
  const days = (7 - now.weekday + 7) % 7; // luxon: Sunday = 7
  let ev = now.plus({ days }).set({ hour: EVENT_HOUR, minute: 0, second: 0, millisecond: 0 });
  if (ev <= now) ev = ev.plus({ days: 7 });
  return ev;
}
// Discord timestamps display in each user's own timezone
const ts = (ev, style = "F") => `<t:${Math.floor(ev.toSeconds())}:${style}>`;

// ---------- embeds & buttons ----------
const LINE = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";

function panelEmbed(withGif = HAS_GIF) {
  const ev = nextEvent();
  const count = Object.keys(load()).length;

  const fields = [
    { name: "📅 Date", value: ts(ev, "F"), inline: true },
    { name: "⏳ Starts", value: ts(ev, "R"), inline: true },
    { name: "👥 Players registered", value: `**${count}**`, inline: true },
    { name: "🎮 Edition", value: "Minecraft: Java", inline: true },
    { name: "📩 Server IP", value: "Sent to your **DMs** after you register", inline: true },
  ];
  if (PRIZE) fields.push({ name: "🏆 Prize", value: PRIZE, inline: true });
  else fields.push({ name: "🕗 Time", value: ts(ev, "t"), inline: true });

  fields.push({
    name: "📖 How to join",
    value:
      "**1️⃣** Press **Register** below\n" +
      "**2️⃣** Enter your exact in-game Minecraft nickname\n" +
      "**3️⃣** Check your **DMs** for the server IP and event details\n" +
      "**4️⃣** Join the server a few minutes before the start",
  });
  fields.push({
    name: "⚠️ Good to know",
    value:
      "• One registration per Discord account\n" +
      "• Your nickname must match your Minecraft account exactly\n" +
      "• Keep your DMs open, or press **Resend info** later\n" +
      "• Changed your mind? Press **Unregister** to free your spot",
  });

  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setAuthor({ name: "🔮 Tournament Registration" })
    .setTitle(`⚔️  ${TOURNAMENT_NAME.toUpperCase()}  ⚔️`)
    .setDescription(
      `${LINE}\n` +
      "### 👑 Ready to fight for the crown?\n" +
      "Gather your skills, sharpen your sword and prove you're the best.\n" +
      "Register now and secure your place in the arena!\n" +
      `${LINE}`
    )
    .addFields(fields)
    .setFooter({ text: "💜 Good luck, warriors! • Make sure your DMs are open" })
    .setTimestamp();
  const avatar = client.user?.displayAvatarURL({ size: 256 });
  if (avatar) embed.setThumbnail(avatar);
  if (withGif) embed.setImage(`attachment://${GIF_NAME}`);
  return embed;
}

function dmEmbed(nick) {
  const ev = nextEvent();
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("✅ You're registered!")
    .setDescription(`See you in the arena, **${nick}**! ⚔️`)
    .addFields(
      { name: "🌐 Server IP", value: "```" + SERVER_IP + "```" },
      { name: "📅 Date", value: ts(ev, "F"), inline: true },
      { name: "⏳ Starts", value: ts(ev, "R"), inline: true }
    )
    .setFooter({ text: "Be online a few minutes early. Good luck!" });
}

const playerRow = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tourney:register").setLabel("Register").setEmoji("⚔️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("tourney:resend").setLabel("Resend info").setEmoji("📩").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("tourney:unregister").setLabel("Unregister").setEmoji("🚪").setStyle(ButtonStyle.Danger)
  );

const adminRow = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin:waitlist").setLabel("Waiting list").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:remove").setLabel("Remove player").setEmoji("🗑️").setStyle(ButtonStyle.Secondary)
  );

const adminEmbed = () =>
  new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("🛡️ Admin Panel")
    .setDescription("Only admins can use these buttons.");

const publicPayload = (withGif = HAS_GIF) => ({
  embeds: [panelEmbed(withGif)],
  components: ADMIN_CHANNEL_ID ? [playerRow()] : [playerRow(), adminRow()],
});
const adminPayload = () => ({ embeds: [adminEmbed()], components: [adminRow()] });

// ---------- panel posting: always exactly ONE panel per channel ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const hasButton = (msg, customId) =>
  msg.components.some((row) => row.components.some((c) => c.customId === customId));

async function ensurePanel(channelId, markerId, buildPayload, wantGif) {
  const useGif = wantGif && HAS_GIF;
  const channel = await client.channels.fetch(channelId).catch((err) => {
    console.error(`❌ Can't fetch channel ${channelId}: ${err.message}`);
    return null;
  });
  if (!channel || !channel.isTextBased()) {
    console.error(`❌ Channel ${channelId} not found or not a text channel. Check the ID, and that the bot is in that server and can see the channel.`);
    return;
  }

  // Tell the user exactly which permissions are missing
  try {
    const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
    const perms = channel.permissionsFor(me);
    const needed = [
      ["ViewChannel", "View Channel"], ["SendMessages", "Send Messages"],
      ["EmbedLinks", "Embed Links"], ["AttachFiles", "Attach Files"],
      ["ReadMessageHistory", "Read Message History"], ["ManageMessages", "Manage Messages"],
    ];
    const missing = needed.filter(([f]) => !perms?.has(PermissionFlagsBits[f])).map(([, n]) => n);
    if (missing.length) console.error(`⚠️ Missing permissions in #${channel.name}: ${missing.join(", ")}`);
  } catch (err) {
    console.error("Permission check failed:", err.message);
  }

  // Find every panel the bot already posted here (works even if the server lost its data files)
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const mine = recent
    ? [...recent.filter((m) => m.author.id === client.user.id && hasButton(m, markerId)).values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    : [];

  let keeper = mine[0] || null;
  const extras = mine.slice(1);

  // The panel must carry the gif; if the old one doesn't, replace it
  if (keeper && useGif && !keeper.attachments.some((a) => a.name === GIF_NAME)) {
    extras.push(keeper);
    keeper = null;
  }

  for (const m of extras) await m.delete().catch(() => {});

  if (keeper) {
    await keeper.edit(buildPayload(useGif)).catch((err) => console.error("❌ Couldn't edit panel:", err.message));
    return;
  }

  try {
    const payload = buildPayload(useGif);
    if (useGif) payload.files = [new AttachmentBuilder(GIF_PATH, { name: GIF_NAME })];
    await channel.send(payload);
    console.log(`✅ Panel posted in #${channel.name}`);
  } catch (err) {
    console.error(`❌ Couldn't send panel in #${channel.name}: ${err.message}`);
    if (useGif) {
      try {
        await channel.send(buildPayload(false));
        console.warn("⚠️ Posted the panel WITHOUT the gif. Give the bot the 'Attach Files' permission to show it.");
      } catch (err2) {
        console.error(`❌ Fallback also failed: ${err2.message}`);
      }
    }
  }
}

// Serialized so two refreshes can never run at the same time and create duplicates
let chain = Promise.resolve();
function refreshPanels() {
  chain = chain
    .then(async () => {
      if (PANEL_CHANNEL_ID) await ensurePanel(PANEL_CHANNEL_ID, "tourney:register", publicPayload, true);
      if (ADMIN_CHANNEL_ID) await ensurePanel(ADMIN_CHANNEL_ID, "admin:waitlist", adminPayload, false);
    })
    .catch(console.error);
  return chain;
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await client.application.commands.set([]).catch(() => {}); // clear old slash commands
  console.log(`Next event: ${nextEvent().toFormat("cccc dd LLLL yyyy, HH:mm")} (${TZ})`);
  if (!PANEL_CHANNEL_ID) console.error("❌ PANEL_CHANNEL_ID is not set, no panel will be posted.");
  console.log(`Panel channel: ${PANEL_CHANNEL_ID || "(not set)"} | Admin channel: ${ADMIN_CHANNEL_ID || "(none)"}`);
  await refreshPanels();
  setInterval(refreshPanels, 60 * 60 * 1000); // keep date + counter fresh
});

// ---------- interactions ----------
const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);
const adminsOnly = (i) => i.reply({ content: "⛔ Admins only.", flags: EPHEMERAL });

client.on("interactionCreate", async (i) => {
  try {
    // ----- buttons -----
    if (i.isButton()) {
      if (i.customId === "tourney:register") {
        const modal = new ModalBuilder().setCustomId("tourney:modal").setTitle("Tournament Registration")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("nick").setLabel("Minecraft nickname")
                .setPlaceholder("e.g. Steve_123").setStyle(TextInputStyle.Short)
                .setMinLength(3).setMaxLength(16).setRequired(true)
            )
          );
        return i.showModal(modal);
      }

      if (i.customId === "tourney:resend") {
        const entry = load()[i.user.id];
        if (!entry) return i.reply({ content: "You're not registered yet.", flags: EPHEMERAL });
        try {
          await i.user.send({ embeds: [dmEmbed(entry.nick)] });
          return i.reply({ content: "📩 Sent! Check your DMs.", flags: EPHEMERAL });
        } catch {
          return i.reply({ content: "❌ I still can't DM you. Enable DMs from server members.", flags: EPHEMERAL });
        }
      }

      if (i.customId === "tourney:unregister") {
        const data = load();
        if (data[i.user.id]) {
          delete data[i.user.id];
          save(data);
          await i.reply({ content: "🚪 You've been unregistered.", flags: EPHEMERAL });
          return void refreshPanels();
        }
        return i.reply({ content: "You're not registered.", flags: EPHEMERAL });
      }

      // ----- admin buttons -----
      if (i.customId === "admin:waitlist") {
        if (!isAdmin(i)) return adminsOnly(i);
        const entries = Object.entries(load());
        const e = new EmbedBuilder().setColor(PURPLE).setTitle("📋 Waiting list");
        if (!entries.length) {
          e.setDescription("Nobody has registered yet.");
        } else {
          let text = entries.map(([id, v], n) => `\`${n + 1}.\` **${v.nick}** — <@${id}>`).join("\n");
          if (text.length > 3900) text = text.slice(0, 3900).split("\n").slice(0, -1).join("\n") + "\n…";
          e.setDescription(text).setFooter({ text: `${entries.length} player(s)` });
        }
        return i.reply({ embeds: [e], flags: EPHEMERAL }); // only the admin who clicked sees it
      }

      if (i.customId === "admin:remove") {
        if (!isAdmin(i)) return adminsOnly(i);
        const modal = new ModalBuilder().setCustomId("admin:removemodal").setTitle("Remove player")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("nick").setLabel("Minecraft nickname to remove")
                .setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(16).setRequired(true)
            )
          );
        return i.showModal(modal);
      }
    }

    // ----- modals -----
    if (i.isModalSubmit()) {
      const nick = i.fields.getTextInputValue("nick").trim();

      if (i.customId === "tourney:modal") {
        if (!NICK_RE.test(nick))
          return i.reply({ content: "❌ Invalid nickname. Use 3–16 letters, numbers or underscores.", flags: EPHEMERAL });

        const data = load();
        if (data[i.user.id])
          return i.reply({
            content: `⚠️ You're already registered as **${data[i.user.id].nick}**. Unregister first to change it.`,
            flags: EPHEMERAL,
          });
        if (Object.values(data).some((v) => v.nick.toLowerCase() === nick.toLowerCase()))
          return i.reply({ content: "❌ That nickname is already registered by someone else.", flags: EPHEMERAL });

        data[i.user.id] = { nick, discord: i.user.tag, registeredAt: new Date().toISOString() };
        save(data);

        let msg;
        try {
          await i.user.send({ embeds: [dmEmbed(nick)] });
          msg = `✅ Registered as **${nick}**! Check your DMs for the server IP.`;
        } catch {
          msg = `✅ Registered as **${nick}**, but I couldn't DM you. Enable DMs from server members, then press **Resend info**.`;
        }
        await i.reply({ content: msg, flags: EPHEMERAL });
        return void refreshPanels();
      }

      if (i.customId === "admin:removemodal") {
        if (!isAdmin(i)) return adminsOnly(i);
        const data = load();
        const id = Object.keys(data).find((k) => data[k].nick.toLowerCase() === nick.toLowerCase());
        if (!id) return i.reply({ content: `No player found with nickname **${nick}**.`, flags: EPHEMERAL });
        delete data[id];
        save(data);
        await i.reply({ content: `🗑️ Removed **${nick}** (<@${id}>).`, flags: EPHEMERAL });
        return void refreshPanels();
      }
    }
  } catch (err) {
    console.error(err);
  }
});

process.on("unhandledRejection", (err) => console.error("Unhandled error:", err));
client.on("error", (err) => console.error("Client error:", err));

if (!TOKEN) console.error("❌ DISCORD_TOKEN is not set.");
client.login(TOKEN);
