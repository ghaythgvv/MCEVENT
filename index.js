require("dotenv").config();
const fs = require("fs");
const { DateTime } = require("luxon");
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const SERVER_IP = process.env.SERVER_IP || "play.example.com";
const TZ = process.env.TIMEZONE || "Europe/Rome";
const EVENT_HOUR = 20; // 8 PM
const DATA_FILE = "registrations.json";
const PURPLE = 0x8a2be2;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/; // valid Minecraft Java usernames
const EPHEMERAL = MessageFlags.Ephemeral;

// ---------- storage ----------
const load = () => (fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : {});
const save = (d) => fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));

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

// ---------- embeds ----------
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

const panelButtons = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tourney:register").setLabel("Register").setEmoji("⚔️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("tourney:resend").setLabel("Resend info").setEmoji("📩").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("tourney:unregister").setLabel("Unregister").setEmoji("🚪").setStyle(ButtonStyle.Danger)
  );

// ---------- commands ----------
const commands = [
  new SlashCommandBuilder().setName("panel").setDescription("Post the tournament registration panel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("waitlist").setDescription("(Admin) See everyone who registered")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("remove").setDescription("(Admin) Remove a player from the list")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) => o.setName("user").setDescription("Player to remove").setRequired(true)),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  await client.application.commands.set(commands);
  console.log(`Logged in as ${client.user.tag} — next event: ${nextEvent().toFormat("cccc dd LLLL yyyy, HH:mm ZZZZ")}`);
});

const isAdmin = (i) => i.memberPermissions?.has(PermissionFlagsBits.Administrator);

client.on("interactionCreate", async (i) => {
  try {
    // ----- slash commands -----
    if (i.isChatInputCommand()) {
      if (!isAdmin(i)) return i.reply({ content: "⛔ Admins only.", flags: EPHEMERAL });

      if (i.commandName === "panel") {
        await i.channel.send({ embeds: [panelEmbed()], components: [panelButtons()] });
        return i.reply({ content: "✅ Panel posted.", flags: EPHEMERAL });
      }

      if (i.commandName === "waitlist") {
        const data = load();
        const entries = Object.entries(data);
        const e = new EmbedBuilder().setColor(PURPLE).setTitle("📋 Waiting list");
        if (!entries.length) {
          e.setDescription("Nobody has registered yet.");
        } else {
          let text = entries.map(([id, v], n) => `\`${n + 1}.\` **${v.nick}** — <@${id}>`).join("\n");
          if (text.length > 3900) text = text.slice(0, 3900).split("\n").slice(0, -1).join("\n") + "\n…";
          e.setDescription(text).setFooter({ text: `${entries.length} player(s)` });
        }
        return i.reply({ embeds: [e], flags: EPHEMERAL }); // only the admin sees it
      }

      if (i.commandName === "remove") {
        const user = i.options.getUser("user");
        const data = load();
        if (data[user.id]) {
          delete data[user.id];
          save(data);
          return i.reply({ content: `🗑️ Removed ${user}.`, flags: EPHEMERAL });
        }
        return i.reply({ content: "That user isn't registered.", flags: EPHEMERAL });
      }
    }

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
    }

    // ----- modal submit -----
    if (i.isModalSubmit() && i.customId === "tourney:modal") {
      const nick = i.fields.getTextInputValue("nick").trim();
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
  } catch (err) {
    console.error(err);
  }
});

client.login(TOKEN);
