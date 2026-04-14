const fs = require('fs');
const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// --- 1. CONFIG & STATE MANAGEMENT ---
const CONFIG_FILE = './config.json';
const DEFAULT_CONFIG = {
    botActive: true,
    triggerCommand: "!pay",
    wallets: {
        "Bitcoin (BTC)": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
        "Ethereum (ETH)": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
    },
    messages: {
        groupReply: "Hey @user, to keep this group clean, I've sent the payment details to your DMs! 📩🔒",
        dmMenu: "👋 *Welcome to the Automated Payment Desk*\n\nPlease select the cryptocurrency network you wish to use by replying with the corresponding number:",
        successText: "Here is the exact deposit address:"
    }
};

if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 4));
const getConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const saveConfig = (cfg) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 4));

// Track live connection state
let botState = {
    status: 'initializing', // initializing, qr, connected, disconnected
    qrCodeUrl: null
};

// --- 2. EXPRESS API & DASHBOARD ---
const app = express();
app.use(express.json());

// Basic Authentication for Security
app.use(basicAuth({
    users: { 'admin': 'admin123' }, // !! CHANGE PASSWORD !!
    challenge: true,
    realm: 'WhatsApp Bot Admin',
}));

app.use(express.static(path.join(__dirname, 'public'))); // Serve the frontend

// API Routes
app.get('/api/status', (req, res) => res.json(botState));
app.get('/api/config', (req, res) => res.json(getConfig()));
app.post('/api/config', (req, res) => {
    saveConfig(req.body);
    res.json({ success: true });
});
app.post('/api/logout', async (req, res) => {
    if (botState.status === 'connected') {
        await client.logout();
        botState.status = 'disconnected';
    }
    res.json({ success: true });
});

// --- 3. WHATSAPP BOT LOGIC ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/google-chrome-stable',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

const userSessions = new Map();
const simulateTyping = async (chat, duration = 1500) => {
    await chat.sendStateTyping();
    return new Promise(resolve => setTimeout(resolve, duration));
};

// Events
client.on('qr', async (qr) => {
    botState.status = 'qr';
    botState.qrCodeUrl = await qrcode.toDataURL(qr);
});

client.on('ready', () => {
    botState.status = 'connected';
    botState.qrCodeUrl = null;
    console.log('✅ WhatsApp Bot Ready');
});

client.on('disconnected', () => {
    botState.status = 'disconnected';
    botState.qrCodeUrl = null;
    client.initialize(); // Auto-reconnect
});

client.on('message', async (msg) => {
    const config = getConfig();
    if (!config.botActive || msg.fromMe) return;

    const text = msg.body.trim().toLowerCase();
    const trigger = config.triggerCommand.toLowerCase();
    const senderId = msg.author || msg.from;
    const chat = await msg.getChat();

    // Trigger Command
    if (text === trigger) {
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
    // Handle Menu Selection
    else if (!chat.isGroup && !isNaN(text)) {
        const session = userSessions.get(senderId);
        if (session && (Date.now() - session.timestamp < 300000)) {
            const index = parseInt(text) - 1;
            const coins = Object.keys(config.wallets);

            if (index >= 0 && index < coins.length) {
                const selectedCoin = coins[index];
                const address = config.wallets[selectedCoin];

                await simulateTyping(chat, 2000);
                const qrDataUrl = await qrcode.toDataURL(address, { width: 400, margin: 2 });
                const media = new MessageMedia('image/png', qrDataUrl.split(',')[1], 'wallet-qr.png');

                await chat.sendMessage(media, {
                    caption: `🏦 *${selectedCoin}*\n\n${config.messages.successText}\n\n\`\`\`${address}\`\`\`\n\n_💡 Tap address to copy, or scan the QR._`
                });
                userSessions.delete(senderId);
            }
        }
    }
});

async function sendMenu(chat, userId, config) {
    await simulateTyping(chat, 1500);
    let replyMsg = `${config.messages.dmMenu}\n\n`;
    const coins = Object.keys(config.wallets);
    coins.forEach((coin, index) => { replyMsg += `*${index + 1} ➔* ${coin}\n`; });

    await chat.sendMessage(replyMsg);
    userSessions.set(userId, { timestamp: Date.now() });
}

client.initialize();
app.listen(3005, () => console.log(`[Server] Dashboard live on port 3005`));