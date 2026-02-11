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
const qrcode = require("qrcode-terminal"); // <--- Import the new library

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

// Load Config
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        const defaultConfig = {
            apiKeys: ["default_secret_key"],
            allowedIPs: ["::1", "127.0.0.1"]
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}

// Format Mobile Number (+91xxxx -> 91xxxx@s.whatsapp.net)
function formatToJid(mobileNumber) {
    let cleaned = mobileNumber.replace(/\D/g, "");
    return `${cleaned}@s.whatsapp.net`;
}

// —— MIDDLEWARE ————————————————————————————————————
const authMiddleware = (req, res, next) => {
    const config = loadConfig();

    // 1. IP Validation (Modified)
    const clientIp = req.ip || req.connection.remoteAddress;

    // Check if we are allowing ALL IPs
    const allowAllIPs = config.allowedIPs.includes("*");

    if (!allowAllIPs) {
        // Only check specific IPs if wildcard is NOT present
        const normalizedIp = clientIp === '::1' ? '127.0.0.1' : clientIp.replace(/^.*:/, '');
        const isIpAllowed = config.allowedIPs.includes(clientIp) || config.allowedIPs.includes(normalizedIp);

        if (!isIpAllowed) {
            console.warn(`[AUTH FAIL] Blocked IP: ${clientIp}`);
            return res.status(403).json({ error: "Access Denied: IP not whitelisted" });
        }
    }

    // 2. API Key Validation (Still Active)
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || !config.apiKeys.includes(apiKey)) {
        console.warn(`[AUTH FAIL] Invalid Key from IP: ${clientIp}`);
        return res.status(401).json({ error: "Access Denied: Invalid API Key" });
    }

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
        // printQRInTerminal: true,  <--- DEPRECATED OPTION REMOVED
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Manual QR generation
        if (qr) {
            console.log("\nScan this QR Code to login:");
            qrcode.generate(qr, { small: true }); // <--- GENERATE QR HERE
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("⚠️ Connection closed. Reconnecting...", shouldReconnect);
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === "open") {
            console.log("✅ WhatsApp Connected and Ready!");
        }
    });
}

// —— API ROUTES ————————————————————————————————————

app.post("/send-message", authMiddleware, async (req, res) => {
    const { mobileNumber, message } = req.body;

    if (!mobileNumber || !message) {
        return res.status(400).json({
            success: false,
            error: "Missing 'mobileNumber' or 'message' in body"
        });
    }

    if (!sock) {
        return res.status(503).json({
            success: false,
            error: "WhatsApp service is not initializing"
        });
    }

    try {
        const jid = formatToJid(mobileNumber);

        // Check for existence (optional, adds delay)
        // const [result] = await sock.onWhatsApp(jid);
        // if (!result?.exists) return res.status(404).json({ error: "Number not on WhatsApp" });

        await sock.sendMessage(jid, { text: `${message}\n\n ~ veerrajpoot.com` });

        console.log(`[SENT] To: ${mobileNumber} | Msg: "${message.substring(0, 20)}..."`);

        return res.json({
            success: true,
            status: "Message sent successfully",
            to: mobileNumber
        });

    } catch (error) {
        console.error("Send Error:", error);
        return res.status(500).json({
            success: false,
            error: "Failed to send message",
            details: error.message
        });
    }
});

// —— START SERVER ——————————————————————————————————
app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
    console.log(`🔒 Edit 'api_config.json' to manage Access Keys and IPs`);

    startWhatsApp();
});