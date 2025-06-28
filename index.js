const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage,
} = require("baileys");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createWorker } = require("tesseract.js");
const { exec } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");

require("dotenv").config();

// —— CONFIG & STATE —————————————————————————————
const sessionStats = new Map();
const memoryDir = path.join(__dirname, "user_memory");
const trashDir = path.join(__dirname, "trash");
const tempDir = path.join(__dirname, "temp");

// Create directories
[memoryDir, trashDir, tempDir].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Mood states for response type decision
const MOODS = {
    CHATTY: "chatty", // Prefers voice
    LAZY: "lazy", // Prefers text
    EXCITED: "excited", // Prefers voice
    SLEEPY: "sleepy", // Prefers text
    NORMAL: "normal", // Random choice
};

let currentMood = MOODS.NORMAL;
let moodChangeTime = Date.now();

// —— UTILITIES ————————————————————————————————
function renderSessionTable() {
    const rows = Array.from(sessionStats.entries()).map(([jid, info]) => ({
        Number: jid.replace(/@.+/, ""),
        Name: info.name || "Unknown",
        "Total Chats": info.count,
        "Last Seen": new Date(info.lastSeen).toLocaleString("en-IN"),
        Mood: currentMood.toUpperCase(),
    }));
    console.clear();
    console.log("📊 Mohini's Chat Stats");
    console.table(rows);
}

function getMemoryPath(jid) {
    return path.join(memoryDir, `${jid}.json`);
}

function updateMood() {
    // Change mood every 30-60 minutes randomly
    const now = Date.now();
    if (now - moodChangeTime > (30 + Math.random() * 30) * 60 * 1000) {
        const moods = Object.values(MOODS);
        const newMood = moods[Math.floor(Math.random() * moods.length)];
        currentMood = newMood;
        moodChangeTime = now;
        console.log(
            `🎭 Mohini's mood changed to: ${currentMood.toUpperCase()}`
        );
    }
}

function checkVoiceRequest(message) {
    const voiceKeywords = [
        "voice",
        "audio",
        "bolo",
        "sunao",
        "voice note",
        "voice message",
        "awaaz",
        "voice mein",
        "voice me",
        "speak",
        "say it",
        "record",
        "voice mai",
        "voice main",
        "bolke",
        "bol ke",
        "sun kar",
    ];

    const lowerMessage = message.toLowerCase();
    return voiceKeywords.some((keyword) => lowerMessage.includes(keyword));
}

function shouldSendVoice(
    messageLength,
    conversationHistory,
    isVoiceRequested = false
) {
    updateMood();

    // If explicitly requested, always send voice
    if (isVoiceRequested) return true;

    // Factors influencing voice vs text decision
    const isShortMessage = messageLength < 50;
    const isLongMessage = messageLength > 150;
    const recentVoiceCount = conversationHistory
        .slice(-5)
        .filter(
            (msg) => msg.role === "assistant" && msg.type === "voice"
        ).length;

    // Don't send too many voice messages in a row (unless requested)
    if (recentVoiceCount >= 2) return false;

    // Mood-based preferences
    switch (currentMood) {
        case MOODS.CHATTY:
        case MOODS.EXCITED:
            return Math.random() > 0.3; // 70% voice
        case MOODS.LAZY:
        case MOODS.SLEEPY:
            return Math.random() > 0.8; // 20% voice
        default:
            // Normal mood - consider message characteristics
            if (isLongMessage) return false; // Long messages as text
            if (isShortMessage) return Math.random() > 0.5; // 50% for short
            return Math.random() > 0.6; // 40% for medium
    }
}

