require('dotenv').config();

module.exports = {
  token: process.env.TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID, // used by deploy-commands.js for instant slash commands
  logChannelId: process.env.LOG_CHANNEL_ID || '1551005021955559434',
  color: 0x9b59b6, // purple used on every embed
};
