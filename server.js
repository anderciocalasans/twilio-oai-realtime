// server.js — Twilio <-> OpenAI Realtime (pt-BR, fluido)
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
app.get("/", (_req, res) => res.send("OK - Twilio <-> OpenAI Realtime"));

// WS público para Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (twilioWs) => {
  console.log("🔌 Twilio stream conectado");
  let streamSid = null;

  // --- Conecta no OpenAI Realtime ---
  const oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // buffer para mensagens que chegam ANTES do OAI abrir
  const toOAIQueue = [];
  const sendToOAI = (obj) => {
    const str = JSON.stringify(obj);
    if (oaiWs.readyState === WebSocket.OPEN) {
      oaiWs.send(str);
    } else {
      toOAIQueue.push(str);
    }
  };

  // buffer para mensagens ao Twilio (quase nunca precisa, mas por segurança)
  const toTwilio = (obj) => {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify(obj));
    }
  };

  // Controle de fim de fala (commit + response)
  let inactivityTimer = null;
  let pending = false;
  const SILENCE_MS = 700; // 0,7s sem áudio => considera fim de fala

  const scheduleCommitAndRespond = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (pending) return;
      pending = true;
      try {
        // 1) fecha o buffer de entrada
        sendToOAI({ type: "input_audio_buffer.commit" });
        // 2) pede resposta em áudio (streaming)
        sendToOAI({ type: "response.create", response: { modalities: ["audio"] } });
      } catch (e) {
        console.error("Erro ao commit/response:", e);
      } finally {
        pending = false;
      }
    }, SILENCE_MS);
  };

  // Quando o OAI abrir, atualiza sessão e esvazia fila
  oaiWs.on("open", () => {
    console.log("✅ Conectado ao OpenAI Realtime");
    sendToOAI({
      type: "session.update",
      session: {
        // turn-taking natural
        turn_detection: { type: "server_vad" },
        // codec compatível com telefonia Twilio
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // voz/persona
        voice: OAI_VOICE,
        modalities: ["text", "audio"],
        temperature: 0.55,
        instructions:
          "Fale em português do Brasil como consultora simpática da Joey Suplementos. " +
          "Converse de forma humana e prática, 1–2 frases por vez; entregue valor antes de perguntar; " +
          "varie o jeito de perguntar e evite repetir a mesma pergunta. " +
          "Para sono, cite 1–2 opções comuns (magnésio, L‑teanina, melatonina curto prazo) e pergunte " +
          "uma coisa específica (adormecer, manter o sono, acordar cedo?). Evite promessas médicas.",
      },
    });

    // esvazia o buffer pendente
    while (toOAIQueue.length) oaiWs.send(toOAIQueue.shift());
  });

  // Twilio -> OAI
  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;

        if (GREETING) {
          // saudação curta (opcional)
          sendToOAI({
            type: "response.create",
            response: {
              instructions:
                "Saudação breve e natural. Diga que pode ajudar com sono, energia, foco ou massa, " +
                "e finalize com uma pergunta aberta sobre o objetivo principal.",
              modalities: ["audio"],
            },
          });
        }
        return;
      }

      if (msg.event === "media") {
        // anexar áudio μ-law 8k (base64, sem header)
        sendToOAI({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        });
        // programa commit + response se houver silêncio
        scheduleCommitAndRespond();
        return;
      }

      if (msg.event === "stop") {
        try { oaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        return;
      }
    } catch (e) {
      console.error("Erro Twilio->Bridge:", e);
    }
  });

  // OAI -> Twilio
  oaiWs.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf.toString());

      // deltas de áudio prontos para tocar (g711_ulaw 8k base64)
      if (
        (evt.type === "response.output_audio.delta" ||
          evt.type === "output_audio.delta") &&
        evt.delta &&
        streamSid
      ) {
        toTwilio({ event: "media", streamSid, media: { payload: evt.delta } });
      }

      if (evt.type === "response.completed" && streamSid) {
        toTwilio({ event: "mark", streamSid, mark: { name: "done" } });
      }
    } catch (e) {
      console.error("Erro Bridge->Twilio:", e);
    }
  });

  const closeSafe = () => {
    try { oaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };
  oaiWs.on("close", () => console.log("🔻 OAI WS fechado"));
  oaiWs.on("error", (e) => { console.error("OAI WS error:", e); closeSafe(); });
  twilioWs.on("close", () => { console.log("🔻 Twilio WS fechado"); closeSafe(); });
});

server.listen(PORT, () => console.log(`🚀 Bridge rodando em :${PORT}`));
