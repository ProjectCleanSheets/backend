import type { VercelRequest, VercelResponse } from '@vercel/node';
import spec from '../openapi.json';

/**
 * GET /api/docs        — Swagger UI with a Google Sign-In button; the issued ID
 *                        token is auto-attached to every Try-it-out request.
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
    <span class="status" id="authstatus">Signed in — requests are authorized automatically</span>
    <span class="hint" id="authhint">Sign in to test auth-gated endpoints (token also works in the Authorize dialog)</span>
  </div>
  <div id="swagger-ui"></div>

  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <script>
    let idToken = null;

    window.ui = SwaggerUIBundle({
      url: '/api/docs?spec=1',
      dom_id: '#swagger-ui',
      persistAuthorization: true,
      requestInterceptor: (request) => {
        if (idToken && !request.headers['Authorization']) {
          request.headers['Authorization'] = 'Bearer ' + idToken;
        }
        return request;
      },
    });

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
          document.getElementById('authstatus').style.display = 'inline';
          document.getElementById('authhint').style.display = 'none';
          // also pre-fill the Authorize dialog so the padlocks close
          window.ui.preauthorizeApiKey && window.ui.authActions.authorizeWithPersistOption({
            googleIdToken: {
              name: 'googleIdToken',
              schema: { type: 'http', scheme: 'bearer' },
              value: idToken,
            },
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
