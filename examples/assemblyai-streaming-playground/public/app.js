const $ = selector => document.querySelector(selector);
const form = $('#settings');
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms

const state = {
  socket: null,
  source: null,
  status: 'ready',
  startedAt: 0,
  partials: 0,
  // wall-clock time each 100 ms audio chunk left the browser, by chunk index
  chunkSentAt: [],
  // speech onset (audio ms) reported by SpeechStarted, waiting for its turn
  pendingSpeechStartMs: null,
  // per turn_order: { firstPartialMs, finalMs } latencies in milliseconds
  latency: new Map(),
  turns: new Map(),
  speakerOrder: [],
  events: new Map(),
  // latest end_of_turn_confidence per turn_order, from the raw Turn messages
  confidence: new Map(),
};

// ---------- settings -> providerOptions ----------

function readSettings() {
  const data = new FormData(form);
  const text = key => (data.get(key) ?? '').toString().trim();
  const num = key => (text(key) === '' ? undefined : Number(text(key)));
  const bool = key => data.get(key) != null;
  const list = key =>
    text(key) === ''
      ? undefined
      : text(key)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
  const tri = key => (text(key) === '' ? undefined : text(key) === 'true');
  const set = (target, key, value) => {
    if (value !== undefined && value !== '' && value !== false)
      target[key] = value;
  };

  const model = text('model');
  const options = {};
  const streaming = {};

  set(options, 'prompt', text('prompt'));
  set(options, 'keytermsPrompt', list('keyterms'));
  set(options, 'languageDetection', bool('languageDetection'));
  set(options, 'speakerLabels', bool('speakerLabels'));
  if (bool('redactPii')) {
    options.redactPii = true;
    set(options, 'redactPiiPolicies', list('redactPiiPolicies'));
    set(options, 'redactPiiSub', text('redactPiiSub'));
  }

  set(streaming, 'mode', text('mode'));
  set(streaming, 'languageCodes', list('languageCodes'));
  if (bool('speakerLabels')) {
    set(streaming, 'maxSpeakers', num('maxSpeakers'));
    set(streaming, 'speakerLabelsRevisionIntervalMs', num('revisionInterval'));
  }
  if (tri('includePartialTurns') !== undefined)
    streaming.includePartialTurns = tri('includePartialTurns');
  set(streaming, 'formatTurns', bool('formatTurns'));
  set(streaming, 'minTurnSilence', num('minTurnSilence'));
  set(streaming, 'maxTurnSilence', num('maxTurnSilence'));
  set(streaming, 'interruptionDelay', num('interruptionDelay'));
  if (tri('continuousPartials') !== undefined)
    streaming.continuousPartials = tri('continuousPartials');
  set(
    streaming,
    'endOfTurnConfidenceThreshold',
    num('endOfTurnConfidenceThreshold'),
  );
  set(streaming, 'voiceFocus', text('voiceFocus'));
  if (text('voiceFocus'))
    set(streaming, 'voiceFocusThreshold', num('voiceFocusThreshold'));
  set(streaming, 'vadThreshold', num('vadThreshold'));
  set(streaming, 'sessionHeartbeat', bool('sessionHeartbeat'));
  set(streaming, 'acknowledgeSilence', bool('acknowledgeSilence'));
  if (Object.keys(streaming).length > 0) options.streaming = streaming;

  return { model, options };
}

// ---------- code panel ----------

function escapeHtml(text) {
  return text.replace(
    /[&<>]/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch],
  );
}

// Brand code conventions: keywords green, strings Cobolt, numbers orange.
function highlight(code) {
  const tokens =
    /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*')|\b(\d+(?:\.\d+)?)\b|\b(import|from|const|await|for|of|if|true|false|null)\b/g;
  return escapeHtml(code).replace(
    tokens,
    (match, comment, string, number, keyword) => {
      if (comment) return `<span class="c">${comment}</span>`;
      if (string) return `<span class="s">${string}</span>`;
      if (number) return `<span class="n">${number}</span>`;
      if (keyword) return `<span class="k">${keyword}</span>`;
      return match;
    },
  );
}

