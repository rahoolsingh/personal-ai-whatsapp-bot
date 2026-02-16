const express = require("express");
const bodyParser = require("body-parser");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { attachLlmAiLogic } = require("./llmAiBot");

// —— CONFIGURATION —————————————————————————————————
const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, "api_config.json");
const AUTH_DIR = path.join(__dirname, "auth_info_baileys");

// —— EXPRESS APP SETUP —————————————————————————————
const app = express();
app.use(bodyParser.json());

// Global variable to hold the socket connection
let sock;

// —— UTILITIES —————————————————————————————————————
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        const defaultConfig = { apiKeys: ["default_secret_key"], allowedIPs: ["::1", "127.0.0.1"] };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}

function formatToJid(mobileNumber) {
    let cleaned = mobileNumber.replace(/\D/g, "");
    return `${cleaned}@s.whatsapp.net`;
}

// —— MIDDLEWARE ————————————————————————————————————
const authMiddleware = (req, res, next) => {
    const config = loadConfig();
    const clientIp = req.ip || req.connection.remoteAddress;
    const allowAllIPs = config.allowedIPs.includes("*");

    if (!allowAllIPs) {
        const normalizedIp = clientIp === '::1' ? '127.0.0.1' : clientIp.replace(/^.*:/, '');
        const isIpAllowed = config.allowedIPs.includes(clientIp) || config.allowedIPs.includes(normalizedIp);
        if (!isIpAllowed) return res.status(403).json({ error: "Access Denied: IP not whitelisted" });
    }

    const apiKey = req.headers["x-api-key"];
    if (!apiKey || !config.apiKeys.includes(apiKey)) return res.status(401).json({ error: "Access Denied: Invalid API Key" });

    next();
};

// —— WHATSAPP LOGIC ————————————————————————————————
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("\nScan this QR Code to login:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("⚠️ Connection closed. Reconnecting...", shouldReconnect);
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === "open") {
            console.log("✅ WhatsApp Connected and Ready!");
        }
    });

    // START THE AI BOT LISTENER HERE
    // Pass the socket to the AI logic
    attachLlmAiLogic(sock);
}

// —— API ROUTES ————————————————————————————————————
app.post("/send-message", authMiddleware, async (req, res) => {
    const { mobileNumber, message } = req.body;

    if (!mobileNumber || !message) return res.status(400).json({ success: false, error: "Missing data" });
    if (!sock) return res.status(503).json({ success: false, error: "WhatsApp service is not initializing" });

    try {
        const jid = formatToJid(mobileNumber);
        await sock.sendMessage(jid, { text: `${message}\n\n ~ veerrajpoot.com` });
        return res.json({ success: true, status: "Message sent successfully" });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Failed to send message", details: error.message });
    }
});

// —— START SERVER ——————————————————————————————————
app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
    startWhatsApp();
});