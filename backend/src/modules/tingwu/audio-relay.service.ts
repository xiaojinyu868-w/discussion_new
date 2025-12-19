import { Injectable, Logger } from "@nestjs/common";
import { once } from "events";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import WS, { RawData } from "ws";
import ffmpeg from "ffmpeg-static";

type RelaySession = {
  ffmpeg: ChildProcessWithoutNullStreams;
  socket: WS;
  pendingPcm: Buffer[];
  isSocketReady: boolean;
};

@Injectable()
export class AudioRelayService {
  private readonly logger = new Logger(AudioRelayService.name);
  private readonly sessions = new Map<string, RelaySession>();

  create(sessionId: string, meetingJoinUrl: string) {
    if (this.sessions.has(sessionId)) {
      return;
    }
    this.logger.log(`Creating audio relay for session ${sessionId}`);
    const socket = new WS(meetingJoinUrl);
    const ffmpegProcess = spawn(
      ffmpeg ?? "ffmpeg",
      [
        "-loglevel",
        "error",
        "-f",
        "mp4",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const relay: RelaySession = {
      ffmpeg: ffmpegProcess,
      socket,
      pendingPcm: [],
      isSocketReady: false,
    };

    socket.on("open", () => {
      this.logger.log(`Tingwu socket open for session ${sessionId}`);
      relay.isSocketReady = true;
      relay.pendingPcm.forEach((chunk) => this.sendRaw(socket, chunk));
      relay.pendingPcm.length = 0;
    });

    socket.on("error", (error) => {
      this.logger.error(
        `Realtime socket error for session ${sessionId}`,
        error
      );
    });

    socket.on("close", () => {
      this.logger.warn(`Realtime socket closed for session ${sessionId}`);
      relay.isSocketReady = false;
    });

    ffmpegProcess.stdout.on("data", (chunk: Buffer) => {
      if (relay.isSocketReady && socket.readyState === WS.OPEN) {
        this.sendRaw(socket, chunk);
      } else {
        relay.pendingPcm.push(chunk);
      }
    });

    ffmpegProcess.on("error", (error) => {
      this.logger.error(
        `ffmpeg process error for session ${sessionId}`,
        error
      );
    });

    ffmpegProcess.stderr.on("data", (data) => {
      this.logger.warn(
        `ffmpeg stderr for session ${sessionId}: ${data.toString()}`
      );
    });

    ffmpegProcess.on("close", (code, signal) => {
      this.logger.warn(
        `ffmpeg process closed for session ${sessionId} (code=${code}, signal=${signal})`
      );
      if (socket.readyState === WS.OPEN) {
        socket.close();
      }
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, relay);
  }

  async write(sessionId: string, chunk: Buffer) {
    const relay = this.sessions.get(sessionId);
    if (!relay) {
      throw new Error(`Relay not found for session ${sessionId}`);
    }
    const { ffmpeg } = relay;
    if (!ffmpeg.stdin.writable) {
      throw new Error(`Relay input closed for session ${sessionId}`);
    }
    if (!ffmpeg.stdin.write(chunk)) {
      await once(ffmpeg.stdin, "drain");
    }
  }

  async stop(sessionId: string) {
    const relay = this.sessions.get(sessionId);
    if (!relay) return;
    this.logger.log(`Stopping relay for session ${sessionId}`);
    try {
      relay.ffmpeg.stdin.end();
    } catch (error) {
      this.logger.error(
        `Error closing ffmpeg stdin for session ${sessionId}`,
        error
      );
    }
    if (relay.socket.readyState === WS.OPEN) {
      relay.socket.close();
    }
    this.sessions.delete(sessionId);
  }

  private sendRaw(socket: WS, data: RawData) {
    (socket as unknown as {
      send: (payload: RawData, options?: any, cb?: (err?: Error) => void) => void;
    }).send(data, { binary: true });
  }
}


