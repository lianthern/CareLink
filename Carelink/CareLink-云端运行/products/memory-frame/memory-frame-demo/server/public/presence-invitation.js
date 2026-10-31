'use strict';
// Presence only invites. Camera capture is owned by the explicit frame control;
// accepting an invitation never opens the microphone.
globalThis.MemoryPresence = (() => {
  let invitation = null, guardTimer = null, lastLocalInvitationAt = 0, lastInvitationAt = 0;
  const seenInPage = new Map();
  const valid = event => event && event.type === 'presence.dwell'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.eventId)
    && Number.isSafeInteger(event.seq) && event.seq > 0
    && Number.isSafeInteger(event.receivedAt) && Number.isSafeInteger(event.expiresAt)
    && event.expiresAt > event.receivedAt && event.expiresAt - event.receivedAt <= 15000;
  const log = (event, outcome, reason) => console.info('[presence]', {
    eventId: event.eventId, seq: event.seq, outcome, ...(reason ? { reason } : {})
  });
  // Full request RTT is a conservative upper bound on time in transit. Adding it
  // prevents a slow state response from granting an already expired event a new TTL.
  function serverNow() {
    return Number.isFinite(state?.serverTime) && Number.isFinite(stateReceivedAt)
      ? state.serverTime + Math.max(0, typeof stateRoundTripMs === 'number' ? stateRoundTripMs : 0) + Math.max(0, performance.now() - stateReceivedAt) : Date.now();
  }
  function gate(fixedPhoto) {
    if (!frame || location.pathname !== '/frame' || session?.role !== 'frame') return 'wrong-page';
    if (!session?.token || sessionExpired || authScreenActive) return 'session';
    if (document.hidden || document.documentElement.classList.contains('night-view')) return 'hidden';
    if (recording || recordingStarting || sending) return 'recording';
    if ((frameAudio && !frameAudio.paused && !frameAudio.ended)
      || [...document.querySelectorAll('audio')].some(audio => !audio.paused && !audio.ended)) return 'audio';
    if (globalThis.MemoryRealtime?.busy() || globalThis.MemoryAI?.busy()
      || globalThis.MemoryCall?.busy?.() || (globalThis.speechSynthesis?.speaking && !invitation?.utterance)) return 'conversation';
    if ([...document.querySelectorAll('dialog[open]')].some(dialog => dialog !== invitation?.dialog)) return 'dialog';
    const photo = fixedPhoto ? state?.messages.find(message => message._id === fixedPhoto) : current();
    if (!photo || photo.deleted || photo.type !== 'photo' || !photo.image || !photo.imageURL) return 'no-photo';
    if (typeof globalThis.MemoryAI?.openFromPresence !== 'function') return 'ai-unavailable';
    return '';
  }
  function close(reason = 'closed') {
    const previous = invitation; invitation = null;
    clearInterval(guardTimer); guardTimer = null;
    if (!previous) return;
    previous.removeAbort?.();
    if (previous.utterance) { previous.utterance = null; globalThis.speechSynthesis?.cancel(); }
    previous.dialog.close(); previous.dialog.remove();
    log(previous.event, 'closed', reason);
    if (['declined', 'accepted'].includes(reason) && previous.focus?.isConnected) previous.focus.focus?.({ preventScroll: true });
  }
  function guard() {
    if (!invitation) return;
    if (invitation.token !== session?.token) return close('session');
    if ((invitation.local ? Date.now() : serverNow()) >= invitation.event.expiresAt) return close('expired');
    const reason = gate(invitation.photoId);
    if (reason) close(reason);
  }
  function consume(event) {
    const storageKey = 'memory-presence-seen-v1:' + session.room;
    let stored;
    try { stored = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return 'storage-unavailable'; }
    const previous = seenInPage.get(storageKey);
    if ([stored, previous].some(value => value && (value.seq >= event.seq || value.eventId === event.eventId))) return 'duplicate';
    // Persist before checking visibility/busy gates: ignored events are never queued.
    const value = { seq: event.seq, eventId: event.eventId };
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { return 'storage-unavailable'; }
    seenInPage.set(storageKey, value);
    return '';
  }
  function show(event, { local = false, signal, speak = false } = {}) {
    lastInvitationAt = Date.now();
    const dialog = document.createElement('dialog');
    dialog.id = 'presenceInvitation'; dialog.className = 'presence-invitation';
    dialog.setAttribute('aria-labelledby', 'presenceInvitationTitle');
    dialog.setAttribute('aria-describedby', 'presenceInvitationNote');
    dialog.innerHTML = '<p class="presence-eyebrow">一起聊聊家里的记忆</p><h2 id="presenceInvitationTitle">想聊聊这张照片吗？</h2><p id="presenceInvitationNote">确认后，AI 会读取这张照片，先温和地问您一句。不会自动打开麦克风。</p><div class="presence-invitation-actions"><button id="presenceAccept" class="primary" type="button">和 AI 聊聊</button><button id="presenceDecline" type="button" autofocus>暂时不用</button></div>';
    invitation = { event, photoId: current()._id, token: session.token, dialog, focus: document.activeElement, local };
    if (signal) {
      const abort = () => { if (invitation?.event === event) close('camera-unavailable'); };
      signal.addEventListener('abort', abort, { once: true });
      invitation.removeAbort = () => signal.removeEventListener('abort', abort);
    }
    document.body.append(dialog);
    dialog.querySelector('#presenceDecline').onclick = () => close('declined');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close('declined'); });
    dialog.querySelector('#presenceAccept').onclick = async () => {
      guard(); const accepted = invitation; if (!accepted) return;
      close('accepted'); log(accepted.event, 'accepted');
      try {
        const result = await globalThis.MemoryAI.openFromPresence(accepted.photoId);
        log(accepted.event, result?.opened && session?.token === accepted.token && !sessionExpired ? 'ai-opened' : 'ai-not-opened');
      } catch { log(accepted.event, 'ai-open-failed'); toast('暂时未能打开 AI 聊天，请稍后再试'); }
    };
    dialog.showModal(); log(event, 'shown');
    guardTimer = setInterval(guard, 200);
    // This optional invitation was enabled by the camera button. It contains no
    // model request or recording, and failure leaves the visible question usable.
    if (local && speak && globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance) {
      try {
        const utterance = new SpeechSynthesisUtterance('您好，想聊聊这张照片吗？');
        utterance.lang = 'zh-CN'; utterance.rate = 0.9;
        const active = invitation; active.utterance = utterance;
        utterance.onend = utterance.onerror = () => { if (active.utterance === utterance) active.utterance = null; };
        speechSynthesis.speak(utterance);
      } catch { if (invitation?.event === event) invitation.utterance = null; }
    }
  }
  function receive(event) {
    if (!frame || session?.role !== 'frame' || !session?.token || sessionExpired || authScreenActive) { close('session'); return; }
    guard();
    if (!event) { if (!invitation?.local) close('unavailable'); return; }
    if (!valid(event)) return;
    const consumed = consume(event);
    if (consumed) { log(event, consumed === 'duplicate' ? 'duplicate' : 'ignored', consumed === 'duplicate' ? undefined : consumed); return; }
    log(event, 'received');
    if (event.expiresAt <= serverNow() || event.receivedAt > serverNow() + 1000) { log(event, 'expired'); return; }
    const reason = invitation ? 'invitation' : gate();
    if (reason) { log(event, 'ignored', reason); return; }
    if (Date.now() - lastLocalInvitationAt < 60000) { log(event, 'ignored', 'local-cooldown'); return; }
    show(event);
  }
  function receiveLocal(observation, { speak = false } = {}) {
    guard();
    if (!observation?.signal || observation.signal.aborted || !Number.isFinite(observation.observedAt)
        || Date.now() - observation.observedAt < 0 || Date.now() - observation.observedAt > 1500
        || invitation || gate() || Date.now() - lastInvitationAt < 60000) return false;
    const receivedAt = Date.now();
    lastLocalInvitationAt = receivedAt;
    show({ eventId: crypto.randomUUID(), seq: 0, type: 'presence.dwell', receivedAt,
      expiresAt: receivedAt + 15000, source: 'browser-camera' }, { local: true, signal: observation.signal, speak });
    return true;
  }
  document.addEventListener('visibilitychange', guard);
  document.addEventListener('play', guard, true);
  globalThis.addEventListener('pagehide', () => close('pagehide'));
  return { receive, receiveLocal, close, guard,
    closeLocal(reason) { if (invitation?.local) close(reason); },
    speaking() { return !!invitation?.utterance; } };
})();
