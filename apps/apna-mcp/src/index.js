import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import QRCode from 'qrcode';

const protocolVersion = '2025-03-26';
const modernProtocolVersion = '2026-07-28';
const apiUrl = process.env.APNA_API_URL?.replace(/\/+$/, '');
const merchantId = process.env.APNA_MERCHANT_ID;
const serverInfo = { name: 'apna-payments', version: '1.0.0' };

const tools = [
  {
    name: 'apna_create_payment_link',
    description: 'Create an Apna hosted UPI checkout link and a QR image for a one-time payment. The merchant must already have an active receiving account configured. This creates a payment request; it does not confirm that payment succeeded.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', exclusiveMinimum: 0, description: 'Payment amount in INR, for example 149 or 149.50.' },
        description: { type: 'string', minLength: 1, maxLength: 120, description: 'Short item or reason for payment.' },
        orderId: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional merchant order reference. A unique reference is generated when omitted.' },
        returnUrl: { type: 'string', description: 'Optional HTTPS URL to return to after checkout.' }
      },
      required: ['amount', 'description'],
      additionalProperties: false
    }
  },
  {
    name: 'apna_get_payment_status',
    description: 'Get the current status of an Apna payment by payment ID. A created link or customer return to a website is not proof of payment; only SUCCESS means Apna verified the payment.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        paymentId: { type: 'string', minLength: 1, description: 'Payment ID returned when the link was created.' }
      },
      required: ['paymentId'],
      additionalProperties: false
    }
  }
];

function rpcResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function rpcError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function apnaRequest(path, options = {}) {
  if (!apiUrl || !merchantId) {
    throw new Error('Configure APNA_API_URL and APNA_MERCHANT_ID before using Apna tools.');
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-merchant-id': merchantId,
      ...options.headers
    },
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Apna API returned HTTP ${response.status}.`);
  }
  return payload;
}

async function createPaymentLink(args) {
  const amount = Number(args.amount);
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if (!Number.isFinite(amount) || amount <= 0) return toolError('Enter a payment amount greater than zero.');
  if (!description || description.length > 120) return toolError('Add a short description of 1 to 120 characters.');

  const orderId = args.orderId?.trim() || `APNA-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const payment = await apnaRequest('/api/v1/payments', {
    method: 'POST',
    body: JSON.stringify({
      orderId,
      amount: amount.toFixed(2),
      currency: 'INR',
      ...(args.returnUrl ? { returnUrl: args.returnUrl } : {}),
      metadata: { description, source: 'apna-mcp' }
    })
  });

  if (!payment.checkoutUrl || !payment.paymentId) {
    throw new Error('Apna did not return a checkout link. Check the merchant receiving account and checkout configuration.');
  }

  const qrDataUrl = await QRCode.toDataURL(payment.checkoutUrl, { errorCorrectionLevel: 'M', margin: 2, width: 360 });
  const qrBase64 = qrDataUrl.slice(qrDataUrl.indexOf(',') + 1);
  return {
    content: [
      { type: 'text', text: `Payment link created for ₹${payment.amount || amount.toFixed(2)}.\nDescription: ${description}\nOrder: ${payment.orderId || orderId}\nPayment ID: ${payment.paymentId}\nCheckout link: ${payment.checkoutUrl}\nStatus: ${payment.status || 'INITIATED'}\n\nShare the checkout link or the QR image. Payment is not confirmed until Apna reports SUCCESS.` },
      { type: 'image', data: qrBase64, mimeType: 'image/png' }
    ]
  };
}

async function getPaymentStatus(args) {
  const paymentId = typeof args.paymentId === 'string' ? args.paymentId.trim() : '';
  if (!paymentId) return toolError('A payment ID is required.');
  const payment = await apnaRequest(`/api/v1/payments/${encodeURIComponent(paymentId)}`);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        paymentId: payment.paymentId,
        orderId: payment.orderId,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        completedAt: payment.completedAt
      }, null, 2)
    }]
  };
}

async function callTool(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolError('Tool arguments must be a JSON object.');
  if (name === 'apna_create_payment_link') return createPaymentLink(args);
  if (name === 'apna_get_payment_status') return getPaymentStatus(args);
  return toolError(`Unknown Apna tool: ${name}`);
}

async function handleMessage(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) rpcError(message.id, -32600, 'Invalid JSON-RPC request.');
    return;
  }

  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'server/discover') {
    rpcResult(message.id, {
      supportedVersions: [modernProtocolVersion, '2025-11-25', protocolVersion],
      capabilities: { tools: { listChanged: false } },
      instructions: 'Create a payment link only after the merchant has configured an active receiving account. A payment is complete only when status is SUCCESS.',
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }
    });
    return;
  }
  if (message.method === 'initialize') {
    rpcResult(message.id, {
      protocolVersion: message.params?.protocolVersion || protocolVersion,
      capabilities: { tools: {} },
      serverInfo
    });
    return;
  }
  if (message.method === 'ping') {
    rpcResult(message.id, {});
    return;
  }
  if (message.method === 'tools/list') {
    const result = { tools };
    if (message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === modernProtocolVersion) {
      Object.assign(result, {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }
      });
    }
    rpcResult(message.id, result);
    return;
  }
  if (message.method === 'tools/call') {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments);
      if (message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === modernProtocolVersion) {
        result.resultType = 'complete';
        result._meta = { 'io.modelcontextprotocol/serverInfo': serverInfo };
      }
      rpcResult(message.id, result);
    } catch (error) {
      rpcResult(message.id, toolError(error.message || 'Apna request failed.'));
    }
    return;
  }
  if (message.id !== undefined) rpcError(message.id, -32601, `Method not found: ${message.method}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    handleMessage(message).catch(() => {
      if (message?.id !== undefined) rpcError(message.id, -32603, 'Internal MCP server error.');
    });
  } catch {
    rpcError(null, -32700, 'Parse error.');
  }
});
