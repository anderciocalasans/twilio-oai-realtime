// server.js — ponte Twilio Media Streams ↔ OpenAI Realtime (G.711 μ-law ponta a ponta)
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

// ---- Health
app.get('/healthz', (_, res) => res.status(200).send('ok'));
app.get('/health',  (_, res) => res.status(200).send('ok'));

// ---- TwiML opcional (se quiser usar como Url da call)
app.get('/twiml', (req, res) => {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/voice-stream"/>
  </Connect>
</Response>`);
});

// ---- WebSocket do Twilio
const wss = new WebSocketServer({ server: http, path: '/voice-stream' });

// μ-law 8 kHz: 1 byte por amostra ⇒ 100 ms ≈ 800 bytes. Vamos usar 200 ms (1600).
const MIN_ULAW_BYTES = 1600;

wss.on('connection', async (twilioWS) => {
  console.log('⚡ Twilio conectado ao /voice-stream');

  // Conecta na OpenAI Realtime
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let openaiReady = false;

  // buffers/controle (μ-law)
  let pendingULaw = [];
  let pendingBytes = 0;   // bytes μ-law acumulados
  let hasAudio = false;
  let commitTimer = null;

  const cleanup = (why = '') => {
    try { if (commitTimer) { clearInterval(commitTimer); commitTimer = null; } } catch {}
    try { twilioWS.close(); } catch {}
    try { oaWS.close(); } catch {}
    pendingULaw = [];
    pendingBytes = 0;
    hasAudio = false;
    console.log('🧹 Encerrando sessão:', why);
  };

  const startCommitLoop = () => {
    if (commitTimer) return;
    commitTimer = setInterval(() => {
      if (!openaiReady || !hasAudio) return;
      if (pendingBytes < MIN_ULAW_BYTES) return;

      const chunk = Buffer.concat(pendingULaw);
      pendingULaw = [];
      pendingBytes = 0;

      console.log('📤 commit bytes (μ-law):', chunk.length);
      // envia μ-law direto
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      oaWS.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['audio','text'] }
      }));
    }, 300);
  };

  // ---- OpenAI handlers
  oaWS.on('open', () => console.log('✅ OpenAI Realtime aberto'));

  oaWS.on('message', (raw) => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === 'session.created') {
      console.log('🟢 session.created');

      // IMPORTANTÍSSIMO: μ-law 8 kHz como entrada e saída
      oaWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format:  'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          instructions: `Você é o assistente virtual da Joie Suplementos. Fale em pt-BR, tom cordial e objetivo.
Oferta breve; se houver interesse, ofereça enviar link oficial por WhatsApp/SMS.
Se disser "parar" ou "não quero", encerre educadamente.`
        }
      }));

      // Saudação inicial (a IA já fala algo)
      oaWS.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio','text'],
          instructions: 'Oi! Eu sou o assistente virtual da Joie Suplementos. Posso falar um minuto?'
        }
      }));

      openaiReady = true;
    }

    // Áudio de saída da IA (já em μ-law por causa do output_audio_format)
    if (data.type === 'response.output_audio.delta' && data.delta) {
      // delta já está em g711_ulaw (base64)
      twilioWS.send(JSON.stringify({ event: 'media', media: { payload: data.delta } }));
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

  // ---- Twilio → μ-law → OpenAI
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
      console.log('🎙️  media bytes (μ-law):', ulawBuf.length);

      hasAudio = true;
      pendingULaw.push(ulawBuf);
      pendingBytes += ulawBuf.length;

      startCommitLoop();
      return;
    }

    if (msg.event === 'stop') {
      console.log('🛰️  Twilio stream STOP');

      // flush final se tiver ≥ 200 ms acumulados
      if (pendingBytes >= MIN_ULAW_BYTES) {
        const chunk = Buffer.concat(pendingULaw);
        console.log('📤 commit final bytes (μ-law):', chunk.length);
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        oaWS.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'] } }));
      }

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
