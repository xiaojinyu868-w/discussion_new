import { apiClient } from "./client";
import { SpeakerSegment, SummaryCard } from "@/store/useSessionStore";

export const sessionApi = {
  create: () =>
    apiClient.post<{
      sessionId: string;
      taskId: string;
      meetingJoinUrl: string;
    }>("/sessions", {
      meetingId: `meeting-${Date.now()}`,
    }),
  fetchTranscripts: (sessionId: string) =>
    apiClient.get<{
      sessionId: string;
      transcription: SpeakerSegment[];
      taskStatus?: string;
    }>(`/sessions/${sessionId}/transcripts`),
  fetchSummaries: (sessionId: string) =>
    apiClient.get<{
      sessionId: string;
      summaries: SummaryCard[];
    }>(`/sessions/${sessionId}/summaries`),
  uploadAudioChunk: (sessionId: string, chunk: string) =>
    apiClient.post<{ ok: boolean }>(`/sessions/${sessionId}/audio`, {
      chunk,
    }),
  complete: (sessionId: string) =>
    apiClient.post<{ ok: boolean }>(`/sessions/${sessionId}/complete`),
  triggerSkill: (sessionId: string, skill: "inner_os" | "brainstorm") =>
    apiClient.post<{
      cards: SummaryCard[];
    }>(`/sessions/${sessionId}/skills/${skill}`),
};
