'use strict';
// All provider configuration and signing remain on this server. This adapter
// never reads AI_VISION_* or inherits the function's cloud credentials.
const PROVIDER = 'tencent-trtc';
const FLOW_MODELS = Object.freeze(['flow_02_turbo', 'flow_01_turbo']);
const REGIONS = new Set(['ap-beijing', 'ap-guangzhou', 'ap-shanghai', 'ap-singapore', 'ap-tokyo', 'na-ashburn', 'na-siliconvalley']);
const POLICY = '你是 unseen 记忆相框的 AI 助手。用简短自然的中文耐心交流，不冒充家人，不编造记忆、人物关系或经历。不知道就说不知道。当前语音只用于聊天，不能执行留言、联系、发送、删除或保存；如用户要求执行，提醒其结束语音后在文字聊天中检查确认卡片。';
const disabled = reason => ({ enabled: false, provider: PROVIDER, reason });
function bridgeURL(env) {
  return /^[a-z0-9][a-z0-9-]{1,99}$/.test(env.MEMORY_CLOUDBASE_ENV || '')
    ? `https://${env.MEMORY_CLOUDBASE_ENV}.service.tcloudbase.com/internal/ai-realtime/chat/completions` : null;
}
function controlConfiguration(env = process.env) {
  const sdkAppId = Number(env.AI_REALTIME_TRTC_APP_ID), region = env.AI_REALTIME_TRTC_REGION || 'ap-shanghai';
  const secretId = env.AI_REALTIME_TRTC_SECRET_ID, secretKey = env.AI_REALTIME_TRTC_SECRET_KEY;
  if (!Number.isSafeInteger(sdkAppId) || sdkAppId <= 0 || !REGIONS.has(region) ||
    typeof secretId !== 'string' || !secretId.trim() || typeof secretKey !== 'string' || !secretKey.trim()) return null;
  return { sdkAppId, region, secretId, secretKey, token: env.AI_REALTIME_TRTC_TOKEN || undefined };
}
function configuration(env = process.env) {
  if (env.AI_REALTIME_ENABLED !== '1') return disabled('实时语音尚未开通。现在可以使用文字聊天、照片交流和录音转写。');
  if (env.AI_REALTIME_PROVIDER !== PROVIDER) return disabled('实时语音服务尚未配置完成');
  const control = controlConfiguration(env), sdkSecret = env.AI_REALTIME_TRTC_SDK_SECRET;
  if (!control || typeof sdkSecret !== 'string' || !sdkSecret.trim()) return disabled('实时语音的应用与服务端凭据尚未配置完成');
  const { sdkAppId, region, secretId, secretKey } = control;
  // Required administrator attestation; no automatic console changes.
  if (env.AI_REALTIME_TRTC_ROOM_AUTH !== '1') return disabled('实时语音尚未完成房间权限配置');
  let llm, tts;
  const llmMode = env.AI_REALTIME_LLM_MODE || 'direct';
  if (!['direct', 'cloudbase-bridge'].includes(llmMode)) return disabled('实时语音模型连接方式无效');
  try {
    tts = JSON.parse(env.AI_REALTIME_TTS_JSON);
    llm = llmMode === 'cloudbase-bridge'
      ? { LLMType: 'openai', Model: 'hy3', APIKey: 'per-call-token-required', APIUrl: bridgeURL(env) }
      : JSON.parse(env.AI_REALTIME_LLM_JSON);
  } catch { return disabled('实时语音的大模型与音色尚未配置完成'); }
  if (!llm || llm.LLMType !== 'openai' || typeof llm.Model !== 'string' || !llm.Model.trim() || typeof llm.APIKey !== 'string' || !llm.APIKey.trim()) return disabled('实时语音大模型配置不完整');
  try { const u = new URL(llm.APIUrl); if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || !u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return disabled('实时语音大模型需要公开 HTTPS 接口'); } catch { return disabled('实时语音大模型接口无效'); }
  // One documented TTS provider; no arbitrary credential-bearing JSON passthrough.
  if (!tts || tts.TTSType !== 'flow' || typeof tts.VoiceId !== 'string' || !tts.VoiceId.trim() || !FLOW_MODELS.includes(tts.Model)) return disabled('实时语音音色配置不完整');
  return { enabled: true, provider: PROVIDER, reason: '', sdkAppId, region, sdkSecret, secretId, secretKey, llmMode,
    token: env.AI_REALTIME_TRTC_TOKEN || undefined,
    llm: { LLMType: 'openai', Model: llm.Model, ...(llmMode === 'direct' ? { APIKey: llm.APIKey } : {}), APIUrl: llm.APIUrl,
      Streaming: true, History: 6, HistoryMode: 1, SystemPrompt: POLICY,
      ...(llmMode === 'cloudbase-bridge' ? { MaxTokens: 256, Temperature: 0.6, TopP: 0.8, Timeout: 20, ExtraBody: { enable_thinking: false } } : {}) },
    tts: { TTSType: 'flow', VoiceId: tts.VoiceId, Model: tts.Model, Speed: 1, Language: 'zh' } };
}
function createTRTC({ env = process.env, client: suppliedClient, signer: suppliedSigner } = {}) {
  const config = configuration(env), control = controlConfiguration(env); let client = suppliedClient, signer = suppliedSigner;
  function requireControl() {
    if (!control) throw Object.assign(Error('实时语音清理凭据尚未配置完成'), { status: 503 });
    client ||= new (require('tencentcloud-sdk-nodejs-trtc').trtc.v20190722.Client)({
      credential: { secretId: control.secretId, secretKey: control.secretKey, token: control.token }, region: control.region,
      profile: { httpProfile: { endpoint: 'trtc.tencentcloudapi.com', reqTimeout: 20 } } });
  }
  function requireReady() {
    if (!config.enabled) throw Object.assign(Error(config.reason), { status: 503 });
    requireControl();
    signer ||= new (require('tls-sig-api-v2').Api)(config.sdkAppId, config.sdkSecret);
  }
  const roomKey = (userId, roomId) => signer.genPrivateMapKeyWithStringRoomID(userId, 60, roomId, 15); // create/join/send/receive AUDIO only
  return {
    cleanupReady: () => Boolean(control),
    usesBridge: () => config.enabled && config.llmMode === 'cloudbase-bridge',
    capabilities: () => ({ enabled: config.enabled, provider: PROVIDER, reason: config.reason, verification: 'configuration-only', automaticInterruption: true }),
    credentials(entry) { requireReady(); return { sdkAppId: config.sdkAppId, userId: entry.userId, strRoomId: entry.rtcRoom,
      userSig: signer.genUserSig(entry.userId, 60), privateMapKey: roomKey(entry.userId, entry.rtcRoom), agentId: entry.agentId, credentialTtlSeconds: 60 }; },
    async start(entry, { bridgeToken } = {}) {
      requireReady();
      if (config.llmMode === 'cloudbase-bridge' && (typeof bridgeToken !== 'string' ||
        require('node:crypto').createHash('sha256').update(bridgeToken).digest('hex') !== entry.bridgeHash))
        throw Object.assign(Error('实时语音本次会话授权缺失'), { status: 503 });
      const result = await client.StartAIConversation({ SdkAppId: config.sdkAppId, RoomId: entry.rtcRoom, RoomIdType: 1,
        SessionId: entry.providerSession, AgentConfig: { UserId: entry.agentId,
          // TLS UserSig with the room permission userbuf is accepted as the bot's signature.
          UserSig: roomKey(entry.agentId, entry.rtcRoom), TargetUserId: entry.userId,
          MaxIdleTime: 60, InterruptMode: 0, InterruptSpeechDuration: 300, TurnDetectionMode: 0,
          FilterOneWord: false, WelcomeMessage: '', WelcomeMessagePriority: 0 },
        STTConfig: { Language: 'zh' }, LLMConfig: JSON.stringify({ ...config.llm,
          ...(config.llmMode === 'cloudbase-bridge' ? { APIKey: bridgeToken } : {}) }), TTSConfig: JSON.stringify(config.tts) });
      if (!result?.TaskId) throw Error('TRTC start missing task');
      return result.TaskId;
    },
    async lookup(entry) {
      requireControl();
      try {
        const result = await client.DescribeAIConversation({ SdkAppId: control.sdkAppId, SessionId: entry.providerSession });
        // A malformed success is not authoritative evidence that no task exists.
        if (typeof result?.TaskId !== 'string' || !result.TaskId) throw Error('TRTC lookup missing task');
        return result.TaskId;
      }
      catch (error) {
        if (error.code === 'FailedOperation.TaskNotExist') return null;
        // Versions through 0.5.1 generated a 71-character SessionId. Reconcile
        // only an explicitly rejected, settled legacy Start when Describe also
        // confirms that exact impossible ID length. Unknown starts remain pending.
        if (entry.status === 'stopping' && entry.attempted === true && entry.startSettled === true &&
          entry.startFailureCode === 'InvalidParameter' && entry.taskId === '' &&
          /^unseen_[a-f0-9]{64}$/.test(entry.providerSession || '') &&
          error.code === 'InvalidParameter' &&
          /\binvalid DescribeAIConversationReq\.SessionId: value length must be at most 64 runes\b/.test(error.message || '')) return null;
        throw error;
      }
    },
    async stop(taskId) {
      requireControl();
      try { await client.StopAIConversation({ TaskId: taskId }); }
      catch (error) { if (error.code !== 'FailedOperation.TaskNotExist') throw error; }
    }
  };
}
module.exports = { createTRTC, configuration, controlConfiguration, POLICY, FLOW_MODELS, bridgeURL };
