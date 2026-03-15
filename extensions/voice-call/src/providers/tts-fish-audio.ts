import { pcmToMulaw } from "../telephony-audio.js";

/**
 * Fish Audio TTS Provider
 *
 * Generates speech audio using Fish Audio's text-to-speech API.
 * Handles audio format conversion for telephony (mu-law 8kHz).
 *
 * Fish Audio supports voice cloning and returns PCM audio at configurable
 * sample rates. We request 24kHz to match the OpenAI provider pipeline,
 * then reuse the same resample + mu-law encoding path.
 *
 * @see https://docs.fish.audio
 */

/**
 * Fish Audio TTS configuration.
 */
export interface FishAudioTTSConfig {
  /** Fish Audio API key (uses FISH_AUDIO_API_KEY env if not set) */
  apiKey?: string;
  /** Voice/reference ID for the cloned voice (uses FISH_AUDIO_VOICE_ID env if not set) */
  voiceId?: string;
  /** Model to use. Always s2-pro unless explicitly overridden. */
  model?: string;
  /** Latency mode: "normal" (best quality), "balanced" (~300ms), "low" (fastest) */
  latency?: "normal" | "balanced" | "low";
  /** Temperature for generation (0-1). Default: 0.7 */
  temperature?: number;
  /** Top-p sampling (0-1). Default: 0.7 */
  topP?: number;
  /** Normalize text for numbers/dates. Default: true */
  normalize?: boolean;
  /** Characters per chunk. Default: 200 */
  chunkLength?: number;
  /** Prosody speed multiplier (0.5-2.0). Default: 1.0 */
  speed?: number;
  /** Repetition penalty (>1.0 reduces repetition). Default: 1.2 */
  repetitionPenalty?: number;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Fish Audio TTS Provider for generating speech audio.
 */
export class FishAudioTTSProvider {
  private apiKey: string;
  private voiceId: string;
  private model: string;
  private latency: "normal" | "balanced" | "low";
  private temperature: number;
  private topP: number;
  private normalize: boolean;
  private chunkLength: number;
  private speed: number;
  private repetitionPenalty: number;

  constructor(config: FishAudioTTSConfig = {}) {
    this.apiKey =
      trimToUndefined(config.apiKey) ?? trimToUndefined(process.env.FISH_AUDIO_API_KEY) ?? "";
    this.voiceId =
      trimToUndefined(config.voiceId) ?? trimToUndefined(process.env.FISH_AUDIO_VOICE_ID) ?? "";
    this.model = trimToUndefined(config.model) ?? "s2-pro";
    this.latency = config.latency ?? "balanced";
    this.temperature = config.temperature ?? 0.7;
    this.topP = config.topP ?? 0.7;
    this.normalize = config.normalize ?? true;
    this.chunkLength = config.chunkLength ?? 200;
    this.speed = config.speed ?? 1.0;
    this.repetitionPenalty = config.repetitionPenalty ?? 1.2;

    if (!this.apiKey) {
      throw new Error(
        "Fish Audio API key required (set FISH_AUDIO_API_KEY or pass apiKey in config)",
      );
    }
    if (!this.voiceId) {
      throw new Error(
        "Fish Audio voice ID required (set FISH_AUDIO_VOICE_ID or pass voiceId in config)",
      );
    }
  }

  /**
   * Generate speech audio from text.
   * Returns raw PCM audio data (24kHz, mono, 16-bit signed LE).
   * Same format as OpenAI TTS output.
   */
  async synthesize(text: string): Promise<Buffer> {
    const body = {
      text,
      reference_id: this.voiceId,
      format: "pcm",
      pcm_sample_rate: 24000,
      latency: this.latency,
      normalize: this.normalize,
      chunk_length: this.chunkLength,
      temperature: this.temperature,
      top_p: this.topP,
      repetition_penalty: this.repetitionPenalty,
      prosody: {
        speed: this.speed,
        volume: 0,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let response: Response;
    try {
      response = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          model: this.model,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("Fish Audio timeout after 10s");
      }
      throw new Error(
        `Fish Audio network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      if (response.status === 401) {
        throw new Error("Fish Audio auth failed — check FISH_AUDIO_API_KEY");
      }
      if (response.status === 429) {
        throw new Error("Fish Audio rate limited");
      }
      if (response.status >= 500) {
        throw new Error(`Fish Audio server error: ${response.status}`);
      }
      throw new Error(`Fish Audio TTS failed: ${response.status} - ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length === 0) {
      throw new Error("Fish Audio returned empty audio");
    }

    return buffer;
  }

  /**
   * Generate speech and convert to mu-law format for telephony.
   * Twilio/Telnyx Media Streams expect 8kHz mono mu-law audio.
   */
  async synthesizeForTwilio(text: string): Promise<Buffer> {
    // Get raw PCM from Fish Audio (24kHz, 16-bit signed LE, mono)
    const pcm24k = await this.synthesize(text);

    // Resample from 24kHz to 8kHz
    const pcm8k = resample24kTo8k(pcm24k);

    // Encode to mu-law
    return pcmToMulaw(pcm8k);
  }
}

/**
 * Resample 24kHz PCM to 8kHz using linear interpolation.
 * Input/output: 16-bit signed little-endian mono.
 * (Same algorithm as tts-openai.ts)
 */
function resample24kTo8k(input: Buffer): Buffer {
  const inputSamples = input.length / 2;
  const outputSamples = Math.floor(inputSamples / 3);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * 3;
    const srcIdx = srcPos * 2;

    if (srcIdx + 3 < input.length) {
      const s0 = input.readInt16LE(srcIdx);
      const s1 = input.readInt16LE(srcIdx + 2);
      const frac = srcPos % 1 || 0;
      const sample = Math.round(s0 + frac * (s1 - s0));
      output.writeInt16LE(clamp16(sample), i * 2);
    } else {
      output.writeInt16LE(input.readInt16LE(srcIdx), i * 2);
    }
  }

  return output;
}

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}