function toObjectLiteral(value, indent) {
  return JSON.stringify(value, null, 2)
    .replace(/"([A-Za-z_$][\w$]*)":/g, '$1:')
    .replace(/"/g, "'")
    .split('\n')
    .join('\n' + ' '.repeat(indent));
}

function renderCode() {
  const { model, options } = readSettings();
  const hasOptions = Object.keys(options).length > 0;
  const code = `import { createAssemblyAI } from '@ai-sdk/assemblyai';
import { experimental_streamTranscribe as streamTranscribe } from 'ai';
import { WebSocket } from 'ws';

const assemblyai = createAssemblyAI({ webSocket: WebSocket });

const result = streamTranscribe({
  model: assemblyai.transcription('${model}'),
  audio, // ReadableStream<Uint8Array> of 16 kHz 16-bit PCM
  inputAudioFormat: { type: 'audio/pcm', rate: 16000 },${
    hasOptions
      ? `
  providerOptions: {
    assemblyai: ${toObjectLiteral(options, 4)},
  },`
      : ''
  }
});

for await (const part of result.fullStream) {
  if (part.type === 'transcript-partial') show(part.id, part.text, { partial: true });
  if (part.type === 'transcript-final') show(part.id, part.text, part.providerMetadata?.assemblyai);
}`;
  $('#code').innerHTML = highlight(code);
}

form.addEventListener('input', renderCode);
form.addEventListener('change', renderCode);
renderCode();

$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#code').textContent);
  $('#copy').textContent = 'Copied';
  setTimeout(() => ($('#copy').textContent = 'Copy'), 1500);
});

// ---------- session ----------

function setStatus(status, detail) {
  state.status = status;
  const labels = {
    ready: 'Ready',
    connecting: 'Connecting',
    listening: 'Listening',
    finishing: 'Finishing',
    done: 'Done',
    error: 'Error',
  };
  $('#status').dataset.state = status;
  $('#statusText').textContent = detail
    ? `${labels[status]}: ${detail}`
    : labels[status];
  const live =
    status === 'connecting' || status === 'listening' || status === 'finishing';
  $('#mic').disabled = live;
  $('#sample').disabled = live;
  $('#stop').disabled = status !== 'listening';
  $('#settingsPanel').setAttribute('aria-disabled', String(live));
}

function resetSession() {
  state.turns.clear();
  state.speakerOrder = [];
  state.events.clear();
  state.confidence.clear();
  state.latency.clear();
  state.chunkSentAt = [];
  state.pendingSpeechStartMs = null;
  state.partials = 0;
  $('#turns').innerHTML = '';
  $('#empty').hidden = false;
  $('#warnings').innerHTML = '';
  $('#events').innerHTML = '<span class="muted">None yet.</span>';
  $('#revisions').innerHTML = '<span class="muted">None yet.</span>';
  for (const id of [
    'modelUsed',
    'avgFirstPartial',
    'avgFinal',
    'audioDuration',
    'sessionId',
  ]) {
    $(`#${id}`).textContent = 'Waiting';
    $(`#${id}`).classList.add('muted');
  }
  $('#turnCount').textContent = '0';
  $('#partialCount').textContent = '0';
  showLevel(0);
}

function setStat(id, value) {
  const el = $(`#${id}`);
  el.textContent = value;
  el.classList.remove('muted');
}

async function start(kind) {
  const { model, options } = readSettings();
  resetSession();
  setStatus('connecting');

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(
    `${protocol}://${location.host}/stream?model=${encodeURIComponent(model)}`,
  );
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () =>
        reject(new Error('could not reach the relay server'));
    });
  } catch (error) {
    setStatus('error', error.message);
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'transcription-stream.start',
      inputAudioFormat: { type: 'audio/pcm', rate: SAMPLE_RATE },
      providerOptions: { assemblyai: options },
      includeRawChunks: true,
    }),
  );
  socket.onmessage = event => handlePart(JSON.parse(event.data));
  socket.onclose = event => {
    stopSource();
    if (state.status !== 'done' && state.status !== 'error') {
      setStatus(
        event.code === 1000 ? 'done' : 'error',
        event.code === 1000
          ? ''
          : event.reason || `socket closed (${event.code})`,
      );
    }
  };

  state.startedAt = performance.now();
  try {
    state.source =
      kind === 'mic'
        ? await startMicrophone(socket)
        : await startSampleClip(socket);
    setStatus('listening');
  } catch (error) {
    setStatus('error', error.message);
    socket.close();
  }
}

