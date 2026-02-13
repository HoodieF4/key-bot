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
  ButtonStyle
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();

// -------- ENV --------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;            // Application ID
const GUILD_ID = process.env.GUILD_ID || null;      // Your server ID (recommended)
const SITE_BASE_URL = process.env.SITE_BASE_URL;    // e.g. https://key-site-n0v5.onrender.com
const LOCKR_URL = process.env.LOCKR_URL;            // https://lockr.so/Q03XMO7D

const ACCESS_ROLE_ID = process.env.ACCESS_ROLE_ID || "1471729359449751694";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1471730794631266557";
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID || "1471730464296534209";

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

  // Track invalid attempts per hour: only log first invalid per hour per user
  db.run(`
    CREATE TABLE IF NOT EXISTS failures (
      user_id TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL,
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

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Post the key panel in the panel channel.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Post the key panel (Generate + Redeem instructions).")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("redeem")
      .setDescription("Redeem a key and get 1-hour access.")
      .addStringOption(opt =>
        opt.setName("key")
          .setDescription("Paste your key here")
          .setRequired(true)
      )
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

// -------- Failure rate-limit (log only once per hour per user) --------
function recordFailureAndShouldLog(userId, cb) {
  const t = nowMs();
  db.get(`SELECT * FROM failures WHERE user_id=?`, [userId], (err, row) => {
    if (err) return cb(true); // if DB fails, still log to not hide issues

    if (!row) {
      db.run(
        `INSERT INTO failures (user_id, window_start, count, logged) VALUES (?,?,?,?)`,
        [userId, t, 1, 1]
      );
      return cb(true); // first failure => log
    }

    const windowStart = row.window_start;
    const within = (t - windowStart) < oneHourMs();

    if (!within) {
      // reset window
      db.run(
        `UPDATE failures SET window_start=?, count=?, logged=? WHERE user_id=?`,
        [t, 1, 1, userId]
      );
      return cb(true); // log first failure of new hour window
    }

    // still within hour
    const newCount = row.count + 1;
    const alreadyLogged = row.logged === 1;

    db.run(
      `UPDATE failures SET count=? WHERE user_id=?`,
      [newCount, userId]
    );

    // Your rule: even if 5 wrong keys in 1h, only log the first one.
    return cb(!alreadyLogged);
  });
}

// -------- Grant role + schedule expiry --------
async function grantRoleForOneHour(client, interaction) {
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

async function expireLoop(client) {
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
  }, 15_000); // check every 15s
}

// -------- Discord client --------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  await postLog(client, "🤖 Key bot is online.");
  expireLoop(client);
});

// Interactions
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.isButton()) {
      if (interaction.customId === "redeem_help") {
        return interaction.reply({
          content: "✅ To redeem your key, use:\n`/redeem key:YOUR_KEY_HERE`",
          ephemeral: true
        });
      }
    }

    if (interaction.commandName === "setup") {
      const embed = new EmbedBuilder()
        .setTitle("🔞 Get Your FREE NSFW Content!")
        .setDescription(
          "Follow the simple steps below to unlock your NSFW content:\n\n" +
          "🔑 **Get Your Key**\n" +
          "1. Click **Generate Key**\n" +
          "2. Follow the site steps\n" +
          "3. Copy your key\n\n" +
          "✅ **Redeem Your Key**\n" +
          "1. Click **Redeem Key**\n" +
          "2. Paste your key\n" +
          "3. Enjoy!"
        )
        .setFooter({ text: "💦 100% FREE • Unlimited Keys • No Limits • Start now 😈" });

      // You said you'll add the image later:
        embed.setImage("https://media.discordapp.net/attachments/1146456316290797678/1471765991062245487/image_3.png?ex=69902064&is=698ecee4&hm=eff5a60ad0ac2b9c91353feb71af65225bedd6625fd88d43d16b80da3b13b5ee&=&format=webp&quality=lossless&width=2168&height=1355");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Generate Key")
          .setStyle(ButtonStyle.Link)
          .setURL(LOCKR_URL),

        new ButtonBuilder()
          .setCustomId("redeem_help")
          .setLabel("Redeem Key")
          .setStyle(ButtonStyle.Success)
      );

      const ch = await interaction.guild.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
      if (!ch) {
        return interaction.reply({ content: "❌ Panel channel not found. Check PANEL_CHANNEL_ID.", ephemeral: true });
      }

      await ch.send({ embeds: [embed], components: [row] });

      return interaction.reply({ content: "✅ Panel message posted in the panel channel.", ephemeral: true });
    }

    
    if (interaction.commandName === "panel") {
      const embed = new EmbedBuilder()
        .setTitle("🔞 Get Your FREE NSFW Content!")
        .setDescription(
          "Follow the simple steps below to unlock your NSFW content:\n\n" +
          "🔑 **Get Your Key**\n" +
         "1. Click **Generate Key**\n" +
          "2. Follow the site steps\n" +
          "3. Copy your key\n\n" +
          "✅ **Redeem Your Key**\n" +
          "1. Click **Redeem Key**\n" +
          "2. Paste your key\n" +
          "3. Enjoy!"
        )
        .setFooter({ text: "💦 100% FREE • Unlimited Keys • No Limits • Start now 😈" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("🔑 Generate Key")
          .setStyle(ButtonStyle.Link)
          .setURL(LOCKR_URL),

        new ButtonBuilder()
          .setCustomId("redeem_help")
          .setLabel("✅ Redeem Key")
          .setStyle(ButtonStyle.Success)
      );

      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }

    if (interaction.commandName === "redeem") {
      const key = interaction.options.getString("key", true).trim();

      // Call the site
      const result = await redeemOnSite(key, interaction.user.id);

      if (!result.ok) {
        // Always tell the user (ephemeral), but log only once per hour per user
        recordFailureAndShouldLog(interaction.user.id, async (shouldLog) => {
          if (shouldLog) {
            await postLog(client, `❌ <@${interaction.user.id}> — invalid key attempt.`);
          }
        });

        return interaction.reply({
          content: "❌ Invalid or expired key. Please generate a new one and try again.",
          ephemeral: true
        });
      }

      // Success -> grant role for 1 hour
      const expiresAt = await grantRoleForOneHour(client, interaction);

      await postLog(client, `✅ <@${interaction.user.id}> — key approved. Access granted for **1 hour**.`);

      return interaction.reply({
        content: `✅ Key approved! You now have access for **1 hour**.\n⏳ Expires <t:${Math.floor(expiresAt / 1000)}:R>.`,
        ephemeral: true
      });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "⚠️ Something went wrong. Please try again later.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(BOT_TOKEN);
