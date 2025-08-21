// Bridge Twilio <-> OpenAI Realtime (voz em tempo real)
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // defina no Render
const OAI_MODEL = process.env.OAI_MODEL || "gpt-4o-realtime-preview";
const OAI_VOICE = process.env.OAI_VOICE || "alloy";

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY não definido. Configure no Render > Environment.");
}

const app = express();
const server = http.createServer(app);

// Healthcheck
app.get("/", (_req, res) => res.send("OK - Twilio <-> OpenAI Realtime"));

// WebSocket público para a Twilio (Media Streams)
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWs) => {
  console.log("🔌 Twilio stream conectado");
  let streamSid = null;

  // Conecta no WebSocket Realtime da OpenAI
  const oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // Sessão Realtime: formatos, voz e VAD
  oaiWs.on("open", () => {
    console.log("✅ Conectado ao OpenAI Realtime");
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: OAI_VOICE,
        instructions:
          "Fale em português do Brasil como consultora simpática da Joey Suplementos. " +
          "Converse de forma natural, 1–2 frases por vez; faça pergunta aberta quando fizer sentido. " +
          "Evite repetir a mesma pergunta.",
        modalities: ["text", "audio"],
        temperature: 0.6
      }
    };
    oaiWs.send(JSON.stringify(sessionUpdate));
  });

  // Mensagens da Twilio (start/media/stop)
  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        return;
      }

      if (msg.event === "media") {
        // payload base64 μ-law 8k sem header
        oaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
        return;
      }

      if (msg.event === "stop") {
        try { oaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        return;
      }
    } catch (e) {
      console.error("Erro processando mensagem da Twilio:", e);
    }
  });

  // Mensagens do OpenAI (deltas de áudio de saída)
  oaiWs.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf.toString());

      if (
        (evt.type === "response.output_audio.delta" ||
         evt.type === "output_audio.delta") &&
        evt.delta && streamSid
      ) {
        const media = {
          event: "media",
          streamSid,
          media: { payload: evt.delta } // base64 μ-law 8k
        };
        twilioWs.send(JSON.stringify(media));
      }

      if (evt.type === "response.completed" && streamSid) {
        twilioWs.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "done" } }));
      }
    } catch (e) {
      console.error("Erro processando mensagem do OpenAI:", e);
    }
  });

  const closeSafe = () => {
    try { oaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };
  oaiWs.on("close", () => { console.log("🔻 OAI WS fechado"); });
  oaiWs.on("error", (e) => { console.error("OAI WS error:", e); closeSafe(); });
  twilioWs.on("close", () => { console.log("🔻 Twilio WS fechado"); closeSafe(); });
});

server.listen(PORT, () => {
  console.log(`🚀 Bridge rodando em :${PORT}`);
});
