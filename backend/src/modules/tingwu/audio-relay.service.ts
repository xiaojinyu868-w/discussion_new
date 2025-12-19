import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import WS from "ws";
import ffmpeg from "ffmpeg-static";

type RelaySession = {
  socket: WS | null;
  audioBuffer: Buffer[];
  meetingJoinUrl: string;
  isProcessing: boolean;
};

@Injectable()
export class AudioRelayService {
  private readonly logger = new Logger(AudioRelayService.name);
  private readonly sessions = new Map<string, RelaySession>();

  create(sessionId: string, meetingJoinUrl: string) {
    if (this.sessions.has(sessionId)) {
      return;
    }
    this.logger.log(`Creating audio relay session ${sessionId}`);

    const relay: RelaySession = {
      socket: null,
      audioBuffer: [],
      meetingJoinUrl,
      isProcessing: false,
    };

    this.sessions.set(sessionId, relay);
  }

  async write(sessionId: string, chunk: Buffer) {
    const relay = this.sessions.get(sessionId);
    if (!relay) {
      throw new Error(`Relay not found for session ${sessionId}`);
    }

    relay.audioBuffer.push(chunk);
    this.logger.debug(
      `Buffered ${chunk.length} bytes for session ${sessionId}, total chunks: ${relay.audioBuffer.length}`
    );
  }

  updateUrl(sessionId: string, meetingJoinUrl: string) {
    const relay = this.sessions.get(sessionId);
    if (relay) {
      relay.meetingJoinUrl = meetingJoinUrl;
      this.logger.log(`Updated meetingJoinUrl for session ${sessionId}`);
    }
  }

  async processAndSend(sessionId: string): Promise<void> {
    const relay = this.sessions.get(sessionId);
    if (!relay) {
      throw new Error(`Relay not found for session ${sessionId}`);
    }

    if (relay.audioBuffer.length === 0) {
      this.logger.warn(`No audio data to process for session ${sessionId}`);
      return;
    }

    if (relay.isProcessing) {
      this.logger.warn(`Already processing audio for session ${sessionId}`);
      return;
    }

    relay.isProcessing = true;
    const fullAudio = Buffer.concat(relay.audioBuffer);
    this.logger.log(
      `Processing ${fullAudio.length} bytes of audio for session ${sessionId}`
    );

    // 将音频写入临时文件（解决 MP4/M4A 需要 seek 的问题）
    const tempDir = os.tmpdir();
    const tempInputFile = path.join(tempDir, `${sessionId}-input.tmp`);
    const tempOutputFile = path.join(tempDir, `${sessionId}-output.pcm`);

    try {
      // 写入临时文件
      fs.writeFileSync(tempInputFile, fullAudio);
      this.logger.log(`Wrote temp file: ${tempInputFile}`);

      // 用 ffmpeg 转码到临时输出文件
      await this.transcodeWithFfmpeg(tempInputFile, tempOutputFile, sessionId);

      // 读取转码后的 AAC 文件
      if (!fs.existsSync(tempOutputFile)) {
        throw new Error("FFmpeg output file not created");
      }

      const aacData = fs.readFileSync(tempOutputFile);
      this.logger.log(`Transcoded PCM size: ${aacData.length} bytes`);

      if (aacData.length === 0) {
        throw new Error("FFmpeg produced empty output");
      }

      // 建立 WebSocket 连接并发送
      await this.sendToTingwu(relay, aacData, sessionId);
    } finally {
      // 清理临时文件
      relay.isProcessing = false;
      try {
        if (fs.existsSync(tempInputFile)) fs.unlinkSync(tempInputFile);
        if (fs.existsSync(tempOutputFile)) fs.unlinkSync(tempOutputFile);
      } catch (e) {
        this.logger.warn(`Failed to cleanup temp files: ${e}`);
      }
    }
  }

