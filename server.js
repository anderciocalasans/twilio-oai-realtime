import express from "express";
import fetch from "node-fetch";
import WebSocket from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

// Rota que o Twilio vai chamar quando uma ligação começar
app.post("/voice", async (req, res) => {
  const response = `
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media-stream"/>
      </Connect>
    </Response>
  `;
  res.type("text/xml");
  res.send(response);
});

// WebSocket para lidar com a mídia de voz do Twilio
app.ws("/media-stream", (ws, req) => {
  console.log("Novo stream do Twilio conectado");

  // Conectar ao OpenAI Realtime
  const oai = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  // Proxy Twilio -> OpenAI
  ws.on("message", (msg) => {
    oai.send(msg.toString());
  });

  // Proxy OpenAI -> Twilio
  oai.on("message", (msg) => {
    ws.send(msg.toString());
  });

  oai.on("close", () => console.log("Conexão OpenAI fechada"));
  ws.on("close", () => console.log("Conexão Twilio fechada"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));