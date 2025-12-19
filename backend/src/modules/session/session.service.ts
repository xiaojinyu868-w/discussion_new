import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { TingwuService } from "../tingwu/tingwu.service";
import { CreateSessionDto } from "./session.dto";
import { v4 as uuid } from "uuid";
import { PollerService } from "../task-poller/poller.service";
import { AudioRelayService } from "../tingwu/audio-relay.service";

type Transcript = {
  id: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private sessions = new Map<
    string,
    { taskId: string; meetingJoinUrl: string }
  >();
  private transcripts = new Map<string, Transcript[]>();
  private summaries = new Map<string, any[]>();
  private taskStatuses = new Map<string, string | undefined>();

  constructor(
    private readonly tingwuService: TingwuService,
    private readonly pollerService: PollerService,
    private readonly audioRelayService: AudioRelayService
  ) {}

  async createRealtimeSession(body: CreateSessionDto) {
    const sessionId = uuid();
    const { taskId, meetingJoinUrl } =
      await this.tingwuService.createRealtimeTask(body);

    this.sessions.set(sessionId, { taskId, meetingJoinUrl });
    this.taskStatuses.set(sessionId, "NEW");
    this.audioRelayService.create(sessionId, meetingJoinUrl);
    this.pollerService.registerTask(sessionId, taskId, async (payload) => {
      if (payload.transcription?.length) {
        const existing = this.transcripts.get(sessionId) ?? [];
        const map = new Map<string, Transcript>();
        [...existing, ...payload.transcription].forEach((segment) => {
          map.set(segment.id, segment);
        });
        const merged = Array.from(map.values()).sort(
          (a, b) => a.startMs - b.startMs
        );
        this.transcripts.set(sessionId, merged);
      }
      if (payload.summaries?.length) {
        const existing = this.summaries.get(sessionId) ?? [];
        const combined = new Map<string, any>();
        [...existing, ...payload.summaries].forEach((card) => {
          combined.set(card.id, card);
        });
        this.summaries.set(sessionId, Array.from(combined.values()));
      }
      if (payload.taskStatus) {
        this.taskStatuses.set(sessionId, payload.taskStatus);
      }
    });

    return {
      sessionId,
      taskId,
      meetingJoinUrl,
    };
  }

  async ingestAudioChunk(sessionId: string, base64Chunk: string) {
    if (!this.sessions.has(sessionId)) {
      throw new NotFoundException("Session not found");
    }
    const buffer = Buffer.from(base64Chunk, "base64");
    try {
      await this.audioRelayService.write(sessionId, buffer);
    } catch (error) {
      const relayError = error as Error;
      if (
        relayError?.message.includes("Relay not found") ||
        relayError?.message.includes("Relay input closed")
      ) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw relayError;
        }
        this.logger.warn(
          `Audio relay unavailable for session ${sessionId}, attempting to recreate`
        );
        this.audioRelayService.create(sessionId, session.meetingJoinUrl);
        await this.audioRelayService.write(sessionId, buffer);
        return;
      }
      throw relayError;
    }
  }

  async completeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException("Session not found");
    }
    await this.audioRelayService.stop(sessionId);
    this.pollerService.unregisterTask(sessionId);
    await this.tingwuService.stopRealtimeTask(session.taskId);
    this.taskStatuses.set(sessionId, "COMPLETED");
    return { ok: true };
  }

  async getTranscripts(sessionId: string) {
    return {
      sessionId,
      transcription: this.transcripts.get(sessionId) ?? [],
      taskStatus: this.taskStatuses.get(sessionId),
    };
  }

  async getSummaries(sessionId: string) {
    return {
      sessionId,
      summaries: this.summaries.get(sessionId) ?? [],
    };
  }

  async triggerSkill(sessionId: string, skill: "inner_os" | "brainstorm") {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    const result = await this.tingwuService.triggerCustomPrompt(
      session.taskId,
      skill
    );
    const cards = this.normalizeCustomPrompt(result, skill, session.taskId);
    if (cards.length) {
      const existing = this.summaries.get(sessionId) ?? [];
      const combined = new Map<string, any>();
      [...existing, ...cards].forEach((card) => {
        combined.set(card.id, card);
      });
      this.summaries.set(sessionId, Array.from(combined.values()));
    }
    return {
      cards,
    };
  }

  private normalizeCustomPrompt(
    raw: any,
    skill: "inner_os" | "brainstorm",
    taskId: string
  ) {
    const data = raw?.Data ?? raw?.data ?? {};
    const result =
      data.Result ??
      data?.results ??
      raw?.result ??
      raw ??
      {};
    const items: any[] =
      result?.Items ??
      result?.items ??
      result ??
      [];
    if (!Array.isArray(items)) {
      return [];
    }
    return items.map((item: any, index: number) => ({
      id: `${taskId}-${skill}-${index}`,
      type: skill === "inner_os" ? "inner_os" : "brainstorm",
      title: skill === "inner_os" ? "内心OS" : "头脑风暴",
      content: item,
      updatedAt: new Date().toISOString(),
    }));
  }
}