  private transcodeWithFfmpeg(
    inputFile: string,
    outputFile: string,
    sessionId: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // 通义听悟实时转写要求：PCM 格式，16kHz，单声道，16bit
      const ffmpegProcess = spawn(ffmpeg ?? "ffmpeg", [
        "-y", // 覆盖输出文件
        "-i",
        inputFile,
        "-vn", // 不要视频
        "-acodec",
        "pcm_s16le", // PCM 16bit 小端
        "-ar",
        "16000", // 16kHz 采样率
        "-ac",
        "1", // 单声道
        "-f",
        "s16le", // 原始 PCM 格式
        outputFile,
      ]);

      let stderr = "";

      ffmpegProcess.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpegProcess.on("error", (error) => {
        this.logger.error(`ffmpeg error: ${error.message}`);
        reject(error);
      });

      ffmpegProcess.on("close", (code) => {
        if (code === 0) {
          this.logger.log(`ffmpeg transcoding completed for ${sessionId}`);
          resolve();
        } else {
          this.logger.error(`ffmpeg stderr: ${stderr}`);
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    });
  }

  private sendToTingwu(
    relay: RelaySession,
    pcmData: Buffer,
    sessionId: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WS(relay.meetingJoinUrl);
      relay.socket = socket;

      socket.on("open", () => {
        this.logger.log(`Tingwu socket open, sending StartTranscription command...`);

        // 1. 先发送 StartTranscription 控制消息
        const startCommand = JSON.stringify({
          header: {
            name: "StartTranscription",
            namespace: "SpeechTranscriber",
          },
          payload: {
            format: "pcm",
            sample_rate: 16000,
          },
        });
        socket.send(startCommand);
        this.logger.log(`Sent StartTranscription command`);

        // 2. 等待一小段时间后开始发送音频数据
        setTimeout(() => {
          this.logger.log(`Starting to send ${pcmData.length} bytes of PCM data...`);
          
          // 分块发送（每块 1024 字节，每 100ms 发送一次，模拟实时流）
          const chunkSize = 1024;
          let offset = 0;
          let sentBytes = 0;

          const sendNextChunk = () => {
            if (socket.readyState !== WS.OPEN) {
              this.logger.warn(`Socket closed during sending, sent ${sentBytes} bytes`);
              return;
            }

            if (offset >= pcmData.length) {
              this.logger.log(`All ${sentBytes} bytes sent to Tingwu`);
              
              // 3. 发送 StopTranscription 命令
              const stopCommand = JSON.stringify({
                header: {
                  name: "StopTranscription",
                  namespace: "SpeechTranscriber",
                },
                payload: {},
              });
              socket.send(stopCommand);
              this.logger.log(`Sent StopTranscription command`);
              
              // 等待服务端处理完成
              setTimeout(() => resolve(), 3000);
              return;
            }

            const end = Math.min(offset + chunkSize, pcmData.length);
            const chunk = pcmData.subarray(offset, end);

            socket.send(chunk);
            sentBytes += chunk.length;

            offset = end;

            // 每 50ms 发送一块（加快速度）
            setTimeout(sendNextChunk, 50);
          };

          sendNextChunk();
        }, 500); // 等待 500ms 让服务端准备好
      });

      socket.on("error", (error) => {
        this.logger.error(`Socket error: ${error.message}`);
        reject(error);
      });

      socket.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.logger.log(`Tingwu response: ${JSON.stringify(msg)}`);
          
          // 检查是否有转写结果
          if (msg.header?.name === "TranscriptionResultChanged" || 
              msg.header?.name === "SentenceEnd") {
            this.logger.log(`Got transcription: ${JSON.stringify(msg.payload)}`);
          }
        } catch {
          // 二进制数据
        }
      });

      socket.on("close", (code, reason) => {
        this.logger.warn(`Socket closed, code=${code}`);
      });
    });
  }

  async stop(sessionId: string) {
    const relay = this.sessions.get(sessionId);
    if (!relay) return;
    this.logger.log(`Stopping relay for session ${sessionId}`);

    if (relay.socket && relay.socket.readyState === WS.OPEN) {
      relay.socket.close();
    }
    this.sessions.delete(sessionId);
  }
}