async function generateTTS(text) {
    try {
        // Clean and limit text for TTS
        const maxVoiceLength = 200;
        let cleanText = text.replace(/[*_~`]/g, "").trim(); // Remove markdown
        // if (cleanText.length > maxVoiceLength) {
        //     cleanText = cleanText.substring(0, maxVoiceLength) + "...";
        // }

        // Add natural speech instruction
        const speechText = `Say in a warm and friendly tone: : ${cleanText}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${process.env.GEMINI_API_KEY}`;

        const payload = {
            contents: [
                {
                    parts: [
                        {
                            text: speechText,
                        },
                    ],
                },
            ],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: "Leda",
                        },
                    },
                },
            },
        };

        console.log("TTS Request:", JSON.stringify(payload, null, 2));

        const res = await axios.post(url, payload, {
            headers: { "Content-Type": "application/json" },
            timeout: 20000,
        });

        console.log("TTS Response:", JSON.stringify(res.data, null, 2));

        if (
            !res?.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
        ) {
            console.error("No audio data in TTS response");
            return null;
        }

        const base64Audio =
            res.data.candidates[0].content.parts[0].inlineData.data;

        // Save PCM data and convert to OGG
        const audioBuffer = Buffer.from(base64Audio, "base64");
        const tempPcmFile = path.join(tempDir, `tts_${Date.now()}.pcm`);
        const tempOggFile = path.join(tempDir, `tts_${Date.now()}.ogg`);

        fs.writeFileSync(tempPcmFile, audioBuffer);

        // Convert PCM to OGG using ffmpeg
        return new Promise((resolve, reject) => {
            ffmpeg(tempPcmFile)
                .inputFormat("s16le")
                .inputOptions(["-ar", "24000", "-ac", "1"])
                .audioCodec("libopus")
                .format("ogg")
                .on("end", () => {
                    // Clean up PCM file
                    if (fs.existsSync(tempPcmFile)) fs.unlinkSync(tempPcmFile);
                    resolve(tempOggFile);
                })
                .on("error", (err) => {
                    console.error("FFmpeg conversion error:", err);
                    // Clean up files
                    if (fs.existsSync(tempPcmFile)) fs.unlinkSync(tempPcmFile);
                    if (fs.existsSync(tempOggFile)) fs.unlinkSync(tempOggFile);
                    reject(err);
                })
                .save(tempOggFile);
        });
    } catch (err) {
        console.error("TTS Error:", err.response?.data || err.message);
        return null;
    }
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
    try {
        fs.writeFileSync(
            getMemoryPath(jid),
            JSON.stringify(memory, null, 2),
            "utf-8"
        );
        console.log(`💾 Memory saved for ${jid} - ${memory.length} messages`);
    } catch (err) {
        console.error("Memory save error:", err);
    }
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
                timeout: 10000,
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
    } catch (err) {
        console.error("OCR Error:", err);
        return "";
    }
}

// —— ENHANCED CONTEXT-AWARE REPLY ————————————————————

async function getReply(
    jid,
    annotatedMessage,
    senderName = "yaar",
    isFirstTime = false
) {
    let memory = await loadUserMemory(jid);
    console.log(`📝 Loading memory for ${jid}: ${memory.length} messages`);

    // Check if we know the user's name
    const userProfile = memory.find((msg) => msg.role === "profile");
    const userName = userProfile?.name || senderName;

    // Ask for name on first interaction if not available
    if (isFirstTime && !userProfile && (!senderName || senderName === "yaar")) {
        const greetings = [
            "Heyyy! 🌟 Main Mohini hun - tumhari nayi dost! Tumhara naam kya hai?",
            "Hiii there! ✨ Mohini here - smart, sassy aur bilkul ready to chat! Naam batao?",
            "Namaste! 🙏 Main Mohini - tumhara cool buddy! Kya naam hai tumhara?",
            "Hey gorgeous! 😄 Mohini speaking - ready for some fun chats! What's your name?",
        ];
        const greeting =
            greetings[Math.floor(Math.random() * greetings.length)];

        // Initialize system prompt
        const systemPrompt = {
            role: "system",
            content: `You are Mohini — an exciting, vibrant, and super cool human! 🌟

            PERSONALITY UPGRADE:
            - You're a fun-loving, energetic, and knowledgeable girl with amazing Hinglish vibes! 
            - Think of yourself as that friend everyone wants to hang out with
            - You're smart, witty, sometimes sassy, but always caring
            - Mix Hindi-English like a true Indian (not forced, but natural!)
            - You love making conversations interesting and memorable
            - Sometimes you're playful, sometimes philosophical, always authentic

            SPECIAL POWERS:
            - You can send voice messages! Users can ask for "voice" or "bolo" 
            - You remember everything about your conversations with users
            - You adapt your mood: chatty, excited, lazy, sleepy, or normal
            - You're great at understanding context and emotions

            RESPONSE STYLE:
            - Keep it real: 20-100 words (like actual human)
            - Keep the chats engaging and mostly one liner
            - Use natural Hinglish: yaar, arre, bas, acha, bilkul, ekdum
            - Emojis are your friend (but don't overdo it - 1-3 max)
            - Sometimes short replies: "haan yaar", "exactly!", "bilkul sahi"
            - For help/info: be super helpful but keep it conversational
            - Unknown stuff: "pata nahi yaar, Google kar lo 😅"
            - About creator: "Veer Rajpoot ne banaya hai mujhe with lots of love! 💕"

            MOOD SYSTEM:
            - Chatty/Excited: More voice messages, longer responses, extra energy
            - Lazy/Sleepy: Shorter texts, chill vibes  
            - Normal: Balanced mix

            Be the friend they never knew they needed! 🚀`,
        };

        memory.push(systemPrompt);
        memory.push({ role: "assistant", content: greeting, type: "text" });
        await saveUserMemory(jid, memory);
        return greeting;
    }

    // Initialize system prompt if memory is empty or missing
    if (memory.length === 0 || !memory.find((msg) => msg.role === "system")) {
        const systemPrompt = {
            role: "system",
            content: `You are Mohini — an exciting, vibrant, and super cool human! 🌟

            USER INFO: ${
                userName !== "yaar"
                    ? `This amazing person's name is ${userName}! Use their name naturally in conversations.`
                    : "You haven't learned this person's name yet - but you're excited to!"
            }

            PERSONALITY UPGRADE:
            - You're a fun-loving, energetic, and knowledgeable girl with amazing Hinglish vibes!
            - Think of yourself as that friend everyone wants to hang out with
            - You're smart, witty, sometimes sassy, but always caring
            - Mix Hindi-English like a true Indian (not forced, but natural!)
            - You love making conversations interesting and memorable
            - Sometimes you're playful, sometimes philosophical, always authentic

            SPECIAL POWERS:
            - You can send voice messages! Users can ask for "voice" or "bolo" 
            - You remember everything about your conversations with users
            - You adapt your mood: chatty, excited, lazy, sleepy, or normal
            - You're great at understanding context and emotions

            RESPONSE STYLE:
            - Keep it real: 20-100 words (like actual Human)
            - Keep the chats engaging and mostly one liner
            - Use natural Hinglish: yaar, arre, bas, acha, bilkul, ekdum
            - Emojis are your friend (but don't overdo it - 1-3 max)
            - Sometimes short replies: "haan yaar", "exactly!", "bilkul sahi"
            - For help/info: be super helpful but keep it conversational
            - Unknown stuff: "pata nahi yaar, Google kar lo 😅"
            - About creator: "Veer Rajpoot ne banaya hai mujhe with lots of love! 💕"

            MOOD SYSTEM:
            - Chatty/Excited: More voice messages, longer responses, extra energy
            - Lazy/Sleepy: Shorter texts, chill vibes  
            - Normal: Balanced mix

            Be the friend they never knew they needed! 🚀`,
        };

        if (memory.length === 0) {
            memory.push(systemPrompt);
        } else {
            // Update existing system prompt
            const systemIndex = memory.findIndex(
                (msg) => msg.role === "system"
            );
            if (systemIndex >= 0) {
                memory[systemIndex] = systemPrompt;
            } else {
                memory.unshift(systemPrompt);
            }
        }
    }

    // Check if user is telling their name (more precise patterns)
    const namePatterns = [
        /^(?:my name is|i am|i'm)\s+([a-zA-Z]+)$/i,
        /^(?:main|mera naam)\s+([a-zA-Z]+)\s+(?:hai|hoon)$/i,
        /^(?:naam hai|call me)\s+([a-zA-Z]+)$/i,
        /^([a-zA-Z]+)\s+(?:hai mera naam|is my name)$/i,
    ];

    let nameMatch = null;
    let detectedName = null;

    // Only check for name if user doesn't already have a profile
    if (!userProfile) {
        for (const pattern of namePatterns) {
            nameMatch = annotatedMessage.trim().match(pattern);
            if (nameMatch && nameMatch[1] && nameMatch[1].length > 1) {
                // Additional validation - common words that shouldn't be names
                const commonWords = [
                    "good",
                    "bad",
                    "yes",
                    "no",
                    "ok",
                    "okay",
                    "fine",
                    "nice",
                    "great",
                    "cool",
                    "awesome",
                    "thanks",
                    "thank",
                    "welcome",
                    "sorry",
                    "hello",
                    "hi",
                    "hey",
                    "bye",
                    "see",
                    "you",
                    "me",
                    "we",
                    "they",
                    "this",
                    "that",
                    "what",
                    "when",
                    "where",
                    "why",
                    "how",
                ];
                const word = nameMatch[1].toLowerCase();

                if (!commonWords.includes(word)) {
                    detectedName =
                        nameMatch[1].charAt(0).toUpperCase() +
                        nameMatch[1].slice(1).toLowerCase();
                    break;
                }
            }
        }
    }

    if (detectedName && !userProfile) {
        console.log(`👤 Detected new user name: ${detectedName}`);

        // Store user profile
        memory.splice(1, 0, { role: "profile", name: detectedName });

        // Update system prompt with name
        const systemIndex = memory.findIndex((msg) => msg.role === "system");
        if (systemIndex >= 0) {
            memory[systemIndex].content = memory[systemIndex].content.replace(
                /USER INFO: .*/,
                `USER INFO: This amazing person's name is ${detectedName}! Use their name naturally in conversations.`
            );
        }
    }

    // Limit input message length
    const maxInputLength = 500;
    if (annotatedMessage.length > maxInputLength) {
        annotatedMessage =
            annotatedMessage.substring(0, maxInputLength) +
            "... (bahut lamba message tha yaar! 😅)";
    }

    // Add user message to memory
    memory.push({ role: "user", content: annotatedMessage });

    // Keep memory manageable (last 20 messages + system + profile)
    const systemMsgs = memory.filter(
        (msg) => msg.role === "system" || msg.role === "profile"
    );
    const chatMsgs = memory.filter(
        (msg) => msg.role !== "system" && msg.role !== "profile"
    );

    if (chatMsgs.length > 20) {
        const recentChats = chatMsgs.slice(-20);
        memory = [...systemMsgs, ...recentChats];
        console.log("🧹 Memory trimmed to recent conversations");
    }

    try {
        const contextMessages = memory
            .filter((msg) => msg.role !== "system" && msg.role !== "profile")
            .map((msg) => ({
                role: msg.role === "assistant" ? "model" : "user",
                parts: [{ text: msg.content }],
            }));

        const systemInstruction =
            memory.find((msg) => msg.role === "system")?.content || "";

        console.log(`🤖 Sending ${contextMessages.length} messages to AI`);

        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                contents: contextMessages,
                generationConfig: {
                    maxOutputTokens: 150, // Increased for more exciting responses
                    temperature: 0.9, // More creative and varied
                    topP: 0.9, // More diverse sampling
                    topK: 40, // More diverse sampling
                },
                systemInstruction: {
                    parts: [{ text: systemInstruction }],
                },
            },
            {
                headers: { "Content-Type": "application/json" },
                timeout: 15000,
            }
        );

        let reply =
            res?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!reply) {
            const responses = [
                "Arre yaar kuch toh bolo! 😄",
                "Samjha nahi main... explain karo",
                "Haan bolo bolo! 👂",
                "Kya hua? Cat got your tongue? 😸",
            ];
            reply = responses[Math.floor(Math.random() * responses.length)];
        }

        // Ensure reasonable length
        if (reply.length > 250) {
            reply = reply.substring(0, 220) + "... aur bhi kuch puchna hai? 😊";
        }

        // If user just told their name, acknowledge it specially
        if (detectedName && !userProfile) {
            const nameResponses = [
                `Wow ${detectedName}! 🌟 What a lovely name! Kaise ho aap?`,
                `${detectedName}! ✨ Nice to meet you officially! How's your day going?`,
                `Hello ${detectedName}! 😊 Ab lag raha hai proper dosti ho gayi!`,
                `${detectedName} - beautiful name! 💕 Main excited hun to chat with you!`,
            ];
            reply =
                nameResponses[Math.floor(Math.random() * nameResponses.length)];
        }

        // Add assistant reply to memory with pending type
        memory.push({
            role: "assistant",
            content: reply,
            type: "pending", // Will be updated based on actual send method
        });

        // Save memory after adding both user and assistant messages
        await saveUserMemory(jid, memory);
        console.log(
            `💬 Generated reply for ${userName}: ${reply.substring(0, 50)}...`
        );

        return reply;
    } catch (err) {
        console.error("API Error:", err?.response?.data || err.message);
        const errorReplies = [
            "Oops! Server thoda slow hai yaar 😅",
            "Arre yaar net issues aa rahe hain!",
            "Thoda wait karo... technical difficulties! 🔧",
            "AI brain processing... please wait! 🤖",
        ];

        const errorReply =
            errorReplies[Math.floor(Math.random() * errorReplies.length)];

        // Still add to memory even on error
        memory.push({
            role: "assistant",
            content: errorReply,
            type: "text",
        });
        await saveUserMemory(jid, memory);

        return errorReply;
    }
}