function finishInput() {
  stopSource();
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(
      JSON.stringify({ type: 'transcription-stream.audio-done' }),
    );
    setStatus('finishing');
  }
}

function stopSource() {
  state.source?.stop();
  state.source = null;
  showLevel(0);
}

$('#mic').addEventListener('click', () => start('mic'));
$('#sample').addEventListener('click', () => start('sample'));
$('#stop').addEventListener('click', finishInput);

// ---------- audio sources ----------

function showLevel(peak) {
  $('#level').style.width = `${Math.min(100, Math.round(peak * 140))}%`;
}

async function startMicrophone(socket) {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  await context.audioWorklet.addModule('/worklet.js');
  const source = context.createMediaStreamSource(media);
  const node = new AudioWorkletNode(context, 'pcm-downsampler');
  const silent = context.createGain();
  silent.gain.value = 0;
  node.port.onmessage = ({ data }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data.pcm);
      state.chunkSentAt.push(performance.now());
    }
    showLevel(data.peak);
  };
  source.connect(node);
  node.connect(silent);
  silent.connect(context.destination);
  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const track of media.getTracks()) track.stop();
      void context.close();
    },
  };
}

async function startSampleClip(socket) {
  const response = await fetch('/sample.mp3');
  const decodeContext = new AudioContext();
  const decoded = await decodeContext.decodeAudioData(
    await response.arrayBuffer(),
  );
  void decodeContext.close();
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const bufferSource = offline.createBufferSource();
  bufferSource.buffer = decoded;
  bufferSource.connect(offline.destination);
  bufferSource.start();
  const samples = (await offline.startRendering()).getChannelData(0);

  let offset = 0;
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      clearInterval(timer);
      return;
    }
    if (offset >= samples.length) {
      clearInterval(timer);
      finishInput();
      return;
    }
    const slice = samples.subarray(offset, offset + CHUNK_SAMPLES);
    offset += CHUNK_SAMPLES;
    const pcm = new Int16Array(slice.length);
    let peak = 0;
    for (let i = 0; i < slice.length; i++) {
      const sample = Math.max(-1, Math.min(1, slice[i]));
      peak = Math.max(peak, Math.abs(sample));
      pcm[i] = sample * 0x7fff;
    }
    socket.send(pcm.buffer);
    state.chunkSentAt.push(performance.now());
    showLevel(peak);
    $('#statusText').textContent =
      `Sample clip, ${(offset / SAMPLE_RATE).toFixed(0)} of ${decoded.duration.toFixed(0)}s`;
  }, 100);
  return { stop: () => clearInterval(timer) };
}

// ---------- stream parts -> UI ----------

function handlePart(part) {
  switch (part.type) {
    case 'stream-start':
      for (const warning of part.warnings)
        addWarning(
          warning.message ?? warning.details ?? JSON.stringify(warning),
        );
      break;
    case 'response-metadata':
      if (part.modelId) setStat('modelUsed', part.modelId);
      break;
    case 'transcript-partial':
      state.partials++;
      $('#partialCount').textContent = String(state.partials);
      upsertTurn({
        id: part.id,
        text: part.text,
        partial: true,
        startSecond: part.startSecond,
      });
      break;
    case 'transcript-final': {
      const meta = part.providerMetadata?.assemblyai ?? {};
      upsertTurn({
        id: part.id,
        text: part.text,
        partial: false,
        startSecond: part.startSecond,
        endSecond: part.endSecond,
        speaker: meta.speakerLabel,
        language: meta.languageCode,
        error: meta.error,
      });
      break;
    }
    case 'raw':
      handleRaw(part.rawValue);
      break;
    case 'error':
      addWarning(
        `Error: ${part.error?.message ?? JSON.stringify(part.error)}`,
        true,
      );
      break;
    case 'finish': {
      const meta = part.providerMetadata?.assemblyai ?? {};
      if (part.durationInSeconds != null) {
        setStat(
          'audioDuration',
          `${part.durationInSeconds}s of audio, ${meta.sessionDurationSeconds ?? '?'}s session`,
        );
      }
      if (meta.speechModelUsed) setStat('modelUsed', meta.speechModelUsed);
      setStatus('done');
      break;
    }
  }
}

