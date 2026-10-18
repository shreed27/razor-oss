import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YoupiPaymentClient } from '@youpi/merchant-sdk';
import { getDatabase, MerchantRepository, ReceivingAccountRepository } from '@youpi/db';
import QRCode from 'qrcode';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

export class CoinWalletStoreServer {
  /**
   * @param {{
   *   gatewayApiUrl?: string,
   *   merchantId?: string,
   *   webhookSecret?: string
   * }} [options={}]
   */
  constructor(options = {}) {
    const internalPort = process.env.PAYMENT_API_PORT || 6100;
    this.gatewayApiUrl = options.gatewayApiUrl || process.env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${internalPort}`;
    this.merchantId = options.merchantId || '00000000-0000-0000-0000-000000000001';
    this.webhookSecret = options.webhookSecret || 'merchant_webhook_secret_for_wallet_store';

    this.paymentClient = new YoupiPaymentClient({
      apiUrl: this.gatewayApiUrl,
      merchantId: this.merchantId,
      webhookSecret: this.webhookSecret
    });
    this.db = getDatabase();
    this.merchants = new MerchantRepository(this.db);
    this.receivingAccounts = new ReceivingAccountRepository(this.db);
    this.shopDraftAttempts = new Map();
    this.shopDrafts = new Map();
    this.setupHtml = fs.readFileSync(path.join(__dirname, 'setup.html'), 'utf8');

    // In-memory persistent wallet balance & ledger for demo store
    this.walletCoins = 50; // default starting balance
    this.transactionHistory = [];

    this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8');
    this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8');
    this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8');
    this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8');
    this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8');
    this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8');
    this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8');
  }

  creditCoins(orderId, coins, packName) {
    this.walletCoins += Number(coins);
    this.transactionHistory.unshift({
      orderId,
      packName: packName || 'Coin Pack',
      coins: Number(coins),
      status: 'CREDITED',
      timestamp: new Date().toISOString()
    });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Gateway-Signature, X-Gateway-Event'
        });
        res.end();
        return;
      }

      // GET /assets/* (serve product screenshots and icons)
      if (pathname.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) {
        const assetName = path.basename(pathname);
        const assetPath = path.join(__dirname, '../public/assets', assetName);
        if (fs.existsSync(assetPath)) {
          const ext = path.extname(assetName).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400'
          });
          if (method === 'HEAD') { res.end(); return; }
          const stream = fs.createReadStream(assetPath);
          stream.pipe(res);
          return;
        }
      }

      // GET /health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'coin-wallet-store', coins: this.walletCoins }));
        return;
      }

      // Anonymous chat can create a read-only shop preview. It never enables payment collection.
      if (pathname === '/api/setup-draft' && method === 'POST') {
        try {
          const data = await readJson(req);
          const businessName = cleanText(data.businessName, 80);
          const products = normalizeProducts(data.products);
          if (businessName.length < 2) throw new Error('Add a business name with at least 2 characters.');
          if (!products.length) throw new Error('Add at least one product with a price of ₹1 or more.');

          const clientIp = req.socket.remoteAddress || 'unknown';
          const now = Date.now();
          const recentAttempts = (this.shopDraftAttempts.get(clientIp) || []).filter(timestamp => now - timestamp < 60 * 60 * 1000);
          if (recentAttempts.length >= 5) {
            res.setHeader('Retry-After', '3600');
            sendJson(res, 429, { error: 'You’ve made several shop previews recently. Please try again in an hour.' });
            return;
          }
          if (!this.shopDraftAttempts.has(clientIp) && this.shopDraftAttempts.size >= 1000) {
            for (const [ip, timestamps] of this.shopDraftAttempts) {
              if (!timestamps.some(timestamp => now - timestamp < 60 * 60 * 1000)) this.shopDraftAttempts.delete(ip);
            }
            if (this.shopDraftAttempts.size >= 1000) {
              sendJson(res, 503, { error: 'Shop previews are busy right now. Please try again later.' });
              return;
            }
          }
          recentAttempts.push(now);
          this.shopDraftAttempts.set(clientIp, recentAttempts);
          for (const [id, draft] of this.shopDrafts) {
            if (draft.expiresAt <= now) this.shopDrafts.delete(id);
          }
          if (this.shopDrafts.size >= 500) {
            sendJson(res, 503, { error: 'Shop previews are busy right now. Please try again later.' });
            return;
          }
          const previewId = crypto.randomBytes(24).toString('hex');
          this.shopDrafts.set(previewId, {
            businessName,
            products,
            expiresAt: now + 24 * 60 * 60 * 1000
          });
          const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:15000';
          const proto = req.headers['x-forwarded-proto'] || 'http';
          const storefrontUrl = `${proto}://${host}/preview/${previewId}`;
          const qrCode = await QRCode.toDataURL(storefrontUrl, { width: 320, margin: 2, color: { dark: '#14213d', light: '#ffffff' } });
          sendJson(res, 201, {
            businessName, storefrontUrl, qrCode, products,
            onboardingStatus: 'DRAFT', ownerVerified: false, paymentsEnabled: false,
            expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString()
          });
        } catch (error) {
          sendJson(res, 400, { error: error.message || 'Could not create your shop.' });
        }
        return;
      }

      // Legacy setup API is deliberately blocked: a typed UPI ID is not proof of account ownership.
      if (pathname === '/api/setup-shop' && method === 'POST') {
        sendJson(res, 409, {
          error: 'Live payment setup is not available yet. Create a shop preview first; payment activation requires verified merchant ownership.'
        });
        return;
      }

      const previewMatch = pathname.match(/^\/preview\/([a-f0-9]{48})$/);
      if (previewMatch && (method === 'GET' || method === 'HEAD')) {
        const draft = this.shopDrafts.get(previewMatch[1]);
        if (!draft || draft.expiresAt <= Date.now()) {
          this.shopDrafts.delete(previewMatch[1]);
          res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('This shop preview has expired. Create a new one with Apna.ai.');
          return;
        }
        const html = renderShopHtml(draft.businessName, '', draft.products, false);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow'
        });
        if (method === 'HEAD') res.end(); else res.end(html);
        return;
      }

      // Render one merchant's storefront; prices and product names come from persisted server data.
      const shopMatch = pathname.match(/^\/shop\/([a-z0-9-]+)$/i);
      if (shopMatch && (method === 'GET' || method === 'HEAD')) {
        const merchant = this.merchants.findBySlug(shopMatch[1]);
        if (!merchant) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Shop not found'); return; }
        const account = this.receivingAccounts.findActiveForMerchant(merchant.id);
        const products = merchant.branding?.storefront?.products || [];
        const html = renderShopHtml(merchant.businessName, shopMatch[1], products, Boolean(account?.isMerchantEnabled));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        if (method === 'HEAD') res.end(); else res.end(html);
        return;
      }

      // Product ID only: server retrieves the saved price before creating the session.
      const shopCheckoutMatch = pathname.match(/^\/api\/shop\/([a-z0-9-]+)\/checkout$/i);
      if (shopCheckoutMatch && method === 'POST') {
        try {
          const merchant = this.merchants.findBySlug(shopCheckoutMatch[1]);
          const data = await readJson(req);
          const product = merchant?.branding?.storefront?.products?.find(item => item.id === data.productId);
          const account = merchant && this.receivingAccounts.findActiveForMerchant(merchant.id);
          if (!merchant || !product || !account?.isMerchantEnabled) throw new Error('This shop is not ready to accept payments yet.');
          const orderId = `SHOP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
          const paymentClient = new YoupiPaymentClient({ apiUrl: this.gatewayApiUrl, merchantId: merchant.id });
          const payment = await paymentClient.createPayment({
            orderId, amount: (product.pricePaise / 100).toFixed(2), currency: 'INR',
            returnUrl: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}/shop/${shopCheckoutMatch[1]}`,
            metadata: { productId: product.id, productName: product.name, storefront: shopCheckoutMatch[1] }
          });
          const host = req.headers['x-forwarded-host'] || req.headers.host;
          const proto = req.headers['x-forwarded-proto'] || 'http';
          sendJson(res, 200, { checkoutUrl: `${proto}://${host}/checkout/${payment.paymentId}` });
        } catch (error) { sendJson(res, 400, { error: error.message || 'Could not start checkout.' }); }
        return;
      }

      // GET /Apna.js or /sdk/Apna-checkout.js (Universal Frontend Integration Script)
      if (['/Apna.js', '/sdk/Apna-checkout.js', '/sdk/Apna.js', '/youpi.js', '/sdk/youpi-checkout.js', '/sdk/youpi.js'].includes(pathname)) {
        const sdkPath = path.resolve(__dirname, '../../checkout-portal/src/sdk/youpi.js');
        if (fs.existsSync(sdkPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(sdkPath, 'utf8'));
          return;
        }
      }

      // GET /openapi.yaml (Public Developer Integration Specification)
      if (pathname === '/openapi.yaml') {
        const openApiPath = path.resolve(__dirname, '../../../openapi.yaml');
        if (fs.existsSync(openApiPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/yaml; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(openApiPath, 'utf8'));
          return;
        }
      }

      // REVERSE PROXY: /checkout/* and /icons/* -> Checkout Portal (Port 7000)
      if (pathname.startsWith('/checkout') || pathname.startsWith('/icons/')) {
        const portalPort = Number(process.env.CHECKOUT_PORT || 7000);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: portalPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${portalPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Checkout Portal unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // REVERSE PROXY: /api/v1/* -> Payment API (Port 6100 / gatewayApiUrl)
      if (pathname.startsWith('/api/v1/')) {
        try {
          const parsedGateway = new URL(this.gatewayApiUrl);
          const proxyReq = http.request({
            hostname: parsedGateway.hostname || '127.0.0.1',
            port: Number(parsedGateway.port || process.env.PAYMENT_API_PORT || 6100),
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: `${parsedGateway.hostname}:${parsedGateway.port}`,
              'x-forwarded-host': req.headers.host || '',
              'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
            }
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payment Gateway API unavailable', details: err.message }));
            }
          });

          req.pipe(proxyReq);
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to proxy payment API', details: err.message }));
          return;
        }
      }

      // GET / is the merchant setup flow. /demo and /store keep the original showcase.
      if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        if (method === 'HEAD') res.end(); else res.end(this.setupHtml);
        return;
      }
      if ((pathname === '/demo' || pathname === '/store') && (method === 'GET' || method === 'HEAD')) {
        try { this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.storeHtml);
        return;
      }

      // GET /wallet
      if (pathname === '/wallet' && (method === 'GET' || method === 'HEAD')) {
        try { this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.walletHtml);
        return;
      }

      // GET /order-success or /success
      if ((pathname === '/order-success' || pathname === '/success') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const amount = url.searchParams.get('amount') || '499.00';
        const utr = url.searchParams.get('utr') || url.searchParams.get('bankRef') || '123456789012';
        const mode = url.searchParams.get('mode') || url.searchParams.get('payment_mode') || 'UPI';
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        let rendered = this.orderSuccessHtml
          .replaceAll('{{ORDER_ID}}', escapeHtml(orderId))
          .replaceAll('{{AMOUNT}}', escapeHtml(amount))
          .replaceAll('{{UTR}}', escapeHtml(utr))
          .replaceAll('{{MODE}}', escapeHtml(mode))
          .replaceAll('{{TIMESTAMP}}', escapeHtml(timestamp));

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-failed or /failed
      if ((pathname === '/order-failed' || pathname === '/failed') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const rawReason = url.searchParams.get('reason') || '';
        const reason = rawReason === 'UPI_CONFIRMATION_TIMEOUT'
          ? 'The bank did not send a matching confirmation before checkout timed out.'
          : (rawReason.replace(/[_-]+/g, ' ').slice(0, 180) || 'The bank did not confirm this payment.');
        let rendered = this.orderFailedHtml
          .replaceAll('{{ORDER_ID}}', escapeHtml(orderId))
          .replaceAll('ORDER-#', escapeHtml(orderId))
          .replaceAll('{{REASON}}', escapeHtml(reason));

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-suspicious or /suspicious
      if ((pathname === '/order-suspicious' || pathname === '/suspicious') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderSuspiciousHtml.replaceAll('{{ORDER_ID}}', escapeHtml(orderId));

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-expired or /expired
      if ((pathname === '/order-expired' || pathname === '/expired') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderExpiredHtml.replaceAll('{{ORDER_ID}}', escapeHtml(orderId));

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-cancelled or /cancelled
      if ((pathname === '/order-cancelled' || pathname === '/cancelled') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderCancelledHtml.replaceAll('{{ORDER_ID}}', escapeHtml(orderId));

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /api/wallet-balance
      if (pathname === '/api/wallet-balance' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          coins: this.walletCoins,
          history: this.transactionHistory
        }));
        return;
      }

      // POST /api/checkout (Customer clicks purchase pack)
      if (pathname === '/api/checkout' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const rawVal = data.price !== undefined ? data.price : (data.amount !== undefined ? data.amount : 1.00);
            const price = Number(rawVal);
            if (isNaN(price) || price < 1) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Minimum top-up amount is ₹1.00' }));
              return;
            }
            const orderId = `COIN-ORD-${Date.now()}`;
            const amountStr = price.toFixed(2);
            const proto = req.headers['x-forwarded-proto'] || (req.headers.host?.includes('example.com') ? 'https' : 'http');
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5000';
            const returnUrl = `${proto}://${host}/wallet?orderId=${orderId}`;

            // Call Apna Payment Gateway via SDK
            const payment = await this.paymentClient.createPayment({
              orderId,
              amount: amountStr,
              currency: 'INR',
              returnUrl,
              metadata: {
                coins: data.coins || Math.round(price),
                packName: data.packName || data.productName || 'Gamer Pack'
              }
            });

            // Normalize checkoutUrl for localhost development / testing to prevent tunnel offline issues
            let resolvedCheckoutUrl = payment.checkoutUrl;
            if (host.includes('localhost') || host.includes('127.0.0.1')) {
              resolvedCheckoutUrl = `${proto}://${host}/checkout/${payment.paymentId}`;
            }

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              orderId,
              paymentId: payment.paymentId,
              checkoutUrl: resolvedCheckoutUrl
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // POST /api/verify-payment (Instant confirmation & credit from popup drawer handler)
      if (pathname === '/api/verify-payment' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const { paymentId, orderId, coins, packName } = data;

            if (!orderId && !paymentId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing orderId or paymentId' }));
              return;
            }

            // Check if already credited
            const alreadyCredited = this.transactionHistory.some(t => t.orderId === orderId);
            if (alreadyCredited) {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              });
              res.end(JSON.stringify({ success: true, coins: this.walletCoins, message: 'Already credited' }));
              return;
            }

            // Verify with payment API if paymentId is available
            let creditedCoins = Number(coins) || 100;
            let finalPackName = packName || 'Coin Pack';

            if (paymentId) {
              try {
                const session = await this.paymentClient.getPayment(paymentId);
                if (session) {
                  if (session.metadata?.coins) creditedCoins = Number(session.metadata.coins);
                  if (session.metadata?.packName) finalPackName = session.metadata.packName;
                }
              } catch (e) {
                console.warn('[Coin Wallet Store] getPayment check note:', e.message);
              }
            }

            this.creditCoins(orderId, creditedCoins, finalPackName);
            console.log(`[Coin Wallet Store] Verified & credited ${creditedCoins} coins for Order ${orderId}. New balance: ${this.walletCoins}`);

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              success: true,
              coins: this.walletCoins,
              credited: creditedCoins,
              packName: finalPackName
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // POST /api/webhook or /webhook (Signed webhook listener from Apna.ai)
      if ((pathname === '/api/webhook' || pathname === '/webhook') && method === 'POST') {
        let rawBody = '';
        req.on('data', chunk => { rawBody += chunk; });
        req.on('end', () => {
          const signature = req.headers['x-gateway-signature'];

          try {
            // Verify HMAC-SHA256 signature using merchant SDK
            const event = this.paymentClient.verifyWebhook(rawBody, signature);

            if (event.event === 'SUCCESS' || event.status === 'SUCCESS') {
              const orderId = event.orderId || event.data?.orderId;
              const alreadyCredited = this.transactionHistory.some(t => t.orderId === orderId);
              if (!alreadyCredited) {
                const coinsToAdd = Number(event.metadata?.coins || event.data?.metadata?.coins) || 100;
                const packName = event.metadata?.packName || event.data?.metadata?.packName || 'Coin Pack';
                this.creditCoins(orderId, coinsToAdd, packName);
                console.log(`[Coin Wallet Store] Webhook received! Credited ${coinsToAdd} coins for Order ${orderId}. New balance: ${this.walletCoins}`);
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, credited: true }));
          } catch (err) {
            console.error('[Coin Wallet Store] Webhook verification failed:', err.message);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Route Not Found');
    });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 24_000) { reject(new Error('Setup details are too large.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Please check your answers and try again.')); }
    });
    req.on('error', reject);
  });
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeProducts(products) {
  if (!Array.isArray(products)) return [];
  return products.slice(0, 20).map((product, index) => {
    const name = cleanText(product?.name, 80);
    const amount = Number(product?.price);
    if (!name || !Number.isFinite(amount) || amount < 1 || amount > 1000000) return null;
    return { id: `item-${index + 1}`, name, pricePaise: Math.round(amount * 100) };
  }).filter(Boolean);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderShopHtml(businessName, slug, products, enabled) {
  const cards = products.map(product => `<article class="product"><div class="product-icon">🛍️</div><div><h2>${escapeHtml(product.name)}</h2><p>₹${(product.pricePaise / 100).toFixed(2)}</p></div><button ${enabled ? '' : 'disabled'} onclick="buy('${escapeHtml(product.id)}',this)">${enabled ? 'Buy now' : 'Payments not active'}</button></article>`).join('');
  const description = enabled
    ? 'Browse products and pay using the secure checkout.'
    : 'A shop preview created with Apna.ai. Payments are not active for this shop yet.';
  const footer = enabled
    ? 'Payments are confirmed after bank notification verification · Powered by Apna.ai'
    : 'To accept payments, the shop owner must complete verification and connect a payment account.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f7f6f1"><title>${escapeHtml(businessName)} · Apna.ai</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f6f1;color:#17233f;font:16px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.top{background:#17233f;color:white;padding:13px max(calc((100% - 980px)/2),22px);font-weight:750;letter-spacing:-.02em}.wrap{max-width:760px;margin:52px auto;padding:0 20px}.intro{margin-bottom:26px}.intro small{color:#244bd0;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.intro h1{font-size:clamp(34px,7vw,52px);letter-spacing:-.06em;margin:10px 0}.intro p{color:#68748c;line-height:1.6}.preview-note{display:flex;align-items:flex-start;gap:10px;background:#fff8e9;border:1px solid #f2e4c6;border-radius:14px;padding:13px 15px;color:#725a2c;font-size:13px;line-height:1.5;margin-bottom:18px}.product{display:flex;align-items:center;gap:16px;background:white;border:1px solid #e8e8e1;border-radius:18px;padding:18px;margin:12px 0;box-shadow:0 8px 24px #1122440c}.product-icon{font-size:25px;background:#f0f3ff;border-radius:13px;padding:14px}.product h2{font-size:17px;letter-spacing:-.025em;margin:0 0 5px}.product p{margin:0;color:#68748c}.product button{margin-left:auto;border:0;background:#244bd0;color:white;font-weight:700;border-radius:11px;padding:12px 16px;cursor:pointer}.product button:disabled{background:#e9ebf0;color:#68748c;cursor:not-allowed}.foot{margin-top:30px;color:#68748c;font-size:12px;line-height:1.6;text-align:center}button:disabled{cursor:not-allowed}@media(max-width:520px){.wrap{margin:32px auto}.product{flex-wrap:wrap}.product button{width:100%;margin:0}}</style><div class="top">⚡ Apna.ai</div><main class="wrap"><header class="intro"><small>${enabled ? 'Your shop' : 'Shop preview'}</small><h1>${escapeHtml(businessName)}</h1><p>${description}</p></header>${enabled ? '' : '<div class="preview-note"><strong>Preview only</strong><span>These products are visible, but customers can’t pay yet. Payment collection stays off until the owner is verified.</span></div>'}${cards || '<p>This shop has no products yet.</p>'}<div class="foot">${footer}</div></main><script>async function buy(productId,button){button.disabled=true;button.textContent='Opening secure checkout…';try{const r=await fetch('/api/shop/${encodeURIComponent(slug)}/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId})});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not start checkout');location.assign(d.checkoutUrl)}catch(e){alert(e.message);button.disabled=false;button.textContent='Buy now'}}</script></html>`;
}