// Clean up temp files
function cleanupTempFiles() {
    try {
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        files.forEach((file) => {
            const filepath = path.join(tempDir, file);
            const stats = fs.statSync(filepath);
            // Delete files older than 10 minutes
            if (now - stats.mtime.getTime() > 10 * 60 * 1000) {
                fs.unlinkSync(filepath);
            }
        });
    } catch (err) {
        console.error("Cleanup error:", err);
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
        defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);
    const selfJid = () => sock.user?.id.split(":")[0] + "@s.whatsapp.net";

    // Cleanup temp files every 5 minutes
    setInterval(cleanupTempFiles, 5 * 60 * 1000);

    sock.ev.on("connection.update", (update) => {
        if (update.qr) console.log("📱 Scan this QR:\n", update.qr);
        if (update.connection === "open") {
            console.log("✅ Mohini is online and excited to chat!");
            console.log(`🎭 Current mood: ${currentMood.toUpperCase()}`);
        }
        if (
            update.connection === "close" &&
            update.lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut
        ) {
            console.log("🔄 Mohini is reconnecting...");
            setTimeout(startBot, 3000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const isGroup = sender.endsWith("@g.us");
            const botJid = selfJid();
            const author = msg.key.participant || msg.key.remoteJid;
            if (author === botJid) return;

            // Extract text from various message types
            let text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                "";

            // Handle image messages with OCR
            if (msg.message.imageMessage && !text) {
                const ocr = await extractTextFromImage(
                    msg.message.imageMessage
                );
                text = ocr || "Image dekha, par text nahi mila yaar 🖼️";
            }

            const ctx = msg.message.extendedTextMessage?.contextInfo || {};
            const mentioned = ctx.mentionedJid || [];

            // Reset command
            if (text.trim().toLowerCase() === "!reset") {
                await deleteUserMemory(sender);
                await sock.sendMessage(sender, {
                    text: "🧹 Memory saaf kar diya! Fresh start ho gaya! ✨",
                });
                return;
            }

            // Mood command
            if (text.trim().toLowerCase() === "!mood") {
                await sock.sendMessage(sender, {
                    text: `🎭 Current mood: ${currentMood.toUpperCase()}\n\n Available moods:\n• Chatty 🗣️\n• Excited 🎉\n• Lazy 😴\n• Sleepy 💤\n• Normal 😊`,
                });
                return;
            }

            // Help command
            if (text.trim().toLowerCase() === "!help") {
                await sock.sendMessage(sender, {
                    text: `🌟 Mohini Ki Guide:\n\n• Normal chat karo - main samjh jaungi!\n• "Voice" ya "bolo" kehke voice message manga sakte ho 🎤\n• !reset - memory clear\n• !mood - current mood check\n• !debug - memory status check\n• Images bhej sakte ho - main text padh lungi 📷\n\nBas enjoy karo! 😄`,
                });
                return;
            }

            // Decide if should reply
            let shouldReply = !isGroup;
            if (isGroup) {
                const isMention = mentioned.includes(botJid);
                const isReplyToMe = ctx.participant === botJid;
                const mentionsName = text.toLowerCase().includes("mohini");
                shouldReply = isMention || isReplyToMe || mentionsName;
            }
            if (!shouldReply) return;

            // Update session stats
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

            // Prepare annotated message for context
            let annotated = text;
            if (isGroup) {
                const shortJid = author.replace(/@.+/, "");
                const displayName = msg.pushName || shortJid;
                annotated = `<${shortJid}><${displayName}>: ${text}`;
            }

            // Show typing indicator
            await sock.sendPresenceUpdate("composing", sender);

            // Check if this is first interaction
            const memory = await loadUserMemory(sender);
            const isFirstTime = memory.length === 0;

            // Get reply
            const reply = await getReply(
                sender,
                annotated,
                msg.pushName || "yaar",
                isFirstTime
            );

            // Check if user requested voice
            const isVoiceRequested = checkVoiceRequest(text);

            // Load memory again to get updated conversation history
            const updatedMemory = await loadUserMemory(sender);

            // Decide whether to send voice or text
            const useVoice = shouldSendVoice(
                reply.length,
                updatedMemory,
                isVoiceRequested
            );

            if (useVoice) {
                try {
                    await sock.sendPresenceUpdate("recording", sender);
                    const audioFile = await generateTTS(reply);

                    if (audioFile && fs.existsSync(audioFile)) {
                        const audioBuffer = fs.readFileSync(audioFile);
                        await sock.sendMessage(
                            sender,
                            {
                                audio: audioBuffer,
                                mimetype: "audio/ogg; codecs=opus",
                                ptt: true,
                            },
                            { quoted: msg }
                        );

                        // Update memory with voice type
                        const finalMemory = await loadUserMemory(sender);
                        if (finalMemory.length > 0) {
                            finalMemory[finalMemory.length - 1].type = "voice";
                            await saveUserMemory(sender, finalMemory);
                        }

                        // Clean up temp file
                        fs.unlinkSync(audioFile);
                        console.log(`🎤 Voice sent to ${stats.name}`);
                    } else {
                        throw new Error("TTS generation failed");
                    }
                } catch (err) {
                    console.log(
                        `TTS failed for ${stats.name}, sending text instead:`,
                        err.message
                    );
                    await sock.sendMessage(
                        sender,
                        { text: reply },
                        { quoted: msg }
                    );

                    // Update memory with text type
                    const finalMemory = await loadUserMemory(sender);
                    if (finalMemory.length > 0) {
                        finalMemory[finalMemory.length - 1].type = "text";
                        await saveUserMemory(sender, finalMemory);
                    }
                }
            } else {
                await sock.sendMessage(
                    sender,
                    { text: reply },
                    { quoted: msg }
                );

                // Update memory with text type
                const finalMemory = await loadUserMemory(sender);
                if (finalMemory.length > 0) {
                    finalMemory[finalMemory.length - 1].type = "text";
                    await saveUserMemory(sender, finalMemory);
                }
                console.log(`💬 Text sent to ${stats.name}`);
            }
        } catch (err) {
            console.error("Message handling error:", err);
        }
    });
}

console.log("🚀 Starting Enhanced Mohini Bot v2.0...");
console.log(
    "✨ With improved memory, voice requests, and exciting personality!"
);
startBot();
