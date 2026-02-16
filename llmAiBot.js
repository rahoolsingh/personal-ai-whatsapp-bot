const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createWorker } = require("tesseract.js");
const ffmpeg = require("fluent-ffmpeg");

// —— CONFIG & STATE —————————————————————————————
const sessionStats = new Map();
const memoryDir = path.join(__dirname, "user_memory");
const trashDir = path.join(__dirname, "trash");
const tempDir = path.join(__dirname, "temp");

// Create directories
[memoryDir, trashDir, tempDir].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Mood states
const MOODS = {
    CHATTY: "chatty",
    LAZY: "lazy",
    EXCITED: "excited",
    SLEEPY: "sleepy",
    NORMAL: "normal",
};

let currentMood = MOODS.NORMAL;
let moodChangeTime = Date.now();

// —— HELPER FUNCTIONS —————————————————————————————

function updateMood() {
    const now = Date.now();
    if (now - moodChangeTime > (30 + Math.random() * 30) * 60 * 1000) {
        const moods = Object.values(MOODS);
        currentMood = moods[Math.floor(Math.random() * moods.length)];
        moodChangeTime = now;
        console.log(`🎭 Mohini's mood changed to: ${currentMood.toUpperCase()}`);
    }
}

function renderSessionTable() {
    const rows = Array.from(sessionStats.entries()).map(([jid, info]) => ({
        Number: jid.replace(/@.+/, ""),
        Name: info.name || "Unknown",
        "Total Chats": info.count,
        "Last Seen": new Date(info.lastSeen).toLocaleString("en-IN"),
        Mood: currentMood.toUpperCase(),
    }));
    // console.clear(); // Disabled to prevent clearing API logs
    console.log("📊 Mohini's Chat Stats");
    console.table(rows);
}

function getMemoryPath(jid) {
    return path.join(memoryDir, `${jid}.json`);
}

async function loadUserMemory(jid) {
    if (!fs.existsSync(getMemoryPath(jid))) return [];
    try {
        return JSON.parse(fs.readFileSync(getMemoryPath(jid), "utf-8"));
    } catch {
        return [];
    }
}

async function saveUserMemory(jid, memory) {
    fs.writeFileSync(getMemoryPath(jid), JSON.stringify(memory, null, 2), "utf-8");
}

async function deleteUserMemory(jid) {
    const file = getMemoryPath(jid);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

function checkVoiceRequest(message) {
    const voiceKeywords = ["voice", "audio", "bolo", "sunao", "voice note", "speak", "say it", "record", "bolke"];
    return voiceKeywords.some((keyword) => message.toLowerCase().includes(keyword));
}

function shouldSendVoice(messageLength, conversationHistory, isVoiceRequested = false) {
    updateMood();
    if (isVoiceRequested) return true;

    const recentVoiceCount = conversationHistory.slice(-5).filter(msg => msg.role === "assistant" && msg.type === "voice").length;
    if (recentVoiceCount >= 2) return false;

    switch (currentMood) {
        case MOODS.CHATTY: return Math.random() > 0.3;
        case MOODS.EXCITED: return Math.random() > 0.3;
        case MOODS.LAZY: return Math.random() > 0.8;
        case MOODS.SLEEPY: return Math.random() > 0.9;
        default: return messageLength < 50 ? Math.random() > 0.5 : Math.random() > 0.7;
    }
}

async function generateTTS(text) {
    try {
        const cleanText = text.replace(/[*_~`]/g, "").trim();

        // We use gemini-2.0-flash-exp specifically for consistent Audio Output support
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent`;

        const payload = {
            contents: [{
                parts: [{ text: `Say this in a natural, friendly Indian accent: ${cleanText}` }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"], // <--- THIS IS CRITICAL
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: "Puck", // Options: Puck, Charon, Aoede, Fenrir, Leda
                        },
                    },
                },
            },
        };

        const res = await axios.post(url, payload, {
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": process.env.GEMINI_API_KEY,
            }
        });

        // Debug: Log if candidates are missing
        if (!res?.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
            console.error("TTS Response missing audio data:", JSON.stringify(res.data));
            return null;
        }

        const audioBuffer = Buffer.from(res.data.candidates[0].content.parts[0].inlineData.data, "base64");
        const tempPcm = path.join(tempDir, `tts_${Date.now()}.pcm`);
        const tempOgg = path.join(tempDir, `tts_${Date.now()}.ogg`);

        fs.writeFileSync(tempPcm, audioBuffer);

        return new Promise((resolve, reject) => {
            ffmpeg(tempPcm)
                .inputFormat("s16le")
                .inputOptions(["-ar", "24000", "-ac", "1"])
                .audioCodec("libopus")
                .format("ogg")
                .on("end", () => {
                    if (fs.existsSync(tempPcm)) fs.unlinkSync(tempPcm);
                    resolve(tempOgg);
                })
                .on("error", (err) => {
                    if (fs.existsSync(tempPcm)) fs.unlinkSync(tempPcm);
                    reject(err);
                })
                .save(tempOgg);
        });
    } catch (err) {
        console.error("TTS Error:", err.response?.data || err.message);
        return null;
    }
}

async function extractTextFromImage(imageMessage) {
    try {
        const buffer = await axios.get(imageMessage.url || imageMessage.directPath, { responseType: "arraybuffer" }).then(r => Buffer.from(r.data));
        const worker = await createWorker("eng");
        const { data: { text } } = await worker.recognize(buffer);
        await worker.terminate();
        return text.trim();
    } catch {
        return "";
    }
}

async function getReply(jid, annotatedMessage, senderName = "yaar") {
    let memory = await loadUserMemory(jid);

    // System Prompt Injection
    if (memory.length === 0 || !memory.find(msg => msg.role === "system")) {
        const systemPrompt = {
            role: "system",
            content: `You are Mohini — an exciting, vibrant, and super cool human! 🌟
            - Keep it real: 20-100 words (like actual human)
            - Use natural Hinglish: yaar, arre, bas, acha
            - Emojis are your friend (1-3 max)
            - Current Mood: ${currentMood.toUpperCase()}
            - Creator: Veer Rajpoot (veerrajpoot.com)`
        };
        memory.unshift(systemPrompt);
    }

    memory.push({ role: "user", content: annotatedMessage });

    // Trim memory
    if (memory.length > 20) {
        const system = memory.filter(m => m.role === "system");
        const chats = memory.filter(m => m.role !== "system").slice(-15);
        memory = [...system, ...chats];
    }

    try {
        const contextMessages = memory
            .filter(msg => msg.role !== "system")
            .map(msg => ({
                role: msg.role === "assistant" ? "model" : "user",
                parts: [{ text: msg.content }],
            }));

        const systemPart = memory.find(m => m.role === "system")?.content || "";

        // Standard Text Generation
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                contents: contextMessages,
                systemInstruction: { parts: [{ text: systemPart }] },
                generationConfig: { maxOutputTokens: 200, temperature: 0.9 }
            }
        );

        const reply = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Arre yaar, server slow hai 😅";

        memory.push({ role: "assistant", content: reply, type: "pending" });
        await saveUserMemory(jid, memory);
        return reply;

    } catch (err) {
        console.error("Gemini API Error:", err.message);
        return "Mera dimag thoda thak gaya hai... baad mein baat karein? 😴";
    }
}

