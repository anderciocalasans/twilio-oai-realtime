// Bridge Twilio <-> OpenAI Realtime (voz em tempo real)
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // defina no Render
const OAI_MODEL = process.env.OAI_MODEL || "gpt-4o-realtime-preview";
const OAI_VOICE = process.env.OAI_VOICE || "alloy";

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY não definido. Configure no Render > Environment.");
}

const app = express();
const server = http.createServer(app);

// Healthcheck simples
app.get("/", (_req, res) => res.send("OK - Twilio <-> OpenAI Realtime"));

// WebSocket do lado público para a Twilio conectar (Media Streams)
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWs) => {
  console.log("🔌 Twilio stream conectado");

  let streamSid = null;

  // Conecta no WebSocket Realtime da OpenAI
  const oaiWs = new (await import("ws")).WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // Quando a sessão abre, configure formatos + persona + VAD
  oaiWs.on("open", () => {
    console.log("✅ Conectado ao OpenAI Realtime");
    const sessionUpdate = {
      type: "session.update",
      session: {
        // turn-taking pelo servidor (VAD)
        turn_detection: { type: "server_vad" },

        // Áudio em μ-law 8k para casar com a Twilio
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",

        // Voz e instruções
        voice: OAI_VOICE,
        instructions:
          "Fale em português do Brasil como consultora simpática da Joey Suplementos. " +
          "Converse de forma natural e humana, 1–2 frases por vez; " +
          "faça pergunta aberta quando fizer sentido. Evite repetir a mesma pergunta.",
        modalities: ["text", "audio"],
        temperature: 0.6
      }
    };
    oaiWs.send(JSON.stringify(sessionUpdate));
  });

  // 🔁 Mensagens que vêm da Twilio (start/media/stop)
  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        // Nada a enviar ao OAI aqui; só guardamos o streamSid
        return;
      }

      if (msg.event === "media") {
        // Twilio envia payload base64 μ-law 8k SEM header
        // Enviamos ao Realtime como delta de buffer de entrada
        oaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload // base64 μ-law 8k
          })
        );
        // Com server_vad, não precisamos comitar manualmente a cada pacote
        return;
      }

      if (msg.event === "stop") {
        // encerra tudo
        try { oaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        return;
      }
    } catch (e) {
      console.error("Erro processando mensagem da Twilio:", e);
    }
  });

  // 🔁 Mensagens do OpenAI (áudio de resposta em deltas)
  oaiWs.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf.toString());

      // Realtime costuma emitir "response.output_audio.delta"
      if (
        (evt.type === "response.output_audio.delta" ||
          evt.type === "output_audio.delta") &&
        evt.delta &&
        streamSid
      ) {
        const media = {
          event: "media",
          streamSid,
          media: { payload: evt.delta } // base64 μ-law 8k
        };
        twilioWs.send(JSON.stringify(media));
      }

      // Opcional: marcar fim de resposta
      if (evt.type === "response.completed" && streamSid) {
        twilioWs.send(
          JSON.stringify({ event: "mark", streamSid, mark: { name: "done" } })
        );
      }
    } catch (e) {
      console.error("Erro processando mensagem do OpenAI:", e);
    }
  });

  // Encerramentos
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