import { AudioPlayer, VoiceConnection } from "@discordjs/voice";

export interface Song {
  title: string;
  url: string;
  duration: string;
  requestedBy: string;
}

export interface GuildQueue {
  songs: Song[];
  audioPlayer: AudioPlayer;
  connection: VoiceConnection;
  paused: boolean;
}

export const queues = new Map<string, GuildQueue>();
