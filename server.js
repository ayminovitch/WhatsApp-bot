const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const basicAuth = require('express-basic-auth');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const generateSecurePath = () => 'admin-' + crypto.randomBytes(6).toString('hex');

const DEFAULT_CONFIG = {
    botActive: true,
    triggerCommand: "!pay",
    adminPath: generateSecurePath(),
    adminPhone: "",
    wallets: {
        "Bitcoin (BTC)": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
        "Ethereum (ETH)": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
    },
    customCommands: {
        "!help": "Welcome! Please use *!pay* to make a deposit, or visit our website for more info.",
        "!support": "For technical support, please email support@utopiasms.com"
    },
    messages: {
        groupReply: "Hey @user, to keep this group clean, I've sent the payment details to your DMs! 📩",
        dmMenu: "👋 *Welcome to our Secure Payment Desk*\n\nPlease select the network you wish to use by replying with the corresponding number:",
        successText: "Here is your exact deposit address. \n\n*⚠️ IMPORTANT:*\nAfter sending the funds, please reply to this chat with a screenshot or the TXID (Transaction Hash) to confirm your payment."
    }
};

// Application State
let botState = { status: 'initializing', qrCodeUrl: null };
let config = { ...DEFAULT_CONFIG };

// Load config securely into Memory on boot
function loadAndInitConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            if (data.trim() !== '') {
                const parsed = JSON.parse(data);
                // Deep merge defaults to prevent missing objects (like customCommands) from crashing the dashboard
                config = {
                    ...DEFAULT_CONFIG,
                    ...parsed,
                    wallets: { ...DEFAULT_CONFIG.wallets, ...parsed.wallets },
                    customCommands: { ...DEFAULT_CONFIG.customCommands, ...parsed.customCommands },
                    messages: { ...DEFAULT_CONFIG.messages, ...parsed.messages }
                };
            }
        }
    } catch (error) {
        console.error("Config parse error, falling back to defaults:", error);
    }
    // Write back to ensure valid structure and secure admin path is saved
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));
}
loadAndInitConfig();

const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));

// Logger & SSE Broadcaster
const logClients = new Set();
const logger = {
    log: (msg) => {
        const out = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(out);
        const payload = JSON.stringify({ type: 'info', msg: out });
        logClients.forEach(c => c.write(`data: ${payload}\n\n`));
    },
    error: (msg) => {
        const out = `[${new Date().toLocaleTimeString()}] ❌ ${msg}`;
        console.error(out);
        const payload = JSON.stringify({ type: 'error', msg: out });
        logClients.forEach(c => c.write(`data: ${payload}\n\n`));
    }
};

const app = express();
app.use(express.json());

const ADMIN_ROUTE = `/${config.adminPath}`;

// CRITICAL FIX: Trailing Slash Redirect.
// If the user visits /admin-123, we MUST redirect to /admin-123/
// otherwise frontend relative fetch('api/status') fails via 404.
app.use((req, res, next) => {
    if (req.path === ADMIN_ROUTE) {
        return res.redirect(ADMIN_ROUTE + '/');
    }
    next();
});

const adminRouter = express.Router();

adminRouter.use(basicAuth({ users: { 'Ghost': 'DarkWebGhostX20260000' }, challenge: true, realm: 'Elite WhatsApp Bot' }));
adminRouter.use(express.static(path.join(__dirname, 'public')));

adminRouter.get('/api/status', (req, res) => res.json(botState));
adminRouter.get('/api/config', (req, res) => res.json(config));

adminRouter.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    saveConfig();
    logger.log("⚙️ Configurations updated and saved live.");
    res.json({ success: true });
});

adminRouter.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // CRITICAL FIX for NGINX/VPS Proxies

    logClients.add(res);
    req.on('close', () => logClients.delete(res));
});

adminRouter.post('/api/logout', async (req, res) => {
    logger.log('🧨 Factory Reset requested. Wiping session...');
    try { if (botState.status === 'connected') await client.logout(); } catch (e) {}

    const authDir = path.join(DATA_DIR, '.wwebjs_auth');
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });

    res.json({ success: true, message: "Restarting container..." });
    setTimeout(() => process.exit(1), 1000);
});

app.use(ADMIN_ROUTE, adminRouter);
app.use((req, res) => res.status(404).send('<h1>404 - Unauthorized Access Area</h1>'));

// WhatsApp Core Engine
function clearChromiumLocks() {
    const authDir = path.join(DATA_DIR, '.wwebjs_auth');
    if (!fs.existsSync(authDir)) return;
    const targetLocks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    const cleanDirectory = (dirPath) => {
        try {
            const files = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const file of files) {
                const fullPath = path.join(dirPath, file.name);
                if (file.isDirectory()) cleanDirectory(fullPath);
                else if (targetLocks.includes(file.name)) {
                    fs.unlinkSync(fullPath);
                    logger.log(`🧹 Removed stale lock: ${file.name}`);
                }
            }
        } catch (e) {}
    };
    cleanDirectory(authDir);
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        args:[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    }
});

const userSessions = new Map();
const spamCooldown = new Set();

const simulateTyping = async (chat, duration = 1500) => {
    await chat.sendStateTyping();
    return new Promise(resolve => setTimeout(resolve, duration));
};

