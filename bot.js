const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();

// -------- ENV --------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;            // Application ID
const GUILD_ID = process.env.GUILD_ID || null;      // Your server ID (recommended)
const SITE_BASE_URL = process.env.SITE_BASE_URL;    // e.g. https://key-site-n0v5.onrender.com
const LOCKR_URL = process.env.LOCKR_URL;            // https://lockr.so/Q03XMO7D

const ACCESS_ROLE_ID = process.env.ACCESS_ROLE_ID || "1471729359449751694";
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID || "1471730464296534209";

// Panel look
const PANEL_TITLE = "🔞 Get Your FREE NSFW Content!";
const PANEL_IMAGE_URL = process.env.PANEL_IMAGE_URL || "https://media.discordapp.net/attachments/1146456316290797678/1471767031295639703/image_4.png?ex=6990215c&is=698ecfdc&hm=72ce3503ad3f87539e2f79512cbbb1ef3ca8a555ccdc7a4633f9ef214b07717c&=&format=webp&quality=lossless&width=2168&height=1355"; // optional (set later)

if (!BOT_TOKEN || !CLIENT_ID || !SITE_BASE_URL || !LOCKR_URL) {
  console.error("Missing required env vars. Need BOT_TOKEN, CLIENT_ID, SITE_BASE_URL, LOCKR_URL");
  process.exit(1);
}

// -------- DB --------
const db = new sqlite3.Database("./bot.db");
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS grants (
      user_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  // Log invalid key only once per hour per user
  db.run(`
    CREATE TABLE IF NOT EXISTS failures (
      user_id TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      logged INTEGER NOT NULL
    )
  `);
});

function nowMs() { return Date.now(); }
function oneHourMs() { return 60 * 60 * 1000; }

async function postLog(client, text) {
  const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (ch) await ch.send(text).catch(() => {});
}

// -------- Slash commands --------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Post the key panel (Generate + Verify buttons).")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Registered GUILD slash commands");
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Registered GLOBAL slash commands (can take time to appear)");
  }
}

// -------- Key validation (calls your site) --------
async function redeemOnSite(key, userId) {
  const url = `${SITE_BASE_URL.replace(/\/$/, "")}/api/redeem`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, userId })
  });

  if (resp.ok) return { ok: true };

  let data = null;
  try { data = await resp.json(); } catch {}
  return { ok: false, status: resp.status, error: data?.error || "unknown" };
}

// -------- Failure log rate-limit (1 log per hour per user) --------
function shouldLogInvalid(userId, cb) {
  const t = nowMs();
  db.get(`SELECT * FROM failures WHERE user_id=?`, [userId], (err, row) => {
    if (err) return cb(true);

    if (!row) {
      db.run(`INSERT INTO failures (user_id, window_start, logged) VALUES (?,?,?)`, [userId, t, 1]);
      return cb(true);
    }

    const within = (t - row.window_start) < oneHourMs();
    if (!within) {
      db.run(`UPDATE failures SET window_start=?, logged=? WHERE user_id=?`, [t, 1, userId]);
      return cb(true);
    }

    // within 1 hour and already logged => don't log again
    return cb(row.logged !== 1);
  });
}

// -------- Grant role + schedule expiry --------
async function grantRoleForOneHour(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  const role = guild.roles.cache.get(ACCESS_ROLE_ID) || await guild.roles.fetch(ACCESS_ROLE_ID).catch(() => null);
  if (!role) throw new Error("Role not found. Check ACCESS_ROLE_ID.");

  await member.roles.add(role);

  const t = nowMs();
  const expiresAt = t + oneHourMs();

  db.run(
    `INSERT OR REPLACE INTO grants (user_id, guild_id, role_id, granted_at, expires_at) VALUES (?,?,?,?,?)`,
    [interaction.user.id, guild.id, ACCESS_ROLE_ID, t, expiresAt]
  );

  return expiresAt;
}