// —— MAIN LOGIC EXPORT —————————————————————————————

// Renamed back to 'attachAiLogic' so api.js works without changes
async function attachAiLogic(sock) {
    console.log("🤖 Enhanced Mohini AI Attached!");
    console.log(`🎭 Initial Mood: ${currentMood.toUpperCase()}`);

    const selfJid = () => sock.user?.id.split(":")[0] + "@s.whatsapp.net";

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith("@g.us");
        const botJid = selfJid();

        if (sender === "status@broadcast") return;

        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (msg.message.imageMessage) {
            const ocr = await extractTextFromImage(msg.message.imageMessage);
            text = ocr || "Image received";
        }

        const ctx = msg.message.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];

        if (text.trim().toLowerCase() === "!reset") {
            await deleteUserMemory(sender);
            return sock.sendMessage(sender, { text: "🧹 Memory saaf! Fresh start! ✨" });
        }

        let shouldReply = !isGroup;
        if (isGroup) {
            if (mentioned.includes(botJid) || text.toLowerCase().includes("mohini")) shouldReply = true;
        }
        if (!shouldReply) return;

        const stats = sessionStats.get(sender) || { name: msg.pushName || "yaar", count: 0, lastSeen: Date.now() };
        stats.count++;
        sessionStats.set(sender, stats);
        renderSessionTable();

        await sock.sendPresenceUpdate("composing", sender);

        let annotated = text;
        if (isGroup) annotated = `<${msg.pushName}>: ${text}`;

        const reply = await getReply(sender, annotated, msg.pushName);

        const isVoiceRequested = checkVoiceRequest(text);
        let memory = await loadUserMemory(sender);
        const useVoice = shouldSendVoice(reply.length, memory, isVoiceRequested);

        if (useVoice) {
            await sock.sendPresenceUpdate("recording", sender);
            console.log("🎙️ Generating Voice for:", reply.substring(0, 20) + "...");
            const audioPath = await generateTTS(reply);

            if (audioPath) {
                await sock.sendMessage(sender, { audio: fs.readFileSync(audioPath), mimetype: "audio/ogg; codecs=opus", ptt: true }, { quoted: msg });
                fs.unlinkSync(audioPath);

                memory = await loadUserMemory(sender);
                if (memory.length) memory[memory.length - 1].type = "voice";
                await saveUserMemory(sender, memory);
                console.log("✅ Voice Sent!");
                return;
            } else {
                console.log("⚠️ Voice generation failed, sending text.");
            }
        }

        await sock.sendMessage(sender, { text: reply }, { quoted: msg });
        memory = await loadUserMemory(sender);
        if (memory.length) memory[memory.length - 1].type = "text";
        await saveUserMemory(sender, memory);
    });
}

// Export as attachAiLogic to match api.js
module.exports = { attachAiLogic };