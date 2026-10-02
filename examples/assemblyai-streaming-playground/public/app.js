const $ = selector => document.querySelector(selector);
const form = $('#settings');
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms

const state = {
  socket: null,
  source: null,
  status: 'ready',
  startedAt: 0,
  firstPartialAt: null,
  partials: 0,
  turns: new Map(),
  speakerOrder: [],
  events: new Map(),
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
  $('#code').textContent =
    `import { createAssemblyAI } from '@ai-sdk/assemblyai';
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
  $('#stop').disabled = !(status === 'listening');
  $('#settingsPanel').setAttribute('aria-disabled', String(live));
}

function resetSession() {
  state.turns.clear();
  state.speakerOrder = [];
  state.events.clear();
  state.partials = 0;
  state.firstPartialAt = null;
  $('#turns').innerHTML = '';
  $('#empty').hidden = false;
  $('#warnings').innerHTML = '';
  $('#events').innerHTML = '<span class="muted">None yet.</span>';
  $('#revisions').innerHTML = '<span class="muted">None yet.</span>';
  for (const id of [
    'modelUsed',
    'firstPartial',
    'audioDuration',
    'sessionId',
  ]) {
    $(`#${id}`).textContent = '—';
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
    if (socket.readyState === WebSocket.OPEN) socket.send(data.pcm);
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
    showLevel(peak);
    $('#statusText').textContent =
      `Listening to the sample clip, ${(offset / SAMPLE_RATE).toFixed(0)} of ${decoded.duration.toFixed(0)} s`;
  }, 100);
  return { stop: () => clearInterval(timer) };
}

// ---------- stream parts -> UI ----------

function elapsed() {
  return ((performance.now() - state.startedAt) / 1000).toFixed(2);
}

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
      if (state.firstPartialAt == null) {
        state.firstPartialAt = elapsed();
        setStat('firstPartial', `${state.firstPartialAt} s after start`);
      }
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
          `${part.durationInSeconds} s of audio, ${meta.sessionDurationSeconds ?? '?'} s session`,
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
        `<div class="event"><span>${name}</span><b>${count}</b></div>`,
    )
    .join('');
  if (type === 'Begin' && raw.id) setStat('sessionId', raw.id);
  if (type === 'Begin' && raw.configuration?.model)
    setStat('modelUsed', raw.configuration.model);
  if (type === 'SpeakerRevision') applyRevisions(raw.revisions ?? []);
}

function speakerColor(label) {
  if (label == null) return null;
  if (!state.speakerOrder.includes(label)) state.speakerOrder.push(label);
  return `var(--spk-${state.speakerOrder.indexOf(label) % 8})`;
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
    item.innerHTML = `<div class="rail"></div><div class="turn-body"><div class="turn-meta"><span class="speaker"></span><span class="time"></span><span class="lang badge" hidden></span></div><p class="text"></p></div>`;
    $('#turns').appendChild(item);
    state.turns.set(id, item);
    $('#turnCount').textContent = String(state.turns.size);
    item.scrollIntoView({ block: 'nearest' });
  }
  item.classList.toggle('partial', partial);
  item.classList.toggle('redacted-note', text === '' && !partial);
  item.querySelector('.text').textContent =
    text === '' && !partial
      ? error
        ? `Turn removed: ${error}`
        : 'Turn removed'
      : text;
  const time = item.querySelector('.time');
  if (startSecond != null) {
    time.textContent =
      endSecond != null
        ? `${startSecond.toFixed(1)} to ${endSecond.toFixed(1)} s`
        : `${startSecond.toFixed(1)} s`;
  }
  if (speaker != null) setSpeaker(item, speaker);
  if (language) {
    const badge = item.querySelector('.lang');
    badge.textContent = language;
    badge.hidden = false;
  }
}

function setSpeaker(item, label) {
  item.style.setProperty('--speaker', speakerColor(label));
  item.querySelector('.speaker').textContent = `Speaker ${label}`;
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
    setTimeout(() => item.classList.remove('revised'), 1500);
    lines.push(
      `Turn ${revision.turn_order + 1}: ${before} became ${revision.speaker_label ?? 'unknown'}`,
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
