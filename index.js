const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require("baileys");

const { exec } = require("child_process");
const { Boom } = require("@hapi/boom");
const path = require("path");
const axios = require("axios");

async function getReply(text) {
    const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        body: JSON.stringify({
            model: "gemma:7b",
            prompt: `Reply friendly to this message in short: ${text}`,
            stream: false,
        }), 
        headers: { "Content-Type": "application/json" },
    });

    const data = await response.json();
    return data.response?.trim() || "Kya bolun bhai, kuch samajh nahi aaya 😅";
}

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

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("📱 Scan this QR code to log in:\n", qr);
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut;
            console.log("Connection closed. Reconnecting:", shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("✅ Bot connected to WhatsApp!");
        }
    });

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text =
            msg.message.conversation || msg.message.extendedTextMessage?.text;
        console.log("📩 Received:", text);

        const reply = await getReply(text);
        console.log("🤖 Replying with:", reply);

        await sock.sendMessage(msg.key.remoteJid, { text: reply });
    });
}

startBot();

