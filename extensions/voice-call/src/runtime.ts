import type { VoiceCallConfig } from "./config.js";
import { resolveVoiceCallConfig, validateProviderConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { MockProvider } from "./providers/mock.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TelnyxProvider } from "./providers/telnyx.js";
import { FishAudioTTSProvider } from "./providers/tts-fish-audio.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { cleanupTailscaleExposure, setupTailscaleExposure } from "./webhook/tailscale.js";

export type VoiceCallRuntime = {
  config: VoiceCallConfig;
  provider: VoiceCallProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

function createRuntimeResourceLifecycle(params: {
  config: VoiceCallConfig;
  webhookServer: VoiceCallWebhookServer;
}): {
  setTunnelResult: (result: TunnelResult | null) => void;
  stop: (opts?: { suppressErrors?: boolean }) => Promise<void>;
} {
  let tunnelResult: TunnelResult | null = null;
  let stopped = false;

  const runStep = async (step: () => Promise<void>, suppressErrors: boolean) => {
    if (suppressErrors) {
      await step().catch(() => {});
      return;
    }
    await step();
  };

  return {
    setTunnelResult: (result) => {
      tunnelResult = result;
    },
    stop: async (opts) => {
      if (stopped) {
        return;
      }
      stopped = true;
      const suppressErrors = opts?.suppressErrors ?? false;
      await runStep(async () => {
        if (tunnelResult) {
          await tunnelResult.stop();
        }
      }, suppressErrors);
      await runStep(async () => {
        await cleanupTailscaleExposure(params.config);
      }, suppressErrors);
      await runStep(async () => {
        await params.webhookServer.stop();
      }, suppressErrors);
    },
  };
}

function isLoopbackBind(bind: string | undefined): boolean {
  if (!bind) {
    return false;
  }
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

function resolveProvider(config: VoiceCallConfig): VoiceCallProvider {
  const allowNgrokFreeTierLoopbackBypass =
    config.tunnel?.provider === "ngrok" &&
    isLoopbackBind(config.serve?.bind) &&
    (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);

  switch (config.provider) {
    case "telnyx":
      return new TelnyxProvider(
        {
          apiKey: config.telnyx?.apiKey,
          connectionId: config.telnyx?.connectionId,
          publicKey: config.telnyx?.publicKey,
        },
        {
          skipVerification: config.skipSignatureVerification,
        },
      );
    case "twilio":
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: config.twilio?.authToken,
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled ? config.streaming.streamPath : undefined,
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "plivo":
      return new PlivoProvider(
        {
          authId: config.plivo?.authId,
          authToken: config.plivo?.authToken,
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1000)),
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
  }
}

export async function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: Logger;
}): Promise<VoiceCallRuntime> {
  const { config: rawConfig, coreConfig, ttsRuntime, logger } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const config = resolveVoiceCallConfig(rawConfig);

  if (!config.enabled) {
    throw new Error("Voice call disabled. Enable the plugin entry in config.");
  }

  if (config.skipSignatureVerification) {
    log.warn(
      "[voice-call] SECURITY WARNING: skipSignatureVerification=true disables webhook signature verification (development only). Do not use in production.",
    );
  }

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
  }

  const provider = resolveProvider(config);
  const manager = new CallManager(config);
  const webhookServer = new VoiceCallWebhookServer(config, manager, provider, coreConfig);
  const lifecycle = createRuntimeResourceLifecycle({ config, webhookServer });

  const localUrl = await webhookServer.start();

  // Wrap remaining initialization in try/catch so the webhook server is
  // properly stopped if any subsequent step fails.  Without this, the server
  // keeps the port bound while the runtime promise rejects, causing
  // EADDRINUSE on the next attempt.  See: #32387
  try {
    // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
    let publicUrl: string | null = config.publicUrl ?? null;

    if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
      try {
        const nextTunnelResult = await startTunnel({
          provider: config.tunnel.provider,
          port: config.serve.port,
          path: config.serve.path,
          ngrokAuthToken: config.tunnel.ngrokAuthToken,
          ngrokDomain: config.tunnel.ngrokDomain,
        });
        lifecycle.setTunnelResult(nextTunnelResult);
        publicUrl = nextTunnelResult?.publicUrl ?? null;
      } catch (err) {
        log.error(
          `[voice-call] Tunnel setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!publicUrl && config.tailscale?.mode !== "off") {
      publicUrl = await setupTailscaleExposure(config);
    }

    const webhookUrl = publicUrl ?? localUrl;

    if (publicUrl && provider.name === "twilio") {
      (provider as TwilioProvider).setPublicUrl(publicUrl);
    }

    if (provider.name === "twilio" && config.streaming?.enabled) {
      const twilioProvider = provider as TwilioProvider;
      if (ttsRuntime?.textToSpeechTelephony) {
        try {
          const ttsProvider = createTelephonyTtsProvider({
            coreConfig,
            ttsOverride: config.tts,
            runtime: ttsRuntime,
          });
          twilioProvider.setTTSProvider(ttsProvider);
          log.info("[voice-call] Telephony TTS provider configured");
        } catch (err) {
          log.warn(
            `[voice-call] Failed to initialize telephony TTS: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else {
        log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
      }

      const mediaHandler = webhookServer.getMediaStreamHandler();
      if (mediaHandler) {
        twilioProvider.setMediaStreamHandler(mediaHandler);
        log.info("[voice-call] Media stream handler wired to provider");
      }
    }

    // Wire Fish Audio TTS bridge for Telnyx provider
    if (provider.name === "telnyx") {
      const pluginTtsProvider = config.tts?.provider;
      const pluginFishConfig = (config.tts as Record<string, unknown>)?.["fish-audio"] as
        | Record<string, unknown>
        | undefined;

      if (pluginTtsProvider === "fish-audio") {
        const effectiveFishConfig = pluginFishConfig ?? {};
        try {
          const fishTts = new FishAudioTTSProvider({
            apiKey: effectiveFishConfig.apiKey as string | undefined,
            voiceId: effectiveFishConfig.voiceId as string | undefined,
            model: effectiveFishConfig.model as string | undefined,
            latency: effectiveFishConfig.latency as "normal" | "balanced" | "low" | undefined,
            temperature: effectiveFishConfig.temperature as number | undefined,
            topP: effectiveFishConfig.topP as number | undefined,
            normalize: effectiveFishConfig.normalize as boolean | undefined,
            chunkLength: effectiveFishConfig.chunkLength as number | undefined,
            speed: effectiveFishConfig.speed as number | undefined,
          });

          const audioBaseUrl = publicUrl ?? webhookUrl;
          let audioCounter = 0;

          (provider as TelnyxProvider).setFishAudioBridge({
            generateAndServe: async (text: string, callId: string) => {
              const pcm24k = await fishTts.synthesize(text);
              const audioId = `${callId}-${++audioCounter}`;
              const wavBuffer = buildWavBuffer(pcm24k, 24000, 1, 16);
              const localUrl = webhookServer.storeAudio(audioId, wavBuffer);
              if (publicUrl) {
                return localUrl.replace(webhookUrl, publicUrl);
              }
              return localUrl;
            },
          });

          log.info("[voice-call] Fish Audio TTS bridge configured for Telnyx");
        } catch (err) {
          log.warn(
            `[voice-call] Failed to initialize Fish Audio TTS: ${
              err instanceof Error ? err.message : String(err)
            }. Falling back to native Telnyx speak.`,
          );
        }
      }
    }

    await manager.initialize(provider, webhookUrl);

    const stop = async () => await lifecycle.stop();

    log.info("[voice-call] Runtime initialized");
    log.info(`[voice-call] Webhook URL: ${webhookUrl}`);
    if (publicUrl) {
      log.info(`[voice-call] Public URL: ${publicUrl}`);
    }

    return {
      config,
      provider,
      manager,
      webhookServer,
      webhookUrl,
      publicUrl,
      stop,
    };
  } catch (err) {
    // If any step after the server started fails, clean up every provisioned
    // resource (tunnel, tailscale exposure, and webhook server) so retries
    // don't leak processes or keep the port bound.
    await lifecycle.stop({ suppressErrors: true });
    throw err;
  }
}

/**
 * Build a WAV file buffer from raw PCM data.
 * Standard RIFF WAV header (44 bytes) + PCM data.
 */
function buildWavBuffer(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
