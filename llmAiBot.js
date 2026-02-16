const fs = require("fs");
const path = require("path");
const axios = require("axios");
const googleTTS = require("google-tts-api"); // <--- Free TTS Library
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

// —— HELPER FUNCTIONS —————————————————————————————

// 1. Generate Audio using Free Google TTS + FFmpeg
async function textToVoiceNote(text) {
    try {
        // 1. Get MP3 URL from Google TTS (Free, no key)
        const url = googleTTS.getAudioUrl(text, {
            lang: "en", // You can change to 'hi' for Hindi accent
            slow: false,
            host: "https://translate.google.com",
        });

        // 2. Download the MP3
        const mp3Buffer = await axios.get(url, { responseType: "arraybuffer" }).then((r) => Buffer.from(r.data));
        
        const tempMp3 = path.join(tempDir, `input_${Date.now()}.mp3`);
        const tempOgg = path.join(tempDir, `voice_${Date.now()}.ogg`);

        fs.writeFileSync(tempMp3, mp3Buffer);

        // 3. Convert MP3 to WhatsApp Voice Note (Opus/Ogg) using FFmpeg
        return new Promise((resolve, reject) => {
            ffmpeg(tempMp3)
                .outputOptions([
                    "-c:a libopus", 
                    "-b:a 16k",      // Low bitrate for voice
                    "-vbr on", 
                    "-compression_level 10"
                ])
                .toFormat("ogg")
                .save(tempOgg)
                .on("end", () => {
                    fs.unlinkSync(tempMp3); // Cleanup MP3
                    resolve(tempOgg);
                })
                .on("error", (err) => {
                    if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
                    console.error("FFmpeg Error:", err);
                    resolve(null);
                });
        });
    } catch (err) {
        console.error("TTS Generation Error:", err.message);
        return null;
    }
}

// 2. Memory Management
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

// 3. Image OCR
async function extractTextFromImage(imageMessage) {
    try {
        const buffer = await axios.get(imageMessage.url || imageMessage.directPath, { responseType: "arraybuffer" }).then(r => Buffer.from(r.data));
        const worker = await createWorker("eng");
        const { data: { text } } = await worker.recognize(buffer);
        await worker.terminate();
        return text.trim();
    } catch { return ""; }
}

// 4. Gemini 2.5 Logic (Text Only)
async function getReply(jid, annotatedMessage) {
    let memory = await loadUserMemory(jid);

    // Initial Personality Setup
    if (memory.length === 0) {
        memory.unshift({
            role: "system",
            content: `You are Mohini, a witty and friendly AI assistant.
            - Keep answers short (under 30 words) because you are speaking in audio.
            - Use natural, conversational English (or Hinglish if the user speaks Hindi).
            - Do not use emojis, lists, or code blocks (since this is for voice).`
        });
    }

    memory.push({ role: "user", content: annotatedMessage });

    // Keep memory small for speed
    if (memory.length > 12) {
        const sys = memory[0];
        const recent = memory.slice(-10);
        memory = [sys, ...recent];
    }

    try {
        const contextMessages = memory
            .filter(msg => msg.role !== "system")
            .map(msg => ({
                role: msg.role === "assistant" ? "model" : "user",
                parts: [{ text: msg.content }],
            }));

        const systemPart = memory[0].content;

        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                contents: contextMessages,
                systemInstruction: { parts: [{ text: systemPart }] },
                generationConfig: { maxOutputTokens: 100, temperature: 0.7 }
            }
        );

        const reply = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Sorry, I couldn't think of a reply.";
        
        memory.push({ role: "assistant", content: reply });
        await saveUserMemory(jid, memory);
        return reply;

    } catch (err) {
        console.error("Gemini API Error:", err.message);
        return "My brain is offline right now.";
    }
}

// —— MAIN EXPORT —————————————————————————————

async function attachLlmAiLogic(sock) {
    console.log("🤖 Mohini AI (Voice Mode) Attached!");

    const selfJid = () => sock.user?.id.split(":")[0] + "@s.whatsapp.net";

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender === "status@broadcast") return;

        // 1. Extract Text
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (msg.message.imageMessage) {
            text = await extractTextFromImage(msg.message.imageMessage) || "Image received";
        }

        if (!text) return;

        // 2. Commands
        if (text.toLowerCase() === "!reset") {
            await deleteUserMemory(sender);
            await sock.sendMessage(sender, { text: "Memory cleared." });
            return;
        }

        console.log(`📩 Message from ${sender}: ${text.substring(0, 20)}...`);

        // 3. Send Typing Indicator
        await sock.sendPresenceUpdate("recording", sender);

        // 4. Get Text Reply from Gemini
        const replyText = await getReply(sender, text);

        // 5. Generate Audio (Free)
        const audioPath = await textToVoiceNote(replyText);

        if (audioPath) {
            // 6. Send Voice Note
            await sock.sendMessage(sender, { 
                audio: fs.readFileSync(audioPath), 
                mimetype: "audio/ogg; codecs=opus", 
                ptt: true // This makes it a "Voice Note" (green waveform)
            }, { quoted: msg });
            
            // Cleanup
            fs.unlinkSync(audioPath);
            console.log("✅ Audio sent!");
        } else {
            // Fallback if audio fails
            console.log("⚠️ Audio generation failed, sending text.");
            await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
        }
    });
}

module.exports = { attachLlmAiLogic };