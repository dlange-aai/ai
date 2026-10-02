/**
 * AssemblyAI streaming playground: a browser UI plus a small relay.
 *
 * The browser cannot hold the AssemblyAI API key or send the Authorization
 * WebSocket header, so audio from the page is relayed through this server,
 * which runs the real `@ai-sdk/assemblyai` provider via
 * `experimental_streamTranscribe` and forwards the stream parts back.
 *
 * The browser <-> relay protocol is the AI SDK's transcription-stream
 * envelope (the same one AI Gateway speaks): one `transcription-stream.start`
 * text frame, binary audio frames, a `transcription-stream.audio-done` text
 * frame, and JSON-serialized `TranscriptionModelV4StreamPart`s back.
 */
import { config } from 'dotenv';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createAssemblyAI,
  type AssemblyAIProviderSettings,
} from '@ai-sdk/assemblyai';
import {
  experimental_parseTranscriptionStreamClientFrame as parseClientFrame,
  experimental_serializeTranscriptionStreamPart as serializePart,
  type Experimental_TranscriptionStreamStartFrame as StartFrame,
} from '@ai-sdk/provider-utils';
import { experimental_streamTranscribe as streamTranscribe } from 'ai';

const here = fileURLToPath(new URL('.', import.meta.url));
// Reuse the ai-functions example keys so no second .env is needed.
config({ path: join(here, '.env') });
config({ path: join(here, '../ai-functions/.env') });

if (!process.env.ASSEMBLYAI_API_KEY) {
  console.error(
    'ASSEMBLYAI_API_KEY is not set. Add it to examples/assemblyai-streaming-playground/.env or examples/ai-functions/.env.',
  );
  process.exit(1);
}

const assemblyai = createAssemblyAI({
  // The native WebSocket cannot send headers; `ws` can.
  webSocket: WebSocket as unknown as AssemblyAIProviderSettings['webSocket'],
});

const port = Number(process.env.PORT ?? 3210);
const publicDir = join(here, 'public');
const sampleClip = join(here, '../ai-functions/data/galileo.mp3');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const file =
    url.pathname === '/'
      ? join(publicDir, 'index.html')
      : url.pathname === '/sample.mp3'
        ? sampleClip
        : join(publicDir, url.pathname.replace(/^\/+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/stream', 'http://localhost');
  const modelId = url.searchParams.get('model') ?? 'universal-3-5-pro';
  const abort = new AbortController();
  let audioController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let audioClosed = false;
  let started = false;

  const closeAudio = () => {
    if (audioClosed) return;
    audioClosed = true;
    try {
      audioController?.close();
    } catch {
      // already closed by the consumer
    }
  };

  const audio = new ReadableStream<Uint8Array>({
    start(controller) {
      audioController = controller;
    },
  });

  const send = (part: Parameters<typeof serializePart>[0]) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const text = serializePart(part);
    if (text != null) socket.send(text);
  };

  const run = async (start: StartFrame) => {
    const startedAt = Date.now();
    console.log(
      `[${modelId}] session start`,
      JSON.stringify(start.providerOptions ?? {}),
    );
    try {
      const result = streamTranscribe({
        model: assemblyai.transcription(modelId),
        audio,
        inputAudioFormat: start.inputAudioFormat,
        providerOptions: start.providerOptions,
        includeRawChunks: start.includeRawChunks ?? true,
        abortSignal: abort.signal,
      });

      // `fullStream` must be claimed before any result promise.
      const stream = result.fullStream;
      void Promise.resolve(result.warnings)
        .then(warnings => send({ type: 'stream-start', warnings }))
        .catch(() => {});

      for await (const part of stream) {
        send(part);
      }

      const [
        text,
        segments,
        language,
        durationInSeconds,
        providerMetadata,
        responses,
      ] = await Promise.all([
        result.text,
        result.segments,
        result.language,
        result.durationInSeconds,
        result.providerMetadata,
        result.responses,
      ]);
      send({ type: 'response-metadata', ...responses[0] });
      send({
        type: 'finish',
        text,
        segments,
        language,
        durationInSeconds,
        providerMetadata,
      });
      console.log(
        `[${modelId}] finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${text.length} chars`,
      );
      socket.close(1000, 'finished');
    } catch (error) {
      if (!abort.signal.aborted) {
        console.error(
          `[${modelId}] error:`,
          error instanceof Error ? error.message : error,
        );
        send({ type: 'error', error });
        socket.close(1011, 'transcription failed');
      }
    }
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!audioClosed) {
        audioController?.enqueue(new Uint8Array(data as Buffer));
      }
      return;
    }
    const frame = parseClientFrame(data.toString());
    switch (frame.type) {
      case 'start':
        if (!started) {
          started = true;
          void run(frame.frame);
        }
        break;
      case 'audio-done':
        closeAudio();
        break;
      case 'invalid':
        send({
          type: 'error',
          error: new Error(`Invalid frame: ${frame.message}`),
        });
        socket.close(1008, 'invalid frame');
        break;
    }
  });

  socket.on('close', () => {
    // A plain close without audio-done aborts the session.
    if (!audioClosed) {
      abort.abort(new Error('browser disconnected'));
      closeAudio();
    }
  });
});

server.listen(port, () => {
  console.log(`AssemblyAI streaming playground: http://localhost:${port}`);
});