function handleRaw(raw) {
  const type = raw?.type ?? 'unknown';
  state.events.set(type, (state.events.get(type) ?? 0) + 1);
  $('#events').innerHTML = [...state.events.entries()]
    .map(
      ([name, count]) =>
        `<div class="event"><span class="e1">${name}</span><b>${count}</b></div>`,
    )
    .join('');
  if (type === 'SpeechStarted') state.pendingSpeechStartMs = raw.timestamp;
  if (type === 'Turn') {
    trackConfidence(raw);
    trackLatency(raw);
  }
  if (type === 'Begin' && raw.id) setStat('sessionId', raw.id);
  if (type === 'Begin' && raw.configuration?.model)
    setStat('modelUsed', raw.configuration.model);
  if (type === 'SpeakerRevision') applyRevisions(raw.revisions ?? []);
}

// The raw Turn message carries end_of_turn_confidence on every update, so the
// value can be shown changing while a turn is still open. Raw parts arrive
// just before the mapped part, so the value is stored and picked up when the
// turn element is created or updated.
function trackConfidence(raw) {
  if (raw.turn_order == null || raw.end_of_turn_confidence == null) return;
  const entry = {
    value: raw.end_of_turn_confidence,
    final: raw.end_of_turn === true,
  };
  state.confidence.set(raw.turn_order, entry);
  const item = state.turns.get(`turn-${raw.turn_order}`);
  if (item) renderConfidence(item, entry);
}

function renderConfidence(item, entry) {
  const box = item.querySelector('.eot');
  box.hidden = false;
  box.classList.toggle('final', entry.final);
  box.querySelector('.eot-value').textContent =
    `end of turn ${entry.value.toFixed(2)}`;
  box.querySelector('.eot-bar > div').style.width =
    `${Math.round(entry.value * 100)}%`;
}

// ---------- latency, measured against the audio the browser actually sent ----------

const CHUNK_MS = (CHUNK_SAMPLES / SAMPLE_RATE) * 1000;

// Wall-clock time at which the audio at `audioMs` left the browser. Chunks go
// out at real-time pace, so interpolate inside the chunk that carried it.
function sentAt(audioMs) {
  const sent = state.chunkSentAt;
  if (sent.length === 0) return null;
  const index = Math.min(Math.floor(audioMs / CHUNK_MS), sent.length - 1);
  return sent[index] + (audioMs - index * CHUNK_MS);
}

function audioSentMs() {
  return state.chunkSentAt.length * CHUNK_MS;
}

