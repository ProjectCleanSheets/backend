import type { VercelRequest, VercelResponse } from '@vercel/node';
import spec from '../openapi.json';

/**
 * GET /api/docs        — Swagger UI with a Google Sign-In button. The issued ID
 *                        token is exchanged for a backend session
 *                        (POST /api/auth/session) and the resulting access token
 *                        is auto-attached to every Try-it-out request, exactly as
 *                        the iOS app does it (task 19).
 * GET /api/docs?spec=1 — raw OpenAPI JSON.
 *
 * The page and spec are public; every documented endpoint is auth-gated anyway.
 */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.query.spec !== undefined) {
    res.status(200).json(spec);
    return;
  }

  // Client ID is public by design (it ships inside the iOS app too).
  const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(renderPage(clientId));
}

function renderPage(clientId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CleanSheets API</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    #authbar {
      display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
      padding: 12px 20px; background: #1b1b1b; color: #fff;
      font-family: -apple-system, sans-serif; font-size: 14px;
    }
    #authbar .status { color: #8bc34a; display: none; }
    #authbar .hint { color: #aaa; }
  </style>
</head>
<body>
  <div id="authbar">
    <strong>CleanSheets API</strong>
    <div id="gsignin"></div>
    <span class="status" id="authstatus">Signed in — requests carry a backend access token (valid 1 h; sign in again if calls start returning 401)</span>
    <span class="hint" id="authhint">Sign in to test auth-gated endpoints (the ID token is exchanged for a session token automatically)</span>
  </div>
  <div id="swagger-ui"></div>

  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <script>
    // Two token kinds, same as the app: the Google ID token is only ever sent to
    // the exchange endpoint; everything else gets the backend access token.
    let idToken = null;
    let accessToken = null;

    const isExchangeRequest = (url) =>
      url.includes('/api/auth/session') && !url.includes('/refresh');

    window.ui = SwaggerUIBundle({
      url: '/api/docs?spec=1',
      dom_id: '#swagger-ui',
      persistAuthorization: true,
      requestInterceptor: (request) => {
        const token = isExchangeRequest(request.url) ? idToken : accessToken;
        if (token && !request.headers['Authorization']) {
          request.headers['Authorization'] = 'Bearer ' + token;
        }
        return request;
      },
    });

    // Trades the Google ID token for a backend session, so Try-it-out exercises
    // the same auth path the iOS app uses.
    async function startSession() {
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + idToken },
      });
      if (!response.ok) {
        throw new Error('exchange returned HTTP ' + response.status);
      }
      accessToken = (await response.json()).accessToken;

      document.getElementById('authstatus').style.display = 'inline';
      document.getElementById('authhint').style.display = 'none';
      // also pre-fill the Authorize dialog so the padlocks close
      window.ui.preauthorizeApiKey && window.ui.authActions.authorizeWithPersistOption({
        accessToken: {
          name: 'accessToken',
          schema: { type: 'http', scheme: 'bearer' },
          value: accessToken,
        },
        identityToken: {
          name: 'identityToken',
          schema: { type: 'http', scheme: 'bearer' },
          value: idToken,
        },
      });
    }

    window.addEventListener('load', () => {
      const clientId = ${JSON.stringify(clientId)};
      if (!clientId) {
        document.getElementById('authhint').textContent =
          'GOOGLE_CLIENT_ID is not set in this environment — sign-in unavailable, use the Authorize dialog with a token.';
        return;
      }
      google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          idToken = response.credential;
          startSession().catch((err) => {
            document.getElementById('authhint').textContent =
              'Signed in with Google, but the session exchange failed (' + err.message +
              ') — check the backend logs.';
          });
        },
      });
      google.accounts.id.renderButton(document.getElementById('gsignin'), {
        theme: 'filled_black', size: 'medium', text: 'signin_with',
      });
    });
  </script>
</body>
</html>`;
}
