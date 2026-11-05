import OpenAI from 'openai';
import { LiveWS } from 'openai/resources/live/ws';
import type { SessionStartEvent } from 'openai/resources/live/live';

export const AUDIO_CONTENT_TYPE = 'audio/l16;rate=24000';

// VonageとOpenAIの両方でPCM16LE/24kHzを使い、音声の再変換を省く。
export function sessionStart(backendModel: string): SessionStartEvent {
  return {
    type: 'session.start',
    session: {
      model: 'gpt-live-1',
      store: false,
      instructions:
        'あなたは日本語で話すAIです。これは本人の携帯への短い会話テストです。短く自然に返答し、最初は挨拶して音声が聞こえるか確認してください。外部操作は行いません。',
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
      delegation: {
        type: 'responses',
        responses: {
          model: backendModel,
          instructions: '日本語で短い会話をしてください。外部操作や検索は行いません。',
          tools: [],
        },
      },
    },
  };
}

export function connectLive(apiKey: string | undefined): LiveWS {
  return new LiveWS(new OpenAI({ apiKey }));
}
