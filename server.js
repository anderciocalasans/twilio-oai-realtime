// server.js — ponte Twilio Media Streams ↔ OpenAI Realtime
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const {
  PORT = 3000,
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview'
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('❌ Defina OPENAI_API_KEY nas variáveis de ambiente');
  process.exit(1);
}

const app = express();
const http = createServer(app);

// ---------------- Health ----------------
app.get('/healthz', (_, res) => res.status(200).send('ok'));
app.get('/health',  (_, res) => res.status(200).send('ok'));

// ---------------- TwiML opcional ----------------
// (Se quiser usar este endpoint como Url da call)
app.get('/twiml', (req, res) => {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/voice-stream"/>
  </Connect>
</Response>`);
});

// ---------------- utils μ-law ↔ PCM16 (8 kHz) ----------------
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;
function ulawDecode(uVal) {
  uVal = ~uVal & 0xff;
  let t = ((uVal & QUANT_MASK) << 3) + 0x84;
  t <<= ((uVal & SEG_MASK) >>> SEG_SHIFT);
  return ((uVal & SIGN_BIT) ? (0x84 - t) : (t - 0x84));
}
function mulawToPcm16(bufUlaw) {
  const out = new Int16Array(bufUlaw.length);
  for (let i = 0; i < bufUlaw.length; i++) out[i] = ulawDecode(bufUlaw[i]);
  return Buffer.from(out.buffer);
}
function linear2ulaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += 132;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
  let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  let ulawbyte = ~(sign | (exponent << 4) | mantissa);
  return ulawbyte & 0xff;
}
function pcm16ToMulaw(int16) {
  const view = new DataView(int16.buffer, int16.byteOffset, int16.byteLength);
  const out = Buffer.alloc(int16.byteLength / 2);
  for (let i = 0, j = 0; i < int16.byteLength; i += 2, j++) {
    const s = view.getInt16(i, true);
    out[j] = linear2ulaw(s);
  }
  return out;
}

// ---------------- WebSocket Twilio ----------------
const wss = new WebSocketServer({ server: http, path: '/voice-stream' });

// 100ms em PCM16 8kHz ≈ 1600 bytes. Vamos usar 200ms (3200) p/ garantir.
const MIN_PCM_BYTES = 3200;

wss.on('connection', async (twilioWS) => {
  console.log('⚡ Twilio conectado ao /voice-stream');

  // Conexão com a OpenAI Realtime
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let openaiReady = false;

  // buffers e controle do áudio de entrada (Twilio -> OpenAI)
  let pendingPCM = [];
  let pendingBytes = 0;
  let hasAudio = false;
  let commitTimer = null;

  const cleanup = (why = '') => {
    try { if (commitTimer) { clearInterval(commitTimer); commitTimer = null; } } catch {}
    try { twilioWS.close(); } catch {}
    try { oaWS.close(); } catch {}
    pendingPCM = [];
    pendingBytes = 0;
    hasAudio = false;
    console.log('🧹 Encerrando sessão:', why);
  };

  // loop de commit: só inicia após chegar áudio
  const startCommitLoop = () => {
    if (commitTimer) return; // evita duplicidade
    commitTimer = setInterval(() => {
      if (!openaiReady || !hasAudio) return;
      if (pendingBytes < MIN_PCM_BYTES) return; // ainda não temos >=200ms

      const chunk = Buffer.concat(pendingPCM);
      pendingPCM = [];
      pendingBytes = 0;

      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      oaWS.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'] } }));
    }, 300); // 300–400ms é um bom intervalo
  };

  // ------- Handlers OpenAI -------
  oaWS.on('open', () => console.log('✅ OpenAI Realtime aberto'));

  oaWS.on('message', (raw) => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === 'session.created') {
      console.log('🟢 session.created');

      // Formatos como string + instruções
      oaWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format:  'pcm16',
          output_audio_format: 'pcm16',
          instructions: `Você é o assistente virtual da Joie Suplementos. Fale em pt-BR, tom cordial e objetivo.
Oferta breve; se houver interesse, ofereça enviar link oficial por WhatsApp/SMS.
Se disser "parar" ou "não quero", encerre educadamente.`
        }
      }));

      // Saudação inicial
      oaWS.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio','text'],
          instructions: 'Oi! Eu sou o assistente virtual da Joie Suplementos. Posso falar um minuto?'
        }
      }));

      openaiReady = true;
    }

    // Áudio de saída (IA -> Twilio)
    if (data.type === 'response.output_audio.delta' && data.delta) {
      const pcm = Buffer.from(data.delta, 'base64'); // PCM16 8k
      const ulaw = pcm16ToMulaw(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength/2));
      twilioWS.send(JSON.stringify({ event: 'media', media: { payload: ulaw.toString('base64') } }));
    }

    if (data.type === 'response.completed') {
      twilioWS.send(JSON.stringify({ event: 'mark', mark: { name: 'oa_audio_end' } }));
    }

    if (data.type === 'error') {
      console.error('🔥 OAI error detail:', JSON.stringify(data, null, 2));
    }
  });

  oaWS.on('close', () => console.log('🔻 OpenAI WS fechado'));
  oaWS.on('error', (e) => console.error('WS OpenAI erro', e));

  // ------- Twilio -> (áudio) -> OpenAI -------
  twilioWS.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'start') {
      console.log('🛰️  Twilio stream START', msg.start?.streamSid);
      return;
    }

    if (msg.event === 'media') {
      if (!openaiReady) return;
      const ulawB64 = msg.media?.payload;
      if (!ulawB64) return;

      const ulawBuf = Buffer.from(ulawB64, 'base64');
      const pcm16 = mulawToPcm16(ulawBuf);

      hasAudio = true;
      pendingPCM.push(pcm16);
      pendingBytes += pcm16.length;

      // inicia commit loop na 1ª chegada de áudio
      startCommitLoop();
      return;
    }

    if (msg.event === 'stop') {
      console.log('🛰️  Twilio stream STOP');

      // Flush final apenas se >=200ms acumulados
      if (pendingBytes >= MIN_PCM_BYTES) {
        const chunk = Buffer.concat(pendingPCM);
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        oaWS.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'] } }));
      }

      pendingPCM = [];
      pendingBytes = 0;
      hasAudio = false;
      try { if (commitTimer) { clearInterval(commitTimer); commitTimer = null; } } catch {}

      cleanup('twilio stop');
    }
  });

  twilioWS.on('close', () => cleanup('twilio ws close'));
  twilioWS.on('error', (e) => console.error('WS Twilio erro', e));
});

// Render precisa ouvir em 0.0.0.0
http.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`🌐 Servidor em http://0.0.0.0:${process.env.PORT || 3000}`);
});