// First partial: from speech onset (SpeechStarted on Pro models, else the first
// word's start) to the first non-empty partial. Final: from the end of the last
// word to the first message with end_of_turn=true.
function trackLatency(raw) {
  if (raw.turn_order == null) return;
  const now = performance.now();
  let entry = state.latency.get(raw.turn_order);
  if (!entry) {
    entry = { firstPartialMs: null, finalMs: null };
    state.latency.set(raw.turn_order, entry);
  }
  const words = raw.words ?? [];

  if (entry.firstPartialMs == null && (raw.transcript ?? '').length > 0) {
    // a SpeechStarted timestamp is only usable if it is an audio position
    const onset =
      state.pendingSpeechStartMs != null &&
      state.pendingSpeechStartMs <= audioSentMs() + 1000
        ? state.pendingSpeechStartMs
        : words[0]?.start;
    state.pendingSpeechStartMs = null;
    const at = onset != null ? sentAt(onset) : null;
    if (at != null) entry.firstPartialMs = Math.max(0, now - at);
  }

  if (entry.finalMs == null && raw.end_of_turn === true && words.length > 0) {
    const at = sentAt(words[words.length - 1].end);
    if (at != null) entry.finalMs = Math.max(0, now - at);
  }

  const item = state.turns.get(`turn-${raw.turn_order}`);
  if (item) renderLatency(item, entry);
  renderAverages();
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderLatency(item, entry) {
  const box = item.querySelector('.latency');
  const parts = [];
  if (entry.firstPartialMs != null)
    parts.push(`first partial ${formatSeconds(entry.firstPartialMs)}`);
  if (entry.finalMs != null)
    parts.push(`final ${formatSeconds(entry.finalMs)}`);
  box.hidden = parts.length === 0;
  box.textContent = parts.join(', ');
}

function renderAverages() {
  const entries = [...state.latency.values()];
  const average = key => {
    const values = entries.map(e => e[key]).filter(v => v != null);
    if (values.length === 0) return null;
    return {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      n: values.length,
    };
  };
  const turns = n => `${n} ${n === 1 ? 'turn' : 'turns'}`;
  const first = average('firstPartialMs');
  const final = average('finalMs');
  if (first)
    setStat(
      'avgFirstPartial',
      `${formatSeconds(first.mean)} after speech starts, over ${turns(first.n)}`,
    );
  if (final)
    setStat(
      'avgFinal',
      `${formatSeconds(final.mean)} after speech ends, over ${turns(final.n)}`,
    );
}

// Redacted spans ([PERSON_NAME], ####) get the UI & Code highlight block.
function renderTranscript(text) {
  return escapeHtml(text)
    .replace(/\[([A-Z_]+)\]/g, '<mark class="redacted">[$1]</mark>')
    .replace(/#{2,}/g, '<mark class="redacted">$&</mark>');
}

// Speaker A takes the green product accent, B the Cobolt outline, the rest
// stay neutral and differ by letter only: one accent system per surface.
function speakerClass(label) {
  if (!state.speakerOrder.includes(label)) state.speakerOrder.push(label);
  return `spk-${Math.min(state.speakerOrder.indexOf(label), 2)}`;
}

function upsertTurn({
  id,
  text,
  partial,
  startSecond,
  endSecond,
  speaker,
  language,
  error,
}) {
  $('#empty').hidden = true;
  let item = state.turns.get(id);
  if (!item) {
    item = document.createElement('li');
    item.className = 'turn';
    item.dataset.turn = id;
    item.innerHTML = `<div class="turn-meta"><span class="speaker e1"></span><span class="time m1"></span><span class="lang e1" hidden></span><span class="latency m1" hidden></span><span class="eot" hidden><span class="eot-value m1"></span><span class="eot-bar" aria-hidden="true"><div></div></span></span></div><p class="text"></p>`;
    $('#turns').appendChild(item);
    state.turns.set(id, item);
    $('#turnCount').textContent = String(state.turns.size);
    // follow the newest turn inside the transcript window only; scrollIntoView
    // would also scroll the document and push the header out of view
    const wrap = $('.sheet-wrap');
    wrap.scrollTop = wrap.scrollHeight;
  }
  item.classList.toggle('partial', partial);
  item.classList.toggle('removed', text === '' && !partial);
  const textEl = item.querySelector('.text');
  if (text === '' && !partial) {
    textEl.textContent = error ? `Turn removed: ${error}` : 'Turn removed';
  } else {
    textEl.innerHTML = renderTranscript(text);
  }
  const time = item.querySelector('.time');
  if (startSecond != null) {
    time.textContent =
      endSecond != null
        ? `${startSecond.toFixed(1)}s to ${endSecond.toFixed(1)}s`
        : `${startSecond.toFixed(1)}s`;
  }
  if (speaker != null) setSpeaker(item, speaker);
  const turnOrder = Number(id.replace('turn-', ''));
  const confidence = state.confidence.get(turnOrder);
  if (confidence) renderConfidence(item, confidence);
  const latency = state.latency.get(turnOrder);
  if (latency) renderLatency(item, latency);
  if (language) {
    const badge = item.querySelector('.lang');
    badge.textContent = language;
    badge.hidden = false;
  }
}

function setSpeaker(item, label) {
  const chip = item.querySelector('.speaker');
  chip.className = `speaker e1 ${speakerClass(label)}`;
  chip.textContent = `Speaker ${label}`;
}

function applyRevisions(revisions) {
  const lines = [];
  for (const revision of revisions) {
    const item = state.turns.get(`turn-${revision.turn_order}`);
    if (!item) continue;
    const before =
      item.querySelector('.speaker').textContent.replace('Speaker ', '') || '?';
    setSpeaker(item, revision.speaker_label ?? '?');
    item.classList.add('revised');
    setTimeout(() => item.classList.remove('revised'), 900);
    lines.push(
      `Turn ${revision.turn_order + 1}: speaker ${before} became ${revision.speaker_label ?? 'unknown'}`,
    );
  }
  if (lines.length) {
    const box = $('#revisions');
    if (box.querySelector('.muted')) box.innerHTML = '';
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      box.prepend(div);
    }
  }
}

function addWarning(message, isError = false) {
  const div = document.createElement('div');
  div.className = `warning${isError ? ' error' : ''}`;
  div.textContent = message;
  $('#warnings').appendChild(div);
}
