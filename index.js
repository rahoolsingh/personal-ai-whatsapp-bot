const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require("baileys");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createWorker } = require("tesseract.js");

const googleTTS = require("google-tts-api");
const ffmpeg = require("fluent-ffmpeg"); // for MP3 -> Opus

// —– helper to convert TTS (MP3) to Opus ——
async function ttsToOpus(text) {
    // 1. Download TTS first
    const url = googleTTS.getAudioUrl(text, { lang: "en", slow: false });
    const mp3Buffer = await axios({ url, responseType: "arraybuffer" }).then(
        (r) => Buffer.from(r.data)
    );

    fs.writeFileSync("input.mp3", mp3Buffer);

    // 2. Convert to Opus
    await new Promise((resolve, reject) => {
        ffmpeg("input.mp3")
            .outputOptions(["-acodec libopus", "-ab 64k", "-vbr on"])
            .toFormat("ogg")
            .save("output.ogg")
            .on("end", resolve)
            .on("error", reject);
    });

    const opusBuffer = fs.readFileSync("output.ogg");

    fs.unlinkSync("input.mp3"); // Cleanup
    fs.unlinkSync("output.ogg"); // Cleanup

    return opusBuffer;
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
    console.clear();
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
    fs.writeFileSync(
        getMemoryPath(jid),
        JSON.stringify(memory, null, 2),
        "utf-8"
    );
}

async function deleteUserMemory(jid) {
    const file = getMemoryPath(jid);
    if (fs.existsSync(file)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const dest = path.join(trashDir, `${jid}-${ts}.json`);
        const mem = JSON.parse(fs.readFileSync(file, "utf-8"));
        fs.writeFileSync(
            dest,
            JSON.stringify(
                { resetAt: new Date().toISOString(), memory: mem },
                null,
                2
            ),
            "utf-8"
        );
        fs.unlinkSync(file);
    }
}

async function extractTextFromImage(imageMessage) {
    try {
        const buffer = await axios
            .get(imageMessage.url || imageMessage.directPath, {
                responseType: "arraybuffer",
            })
            .then((r) => Buffer.from(r.data));
        const worker = createWorker();
        await worker.load();
        await worker.loadLanguage("eng");
        await worker.initialize("eng");
        const {
            data: { text },
        } = await worker.recognize(buffer);
        await worker.terminate();
        return text.trim();
    } catch {
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

    // Store the annotated user line exactly
    memory.push({ role: "user", content: annotatedMessage });

    if (memory.length > 20) memory = memory.slice(-20);

    try {
        const res = await axios.post("http://localhost:11434/api/chat", {
            model: "gemma3:12b",
            messages: memory,
            stream: false,
        });
        const reply =
            res.data?.message?.content?.trim() || "Arre bata na clearly 😅";
        memory.push({ role: "assistant", content: reply });
        await saveUserMemory(jid, memory);
        return reply;
    } catch {
        return "Server ka mood kharab hai 😓 Try again later!";
    }
}

// —— MAIN BOT LOOP —————————————————————————————
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(
        path.join(__dirname, "auth_info_baileys")
    );
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
    });

    sock.ev.on("creds.update", saveCreds);
    const selfJid = () => sock.user?.id.split(":")[0] + "@s.whatsapp.net";

    sock.ev.on("connection.update", (update) => {
        if (update.qr) console.log("📱 Scan this QR:\n", update.qr);
        if (update.connection === "open") console.log("✅ Mohini is online!");
        if (
            update.connection === "close" &&
            update.lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut
        ) {
            console.log("🔄 Reconnecting...");
            startBot();
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith("@g.us");
        const botJid = selfJid();
        const author = msg.key.participant || msg.key.remoteJid;
        if (author === botJid) return;

        // Extract or OCR text
        let text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";
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
        const stats = sessionStats.get(sender) || {
            name: msg.pushName || "yaar",
            count: 0,
            lastSeen: Date.now(),
        };
        stats.name = msg.pushName || stats.name;
        stats.count += 1;
        stats.lastSeen = Date.now();
        sessionStats.set(sender, stats);
        renderSessionTable();

        // Annotate for memory: <jid><name>: message
        let annotated = text;
        if (isGroup) {
            const shortJid = author.replace(/@.+/, "");
            const displayName = msg.pushName || shortJid;
            annotated = `<${shortJid}><${displayName}>: ${text}`;
        }

        // Simulate typing & fetch reply in parallel
        const delay = 1000 + Math.random() * 1000;
        const typing = sock
            .sendPresenceUpdate("recording", sender)
            .then(() => new Promise((r) => setTimeout(r, delay)));
        const replyP = getReply(sender, annotated, msg.pushName || "yaar");
        await Promise.all([typing, replyP]);
        const reply = await replyP;

        // Preserve quoted context
        let prefix = "";
        if (quoted) {
            const orig =
                Object.values(quoted)[0].text ||
                Object.values(quoted)[0].conversation ||
                Object.values(quoted)[0].caption;
            if (orig) prefix = `💬 "${orig}"\n`;
        }

        // Send reply quoting original
        try {
            // Convert text to audio first
            const url = googleTTS.getAudioUrl(prefix + reply, {
                lang: "en",
                slow: false,
            });

            const audioBuffer = await axios({
                url,
                responseType: "arraybuffer",
            }).then((r) => Buffer.from(r.data));

            await sock.sendMessage(
                sender,
                {
                    audio: audioBuffer,
                    mimetype: "audio/ogg; codecs=opus",
                    ptt: true,
                },
                { quoted: msg }
            );
        } catch (e) {
            console.error("TTS failed, falling back to text!", e);
            await sock.sendMessage(
                sender,
                { text: prefix + reply },
                { quoted: msg }
            );
        }
    });
}

startBot();