client.on('qr', async (qr) => {
    botState.status = 'qr';
    botState.qrCodeUrl = await qrcode.toDataURL(qr);
    logger.log('📱 QR Code successfully generated! Ready for scan.');
});

client.on('ready', () => {
    botState.status = 'connected';
    botState.qrCodeUrl = null;
    logger.log('✅ WhatsApp Bot Connected and Ready to process messages!');
});

client.on('disconnected', () => {
    logger.error('Disconnected from WhatsApp. Restarting process...');
    process.exit(1);
});

client.on('message', async (msg) => {
    if (!config.botActive || msg.fromMe) return;

    const text = msg.body.trim().toLowerCase();
    const trigger = config.triggerCommand.toLowerCase();
    const senderId = msg.author || msg.from;
    const chat = await msg.getChat();

    if (spamCooldown.has(senderId)) return;

    // Handle Custom Commands
    const customMatch = Object.keys(config.customCommands).find(cmd => cmd.toLowerCase() === text);
    if (customMatch) {
        spamCooldown.add(senderId); setTimeout(() => spamCooldown.delete(senderId), 5000);
        logger.log(`💬 Handled custom command [${customMatch}] from ${senderId.split('@')[0]}`);
        await simulateTyping(chat, 1000);
        await chat.sendMessage(config.customCommands[customMatch]);
        return;
    }

    // Handle Main Trigger Flow
    if (text === trigger) {
        spamCooldown.add(senderId); setTimeout(() => spamCooldown.delete(senderId), 5000);
        logger.log(`💳 Initiated payment flow for ${senderId.split('@')[0]}`);

        if (chat.isGroup) {
            await simulateTyping(chat, 1000);
            const contact = await msg.getContact();
            let groupMsg = config.messages.groupReply.replace('@user', `@${contact.number}`);
            await chat.sendMessage(groupMsg, { mentions: [contact] });

            const dmChat = await client.getChatById(senderId);
            await sendMenu(dmChat, senderId, config);
        } else {
            await sendMenu(chat, senderId, config);
        }
    }
    else if (!chat.isGroup) {
        const session = userSessions.get(senderId);
        if (!session) return;

        if (Date.now() - session.timestamp > 600000) {
            userSessions.delete(senderId);
            return;
        }

        if (session.state === 'MENU' && !isNaN(text)) {
            const index = parseInt(text) - 1;
            const coins = Object.keys(config.wallets);

            if (index >= 0 && index < coins.length) {
                const selectedCoin = coins[index];
                const address = config.wallets[selectedCoin];

                logger.log(`🏦 Sent ${selectedCoin} wallet to ${senderId.split('@')[0]}`);
                await simulateTyping(chat, 2000);
                const qrDataUrl = await qrcode.toDataURL(address, { width: 400, margin: 2 });
                const media = new MessageMedia('image/png', qrDataUrl.split(',')[1], 'wallet-qr.png');

                await chat.sendMessage(media, { caption: `🏦 *${selectedCoin}*\n\n\`\`\`${address}\`\`\`\n\n${config.messages.successText}` });
                userSessions.set(senderId, { state: 'AWAITING_RECEIPT', timestamp: Date.now(), coin: selectedCoin });
            }
        }
        else if (session.state === 'AWAITING_RECEIPT') {
            logger.log(`🧾 Received receipt from ${senderId.split('@')[0]}`);
            await simulateTyping(chat, 1000);
            await chat.sendMessage("✅ *Receipt Received!*\n\nThank you. Our team has been notified and is verifying your transaction. We will get back to you shortly.");

            if (config.adminPhone) {
                const adminId = `${config.adminPhone.replace(/[^0-9]/g, '')}@c.us`;
                const contact = await msg.getContact();
                const alertMsg = `🚨 *NEW PAYMENT SUBMISSION*\n\n👤 *From:* +${contact.number}\n🪙 *Network:* ${session.coin}\n💬 *Message:* ${msg.hasMedia ? '[Attached Image]' : text}`;

                try {
                    if (msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        await client.sendMessage(adminId, media, { caption: alertMsg });
                    } else {
                        await client.sendMessage(adminId, alertMsg);
                    }
                    logger.log(`📬 Receipt forwarded to Admin successfully.`);
                } catch (err) { logger.error('Could not forward to admin: ' + err.message); }
            }
            userSessions.delete(senderId);
        }
    }
});

async function sendMenu(chat, userId, cfg) {
    await simulateTyping(chat, 1500);
    let replyMsg = `${cfg.messages.dmMenu}\n\n`;
    Object.keys(cfg.wallets).forEach((coin, index) => { replyMsg += `*${index + 1} ➔* ${coin}\n`; });
    await chat.sendMessage(replyMsg);
    userSessions.set(userId, { state: 'MENU', timestamp: Date.now() });
}

app.listen(3005, () => {
    console.log(`[Server] Booted Successfully.`);
    console.log(`[Access] ➔  http://84.200.154.242:3005${ADMIN_ROUTE}/`);
    console.log(`[Credentials] Username: Ghost | Password: DarkWebGhostX20260000`);
});

clearChromiumLocks();
client.initialize().catch(err => logger.error("CRITICAL Chromium Error: " + err.message));