function expireLoop(client) {
  setInterval(() => {
    const t = nowMs();
    db.all(`SELECT * FROM grants WHERE expires_at <= ?`, [t], async (err, rows) => {
      if (err || !rows?.length) return;

      for (const row of rows) {
        try {
          const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
          if (!guild) {
            db.run(`DELETE FROM grants WHERE user_id=?`, [row.user_id]);
            continue;
          }

          const member = await guild.members.fetch(row.user_id).catch(() => null);
          if (member) {
            await member.roles.remove(row.role_id).catch(() => {});
            await member.send("⏳ Your access has expired. Generate a new key to get access again.").catch(() => {});
          }

          await postLog(client, `⏱️ <@${row.user_id}> — access expired. Role removed.`);
        } finally {
          db.run(`DELETE FROM grants WHERE user_id=?`, [row.user_id]);
        }
      }
    });
  }, 15_000);
}

// -------- Discord client --------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  await postLog(client, "🤖 FrostKey is online.");
  expireLoop(client);
});

client.on("interactionCreate", async (interaction) => {
  try {
    // Button -> open modal
    if (interaction.isButton()) {
      if (interaction.customId === "verify_key") {
        const modal = new ModalBuilder()
          .setCustomId("verify_key_modal")
          .setTitle("Verify Key");

        const keyInput = new TextInputBuilder()
          .setCustomId("key_input")
          .setLabel("Paste your key")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(keyInput);
        modal.addComponents(row);

        return interaction.showModal(modal);
      }
      return;
    }

    // Modal submit -> validate key
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "verify_key_modal") {
        const key = interaction.fields.getTextInputValue("key_input").trim();

        const result = await redeemOnSite(key, interaction.user.id);

        if (!result.ok) {
          shouldLogInvalid(interaction.user.id, async (logIt) => {
            if (logIt) await postLog(client, `❌ <@${interaction.user.id}> — invalid key attempt.`);
          });

          return interaction.reply({
            content: "❌ Invalid or expired key. Please generate a new one and try again.",
            ephemeral: true
          });
        }

        const expiresAt = await grantRoleForOneHour(interaction);
        await postLog(client, `✅ <@${interaction.user.id}> — key approved. Access granted for **1 hour**.`);

        return interaction.reply({
          content: `✅ Key approved! You now have access for **1 hour**.\n⏳ Expires <t:${Math.floor(expiresAt / 1000)}:R>.`,
          ephemeral: true
        });
      }
      return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

if (interaction.commandName === "panel") {
  const embed = new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setDescription(
      "Follow the simple steps below to unlock your content:\n\n" +
      "🔑 **Get Your Key**\n" +
      "1. Click **Generate Key**\n" +
      "2. Complete the tasks\n" +
      "3. Copy your key\n\n" +
      "✅ **Verify Your Key**\n" +
      "1. Click **Verify Key**\n" +
      "2. Paste your key\n" +
      "3. Enjoy!"
    )
    .setFooter({ text: "💦 100% FREE • Unlimited Keys • No Limits • Start now 👿" });

  if (PANEL_IMAGE_URL) embed.setImage(PANEL_IMAGE_URL);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Generate Key")
      .setEmoji("🔑")
      .setStyle(ButtonStyle.Link)
      .setURL(LOCKR_URL),

    new ButtonBuilder()
      .setCustomId("verify_key")
      .setLabel("Verify Key")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );

  const ch = await interaction.guild.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
  if (!ch) {
    return interaction.reply({ content: "❌ Panel channel not found. Check PANEL_CHANNEL_ID.", ephemeral: true });
  }

  await ch.send({ embeds: [embed], components: [row] });
  return interaction.reply({ content: "✅ Panel posted.", ephemeral: true });
}

  const ch = await interaction.guild.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
  if (!ch) {
    return interaction.reply({ content: "❌ Panel channel not found. Check PANEL_CHANNEL_ID.", ephemeral: true });
  }

  await ch.send({ embeds: [embed], components: [row] });

  return interaction.reply({ content: "✅ Panel message posted in the panel channel.", ephemeral: true });
      );

      return interaction.reply({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "⚠️ Something went wrong. Please try again later.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(BOT_TOKEN);
