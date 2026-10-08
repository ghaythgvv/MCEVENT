require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, MessageFlags,
} = require("discord.js");

// ---------- config (from environment variables) ----------
const TOKEN = process.env.DISCORD_TOKEN;
const SERVER_IP = (process.env.SERVER_IP || "play.example.com").trim();
const PANEL_CHANNEL_ID = (process.env.PANEL_CHANNEL_ID || "").trim();
const ADMIN_CHANNEL_ID = (process.env.ADMIN_CHANNEL_ID || "").trim(); // optional
const DATA_DIR = process.env.DATA_DIR || ".";

let TZ = (process.env.TIMEZONE || "Europe/Rome").trim();
if (!DateTime.now().setZone(TZ).isValid) {
  console.warn(`⚠️ TIMEZONE "${TZ}" is not valid, using Europe/Rome. Use names like Europe/Rome.`);
  TZ = "Europe/Rome";
}

const EVENT_HOUR = 20; // 8 PM
const PURPLE = 0x8a2be2;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/; // valid Minecraft Java usernames
const EPHEMERAL = MessageFlags.Ephemeral;

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "registrations.json");
const STATE_FILE = path.join(DATA_DIR, "panel-state.json");
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));
const load = () => readJson(DATA_FILE);
const save = (d) => writeJson(DATA_FILE, d);

// ---------- event date: next Saturday 8 PM ----------
function nextEvent() {
  const now = DateTime.now().setZone(TZ);
  const days = (6 - now.weekday + 7) % 7; // luxon: Saturday = 6
  let ev = now.plus({ days }).set({ hour: EVENT_HOUR, minute: 0, second: 0, millisecond: 0 });
  if (ev <= now) ev = ev.plus({ days: 7 });
  return ev;
}
// Discord timestamps display in each user's own timezone
const ts = (ev, style = "F") => `<t:${Math.floor(ev.toSeconds())}:${style}>`;

// ---------- embeds & buttons ----------
function panelEmbed() {
  const ev = nextEvent();
  return new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle("⚔️ Minecraft Tournament")
    .setDescription(
      "Ready to fight for the crown? 👑\n" +
      "Hit **Register** below and enter your in-game nickname.\n\n" +
      "You'll receive the **server IP** and event details in your DMs."
    )
    .addFields(
      { name: "📅 Date", value: ts(ev, "F"), inline: true },
      { name: "⏳ Starts", value: ts(ev, "R"), inline: true },
      { name: "🎮 Edition", value: "Minecraft: Java", inline: true }
    )
    .setFooter({ text: "Make sure your DMs are open!" });
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

// Public panel payload. If there's no separate admin channel, admin buttons go on the same panel.
const publicPayload = () => ({
  embeds: [panelEmbed()],
  components: ADMIN_CHANNEL_ID ? [playerRow()] : [playerRow(), adminRow()],
});
const adminPayload = () => ({ embeds: [adminEmbed()], components: [adminRow()] });

// ---------- panel posting (edits the old message instead of duplicating) ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function ensurePanel(key, channelId, payload) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error(`❌ Can't access channel ${channelId} (${key}). Check the ID and the bot's permissions.`);
    return;
  }
  const state = readJson(STATE_FILE);
  if (state[key]) {
    const old = await channel.messages.fetch(state[key]).catch(() => null);
    if (old) return old.edit(payload).catch(console.error);
  }
  try {
    const msg = await channel.send(payload);
    state[key] = msg.id;
    writeJson(STATE_FILE, state);
  } catch (err) {
    console.error(`❌ Couldn't send panel in ${channelId}:`, err.message);
  }
}

async function refreshPanels() {
  if (PANEL_CHANNEL_ID) await ensurePanel("public", PANEL_CHANNEL_ID, publicPayload());
  if (ADMIN_CHANNEL_ID) await ensurePanel("admin", ADMIN_CHANNEL_ID, adminPayload());
}

client.once("clientReady", async () => {
  await client.application.commands.set([]); // clear old slash commands, not needed anymore
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Next event: ${nextEvent().toFormat("cccc dd LLLL yyyy, HH:mm")} (${TZ})`);
  if (!PANEL_CHANNEL_ID) console.error("❌ PANEL_CHANNEL_ID is not set, no panel will be posted.");
  await refreshPanels();
  setInterval(refreshPanels, 60 * 60 * 1000); // keep the date on the panel fresh
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
          return i.reply({ content: "🚪 You've been unregistered.", flags: EPHEMERAL });
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
        return i.reply({ content: msg, flags: EPHEMERAL });
      }

      if (i.customId === "admin:removemodal") {
        if (!isAdmin(i)) return adminsOnly(i);
        const data = load();
        const id = Object.keys(data).find((k) => data[k].nick.toLowerCase() === nick.toLowerCase());
        if (!id) return i.reply({ content: `No player found with nickname **${nick}**.`, flags: EPHEMERAL });
        delete data[id];
        save(data);
        return i.reply({ content: `🗑️ Removed **${nick}** (<@${id}>).`, flags: EPHEMERAL });
      }
    }
  } catch (err) {
    console.error(err);
  }
});

client.login(TOKEN);
