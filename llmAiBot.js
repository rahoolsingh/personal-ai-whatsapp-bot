const fs = require("fs");
const path = require("path");
const axios = require("axios");
const googleTTS = require("google-tts-api");
const ffmpeg = require("fluent-ffmpeg");
const { createWorker } = require("tesseract.js");

// —— CONFIG & STATE —————————————————————————————
const sessionStats = new Map();
const memoryDir = path.join(__dirname, "user_memory");
const tempDir = path.join(__dirname, "temp");

// Create directories
[memoryDir, tempDir].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// —— HELPER: Free Audio Generation —————————————————
async function textToVoiceNote(text) {
    try {
        // 1. Get MP3 URL from Google TTS (Free)
        // Split text if it's too long (Google TTS limit is ~200 chars)
        const safeText = text.substring(0, 200); 
        
        const url = googleTTS.getAudioUrl(safeText, {
            lang: "en",
            slow: false,
            host: "https://translate.google.com",
        });

        // 2. Download MP3
        const mp3Buffer = await axios.get(url, { responseType: "arraybuffer" }).then((r) => Buffer.from(r.data));
        
        const tempMp3 = path.join(tempDir, `input_${Date.now()}.mp3`);
        const tempOgg = path.join(tempDir, `voice_${Date.now()}.ogg`);

        fs.writeFileSync(tempMp3, mp3Buffer);

        // 3. Convert to WhatsApp Voice Note (Ogg/Opus)
        return new Promise((resolve, reject) => {
            ffmpeg(tempMp3)
                .outputOptions([
                    "-c:a libopus", 
                    "-b:a 16k",
                    "-vbr on"
                ])
                .toFormat("ogg")
                .save(tempOgg)
                .on("end", () => {
                    if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
                    resolve(tempOgg);
                })
                .on("error", (err) => {
                    if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
                    console.error("FFmpeg Error:", err);
                    resolve(null);
                });
        });
    } catch (err) {
        console.error("TTS Error:", err.message);
        return null;
    }
}

// —— HELPER: User Memory ——————————————————————————
function getMemoryPath(jid) {
    return path.join(memoryDir, `${jid}.json`);
}

async function loadUserMemory(jid) {
    if (!fs.existsSync(getMemoryPath(jid))) return [];
    try {
        return JSON.parse(fs.readFileSync(getMemoryPath(jid), "utf-8"));
    } catch { return []; }
}

async function saveUserMemory(jid, memory) {
    fs.writeFileSync(getMemoryPath(jid), JSON.stringify(memory, null, 2), "utf-8");
}

async function deleteUserMemory(jid) {
    const file = getMemoryPath(jid);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

// —— HELPER: OCR ——————————————————————————————————
async function extractTextFromImage(imageMessage) {
    try {
        const buffer = await axios.get(imageMessage.url || imageMessage.directPath, { responseType: "arraybuffer" }).then(r => Buffer.from(r.data));
        const worker = await createWorker("eng");
        const { data: { text } } = await worker.recognize(buffer);
        await worker.terminate();
        return text.trim();
    } catch { return ""; }
}

// —— GEMINI API (Simple Version) ——————————————————
async function getReply(jid, userMessage) {
    let memory = await loadUserMemory(jid);

    // Add User Message to History
    memory.push({ role: "user", parts: [{ text: userMessage }] });

    // Keep memory short (Last 10 messages)
    if (memory.length > 10) {
        memory = memory.slice(-10);
    }

    try {
        // EXACT Structure you requested
        const payload = {
            contents: memory.map(msg => ({
                role: msg.role,
                parts: msg.parts.map(part => ({ text: part.text }))
            })),
            // max 2 lines of output token
            maxOutputTokens: 100,
        };

        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
            payload,
            {
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": process.env.GEMINI_API_KEY
                }
            }
        );

        const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "System Error";
        
        // Save Assistant Reply
        memory.push({ role: "model", parts: [{ text: reply }] });
        await saveUserMemory(jid, memory);
        
        return reply;

    } catch (err) {
        console.error("Gemini API Error:", err.message);
        return "Sorry, I am having trouble connecting to my brain right now.";
    }
}

// —— MAIN BOT LOGIC ———————————————————————————————
async function attachLlmAiLogic(sock) {
    console.log("🤖 Mohini AI Attached (Text + Audio Mode)");

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender === "status@broadcast") return;

        // 1. Get Text (or OCR)
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (msg.message.imageMessage) {
            text = await extractTextFromImage(msg.message.imageMessage) || "Image received";
        }

        if (!text) return;

        // 2. Handle !reset
        if (text.trim().toLowerCase() === "!reset") {
            await deleteUserMemory(sender);
            await sock.sendMessage(sender, { text: "Memory cleared!" });
            return;
        }

        console.log(`📩 ${sender}: ${text}`);
        await sock.sendPresenceUpdate("recording", sender);

        // 3. Get Gemini Reply
        const replyText = await getReply(sender, text);

        // 4. SEND TEXT (Always First)
        await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
        console.log("✅ Text Sent");

        // 5. SEND AUDIO (Always Second)
        const audioPath = await textToVoiceNote(replyText);
        if (audioPath) {
            await sock.sendMessage(sender, { 
                audio: fs.readFileSync(audioPath), 
                mimetype: "audio/ogg; codecs=opus", 
                ptt: true 
            }, { quoted: msg });
            
            fs.unlinkSync(audioPath); // Cleanup
            console.log("✅ Audio Sent");
        } else {
            console.log("⚠️ Audio generation failed (Text only sent)");
        }
    });
}

module.exports = { attachLlmAiLogic };

