import { IsOptional, IsString } from "class-validator";

export class CreateSessionDto {
  @IsString()
  meetingId: string;

  @IsOptional()
  @IsString()
  topic?: string;
}

export class UploadAudioChunkDto {
  @IsString()
  chunk: string;
}
