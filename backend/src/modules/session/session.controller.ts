import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { SessionService } from "./session.service";
import { CreateSessionDto, UploadAudioChunkDto } from "./session.dto";

@Controller("sessions")
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post()
  async createSession(@Body() body: CreateSessionDto) {
    return this.sessionService.createRealtimeSession(body);
  }

  @Get(":id/transcripts")
  async getTranscripts(@Param("id") id: string) {
    return this.sessionService.getTranscripts(id);
  }

  @Get(":id/summaries")
  async getSummaries(@Param("id") id: string) {
    return this.sessionService.getSummaries(id);
  }

  @Post(":id/skills/:skillType")
  async triggerSkill(
    @Param("id") id: string,
    @Param("skillType") skillType: "inner_os" | "brainstorm"
  ) {
    return this.sessionService.triggerSkill(id, skillType);
  }

  @Post(":id/audio")
  async uploadAudioChunk(
    @Param("id") id: string,
    @Body() body: UploadAudioChunkDto
  ) {
    await this.sessionService.ingestAudioChunk(id, body.chunk);
    return { ok: true };
  }

  @Post(":id/complete")
  async completeSession(@Param("id") id: string) {
    return this.sessionService.completeSession(id);
  }
}
