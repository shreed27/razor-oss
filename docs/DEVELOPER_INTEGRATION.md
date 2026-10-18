# Apna.ai Developer Guide

Apna exposes a local MCP integration for creating a hosted payment link and QR from an AI assistant. This is the easiest way to try the payment flow without writing a website integration.

> **Current scope:** The MCP creates one-time payment links and checks payment status. It does not create a full business website, manage a product catalog, onboard a merchant, configure a payout account, or provide a public Apna-hosted signup service. Those steps still require a configured Apna instance and merchant account.

## Use Apna from an MCP client

### 1. Start a configured Apna instance

Run the API and checkout portal using the [installation guide](INSTALLATION.md). Configure the merchant's receiving UPI account in Merchant Admin and confirm the checkout portal has a browser-reachable URL. The default local ports are API `6100`, checkout `7000`, and Merchant Admin `6001`; deployments may use different ports.

For local testing, the API and checkout URLs may use `127.0.0.1`. A customer on another device cannot open a `localhost` checkout link. To share live links, Apna must be deployed on a reachable domain with HTTPS, and the merchant's checkout URL must point to that deployment.

### 2. Install project dependencies

From the repository root:

```bash
npm install
```

### 3. Add the MCP server to your MCP client

Configure a local `stdio` MCP server. Replace `/absolute/path/to/YouPI-PG` with the directory where you cloned the repository, and replace the merchant ID with the merchant configured in your Apna database.

```json
{
  "mcpServers": {
    "apna": {
      "command": "node",
      "args": ["/absolute/path/to/YouPI-PG/apps/apna-mcp/src/index.js"],
      "env": {
        "APNA_API_URL": "http://127.0.0.1:6100",
        "APNA_MERCHANT_ID": "your-merchant-uuid"
      }
    }
  }
}
```

Restart or reload the MCP client after saving its configuration. Keep the server configured as a local process; do not expose an unprotected payment API to the public internet.

### 4. Ask the assistant

Examples:

- “Make a ₹250 payment link for a family meal.”
- “Create a ₹99 link for order ORD-104.”
- “Check the status of payment `<payment-id>`.”

The assistant receives the hosted checkout URL and a QR image. The customer opens the hosted checkout and pays using an available method. `apna_get_payment_status` reports the current payment status; fulfill an order only when the authoritative status is `SUCCESS`.

## Available MCP tools

| Tool | What it does |
| --- | --- |
| `apna_create_payment_link` | Creates an INR one-time payment request and returns its hosted checkout URL and QR image. Requires an active receiving account for the configured merchant. |
| `apna_get_payment_status` | Reads the public status, amount, order ID, and completion time for a payment ID. |

The MCP process reads `APNA_API_URL` and `APNA_MERCHANT_ID` from its environment. The merchant ID selects the merchant; it is not a secret or an authentication credential. The current API does not provide a production merchant OAuth/API-key flow, so this local MCP is for a trusted, self-hosted Apna instance. Do not treat the merchant ID as a security boundary.

## Integrate a website with the API

For an existing online store, create the payment from the store's **server-side** code:

```http
POST https://<your-apna-api-domain>/api/v1/payments
Content-Type: application/json
X-Merchant-Id: <merchant-id>
Idempotency-Key: <unique-request-key>

{
  "orderId": "ORDER-1001",
  "amount": "499.00",
  "currency": "INR",
  "returnUrl": "https://shop.example/checkout/complete",
  "metadata": { "sku": "TSHIRT-01" }
}
```

The response includes `paymentId` and `checkoutUrl`. Redirect the customer to `checkoutUrl`. Never create orders from untrusted browser-supplied prices; calculate the amount on your server.

There is also a Node.js client package and webhook example in [MERCHANT_INTEGRATION.md](MERCHANT_INTEGRATION.md). The browser checkout script described in [the legacy one-script guide](../AGENTS.md) is another option for sites that already have a backend.

## Payment confirmation

Treat browser redirects and browser events as user-interface signals only. For an online store, fulfill the order only after validating Apna's signed server-to-server webhook as described in [MERCHANT_INTEGRATION.md](MERCHANT_INTEGRATION.md). Use the payment API's `SUCCESS` status as the verified outcome; a QR being shown or a customer returning to the store does not mean payment succeeded.

## What remains before “any merchant, one step”

The current repo is a self-hosted gateway and demo, not yet a public multi-merchant product. A true no-code flow still needs hosted merchant registration, secure merchant authentication, payout-account onboarding, store/product page generation, public payment-link hosting, and support/operational tooling. The MCP is a first integration surface for payment links; it does not replace those platform capabilities.
