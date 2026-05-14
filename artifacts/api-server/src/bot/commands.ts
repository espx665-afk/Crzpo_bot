import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import {
  Message,
  GuildMember,
  EmbedBuilder,
  TextChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { queues, type Song } from "./queue.js";
import { logger } from "../lib/logger.js";

const PREFIX = "!";

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "?:??";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ytdlpInfo(query: string): Promise<{ title: string; url: string; duration: number }> {
  return new Promise((resolve, reject) => {
    const isUrl = query.startsWith("http://") || query.startsWith("https://");
    const target = isUrl ? query : `ytsearch1:${query}`;

    const proc = spawn("yt-dlp", [
      "--dump-json",
      "--no-playlist",
      "--quiet",
      target,
    ]);

    let raw = "";
    let errOut = "";
    proc.stdout.on("data", (d: Buffer) => { raw += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp info failed (${code}): ${errOut}`));
        return;
      }
      try {
        const json = JSON.parse(raw.trim().split("\n")[0]);
        resolve({
          title: json.title ?? "Unknown",
          url: json.webpage_url ?? json.url,
          duration: json.duration ?? 0,
        });
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp output: ${errOut}`));
      }
    });
  });
}

function ytdlpStream(url: string) {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found");

  const ytdlp = spawn("yt-dlp", [
    "-f", "bestaudio",
    "-o", "-",
    "--no-playlist",
    "--quiet",
    url,
  ]);

  const ffmpeg = spawn(ffmpegPath, [
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-loglevel", "error",
    "pipe:1",
  ]);

  ytdlp.stdout.pipe(ffmpeg.stdin);

  ytdlp.stderr.on("data", (d: Buffer) => {
    logger.warn({ msg: d.toString().trim() }, "yt-dlp stderr");
  });
  ffmpeg.stderr.on("data", (d: Buffer) => {
    logger.warn({ msg: d.toString().trim() }, "ffmpeg stderr");
  });
  ytdlp.on("error", (err) => logger.error({ err }, "yt-dlp process error"));
  ffmpeg.on("error", (err) => logger.error({ err }, "ffmpeg process error"));

  return ffmpeg.stdout;
}

async function playNextSong(guildId: string, channel: TextChannel): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue || queue.songs.length === 0) {
    queues.delete(guildId);
    return;
  }

  const song = queue.songs[0];
  try {
    const stream = ytdlpStream(song.url);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
    });

    queue.audioPlayer.play(resource);
    queue.paused = false;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Now Playing")
      .setDescription(`**[${song.title}](${song.url})**`)
      .addFields(
        { name: "Duration", value: song.duration, inline: true },
        { name: "Requested by", value: song.requestedBy, inline: true }
      );
    channel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    logger.error({ err, song }, "Failed to play song");
    channel.send(`Failed to play **${song.title}**, skipping...`).catch(() => {});
    queue.songs.shift();
    await playNextSong(guildId, channel);
  }
}

export async function handlePlay(message: Message, args: string[]): Promise<void> {
  const member = message.member as GuildMember;
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    message.reply("You need to be in a voice channel to play music!").catch(() => {});
    return;
  }

  if (!args.length) {
    message.reply("Please provide a YouTube URL or search query.").catch(() => {});
    return;
  }

  const query = args.join(" ");
  const textChannel = message.channel as TextChannel;
  const guildId = message.guildId!;

  await message.react("⏳").catch(() => {});

  try {
    const info = await ytdlpInfo(query);
    const songInfo: Song = {
      title: info.title,
      url: info.url,
      duration: formatDuration(info.duration),
      requestedBy: message.author.username,
    };

    let queue = queues.get(guildId);
    if (!queue) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: message.guild!.voiceAdapterCreator,
      });

      const audioPlayer = createAudioPlayer();
      queue = { songs: [], audioPlayer, connection, paused: false };
      queues.set(guildId, queue);

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          connection.destroy();
          queues.delete(guildId);
        }
      });

      audioPlayer.on(AudioPlayerStatus.Idle, () => {
        const q = queues.get(guildId);
        if (q) {
          q.songs.shift();
          if (q.songs.length > 0) {
            playNextSong(guildId, textChannel);
          } else {
            queues.delete(guildId);
          }
        }
      });

      audioPlayer.on("error", (err) => {
        logger.error({ err }, "Audio player error");
        const q = queues.get(guildId);
        if (q) {
          q.songs.shift();
          playNextSong(guildId, textChannel);
        }
      });

      connection.subscribe(audioPlayer);

      queue.songs.push(songInfo);
      await playNextSong(guildId, textChannel);
    } else {
      queue.songs.push(songInfo);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Added to Queue")
        .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
        .addFields(
          { name: "Duration", value: songInfo.duration, inline: true },
          { name: "Position", value: `#${queue.songs.length}`, inline: true },
          { name: "Requested by", value: songInfo.requestedBy, inline: true }
        );
      textChannel.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "Error in play command");
    message.reply("Could not find or play that song. Try a different search or URL.").catch(() => {});
  }
}

