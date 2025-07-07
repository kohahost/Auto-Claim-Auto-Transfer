const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require("dotenv").config();

// Fungsi kirim notifikasi Telegram
async function sendTelegramMessage(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message
        });
    } catch (err) {
        console.error("⚠️ Gagal kirim ke Telegram:", err.message);
    }
}

// Fungsi ambil key dari mnemonic
async function getPiWalletAddressFromSeed(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Invalid mnemonic");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derivationPath = "m/44'/314159'/0'";
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);

    return {
        publicKey: keypair.publicKey(),
        secretKey: keypair.secret()
    };
}

// Fungsi utama
async function claimAndSend() {
    const mnemonic = process.env.MNEMONIC;
    const receiver = process.env.RECEIVER_ADDRESS;
    const { publicKey, secretKey } = await getPiWalletAddressFromSeed(mnemonic);
    const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
    const keypair = StellarSdk.Keypair.fromSecret(secretKey);

    try {
        const account = await server.loadAccount(publicKey);
        console.log("🔑 Sender Public Key:", publicKey);

        const claimables = await server.claimableBalances().claimant(publicKey).call();

        for (let cb of claimables.records) {
            const cbID = cb.id;
            const amount = cb.amount;
            console.log(`💰 Found Claimable Balance ID: ${cbID}`);
            console.log(`💸 Claimable Amount: ${amount}`);

            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: (await server.fetchBaseFee()).toString(),
                networkPassphrase: 'Pi Network'
            })
                .addOperation(StellarSdk.Operation.claimClaimableBalance({
                    balanceId: cbID
                }))
                .setTimeout(30)
                .build();

            tx.sign(keypair);

            const res = await server.submitTransaction(tx);

            // ✅ Kirim ke Telegram hanya jika berhasil dan hash tersedia
            if (res && res.hash) {
                console.log(`✅ Claimed Successfully! Hash: ${res.hash}`);
                await sendTelegramMessage(`✅ Klaim Pi sukses!\nBalance ID:\n${cbID}\nTx Hash: ${res.hash}`);
            } else {
                console.log("⚠️ Klaim terkirim tapi tidak ada hash (kemungkinan tidak berhasil).");
            }
        }

        // Cek saldo & kirim jika memungkinkan
        const accInfo = await axios.get(`https://api.mainnet.minepi.com/accounts/${publicKey}`);
        const balance = accInfo.data.balances.find(b => b.asset_type === 'native')?.balance || 0;

        console.log(`📊 Pi Balance: ${balance}`);
        const sendAmount = Number(balance) - 1.5;

        if (sendAmount > 0) {
            const accountReloaded = await server.loadAccount(publicKey);
            const sendTx = new StellarSdk.TransactionBuilder(accountReloaded, {
                fee: (await server.fetchBaseFee()).toString(),
                networkPassphrase: 'Pi Network'
            })
                .addOperation(StellarSdk.Operation.payment({
                    destination: receiver,
                    asset: StellarSdk.Asset.native(),
                    amount: sendAmount.toFixed(7)
                }))
                .setTimeout(30)
                .build();

            sendTx.sign(keypair);
            const txResult = await server.submitTransaction(sendTx);

            if (txResult && txResult.hash) {
                console.log(`📤 Sent ${sendAmount.toFixed(7)} Pi to ${receiver}`);
                console.log(`🔗 View Tx: https://api.mainnet.minepi.com/transactions/${txResult.hash}`);
            } else {
                console.log("⚠️ Transfer gagal: transaksi tidak valid.");
            }
        } else {
            console.log("⚠️ Saldo tidak cukup untuk transfer.");
        }

    } catch (e) {
        console.error("❌ Error:", e.response?.data?.extras?.result_codes || e.message || e);
    } finally {
        console.log("🔄 Menunggu 1 detik sebelum next run...");
        console.log("----------------------------------------------------------------");
        setTimeout(claimAndSend, 1000); // ulangi setiap 1 detik
    }
}

claimAndSend();
