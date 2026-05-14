import http from "http";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { handleMessage } from "./commands.js";
import { logger } from "../lib/logger.js";

export function startKeepAlive(): void {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  });

  server.listen(3000, () => {
    logger.info("Keep-alive server listening on port 3000");
  });

  server.on("error", (err) => {
    logger.error({ err }, "Keep-alive server error");
  });
}

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN not set — Discord bot will not start");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    logger.info({ tag: c.user.tag }, "Discord bot ready");
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => {
      logger.error({ err }, "Unhandled error in message handler");
    });
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to login to Discord");
  });
}
