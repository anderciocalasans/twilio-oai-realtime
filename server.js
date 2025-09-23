// server.js — Ponte Twilio Media Streams ↔ OpenAI Realtime
}


// Fim de uma fala
if (data.type === 'response.completed') {
twilioWS.send(JSON.stringify({ event: 'mark', mark: { name: 'oa_audio_end' } }));
}


// Erros explícitos
if (data.type === 'error') {
console.error('🔥 OAI error detail:', JSON.stringify(data, null, 2));
}
});


oaWS.on('close', () => console.log('🔻 OpenAI WS fechado'));
oaWS.on('error', (e) => console.error('WS OpenAI erro', e));


// 1.2) Keepalive p/ OpenAI (previne idle close)
const keepAlive = setInterval(() => {
try { oaWS.ping(); } catch {}
}, 15000);


// 2) Twilio → OpenAI (receber áudio μ-law 8k e empilhar)
twilioWS.on('message', (raw) => {
let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }


if (msg.event === 'start') {
console.log('🛰️ Twilio stream START', msg.start?.streamSid);
return;
}


if (msg.event === 'media') {
const ulawB64 = msg.media?.payload;
if (!ulawB64 || !openaiReady) return;
const ulawBuf = Buffer.from(ulawB64, 'base64');
const pcm16 = mulawToPcm16(ulawBuf);
pendingPCM.push(pcm16);
return;
}


if (msg.event === 'stop') {
console.log('🛰️ Twilio stream STOP');
// Flush final
if (pendingPCM.length) {
const chunk = Buffer.concat(pendingPCM);
pendingPCM = [];
oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
oaWS.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio'] } }));
}
cleanup('twilio stop');
return;
}
});


twilioWS.on('close', () => {
clearInterval(keepAlive);
cleanup('twilio ws close');
});


twilioWS.on('error', (e) => console.error('WS Twilio erro', e));
});

app.get('/healthz', (_, res) => res.status(200).send('ok'));

http.listen(PORT, () => console.log(`🌐 Servidor em http://localhost:${PORT}`));
