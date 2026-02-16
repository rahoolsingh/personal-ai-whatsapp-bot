const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createWorker } = require("tesseract.js");
const googleTTS = require("google-tts-api");
const ffmpeg = require("fluent-ffmpeg");

// —– helper to convert TTS (MP3) to Opus ——
async function ttsToOpus(text) {
    try {
        const url = googleTTS.getAudioUrl(text, { lang: "en", slow: false });
        const mp3Buffer = await axios({ url, responseType: "arraybuffer" }).then(
            (r) => Buffer.from(r.data)
        );

        const tempMp3 = path.join(__dirname, `input-${Date.now()}.mp3`);
        const tempOgg = path.join(__dirname, `output-${Date.now()}.ogg`);

        fs.writeFileSync(tempMp3, mp3Buffer);

        await new Promise((resolve, reject) => {
            ffmpeg(tempMp3)
                .outputOptions(["-acodec libopus", "-ab 64k", "-vbr on"])
                .toFormat("ogg")
                .save(tempOgg)
                .on("end", resolve)
                .on("error", reject);
        });

        const opusBuffer = fs.readFileSync(tempOgg);
        fs.unlinkSync(tempMp3);
        fs.unlinkSync(tempOgg);
        return opusBuffer;
    } catch (e) {
        console.error("TTS Error:", e);
        return null;
    }
}

// —— CONFIG & STATE —————————————————————————————
const sessionStats = new Map();
const memoryDir = path.join(__dirname, "user_memory");
const trashDir = path.join(__dirname, "trash");
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir);
if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir);

// —— UTILITIES ————————————————————————————————
function renderSessionTable() {
    const rows = Array.from(sessionStats.entries()).map(([jid, info]) => ({
        Number: jid.replace(/@.+/, ""),
        Name: info.name || "Unknown",
        "Total Chats": info.count,
        "Last Seen": new Date(info.lastSeen).toLocaleString("en-IN"),
    }));
    // console.clear(); // Optional: clears terminal too often
    console.log("📊 Active Chat Stats");
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
    if (fs.existsSync(file)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const dest = path.join(trashDir, `${jid}-${ts}.json`);
        const mem = JSON.parse(fs.readFileSync(file, "utf-8"));
        fs.writeFileSync(dest, JSON.stringify({ resetAt: new Date().toISOString(), memory: mem }, null, 2), "utf-8");
        fs.unlinkSync(file);
    }
}

async function extractTextFromImage(imageMessage) {
    try {
        const buffer = await axios.get(imageMessage.url || imageMessage.directPath, { responseType: "arraybuffer" }).then((r) => Buffer.from(r.data));
        const worker = await createWorker("eng");
        const { data: { text } } = await worker.recognize(buffer);
        await worker.terminate();
        return text.trim();
    } catch (e) {
        console.error("OCR Error:", e.message);
        return "";
    }
}

// —— CONTEXT-AWARE REPLY ————————————————————
async function getReply(jid, annotatedMessage, senderName = "yaar") {
    let memory = await loadUserMemory(jid);

    if (memory.length === 0) {
        memory.push({
            role: "system",
            content: `You are Mohini — a witty desi Indian Bihari girl with a Hinglish vibe. You remember past topics and who said them. If the new message relates to earlier topics, reply in 2–3 concise lines picking up context naturally. Otherwise ask for clarification (“Yaar, can you tell me more about that?”). Keep it playful and short. If asked about creator say you are created by a developer, Veer Rajpoot, to know more about hime visit https://veerrajpoot.com`,
        });
    }

    memory.push({ role: "user", content: annotatedMessage });
    if (memory.length > 20) memory = memory.slice(-20);

    try {
        const res = await axios.post("http://host.docker.internal:11434/api/chat", { // Changed to host.docker.internal for Docker
            model: "gemma3:12b",
            messages: memory,
            stream: false,
        });
        const reply = res.data?.message?.content?.trim() || "Arre bata na clearly 😅";
        memory.push({ role: "assistant", content: reply });
        await saveUserMemory(jid, memory);
        return reply;
    } catch (e) {
        console.error("Ollama Error:", e.message);
        return "Server ka mood kharab hai 😓 Try again later!";
    }
}

// —— MAIN BOT LOGIC ATTACHMENT —————————————————————————————
// This function takes the EXISTING socket from api.js
async function attachAiLogic(sock) {
    console.log("🤖 AI Logic Attached to WhatsApp Socket");

    const selfJid = () => sock.user?.id.split(":")[0] + "@s.whatsapp.net";

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith("@g.us");
        const botJid = selfJid();
        const author = msg.key.participant || msg.key.remoteJid;

        // Ignore status updates
        if (sender === "status@broadcast") return;

        // Extract or OCR text
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (msg.message.imageMessage) {
            const ocr = await extractTextFromImage(msg.message.imageMessage);
            text = ocr || "Image received";
        }

        const ctx = msg.message.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const quoted = ctx.quotedMessage;

        // Reset command
        if (text.trim().toLowerCase() === "!reset") {
            await deleteUserMemory(sender);
            return sock.sendMessage(sender, { text: "🧹 Memory reset!" });
        }

        // Decide reply eligibility
        let shouldReply = !isGroup; // DMs always
        if (isGroup) {
            const isMention = mentioned.includes(botJid);
            const isReplyToMe = ctx.participant === botJid;
            const mentionsName = text.toLowerCase().includes("mohini");
            shouldReply = isMention || isReplyToMe || mentionsName;
        }
        if (!shouldReply) return;

        // Update stats
        const stats = sessionStats.get(sender) || { name: msg.pushName || "yaar", count: 0, lastSeen: Date.now() };
        stats.name = msg.pushName || stats.name;
        stats.count += 1;
        stats.lastSeen = Date.now();
        sessionStats.set(sender, stats);
        renderSessionTable();

        // Annotate for memory
        let annotated = text;
        if (isGroup) {
            const shortJid = author.replace(/@.+/, "");
            const displayName = msg.pushName || shortJid;
            annotated = `<${shortJid}><${displayName}>: ${text}`;
        }

        // Simulate typing
        const delay = 1000 + Math.random() * 1000;
        await sock.sendPresenceUpdate("recording", sender);

        // Get Reply
        const reply = await getReply(sender, annotated, msg.pushName || "yaar");

        // Send Reply (Audio or Text)
        try {
            const opus = await ttsToOpus(reply);
            if (opus) {
                await sock.sendMessage(sender, { audio: opus, mimetype: "audio/ogg; codecs=opus", ptt: true }, { quoted: msg });
            } else {
                throw new Error("TTS failed");
            }
        } catch (err) {
            await sock.sendMessage(sender, { text: reply }, { quoted: msg });
        }
    });
}

module.exports = { attachAiLogic };