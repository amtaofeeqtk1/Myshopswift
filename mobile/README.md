# MyShopSwift mobile app

Expo / React Native client in `mobile/`; it uses the existing Express API, PostgreSQL catalogue and customer records, Stripe Checkout, rewards ledger, email verification, and order lifecycle. It does not create a second catalogue or payment implementation.

## Local development

1. Install Node.js 20+ and dependencies with `npm install` in this directory.
2. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_BASE_URL` to a reachable HTTPS API URL. For a physical device, use a deployed host or the computer's LAN address rather than `localhost`.
3. Start Expo with `npm start`, then open the QR code in Expo Go or build a development client.

The API already returns a session token from registration and login. The app stores it with iOS Keychain / Android Keystore through `expo-secure-store` and sends it as a Bearer token. The server's existing `attachUser` middleware accepts that header while web clients continue to use cookies.

Card orders use the existing hosted Stripe Checkout URL in an Expo browser auth session. The API receives `platform: "mobile"`, returning to `myshopswift://payment-result`. On return, the app posts the order and Stripe session IDs to `/api/orders/:id/confirm-card-payment`; the server retrieves the Stripe session, and only a Stripe-verified paid session confirms the order. A cancel return leaves the order awaiting payment. Stripe secrets and webhook credentials remain server-only.

## Build / publish

`app.json` sets the `myshopswift` URL scheme, iOS bundle ID, Android application ID, and SecureStore plugin. Replace the placeholder identifiers with registered store identifiers before release. Configure Apple signing, Google Play signing, store artwork, privacy disclosures, and production API URL; then build with EAS Build (`eas build --platform ios` and `eas build --platform android`). Supply final app icon and splash artwork when approved brand exports are available. Test payment returns and email-link handling on physical devices with Stripe test mode before submission.

## Verification

Run `npm test` for mobile business-rule tests and `npm run typecheck` for TypeScript checks. COD is excluded from the mobile checkout controls; the existing API allowlist accepts only `card` and `points` and rejects `cod`.