export function handleSkip(message: Message): void {
  const guildId = message.guildId!;
  const queue = queues.get(guildId);
  if (!queue || queue.songs.length === 0) {
    message.reply("Nothing is playing right now.").catch(() => {});
    return;
  }
  queue.audioPlayer.stop();
  message.reply(`Skipped **${queue.songs[0].title}**.`).catch(() => {});
}

export function handlePause(message: Message): void {
  const queue = queues.get(message.guildId!);
  if (!queue || queue.songs.length === 0) {
    message.reply("Nothing is playing right now.").catch(() => {});
    return;
  }
  if (queue.paused) {
    message.reply("Music is already paused.").catch(() => {});
    return;
  }
  queue.audioPlayer.pause();
  queue.paused = true;
  message.reply("Music paused.").catch(() => {});
}

export function handleResume(message: Message): void {
  const queue = queues.get(message.guildId!);
  if (!queue || queue.songs.length === 0) {
    message.reply("Nothing is playing right now.").catch(() => {});
    return;
  }
  if (!queue.paused) {
    message.reply("Music is already playing.").catch(() => {});
    return;
  }
  queue.audioPlayer.unpause();
  queue.paused = false;
  message.reply("Music resumed.").catch(() => {});
}

export function handleStop(message: Message): void {
  const guildId = message.guildId!;
  const queue = queues.get(guildId);
  if (!queue) {
    message.reply("Nothing is playing right now.").catch(() => {});
    return;
  }
  queue.songs = [];
  queue.audioPlayer.stop();
  queue.connection.destroy();
  queues.delete(guildId);
  message.reply("Stopped music and cleared the queue.").catch(() => {});
}

export function handleQueue(message: Message): void {
  const queue = queues.get(message.guildId!);
  if (!queue || queue.songs.length === 0) {
    message.reply("The queue is empty.").catch(() => {});
    return;
  }

  const MAX_SHOWN = 10;
  const shown = queue.songs.slice(0, MAX_SHOWN);
  const description = shown
    .map((s, i) =>
      i === 0
        ? `**Now Playing:** [${s.title}](${s.url}) [${s.duration}]`
        : `**${i}.** [${s.title}](${s.url}) [${s.duration}]`
    )
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Music Queue")
    .setDescription(description)
    .setFooter({
      text:
        queue.songs.length > MAX_SHOWN
          ? `...and ${queue.songs.length - MAX_SHOWN} more`
          : `${queue.songs.length} song${queue.songs.length !== 1 ? "s" : ""} in queue`,
    });

  (message.channel as TextChannel).send({ embeds: [embed] }).catch(() => {});
}

export function handleHelp(message: Message): void {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Music Bot Commands")
    .addFields(
      { name: `${PREFIX}play <url or search>`, value: "Play a song from YouTube or add it to the queue" },
      { name: `${PREFIX}skip`, value: "Skip the current song" },
      { name: `${PREFIX}pause`, value: "Pause playback" },
      { name: `${PREFIX}resume`, value: "Resume playback" },
      { name: `${PREFIX}stop`, value: "Stop music and clear the queue" },
      { name: `${PREFIX}queue`, value: "Show the current queue" },
      { name: `${PREFIX}help`, value: "Show this help message" }
    );
  (message.channel as TextChannel).send({ embeds: [embed] }).catch(() => {});
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  if (!message.guildId) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  switch (command) {
    case "play":
      await handlePlay(message, args);
      break;
    case "skip":
      handleSkip(message);
      break;
    case "pause":
      handlePause(message);
      break;
    case "resume":
      handleResume(message);
      break;
    case "stop":
      handleStop(message);
      break;
    case "queue":
    case "q":
      handleQueue(message);
      break;
    case "help":
      handleHelp(message);
      break;
  }
}
