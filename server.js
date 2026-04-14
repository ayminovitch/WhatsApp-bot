const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const basicAuth = require('express-basic-auth');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_DIR = path.join(DATA_DIR, '.wwebjs_auth');

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

function ensureValidConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 4));
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        if (!data || data.trim() === '') throw new Error("Empty JSON");

        let parsed = JSON.parse(data);
        if(!parsed.customCommands) parsed.customCommands = DEFAULT_CONFIG.customCommands;
        return parsed;
    } catch (error) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 4));
        return DEFAULT_CONFIG;
    }
}

const getConfig = () => ensureValidConfig();
const saveConfig = (cfg) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 4));

let botState = { status: 'initializing', qrCodeUrl: null };

const logClients = new Set();
const logger = {
    log: (msg) => {
        const out = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(out);
        logClients.forEach(c => c.write(`data: ${JSON.stringify({ type: 'info', msg: out })}\n\n`));
    },
    error: (msg) => {
        const out = `[${new Date().toLocaleTimeString()}] ❌ ${msg}`;
        console.error(out);
        logClients.forEach(c => c.write(`data: ${JSON.stringify({ type: 'error', msg: out })}\n\n`));
    }
};

const app = express();
app.use(express.json());

const config = getConfig();
const ADMIN_ROUTE = `/${config.adminPath}`;
const adminRouter = express.Router();

adminRouter.use(basicAuth({ users: { 'admin': 'admin123' }, challenge: true, realm: 'Elite WhatsApp Bot' }));
adminRouter.use(express.static(path.join(__dirname, 'public')));

adminRouter.get('/api/status', (req, res) => res.json(botState));
adminRouter.get('/api/config', (req, res) => res.json(getConfig()));
adminRouter.post('/api/config', (req, res) => {
    saveConfig({ ...getConfig(), ...req.body });
    logger.log("⚙️ Configurations updated and saved live.");
    res.json({ success: true });
});

adminRouter.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    logClients.add(res);
    req.on('close', () => logClients.delete(res));
});

adminRouter.post('/api/logout', async (req, res) => {
    logger.log('🧨 Factory Reset requested. Wiping session...');
    try { if (botState.status === 'connected') await client.logout(); } catch (e) {}
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({ success: true, message: "Restarting container..." });
    setTimeout(() => process.exit(1), 1000);
});

app.use(ADMIN_ROUTE, adminRouter);
app.use((req, res) => res.status(404).send('<h1>404 - Not Found</h1>'));

function clearChromiumLocks() {
    if (!fs.existsSync(AUTH_DIR)) return;
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
    cleanDirectory(AUTH_DIR);
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: { executablePath: '/usr/bin/chromium', args:['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }
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
    const cfg = getConfig();
    if (!cfg.botActive || msg.fromMe) return;

    const text = msg.body.trim().toLowerCase();
    const trigger = cfg.triggerCommand.toLowerCase();
    const senderId = msg.author || msg.from;
    const chat = await msg.getChat();

    if (spamCooldown.has(senderId)) return;

    const customMatch = Object.keys(cfg.customCommands).find(cmd => cmd.toLowerCase() === text);
    if (customMatch) {
        spamCooldown.add(senderId); setTimeout(() => spamCooldown.delete(senderId), 5000);
        logger.log(`💬 Handled custom command [${customMatch}] from ${senderId.split('@')[0]}`);
        await simulateTyping(chat, 1000);
        await chat.sendMessage(cfg.customCommands[customMatch]);
        return;
    }

    if (text === trigger) {
        spamCooldown.add(senderId); setTimeout(() => spamCooldown.delete(senderId), 5000);
        logger.log(`💳 Initiated payment flow for ${senderId.split('@')[0]}`);

        if (chat.isGroup) {
            await simulateTyping(chat, 1000);
            const contact = await msg.getContact();
            let groupMsg = cfg.messages.groupReply.replace('@user', `@${contact.number}`);
            await chat.sendMessage(groupMsg, { mentions: [contact] });

            const dmChat = await client.getChatById(senderId);
            await sendMenu(dmChat, senderId, cfg);
        } else {
            await sendMenu(chat, senderId, cfg);
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
            const coins = Object.keys(cfg.wallets);

            if (index >= 0 && index < coins.length) {
                const selectedCoin = coins[index];
                const address = cfg.wallets[selectedCoin];

                logger.log(`🏦 Sent ${selectedCoin} wallet to ${senderId.split('@')[0]}`);
                await simulateTyping(chat, 2000);
                const qrDataUrl = await qrcode.toDataURL(address, { width: 400, margin: 2 });
                const media = new MessageMedia('image/png', qrDataUrl.split(',')[1], 'wallet-qr.png');

                await chat.sendMessage(media, { caption: `🏦 *${selectedCoin}*\n\n\`\`\`${address}\`\`\`\n\n${cfg.messages.successText}` });
                userSessions.set(senderId, { state: 'AWAITING_RECEIPT', timestamp: Date.now(), coin: selectedCoin });
            }
        }
        else if (session.state === 'AWAITING_RECEIPT') {
            logger.log(`🧾 Received receipt from ${senderId.split('@')[0]}`);
            await simulateTyping(chat, 1000);
            await chat.sendMessage("✅ *Receipt Received!*\n\nThank you. Our team has been notified and is verifying your transaction. We will get back to you shortly.");

            if (cfg.adminPhone) {
                const adminId = `${cfg.adminPhone.replace(/[^0-9]/g, '')}@c.us`;
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
                } catch (err) { logger.error('Could not forward to admin', err); }
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
    console.log(`[Server] Booted. Secure URL: http://84.200.154.242:3005${ADMIN_ROUTE}`);
});

clearChromiumLocks();
client.initialize().catch(err => logger.error("CRITICAL Chromium Error:", err));