// server.js — Twilio <-> OpenAI Realtime, fluido e em pt-BR
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OAI_MODEL = process.env.OAI_MODEL || "gpt-4o-realtime-preview";
const OAI_VOICE = process.env.OAI_VOICE || "alloy";
const GREETING = (process.env.GREETING ?? "on").toLowerCase() !== "off";

if (!OPENAI_API_KEY) {
  console.warn("⚠️  Defina OPENAI_API_KEY nas variáveis de ambiente do Render.");
}

const app = express();
const server = http.createServer(app);

// Healthcheck
app.get("/", (_req, res) => res.send("OK - Twilio <-> OpenAI Realtime"));

/**
 * WS público para a Twilio Media Streams
 * Twilio envia/recebe áudio μ-law 8000 base64 (sem header).
 */
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWs) => {
  console.log("🔌 Twilio stream conectado");
  let streamSid = null;
  let oaiWs;

  // Conecta no Realtime
  oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  oaiWs.on("open", () => {
    console.log("✅ Conectado ao OpenAI Realtime");
    // Ajusta codecs, voz, persona e VAD
    oaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          // Turn-taking natural
          turn_detection: { type: "server_vad" },

          // Codec compatível com Twilio (telefonia)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          // Voz e estilo
          voice: OAI_VOICE,
          modalities: ["text", "audio"],
          temperature: 0.55,
          instructions:
            "Fale em português do Brasil como uma consultora simpática da Joey Suplementos. " +
            "Converse de forma humana, com 1–2 frases por vez. " +
            "Entregue valor antes de perguntar; varie o jeito de perguntar; " +
            "evite repetir 'o que mais?'. Se o cliente disser 'sono', cite 1–2 opções comuns " +
            "(ex.: magnésio, L‑teanina, melatonina curto prazo) e faça UMA pergunta específica (ex.: adormecer, manter o sono, acorda cedo?). " +
            "Evite promessas médicas; seja prática e empática.",
        },
      })
    );
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;

        // Opcional: uma saudação curta só no início da ligação
        if (GREETING) {
          oaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                instructions:
                  "Faça uma saudação curta e natural, diga que pode ajudar com sono, energia, foco ou massa, " +
                  "e finalize com uma pergunta aberta sobre o objetivo principal do cliente.",
                modalities: ["audio"],
              },
            })
          );
        }
        return;
      }

      if (msg.event === "media") {
        // Anexa áudio μ-law/8k vindo da Twilio (base64)
        oaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          })
        );
        // Com server_vad, não precisamos comitar manualmente cada pacote
        return;
      }

      if (msg.event === "stop") {
        try {
          oaiWs.close();
        } catch {}
        try {
          twilioWs.close();
        } catch {}
        return;
      }
    } catch (e) {
      console.error("Erro Twilio->Bridge:", e);
    }
  });

  // OpenAI -> Twilio
  oaiWs.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf.toString());

      // Deltas de áudio (μ-law/8k) para tocar imediatamente
      if (
        (evt.type === "response.output_audio.delta" ||
          evt.type === "output_audio.delta") &&
        evt.delta &&
        streamSid
      ) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: evt.delta },
          })
        );
      }

      // Fim de cada resposta (opcional: marcador)
      if (evt.type === "response.completed" && streamSid) {
        twilioWs.send(
          JSON.stringify({ event: "mark", streamSid, mark: { name: "done" } })
        );
      }
    } catch (e) {
      console.error("Erro Bridge->Twilio:", e);
    }
  });

  const closeSafe = () => {
    try {
      oaiWs?.close();
    } catch {}
    try {
      twilioWs?.close();
    } catch {}
  };
  oaiWs.on("close", () => console.log("🔻 OAI WS fechado"));
  oaiWs.on("error", (e) => {
    console.error("OAI WS error:", e);
    closeSafe();
  });
  twilioWs.on("close", () => {
    console.log("🔻 Twilio WS fechado");
    closeSafe();
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Bridge rodando em :${PORT}`);
});
